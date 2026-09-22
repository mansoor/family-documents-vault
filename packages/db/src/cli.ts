import { createPool } from './client.js';
import { dbConfigFromEnv } from './config.js';
import { migrateUp, migrationStatus } from './migrate.js';

const command = process.argv[2] ?? 'status';
const pool = createPool(dbConfigFromEnv().adminUrl, 1);

try {
  if (command === 'up') {
    const applied = await migrateUp(pool, undefined, (m) => console.log(m));
    console.log(applied.length ? `${applied.length} migration(s) applied` : 'up to date');
  } else if (command === 'status') {
    const s = await migrationStatus(pool);
    for (const m of s.applied) console.log(`applied  ${m.version}_${m.name}`);
    for (const m of s.pending) console.log(`pending  ${m.version}_${m.name}`);
    if (!s.applied.length && !s.pending.length) console.log('no migrations');
  } else {
    console.error(`unknown command "${command}" (use: up | status)`);
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
