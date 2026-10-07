// Copies ONLY the website files into dist/ for Cloudflare. An allowlist, so tooling,
// tests, node_modules — or a statement PDF accidentally left in the repo — are never published.
//   node tools/build-site.mjs   (Wrangler runs this automatically before every deploy)
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist';
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', '_headers'];
const DIRS = ['css', 'js', 'data', 'icons', 'vendor'];
const BLOCK = /\.(pdf|csv|xlsx|ofx|qfx)$|\.(plain|decrypted)\.json$/i;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const f of FILES) cpSync(f, join(OUT, f));
for (const d of DIRS) if (existsSync(d)) cpSync(d, join(OUT, d), { recursive: true, filter: (src) => !BLOCK.test(src) });

let n = 0;
(function count(dir) { for (const e of readdirSync(dir)) { const p = join(dir, e); statSync(p).isDirectory() ? count(p) : n++; } })(OUT);
console.log(`Built ${OUT}/ with ${n} files`);
