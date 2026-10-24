import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const url = process.env.DATABASE_URL;
const remote = /sslmode=|tsdb\.cloud/.test(url ?? '');
// Tiger Cloud signs its certificates with its own CA; verify against it rather than skipping checks.
const ca = /tsdb\.cloud/.test(url ?? '') ? readFileSync(new URL('../db/tiger-ca.pem', import.meta.url), 'utf8') : undefined;
export const pool = new pg.Pool({
  connectionString: url?.replace(/[?&]sslmode=[^&]*/, ''),
  ssl: remote ? { ca, rejectUnauthorized: true } : undefined,
  options: '-c search_path=sloth,public',
  max: 4,
});
// An idle connection dropped by the network must not take the process down with it.
pool.on('error', (err) => console.error('database connection error:', err.message));

export async function migrate() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  for (let i = 1; ; i++) {
    try { await pool.query(sql); return; } catch (err) {
      if (i >= 8) throw err;
      console.log(`database not ready (${err.code ?? err.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export const toVector = (v) => (v ? `[${v.join(',')}]` : null);
