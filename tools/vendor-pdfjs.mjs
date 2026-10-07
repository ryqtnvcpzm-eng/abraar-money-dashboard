// Copies the pinned pdf.js build into vendor/pdfjs so the site never loads code from a CDN.
// Run after changing the pdfjs-dist version in package.json:  npm install && npm run vendor
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
const src = 'node_modules/pdfjs-dist';
const dst = 'vendor/pdfjs';
mkdirSync(dst, { recursive: true });
// The "legacy" build carries polyfills, so it also runs on older iOS Safari versions.
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copyFileSync(`${src}/legacy/build/${f}`, `${dst}/${f}`);
copyFileSync(`${src}/LICENSE`, `${dst}/LICENSE`);
const { version } = JSON.parse(readFileSync(`${src}/package.json`, 'utf8'));
console.log(`Vendored pdf.js ${version} into ${dst}/`);
