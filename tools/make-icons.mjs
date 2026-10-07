// Renders the app icon and iOS launch screens to PNG with Playwright (Chromium).
//   npm run icons
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

let pw;
try { pw = await import('playwright'); } catch {
  const require = createRequire(import.meta.url);
  pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
}
const svg = readFileSync('icons/icon.svg', 'utf8');
const rounded = svg.replace('rx="0"', 'rx="228"');
const browser = await pw.chromium.launch();
const page = await browser.newPage();

async function shot(html, w, h, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  writeFileSync(out, await page.screenshot({ type: 'png', omitBackground: true }));
  console.log('wrote', out);
}
const full = (s, size) => `<div style="width:${size}px;height:${size}px">${s.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`;

// iOS rounds the corners itself, so these are full squares.
await shot(full(svg, 180), 180, 180, 'icons/apple-touch-icon.png');
await shot(full(svg, 192), 192, 192, 'icons/icon-192.png');
await shot(full(svg, 512), 512, 512, 'icons/icon-512.png');
// Maskable: artwork already sits inside the 80% safe zone.
await shot(full(svg, 512), 512, 512, 'icons/maskable-512.png');
writeFileSync('icons/icon.svg', svg); // keep square master; favicon uses rounded copy
writeFileSync('icons/favicon.svg', rounded);

// Launch screens: [css width, css height, pixel ratio]
const devices = [[440, 956, 3], [402, 874, 3], [420, 912, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [375, 812, 3], [414, 896, 2], [375, 667, 2]];
mkdirSync('icons/splash', { recursive: true });
for (const [w, h, dpr] of devices) {
  for (const mode of ['light', 'dark']) {
    const bg = mode === 'light' ? '#f2f2f7' : '#000000';
    const size = 112 * dpr;
    const W = w * dpr, H = h * dpr;
    await shot(`<div style="width:${W}px;height:${H}px;background:${bg};display:grid;place-items:center">
      <div style="width:${size}px;height:${size}px;border-radius:${size * 0.2237}px;overflow:hidden;box-shadow:0 ${8 * dpr}px ${24 * dpr}px rgba(0,0,0,${mode === 'light' ? 0.12 : 0.5})">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></div>`, W, H, `icons/splash/splash-${W}x${H}-${mode}.png`);
  }
}
await browser.close();
