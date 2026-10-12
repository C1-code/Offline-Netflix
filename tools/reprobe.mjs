// One-time: reset probe flags so the scanner re-reads codecs, then rescan.
import { db } from '../src/db.js';
import { scan } from '../src/scanner.js';

db.exec('UPDATE files SET probe_done = 0');
const r = await scan({ probe: true, subs: true });
console.log(`reprobe complete: ${r.probed} files probed`);
