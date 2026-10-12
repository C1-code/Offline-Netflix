import fs from 'node:fs';
import path from 'node:path';
import cfg from '../src/config.js';
import { buildPlan, applyPlan } from '../src/rename.js';

const plan = buildPlan();
const all = [...plan.fileMoves, ...plan.folderMoves];

if (!all.length) {
  console.log('Nothing to rename — library is already clean.');
  process.exit(0);
}

console.log(`\nRename plan: ${plan.fileMoves.filter((m) => m.type === 'file').length} media file(s), ` +
  `${plan.fileMoves.filter((m) => m.type === 'companion').length} companion subtitle/nfo file(s), ` +
  `${plan.folderMoves.length} folder(s)\n`);

for (const m of plan.folderMoves) console.log(`[folder]    ${m.from}\n        ->  ${m.to}\n`);
for (const m of plan.fileMoves.filter((m) => m.type === 'file')) console.log(`[file]      ${path.basename(m.from)}\n        ->  ${path.basename(m.to)}\n`);
const comps = plan.fileMoves.filter((m) => m.type === 'companion');
if (comps.length) {
  console.log(`[+${comps.length} companion sub/nfo file(s) renamed to match]\n`);
}

const apply = process.argv.includes('--apply');
if (!apply) {
  fs.writeFileSync(path.join(cfg.dataDir, 'rename-plan.json'), JSON.stringify(plan, null, 2));
  console.log('DRY RUN — nothing was changed. Full plan: data/rename-plan.json');
  console.log('Review it, then run:  npm run rename:apply');
} else {
  const r = applyPlan(plan);
  console.log(`\nApplied ${r.applied} rename(s).`);
  if (r.failed.length) {
    console.log(`\n${r.failed.length} FAILED (skipped):`);
    for (const f of r.failed) console.log(`  ${f.from}\n     -> ${f.to}\n     (${f.error})`);
    console.log('\nRe-run npm run rename:apply to retry after closing any apps using those files.');
  }
  console.log('\nDone. Restart the app (or run npm run scan) to pick up new paths.');
}
