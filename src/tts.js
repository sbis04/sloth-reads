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
const EL_MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5';  // the cheaper, faster model: half the credits
// The voices you can pick from. Each has its own audio cache.
export const VOICES = [
  { id: 'eric', name: 'Eric', note: 'calm and smooth', el: 'cjVigY5qzO86Huf0OWal' },
  { id: 'matilda', name: 'Matilda', note: 'warm and friendly', el: 'XrExE9yKIg1WjnnlVkGX' },
  { id: 'george', name: 'George', note: 'warm British storyteller', el: 'JBFqnCBsd6RMkjVDRZzb' },
  { id: 'lily', name: 'Lily', note: 'soft British', el: 'pFZP5JQG7iQjIQuC4Bku' },
  { id: 'brian', name: 'Brian', note: 'deep and steady', el: 'nPczCjzI2devNBz1zQrb' },
];
export const pickVoice = (id) => VOICES.find((v) => v.id === id) ?? VOICES[0];
// Cache key per voice. Eric keeps the original key, so audio cached before voices existed still plays.
export const voiceKey = (v = VOICES[0]) => (PROVIDER !== 'elevenlabs' ? 'say' : v.id === 'eric' ? `el-${EL_MODEL}` : `el-${EL_MODEL}-${v.id}`);
export const voiceId = voiceKey();
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
async function* elevenlabs(text, signal, voice) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.el}/stream/with-timestamps?output_format=mp3_44100_128`, {
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

const synth = (text, signal, voice) => (PROVIDER === 'elevenlabs' ? elevenlabs(text, signal, voice) : macSay(text, signal));

// Live timings for pieces still being spoken, so the page can highlight before a piece is cached.
const live = new Map(); // `${key}:${voice}` -> Map(segmentKey -> { words })

// Back up to the start of the sentence containing `o`, so a resumed reading starts naturally.
function sentenceStart(text, o) {
  if (o <= 0) return 0;
  const before = text.slice(0, o);
  const m = [...before.matchAll(/[.!?]["')\]]*\s+|\n+/g)].pop();
  return m ? m.index + m[0].length : 0;
}

// What gets spoken, from a starting point: the rest of chunk `c` from offset `o`, then the whole chunks after it.
// Starting from the very beginning is the common case and uses whole-chunk cache keys.
export function segments(text, from) {
  const parts = chunks(text);
  let [c, o] = from ?? [0, 0];
  if (!(c >= 0 && c < parts.length)) { c = 0; o = 0; }
  o = sentenceStart(parts[c], Math.max(0, Math.min(o, parts[c].length - 1)));
  const out = [];
  for (let i = c; i < parts.length; i++) {
    const base = i === c ? o : 0;
    out.push({ chunk: i, base, text: parts[i].slice(base), id: base ? `${i}@${base}` : String(i) });
  }
  return out;
}

export async function cachedChunks(key, vk = voiceId) {
  const { rows } = await pool.query('SELECT key, seconds, alignment FROM audio WHERE key LIKE $1', [`${key}:${vk}:%`]);
  return new Map(rows.map((r) => [r.key.split(':').pop(), r]));
}

// Word timings for every piece known so far, each with its offset in this playback's timeline.
export async function alignment(key, text, voice = VOICES[0], from) {
  const vk = voiceKey(voice);
  const segs = segments(text, from);
  const cached = await cachedChunks(key, vk);
  const now = live.get(`${key}:${vk}`);
  const out = [];
  let offset = 0;
  for (const g of segs) {
    const c = cached.get(g.id), l = now?.get(g.id);
    if (c) { out.push({ i: g.chunk, base: g.base, offset, words: c.alignment ?? [] }); offset += c.seconds; continue; }
    if (l) out.push({ i: g.chunk, base: g.base, offset, words: l.words, partial: true });
    break; // later pieces can't be placed until this one's length is known
  }
  return { start: [segs[0].chunk, segs[0].base], chunks: out, complete: out.length === segs.length && !out.some((c) => c.partial) };
}

// Characters voiced today, across everyone (the visitor budget is measured against this).
export async function charsToday() {
  const { rows } = await pool.query(`SELECT coalesce(sum(chars), 0)::int AS n FROM audio WHERE NOT by_owner AND voice LIKE $1 AND created_at >= date_trunc('day', now())`, [PROVIDER === 'elevenlabs' ? 'el-%' : 'say']);
  return rows[0].n;
}

// Writes speech for `text` into an HTTP response, from a starting point. Fully cached audio is sent whole
// (so it can seek); otherwise it streams as it's generated. `allowGenerate` is checked before every new piece,
// so a budget that runs out mid-article stops there rather than overspending.
export async function stream(req, res, key, text, { allowGenerate, voice = VOICES[0], from }) {
  const may = typeof allowGenerate === 'function' ? allowGenerate : async () => allowGenerate;
  const byOwner = allowGenerate === true; // the owner is passed `true`; visitors get a budget check
  const vk = voiceKey(voice);
  const segs = segments(text, from);
  const { rows } = await pool.query('SELECT key, mp3 FROM audio WHERE key LIKE $1', [`${key}:${vk}:%`]);
  const cached = new Map(rows.map((r) => [r.key.split(':').pop(), r.mp3]));
  if (!cached.has(segs[0].id) && !(await may())) return res.status(403).json({ error: 'The voice is resting until tomorrow.' });

  if (segs.every((g) => cached.has(g.id))) return sendWhole(req, res, Buffer.concat(segs.map((g) => cached.get(g.id))));

  // Headers go out with the first audio, so a voice failure before any sound can still answer with an error.
  let started = false;
  const send = (buf) => {
    if (!started) { res.set({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store' }); started = true; }
    if (!res.writableEnded) res.write(buf);
  };
  const ctl = new AbortController();
  res.on('close', () => ctl.abort()); // the listener stopped: stop generating (and stop paying)
  const liveKey = `${key}:${vk}`;
  if (!live.has(liveKey)) live.set(liveKey, new Map());
  const mine = live.get(liveKey);
  try {
    for (const g of segs) {
      if (ctl.signal.aborted) break;
      if (cached.has(g.id)) { send(cached.get(g.id)); continue; }
      if (!(await may())) break;
      const audio = [];
      const starts = [];
      const entry = { words: [] };
      mine.set(g.id, entry);
      try {
        for await (const p of synth(g.text, ctl.signal, voice)) {
          if (p.audio.length) { audio.push(p.audio); send(p.audio); }
          for (const [k, t] of p.starts) starts[k] = t;
          if (p.starts.length) entry.words = wordsFrom(g.text, starts);
        }
      } catch (err) {
        if (!ctl.signal.aborted) console.error('tts', key, g.id, err.message);
        if (!started) { res.status(503).json({ error: 'voice unavailable' }); return; }
        break;
      } finally { mine.delete(g.id); }
      if (ctl.signal.aborted) break; // a half-spoken piece isn't worth keeping
      const mp3 = Buffer.concat(audio);
      await pool.query('INSERT INTO audio (key, voice, chars, seconds, mp3, alignment, by_owner) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO NOTHING',
        [`${key}:${vk}:${g.id}`, vk, g.text.length, seconds(mp3.length), mp3, JSON.stringify(wordsFrom(g.text, starts)), byOwner]);
    }
  } finally {
    if (!mine.size) live.delete(liveKey);
    if (!res.headersSent) res.status(503).json({ error: 'voice unavailable' });
    else res.end();
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
