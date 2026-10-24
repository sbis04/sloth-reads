// Streams speech for a brief or a whole article, chunk by chunk, with word timings for the live highlight.
// TTS=elevenlabs  -> ElevenLabs streaming with character timestamps (production)
// TTS=say         -> macOS `say` + ffmpeg, with estimated timings (free, for development)
// Each chunk's audio and timings are cached, so a replay never costs twice, and generation stops the moment the listener does.
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
const seconds = (bytes) => (bytes * 8) / 128000; // CBR 128 kbps

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

// Character timings -> word starts: [[seconds, charIndex, length], ...] relative to the chunk.
function wordsFrom(text, starts) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const t = starts[m.index];
    if (t != null) words.push([Math.round(t * 1000) / 1000, m.index, m[0].length]);
  }
  return words;
}

// ElevenLabs sends JSON lines: a slice of audio plus the start time of each character in it.
async function* elevenlabs(text, signal) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', signal,
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let buf = '';
  let pos = 0; // characters aligned so far in this chunk
  for await (const part of res.body) {
    buf += Buffer.from(part).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      const a = j.alignment;
      const starts = a ? a.character_start_times_seconds.map((s, k) => [pos + k, s]) : [];
      if (a) pos += a.characters.length;
      yield { audio: j.audio_base64 ? Buffer.from(j.audio_base64, 'base64') : Buffer.alloc(0), starts };
    }
  }
}

// macOS `say` has no timings, so spread the words across the clip's length (weighted by length): close enough for dev.
async function* macSay(text, signal) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sloth-'));
  try {
    const txt = path.join(dir, 'in.txt'), aiff = path.join(dir, 'out.aiff');
    await writeFile(txt, text);
    await new Promise((ok, fail) => spawn('say', ['-r', '185', '-f', txt, '-o', aiff]).on('exit', (c) => (c ? fail(new Error(`say ${c}`)) : ok())));
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', aiff, '-ac', '1', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
    signal?.addEventListener('abort', () => ff.kill());
    const all = [];
    for await (const part of ff.stdout) { all.push(part); yield { audio: part, starts: [] }; }
    const dur = seconds(Buffer.concat(all).length);
    const total = text.length || 1;
    yield { audio: Buffer.alloc(0), starts: [...text].map((_, k) => [k, (k / total) * dur * 0.97]) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const synth = (text, signal) => (PROVIDER === 'elevenlabs' ? elevenlabs(text, signal) : macSay(text, signal));

// Live timings for chunks still being spoken, so the page can highlight before a chunk is cached.
const live = new Map(); // key -> Map(chunkIndex -> { words, bytes })

export async function cachedChunks(key) {
  const { rows } = await pool.query('SELECT key, seconds, alignment FROM audio WHERE key LIKE $1', [`${key}:${voiceId}:%`]);
  return new Map(rows.map((r) => [Number(r.key.split(':').pop()), r]));
}

// Word timings for every chunk known so far, each with its offset in the overall audio.
export async function alignment(key, text) {
  const parts = chunks(text);
  const cached = await cachedChunks(key);
  const now = live.get(key);
  const out = [];
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const c = cached.get(i), l = now?.get(i);
    if (c) { out.push({ i, offset, words: c.alignment ?? [] }); offset += c.seconds; continue; }
    if (l) out.push({ i, offset, words: l.words, partial: true });
    break; // later chunks can't be placed until this one's length is known
  }
  return { chunks: out, total: parts.length, complete: out.length === parts.length && !out.some((c) => c.partial) };
}

// Characters voiced today, across everyone (the visitor budget is measured against this).
export async function charsToday() {
  const { rows } = await pool.query(`SELECT coalesce(sum(chars), 0)::int AS n FROM audio WHERE voice = $1 AND created_at >= date_trunc('day', now())`, [voiceId]);
  return rows[0].n;
}

// Writes speech for `text` into an HTTP response. Fully cached audio is sent whole (so it can seek);
// otherwise it streams as it's generated. `allowGenerate` is checked before every new chunk,
// so a budget that runs out mid-article stops there rather than overspending.
export async function stream(req, res, key, text, { allowGenerate }) {
  const may = typeof allowGenerate === 'function' ? allowGenerate : async () => allowGenerate;
  const parts = chunks(text);
  const { rows } = await pool.query('SELECT key, mp3 FROM audio WHERE key LIKE $1', [`${key}:${voiceId}:%`]);
  const cached = new Map(rows.map((r) => [Number(r.key.split(':').pop()), r.mp3]));
  if (!cached.has(0) && !(await may())) return res.status(403).json({ error: 'The voice is resting until tomorrow.' });

  if (parts.every((_, i) => cached.has(i))) return sendWhole(req, res, Buffer.concat(parts.map((_, i) => cached.get(i))));

  res.set({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-chunks': String(parts.length) });
  const ctl = new AbortController();
  res.on('close', () => ctl.abort()); // the listener stopped: stop generating (and stop paying)
  if (!live.has(key)) live.set(key, new Map());
  const mine = live.get(key);
  try {
    for (let i = 0; i < parts.length; i++) {
      if (ctl.signal.aborted) break;
      if (cached.has(i)) { res.write(cached.get(i)); continue; }
      if (!(await may())) break;
      const audio = [];
      const starts = [];
      const entry = { words: [], bytes: 0 };
      mine.set(i, entry);
      try {
        for await (const p of synth(parts[i], ctl.signal)) {
          if (p.audio.length) { audio.push(p.audio); entry.bytes += p.audio.length; if (!res.writableEnded) res.write(p.audio); }
          for (const [k, s] of p.starts) starts[k] = s;
          if (p.starts.length) entry.words = wordsFrom(parts[i], starts);
        }
      } catch (err) {
        if (!ctl.signal.aborted) console.error('tts', key, i, err.message);
        break;
      }
      if (ctl.signal.aborted) break; // a half-spoken chunk isn't worth keeping
      const mp3 = Buffer.concat(audio);
      await pool.query('INSERT INTO audio (key, voice, chars, seconds, mp3, alignment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING',
        [`${key}:${voiceId}:${i}`, voiceId, parts[i].length, seconds(mp3.length), mp3, JSON.stringify(wordsFrom(parts[i], starts))]);
      mine.delete(i);
    }
  } finally {
    if (!mine.size) live.delete(key);
    res.end();
  }
}

// Whole files support Range requests, so the player can seek (tap a paragraph to jump there).
function sendWhole(req, res, buf) {
  res.set({ 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  const m = /bytes=(\d*)-(\d*)/.exec(req.get('range') ?? '');
  if (!m) return res.set('content-length', String(buf.length)).end(buf);
  const start = m[1] ? Number(m[1]) : buf.length - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
  if (start >= buf.length || start > end) return res.status(416).set('content-range', `bytes */${buf.length}`).end();
  res.status(206).set({ 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': String(end - start + 1) }).end(buf.subarray(start, end + 1));
}
