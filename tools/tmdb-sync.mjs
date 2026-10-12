import { syncAll } from '../src/tmdb.js';

try {
  const r = await syncAll();
  console.log(`\nTMDB sync: ${r.ok} synced, ${r.fail} unmatched/failed, of ${r.total} titles.`);
} catch (e) {
  console.error('\n' + e.message);
  process.exit(1);
}
