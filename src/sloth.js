// What the sloth does overnight: pull in what you saved, read it, decide if it's worth your time, and brief you in the morning.
import { pool, toVector } from './db.js';
import { ask, embed, MODEL } from './model.js';
import { fetchArticle, devReadingList } from './fetch.js';

const READER = process.env.READER_PROFILE ?? 'a mobile app developer who builds with Flutter, AI models and side projects, and enters hackathons';
const PER_RUN = Number(process.env.ITEMS_PER_RUN ?? 4); // slow and steady: a few articles each hour, all night

const str = { type: 'string' };
const SCHEMA = {
  type: 'object',
  properties: {
    summary: str, takeaways: { type: 'array', items: str }, verdict: { type: 'string', enum: ['read', 'skim', 'skip'] },
    reason: str, tags: { type: 'array', items: str },
  },
  required: ['summary', 'takeaways', 'verdict', 'reason', 'tags'],
};
const BRIEF = { type: 'object', properties: { script: str }, required: ['script'] };

export async function addUrl(url, { source } = {}) {
  const clean = String(url).trim();
  if (!/^https?:\/\//.test(clean)) throw new Error('That doesn\'t look like a link');
  const exists = await pool.query('SELECT id, status FROM items WHERE url = $1', [clean]);
  if (exists.rows[0]) return { id: exists.rows[0].id, existed: true };
  const a = await fetchArticle(clean);
  const { rows } = await pool.query(
    `INSERT INTO items (url, source, dev_id, title, author, author_handle, site, cover, read_minutes, words, text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url RETURNING id`,
    [a.url, source ?? a.source, a.dev_id, a.title, a.author, a.author_handle, a.site, a.cover, a.read_minutes, a.words, a.text],
  );
  return { id: rows[0].id, existed: false };
}

// Gemma reads one article and decides what it's worth to this reader.
export async function processItem(id) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
  const it = rows[0];
  if (!it) return;
  try {
    const body = (it.text ?? '').slice(0, 14000);
    const r = await ask(`You read articles for a busy person so they don't have to. The reader is ${READER}.
Article: "${it.title}"${it.author ? ` by ${it.author}` : ''} (${it.site}, about ${it.read_minutes} min to read)

${body}

Reply with JSON:
summary: 2 or 3 plain sentences: what the article says and what's actually new in it. No hype, no "this article".
takeaways: 3 short, concrete things worth remembering (numbers, names, how-tos), each under 20 words.
verdict: "read" if this reader would really get something from the full text, "skim" if the summary and takeaways cover it, "skip" if it's not worth their time (announcements past their date, fluff, off-topic for them).
reason: one honest sentence saying why, aimed at this reader.
tags: 2 to 4 lowercase topic words.
Only use facts from the article.`, { schema: SCHEMA, maxTokens: 700 });
    const verdict = ['read', 'skim', 'skip'].includes(r.verdict) ? r.verdict : 'skim';
    const takeaways = (r.takeaways ?? []).slice(0, 3).map(String);
    const tags = (r.tags ?? []).slice(0, 4).map((t) => String(t).toLowerCase());
    const doc = `${it.title}\n${r.summary}\n${takeaways.join('\n')}\n${tags.join(' ')}\n${body.slice(0, 2500)}`;
    const vec = await embed(doc);
    await pool.query(
      `UPDATE items SET status = 'done', error = NULL, processed_at = now(), summary = $2, takeaways = $3, verdict = $4, reason = $5, tags = $6,
         embedding = $7, search = setweight(to_tsvector('english', $8), 'A') || setweight(to_tsvector('english', $9), 'B') WHERE id = $1`,
      [id, String(r.summary ?? ''), takeaways, verdict, String(r.reason ?? ''), tags, toVector(vec), `${it.title} ${tags.join(' ')}`, `${r.summary} ${takeaways.join(' ')}`],
    );
    // The lazy payoff: a skip saves the whole read; a skim saves all but a minute with the summary.
    const minutes = verdict === 'skip' ? it.read_minutes : verdict === 'skim' ? Math.max(it.read_minutes - 1, 0) : 0;
    if (minutes > 0) await pool.query('INSERT INTO saved (item_id, kind, minutes) VALUES ($1, $2, $3)', [id, verdict === 'skip' ? 'skipped' : 'summary', minutes]);
    return { id, verdict };
  } catch (err) {
    await pool.query(`UPDATE items SET status = 'failed', error = $2 WHERE id = $1`, [id, String(err.message).slice(0, 300)]);
    throw err;
  }
}

