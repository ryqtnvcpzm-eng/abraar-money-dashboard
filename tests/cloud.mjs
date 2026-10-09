// Sync API + client tests: node tests/cloud.mjs  (uses node:sqlite as a stand-in for D1)
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import * as cloud from '../js/cloud.js';
import { emptyVault } from '../js/ledger.js';
import { seal, openWithSession } from '../js/crypto.js';

// --- minimal D1 shim over node:sqlite ---
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args); }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async run() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
  }
  return { prepare: (sql) => new Stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}
const env = { DB: fakeD1(), INVITE_CODE: 'family-2026' };
globalThis.fetch = async (url, init = {}) => worker.fetch(new Request(new URL(url, 'https://money.test/'), init), env);

let passed = 0; const failed = [];
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed.push(name); console.log('  ✗', name, '\n    ', e.message); } }
const rejects = async (p, code) => { try { await p; } catch (e) { assert.equal(e.code ?? e.message, code); return; } assert.fail(`expected ${code}`); };

console.log('Cloud sync API');
await test('status reports configured', async () => assert.equal(await cloud.available(), true));
await test('unconfigured server says so', async () => {
  const r = await worker.fetch(new Request('https://money.test/api/v1/accounts/x/kdf'), { INVITE_CODE: '' });
  assert.equal(r.status, 503);
});
await test('wrong invite code is refused', async () => {
  await rejects(cloud.createAccount({ invite: 'nope', username: 'abraar', passphrase: 'correct horse battery staple', vault: emptyVault() }), 'bad_invite');
});
let A, B;
await test('two people create separate accounts', async () => {
  A = await cloud.createAccount({ invite: 'family-2026', username: 'Abraar', passphrase: 'orange bicycle quiet harbour', vault: emptyVault() });
  B = await cloud.createAccount({ invite: 'family-2026', username: 'brother', passphrase: 'purple mountain lazy river', vault: emptyVault() });
  assert.equal(A.username, 'abraar');
  assert.notEqual(A.env.kdf.salt, B.env.kdf.salt);
});
await test('usernames are unique', async () => {
  await rejects(cloud.createAccount({ invite: 'family-2026', username: 'abraar', passphrase: 'something else entirely ok', vault: emptyVault() }), 'username_taken');
});
await test('the server stores no plaintext and no token', async () => {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE username = ?').bind('abraar').first();
  const blob = JSON.stringify(row);
  assert.ok(!blob.includes(A.token), 'token stored');
  assert.ok(!/"userRules"|"transactions"/.test(blob), 'plaintext stored');
});
await test('sign in on a new device with username + passphrase', async () => {
  const r = await cloud.signIn('ABRAAR', 'orange bicycle quiet harbour');
  assert.equal(r.vault.sync.username, 'abraar');
  assert.equal(r.token, A.token);
});
await test('wrong passphrase is refused', async () => rejects(cloud.signIn('abraar', 'wrong passphrase here ok'), 'wrong_credentials'));
await test('one person cannot read the other’s vault', async () => {
  await rejects(cloud.pull('abraar', B.token), 'unauthorized');
  await rejects(cloud.signIn('abraar', 'purple mountain lazy river'), 'wrong_credentials');
});
await test('unknown usernames get a stable fake salt (no account enumeration)', async () => {
  const a = await (await fetch('api/v1/accounts/nobody-here/kdf')).json();
  const b = await (await fetch('api/v1/accounts/nobody-here/kdf')).json();
  assert.equal(a.salt, b.salt); assert.equal(a.iterations, 600000);
});
await test('push / pull round trip between two devices', async () => {
  const dev2 = await cloud.signIn('abraar', 'orange bicycle quiet harbour');
  dev2.vault.plan = { note: 'from device 2' };
  const env2 = await seal(dev2.session, dev2.vault, dev2.env.rev + 1);
  await cloud.push('abraar', dev2.token, env2, dev2.env.rev);
  const r = await cloud.pull('abraar', A.token);
  assert.equal(r.rev, env2.rev);
  assert.equal((await openWithSession(r.envelope, A.session)).plan.note, 'from device 2');
});
await test('a stale device gets a conflict instead of overwriting', async () => {
  const stale = await seal(A.session, { ...emptyVault(), sync: { username: 'abraar', token: A.token } }, 5);
  await rejects(cloud.push('abraar', A.token, stale, 1), 'conflict');
  await cloud.push('abraar', A.token, stale, 1, { force: true });
  assert.equal((await cloud.pull('abraar', A.token)).rev, 5);
});
await test('changing the passphrase re-keys the account', async () => {
  const access = await cloud.deriveAccess('new strong passphrase words', 'AAAAAAAAAAAAAAAAAAAAAA==', 600000);
  const next = await seal(access.session, { ...emptyVault(), sync: { username: 'abraar', token: access.token } }, 6);
  await cloud.push('abraar', A.token, next, 5, { newToken: access.token });
  await rejects(cloud.pull('abraar', A.token), 'unauthorized');
  assert.equal((await cloud.signIn('abraar', 'new strong passphrase words')).env.rev, 6);
});
await test('repeated wrong guesses are throttled', async () => {
  for (let i = 0; i < 10; i++) { try { await cloud.pull('brother', 'bogus-token'); } catch { /* expected */ } }
  await rejects(cloud.pull('brother', B.token), 'too_many_attempts');
  await env.DB.prepare('DELETE FROM failures').run();
});
await test('cross-site writes are rejected', async () => {
  const r = await worker.fetch(new Request('https://money.test/api/v1/accounts', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }), env);
  assert.equal(r.status, 403);
});
await test('an existing vault can move into an account', async () => {
  const { createSession } = await import('../js/crypto.js');
  const s = await createSession('legacy vault passphrase ok');
  const v = emptyVault(); v.plan = { note: 'legacy' };
  const legacyEnv = await seal(s, v, 7);
  const r = await cloud.adoptVault({ invite: 'family-2026', username: 'abraar2', passphrase: 'legacy vault passphrase ok', env: legacyEnv, vault: v });
  assert.equal(r.env.rev, 8);
  assert.equal((await cloud.signIn('abraar2', 'legacy vault passphrase ok')).vault.plan.note, 'legacy');
  await rejects(cloud.adoptVault({ invite: 'family-2026', username: 'abraar3', passphrase: 'not the right one at all', env: legacyEnv, vault: v }), 'WRONG_PASSPHRASE');
});
await test('deleting an account removes it', async () => {
  await cloud.deleteAccount('brother', B.token);
  await rejects(cloud.pull('brother', B.token), 'unauthorized');
});

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
