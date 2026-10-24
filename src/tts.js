// Streams speech for a brief or a whole article, chunk by chunk.
// TTS=elevenlabs  -> ElevenLabs streaming (production and the demo recording)
// TTS=say         -> macOS `say` + ffmpeg (development: free, same code path)
// Each chunk is cached in the database, so a replay never costs twice, and generation stops the moment the listener does.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool } from './db.js';

export const PROVIDER = process.env.TTS ?? 'say';
const VOICE = process.env.ELEVENLABS_VOICE ?? 'cjVigY5qzO86Huf0OWal'; // "Eric"
const EL_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5';  // the cheaper, faster model: half the credits
export const voiceId = PROVIDER === 'elevenlabs' ? `el-${EL_MODEL}` : 'say';
const CHUNK = 1800;

// Paragraph-sized pieces, so audio starts fast and a listener who stops early isn't billed for the rest.
export function chunks(text) {
  const paras = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK) { out.push(cur); cur = ''; }
    if (p.length > CHUNK) {
      for (const s of p.match(/[^.!?]+[.!?]+["')\]]*\s*|.+$/g) ?? [p]) {
        if (cur.length + s.length > CHUNK && cur) { out.push(cur); cur = ''; }
        cur += s;
      }
    } else cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) out.push(cur);
  return out;
}

async function* elevenlabs(text, signal) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=mp3_44100_128`, {
    method: 'POST', signal,
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for await (const part of res.body) yield Buffer.from(part);
}

async function* macSay(text, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sloth-'));
  try {
    const txt = path.join(dir, 'in.txt'), aiff = path.join(dir, 'out.aiff');
    await writeFile(txt, text);
    await new Promise((ok, fail) => spawn('say', ['-r', '185', '-f', txt, '-o', aiff]).on('exit', (c) => (c ? fail(new Error(`say ${c}`)) : ok())));
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', aiff, '-ac', '1', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
    signal?.addEventListener('abort', () => ff.kill());
    for await (const part of ff.stdout) yield part;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const synth = (text, signal) => (PROVIDER === 'elevenlabs' ? elevenlabs(text, signal) : macSay(text, signal));
const seconds = (bytes) => (bytes * 8) / 128000;

// Writes speech for `text` into an HTTP response as it's generated. `allowGenerate` false means cached audio only.
export async function stream(res, key, text, { allowGenerate }) {
  const parts = chunks(text);
  const { rows } = await pool.query('SELECT key, mp3 FROM audio WHERE key LIKE $1', [`${key}:${voiceId}:%`]);
  const cached = new Map(rows.map((r) => [Number(r.key.split(':').pop()), r.mp3]));
  if (!allowGenerate && !cached.has(0)) {
    res.status(403).json({ error: 'This one hasn\'t been read aloud yet.' });
    return;
  }
  res.set({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-chunks': String(parts.length) });
  const ctl = new AbortController();
  res.on('close', () => ctl.abort()); // the listener stopped: stop generating (and stop paying)
  for (let i = 0; i < parts.length; i++) {
    if (ctl.signal.aborted) break;
    if (cached.has(i)) { res.write(cached.get(i)); continue; }
    if (!allowGenerate) break;
    const buf = [];
    try {
      for await (const b of synth(parts[i], ctl.signal)) { buf.push(b); if (!res.writableEnded) res.write(b); }
    } catch (err) {
      if (!ctl.signal.aborted) console.error('tts', key, i, err.message);
      break;
    }
    if (ctl.signal.aborted) break; // a half-spoken chunk isn't worth keeping
    const mp3 = Buffer.concat(buf);
    await pool.query('INSERT INTO audio (key, voice, chars, seconds, mp3) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING',
      [`${key}:${voiceId}:${i}`, voiceId, parts[i].length, seconds(mp3.length), mp3]);
  }
  res.end();
}
