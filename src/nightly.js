// One overnight pass by hand: `npm run nightly` (add `-- --brief` to write the morning brief too).
import { migrate, pool } from './db.js';
import { runNight } from './sloth.js';
await migrate();
console.log(await runNight({ trigger: 'manual', brief: process.argv.includes('--brief') }));
await pool.end();
