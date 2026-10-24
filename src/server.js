import express from 'express';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { pool, migrate } from './db.js';
import { addUrl, processItem, runNight, buildBrief, search } from './sloth.js';
import { stream, alignment, chunks, PROVIDER, voiceId } from './tts.js';
import { MODEL } from './model.js';

const BUILD = Date.now().toString(36);
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
app.use(express.json({ limit: '20kb' }));

const same = (a, b) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// The owner (whoever holds OWNER_TOKEN) adds links and generates speech. Everyone else can read and replay.
const isOwner = (req) => same(req.get('x-owner') ?? '', process.env.OWNER_TOKEN ?? '');
const owner = (req, res, next) => (isOwner(req) ? next() : res.status(401).json({ error: 'Only the owner can do that' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
const page = async (file, res) => {
  const html = (await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')).replaceAll('?v=BUILD', `?v=${BUILD}`);
  res.set('cache-control', 'no-cache').type('html').send(html);
};
app.get(['/', '/index.html'], (_req, res) => page('index.html', res));
// The phone's share sheet (PWA share_target) lands here; the page saves the link if you're the owner.
app.get('/share', (req, res) => {
  const found = String(req.query.url || req.query.text || '').match(/https?:\/\/\S+/)?.[0] ?? '';
  res.redirect(found ? `/?add=${encodeURIComponent(found)}` : '/');
});
app.use(express.static('public', { maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0, index: false }));

// Everything the page needs in one call.
app.get('/api/state', async (req, res) => {
  const [brief, items, totals, daily, runs] = await Promise.all([
    pool.query('SELECT day::text AS day, item_ids, script, read_minutes, created_at FROM briefs ORDER BY day DESC LIMIT 1'),
    pool.query(`SELECT id, url, source, title, author, site, cover, read_minutes, status, error, added_at, processed_at, summary, takeaways, verdict, reason, tags, finished_at,
                  EXISTS (SELECT 1 FROM audio a WHERE a.key = 'item:' || items.id || ':' || $1 || ':0') AS has_audio
                FROM items ORDER BY finished_at IS NOT NULL, CASE status WHEN 'done' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                  CASE verdict WHEN 'read' THEN 0 WHEN 'skim' THEN 1 WHEN 'skip' THEN 2 ELSE 3 END, processed_at DESC NULLS LAST, added_at DESC LIMIT 200`, [voiceId]),
    pool.query(`SELECT count(*)::int AS items, count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'queued')::int AS queued,
                  coalesce(sum(read_minutes), 0)::int AS read_minutes, (SELECT coalesce(sum(minutes), 0)::float FROM saved) AS saved_minutes FROM items`),
    pool.query(`SELECT day::date::text AS day, minutes::float, events::int FROM saved_daily WHERE day > now() - INTERVAL '30 days' ORDER BY day`),
    pool.query('SELECT time, trigger, synced, processed, failed, briefed, ms FROM runs ORDER BY time DESC LIMIT 12'),
  ]);
  const b = brief.rows[0];
  let briefAudio = false;
  if (b) briefAudio = (await pool.query('SELECT 1 FROM audio WHERE key = $1', [`brief:${b.day}:${voiceId}:0`])).rowCount > 0;
  res.json({
    owner: isOwner(req), model: MODEL, voice: PROVIDER, brief: b ? { ...b, has_audio: briefAudio } : null,
    items: items.rows, totals: totals.rows[0], daily: daily.rows, runs: runs.rows,
  });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 200);
  if (!q) return res.json([]);
  res.json(await search(q));
});

// Save a link. It's fetched now and read by the model right away (the nightly run picks up anything that fails).
app.post('/api/items', owner, async (req, res) => {
  try {
    const r = await addUrl(req.body?.url);
    res.json(r);
    if (!r.existed) processItem(r.id).catch((err) => console.error('process', r.id, err.message));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/items/:id/done', owner, async (req, res) => {
  await pool.query('UPDATE items SET finished_at = CASE WHEN finished_at IS NULL THEN now() END WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/items/:id/retry', owner, async (req, res) => {
  await pool.query(`UPDATE items SET status = 'queued', error = NULL WHERE id = $1`, [req.params.id]);
  processItem(Number(req.params.id)).catch(() => {});
  res.json({ ok: true });
});
app.delete('/api/items/:id', owner, async (req, res) => {
  await pool.query('DELETE FROM audio WHERE key LIKE $1', [`item:${req.params.id}:%`]);
  await pool.query('DELETE FROM saved WHERE item_id = $1', [req.params.id]);
  await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Listening. Visitors replay what's already been spoken; only the owner spends voice credits on something new.
// Every listenable thing has text (what's spoken) and a cache key.
async function speakable(kind, id) {
  if (kind === 'brief') {
    const { rows } = await pool.query('SELECT script FROM briefs WHERE day = $1', [id]);
    return rows[0] && { key: `brief:${id}`, text: rows[0].script, title: 'Your morning brief' };
  }
  const { rows } = await pool.query('SELECT title, author, site, url, cover, read_minutes, text FROM items WHERE id = $1', [id]);
  const it = rows[0];
  return it && { key: `item:${id}`, text: `${it.title}${it.author ? `, by ${it.author}` : ''}.\n\n${it.text ?? ''}`, title: it.title, author: it.author, site: it.site, url: it.url, cover: it.cover, read_minutes: it.read_minutes };
}
const canGenerate = (req) => isOwner(req) || (req.query.k && same(String(req.query.k), process.env.OWNER_TOKEN ?? ''));
const KINDS = new Set(['brief', 'item']);

app.get('/api/listen/:kind/:id', async (req, res) => {
  if (!KINDS.has(req.params.kind)) return res.status(404).end();
  const s = await speakable(req.params.kind, req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  await stream(req, res, s.key, s.text, { allowGenerate: canGenerate(req) });
});
// The reader view: the exact text being spoken, in the same chunks the audio uses.
app.get('/api/read/:kind/:id', async (req, res) => {
  if (!KINDS.has(req.params.kind)) return res.status(404).end();
  const s = await speakable(req.params.kind, req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { text, key, ...meta } = s;
  res.json({ ...meta, chunks: chunks(text) });
});
// Word timings so far (cached chunks, plus the one being spoken right now).
app.get('/api/align/:kind/:id', async (req, res) => {
  if (!KINDS.has(req.params.kind)) return res.status(404).end();
  const s = await speakable(req.params.kind, req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.set('cache-control', 'no-store').json(await alignment(s.key, s.text));
});

// The overnight run. DigitalOcean Functions call this on a schedule; it answers at once and works in the background.
let running = false;
app.post('/api/cron', async (req, res) => {
  if (!same(req.get('x-cron-secret') ?? '', process.env.CRON_SECRET ?? '') && !isOwner(req)) return res.status(401).json({ error: 'Nope' });
  if (running) return res.status(202).json({ status: 'already running' });
  running = true;
  const brief = req.body?.brief === true;
  res.status(202).json({ status: 'started', brief });
  try { console.log('night run', await runNight({ trigger: isOwner(req) ? 'manual' : 'schedule', brief })); }
  catch (err) { console.error('night run failed', err); } finally { running = false; }
});
app.post('/api/brief', owner, async (_req, res) => res.json(await buildBrief()));

process.on('unhandledRejection', (err) => console.error('unhandled:', err));
await migrate();
const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => console.log(`Sloth Reads on http://localhost:${PORT} (model ${MODEL}, voice ${PROVIDER})`));
