import { scan } from '../src/scanner.js';

console.log('Scanning', process.env.MEDIA_PATH || 'media library (config.json)');
const r = await scan();
console.log('');
console.log('=== Scan complete ===');
console.log(`videos found : ${r.videos}`);
console.log(`skipped      : ${r.skipped}`);
console.log(`duplicates   : ${r.dupes} hidden`);
console.log(`vanished     : ${r.removed} removed from db`);
console.log(`probed       : ${r.probed} files`);
console.log(`library      : ${r.series} series, ${r.movies} movies, ${r.files} playable files`);
if (r.subs) console.log(`subtitles    : matched ${r.subs.matched}/${r.subs.total} external sub file(s)`);
