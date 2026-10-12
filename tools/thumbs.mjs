import { generateAllThumbs } from '../src/thumbs.js';

const n = await generateAllThumbs();
console.log(`done: ${n} thumbnails generated`);
