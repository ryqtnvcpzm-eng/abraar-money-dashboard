// build_data.mjs — encrypts Abraar's transaction data for the PWA.
// Reads /tmp/transactions.json, generates a RANDOM temporary passphrase,
// AES-GCM encrypts the payload (PBKDF2-SHA256, 200k iterations) and writes
// data.enc.json. The browser app decrypts with the identical WebCrypto scheme.
// Run: node build_data.mjs   (or: python3 build_data.py)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = process.env.TRANSACTIONS_JSON || '/tmp/transactions.json';
const OUT = new URL('./data.enc.json', import.meta.url).pathname;
const PASS_FILE = join(homedir(), 'workspace/your_files/pwa-temp-passphrase.txt');
const ITERATIONS = 200000;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%+=';
function tempPassphrase(len = 22) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

const statementSummaries = [
  { month: '2026-01', opening: 6384.96, moneyIn: 10304.20, moneyOut: 1230.55, closing: 15458.61 },
  { month: '2026-02', opening: 15458.61, moneyIn: 16.95, moneyOut: 1326.76, closing: 14148.80 },
  { month: '2026-03', opening: 14148.80, moneyIn: 1445.60, moneyOut: 2478.02, closing: 13116.38 },
  { month: '2026-04', opening: 13116.38, moneyIn: 15150.98, moneyOut: 17784.66, closing: 10482.70 },
  { month: '2026-05', opening: 10482.70, moneyIn: 540.06, moneyOut: 1447.67, closing: 9575.09 },
  { month: '2026-06', opening: 9575.09, moneyIn: 293.04, moneyOut: 2260.02, closing: 7608.11 },
  { month: '2026-07', opening: 7608.11, moneyIn: 5135.12, moneyOut: 1978.60, closing: 10764.63 },
  { month: '2026-08', opening: 10764.63, moneyIn: 2492.95, moneyOut: 1678.23, closing: 11579.35 },
  { month: '2026-09', opening: 11579.35, moneyIn: 2492.95, moneyOut: 2822.83, closing: 11249.47 },
];

const budgetPlan = {
  startsOn: '2026-11-02', employer: 'IQVIA', takeHome: 5799,
  saveTarget: 3769, savePct: 65, spendBudget: 2030,
  allocation: { Housing: 935, Groceries: 350, 'Restaurants/dates': 300, Coffee: 75, Gym: 71, Transit: 110, Misc: 100, Flex: 89 },
};

async function main() {
  const transactions = JSON.parse(readFileSync(SRC, 'utf8'));
  const payload = {
    version: 1, generatedAt: new Date().toISOString(),
    openingBalance: 6384.96, // Jan 1 2026
    statementSummaries, budgetPlan, transactions,
  };
  const passphrase = tempPassphrase();
  const enc = new TextEncoder();
  const salt = randomBytes(16), iv = randomBytes(12);
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const fileData = {
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    ciphertext: b64(ct),
  };
  writeFileSync(OUT, JSON.stringify(fileData, null, 2));
  mkdirSync(join(homedir(), 'workspace/your_files'), { recursive: true });
  writeFileSync(PASS_FILE, passphrase + '\n', { mode: 0o600 });
  console.log(`Wrote ${OUT} (${transactions.length} transactions)`);
  console.log(`Temporary passphrase: ${passphrase}`);
  console.log(`Also saved to ${PASS_FILE} — change it in the app (Plan tab → Security) right away.`);
}
main().catch(e => { console.error(e); process.exit(1); });