// One spoken brief covering everything read since the last one.
export async function buildBrief(day = new Date().toISOString().slice(0, 10)) {
  const { rows: items } = await pool.query(
    `SELECT id, title, site, read_minutes, summary, verdict, reason FROM items
     WHERE status = 'done' AND id NOT IN (SELECT unnest(item_ids) FROM briefs) ORDER BY
     CASE verdict WHEN 'read' THEN 0 WHEN 'skim' THEN 1 ELSE 2 END, processed_at LIMIT 12`);
  if (!items.length) return null;
  const list = items.map((x, i) => `${i + 1}. "${x.title}" (${x.site}, ${x.read_minutes} min). Verdict: ${x.verdict}. ${x.summary} Why: ${x.reason}`).join('\n');
  const r = await ask(`Write a spoken morning brief, like a calm friend reading the news to someone still in bed. It will be turned into speech.
The listener is ${READER}. Overnight you read ${items.length} things they saved, about ${items.reduce((a, x) => a + x.read_minutes, 0)} minutes of reading.
${list}

Rules: start with a one-line good morning that says how much reading you got through. Then cover each article in one or two plain spoken sentences, starting with the ones worth reading in full; say clearly which ones they can skip. Put the greeting, each article, and the closing line in their own short paragraphs, separated by a blank line. End with one short line. No lists, no markdown, no emoji, no URLs. Between 120 and 260 words.
Reply with JSON only: {"script": "..."}`, { schema: BRIEF, maxTokens: 900, temperature: 0.5 });
  const script = String(r.script ?? '').trim();
  const read = items.reduce((a, x) => a + x.read_minutes, 0);
  await pool.query(
    `INSERT INTO briefs (day, item_ids, script, read_minutes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (day) DO UPDATE SET item_ids = briefs.item_ids || EXCLUDED.item_ids, script = EXCLUDED.script, read_minutes = briefs.read_minutes + EXCLUDED.read_minutes, created_at = now()`,
    [day, items.map((x) => x.id), script, read]);
  await pool.query('DELETE FROM audio WHERE key LIKE $1', [`brief:${day}:%`]); // a rewritten brief needs fresh audio
  return { day, items: items.length, script };
}

// One overnight pass. DigitalOcean Functions call this every hour from 1 to 6 AM; the last call writes the brief.
export async function runNight({ trigger = 'manual', brief = false } = {}) {
  const t0 = Date.now();
  let synced = 0, processed = 0, failed = 0;
  if (process.env.DEV_API_KEY) {
    try {
      for (const url of await devReadingList(process.env.DEV_API_KEY)) {
        try { const r = await addUrl(url, { source: 'dev' }); if (!r.existed) synced++; } catch (err) { console.error('sync', url, err.message); }
      }
    } catch (err) { console.error('reading list:', err.message); }
  }
  const { rows } = await pool.query(`SELECT id FROM items WHERE status = 'queued' ORDER BY added_at LIMIT $1`, [PER_RUN]);
  for (const { id } of rows) {
    try { await processItem(id); processed++; } catch (err) { failed++; console.error('process', id, err.message); }
  }
  const b = brief ? await buildBrief() : null;
  await pool.query('INSERT INTO runs (trigger, synced, processed, failed, briefed, ms) VALUES ($1,$2,$3,$4,$5,$6)', [trigger, synced, processed, failed, Boolean(b), Date.now() - t0]);
  return { synced, processed, failed, briefed: Boolean(b), model: MODEL, ms: Date.now() - t0 };
}

// Hybrid search: meaning (pgvector) and exact words (full text), merged with reciprocal rank fusion.
export async function search(q, limit = 8) {
  const vec = toVector(await embed(q));
  const { rows } = await pool.query(
    `WITH v AS (SELECT id, row_number() OVER (ORDER BY embedding <=> $1) AS r FROM items WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 20),
          k AS (SELECT id, row_number() OVER (ORDER BY ts_rank(search, q) DESC) AS r FROM items, websearch_to_tsquery('english', $2) q WHERE search @@ q LIMIT 20)
     SELECT i.id, i.title, i.site, i.url, i.verdict, i.summary, i.read_minutes,
            coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + k.r), 0) AS score, k.r IS NOT NULL AS exact
     FROM items i LEFT JOIN v ON v.id = i.id LEFT JOIN k ON k.id = i.id
     WHERE v.id IS NOT NULL OR k.id IS NOT NULL ORDER BY score DESC LIMIT $3`, [vec, q, limit]);
  return rows;
}
