// Sync API + client tests: node tests/cloud.mjs  (uses node:sqlite as a stand-in for D1)
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import * as cloud from '../js/cloud.js';
import { emptyVault } from '../js/ledger.js';
import { seal, openWithSession } from '../js/crypto.js';
import { plaidMock } from './plaid-mock.mjs';
import { newMailKey, publicOf, openBox, readMessages } from '../js/gmail.js';

// --- minimal D1 shim over node:sqlite ---
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args); }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async run() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  }
  return { prepare: (sql) => new Stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}
const env = { DB: fakeD1(), INVITE_CODE: 'family-2026' };
// Plaid calls the Worker makes go to a stand-in; everything else goes to the Worker.
const plaid = plaidMock();
let liveEnv = env;
// A stand-in for Google's sign-in token endpoint (only what Gmail connect uses).
const google = { codes: new Map(), refresh: new Set(), revoked: [], scope: 'https://www.googleapis.com/auth/gmail.readonly' };
const b64u = (buf) => Buffer.from(buf).toString('base64url');
// And Gmail's API: made-up messages, as Gmail's format=full sends them.
const inboxMail = new Map(); // id -> message
const b64m = (s) => Buffer.from(s, 'utf8').toString('base64url');
function gmailMsg(id, from, subject, date, html, extra = []) {
  inboxMail.set(id, { id, threadId: id, internalDate: String(Date.parse(date)), payload: { mimeType: 'multipart/mixed', filename: '', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date }, { name: 'To', value: 'me@example.com' }, { name: 'Received', value: 'from somewhere' }],
    parts: [{ mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64m(html) } }, ...extra] } });
}
const gmailCalls = [];
function gmailHandle(url, init) {
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (!/^Bearer ya29\./.test(init.headers?.Authorization || '')) return out(401, { error: { code: 401 } });
  gmailCalls.push(url.pathname);
  if (url.pathname.endsWith('/messages')) return out(200, { messages: [...inboxMail.keys()].reverse().map((id) => ({ id, threadId: id })), resultSizeEstimate: inboxMail.size });
  const m = inboxMail.get(url.pathname.split('/').pop());
  return m ? out(200, m) : out(404, { error: { code: 404 } });
}
async function googleHandle(path, form) {
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (form.get('client_id') !== 'g-client' && path !== '/revoke') return out(401, { error: 'invalid_client' });
  if (path === '/revoke') { google.revoked.push(form.get('token')); google.refresh.delete(form.get('token')); return out(200, {}); }
  if (form.get('client_secret') !== 'g-secret') return out(401, { error: 'invalid_client' });
  if (form.get('grant_type') === 'authorization_code') {
    const c = google.codes.get(form.get('code'));
    google.codes.delete(form.get('code'));
    if (!c || c.redirect !== form.get('redirect_uri')) return out(400, { error: 'invalid_grant' });
    const digest = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier') || '')));
    if (digest !== c.challenge) return out(400, { error: 'invalid_grant' });
    const refresh = `1//test-refresh-${crypto.randomUUID()}`;
    google.refresh.add(refresh);
    return out(200, { access_token: 'ya29.test-access', expires_in: 3599, refresh_token: refresh, scope: c.scope ?? google.scope, token_type: 'Bearer' });
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (!google.refresh.has(form.get('refresh_token'))) return out(400, { error: 'invalid_grant' });
    return out(200, { access_token: 'ya29.test-access-2', expires_in: 3599, scope: google.scope, token_type: 'Bearer' });
  }
  return out(400, { error: 'unsupported_grant_type' });
}
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://google.test/gmail/')) return gmailHandle(new URL(String(url)), init);
  if (String(url).startsWith('https://google.test/')) return googleHandle(new URL(String(url)).pathname, new URLSearchParams(init.body));
  if (String(url).startsWith(plaid.base)) {
    const r = plaid.handle(new URL(String(url)).pathname, JSON.parse(init.body));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }
  return worker.fetch(new Request(new URL(url, 'https://money.test/'), init), liveEnv);
};

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
await test('repeated wrong guesses are throttled, but a stranger can’t lock the owner out', async () => {
  const from = (ip, token) => worker.fetch(new Request('https://money.test/api/v1/accounts/brother/vault', { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip } }), env);
  const results = await Promise.all(Array.from({ length: 14 }, () => from('203.0.113.9', 'bogus-token')));
  assert.ok(results.some((r) => r.status === 429), 'parallel guesses hit the limit');
  assert.equal((await from('203.0.113.9', B.token)).status, 429, 'the guessing network stays blocked');
  assert.equal((await from('198.51.100.7', B.token)).status, 200, 'the owner elsewhere still gets in');
  await env.DB.prepare('DELETE FROM failures').run();
});
await test('a forced save must move the revision forward', async () => {
  const cur = await cloud.pull('brother', B.token);
  const older = await seal(B.session, { ...emptyVault(), sync: { username: 'brother', token: B.token } }, Math.max(1, cur.rev - 1));
  await rejects(cloud.push('brother', B.token, older, cur.rev, { force: true }), 'conflict');
});
await test('a client refuses weak key settings from the server', async () => {
  await rejects(cloud.deriveAccess('whatever passphrase', 'AAAAAAAAAAAAAAAAAAAAAA==', 1), 'bad_server_kdf');
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

console.log('Forgot passphrase');
let S;
await test('new accounts come with a recovery key', async () => {
  const v = emptyVault(); v.plan = { note: 'sis plan' };
  S = await cloud.createAccount({ invite: 'family-2026', username: 'sis', passphrase: 'green kettle brave lantern', vault: v });
  assert.match(S.recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
  const row = await env.DB.prepare('SELECT * FROM recovery WHERE username = ?').bind('sis').first();
  assert.ok(row && !row.blob.includes(S.recoveryKey.replace(/-/g, '')), 'server must not see the key');
});
await test('the recovery key resets a forgotten passphrase', async () => {
  const typed = S.recoveryKey.toLowerCase().replace(/-/g, ' ');
  const r = await cloud.recoverWithKey('Sis', typed);
  assert.equal(r.vault.plan.note, 'sis plan');
  const res = await cloud.setPassphrase({ username: 'sis', oldToken: r.token, vault: r.vault, env: r.env, baseRev: r.env.rev, passphrase: 'violet harbor sleepy comet' });
  assert.equal((await cloud.signIn('sis', 'violet harbor sleepy comet')).vault.plan.note, 'sis plan');
  await rejects(cloud.signIn('sis', 'green kettle brave lantern'), 'wrong_credentials');
  await rejects(cloud.pull('sis', S.token), 'unauthorized');
  // …and the same recovery key still works after the reset.
  assert.equal((await cloud.recoverWithKey('sis', S.recoveryKey)).token, res.token);
});
await test('a wrong or malformed recovery key is refused', async () => {
  await rejects(cloud.recoverWithKey('sis', cloud.newRecoveryKey()), 'wrong_recovery_key');
  await rejects(cloud.recoverWithKey('sis', 'abc'), 'bad_recovery_key');
});
await test('unknown usernames get a stable fake recovery blob', async () => {
  const a = await (await fetch('api/v1/accounts/ghost-user/recovery')).json();
  const b = await (await fetch('api/v1/accounts/ghost-user/recovery')).json();
  assert.deepEqual(a, b);
  assert.equal(a.recovery.v, 1);
  await rejects(cloud.recoverWithKey('ghost-user', cloud.newRecoveryKey()), 'wrong_recovery_key');
});
await test('Face ID–style reset: raw key bytes open the account', async () => {
  const { deriveKeyBits, unb64 } = await import('../js/crypto.js');
  const kdf = await (await fetch('api/v1/accounts/sis/kdf')).json();
  const bits = await deriveKeyBits('violet harbor sleepy comet', unb64(kdf.salt), kdf.iterations);
  const r = await cloud.openWithBits('sis', bits);
  assert.equal(r.vault.plan.note, 'sis plan');
});
await test('a new recovery key replaces the old one', async () => {
  const { deriveKeyBits, unb64 } = await import('../js/crypto.js');
  const r = await cloud.signIn('sis', 'violet harbor sleepy comet');
  const bits = await deriveKeyBits('violet harbor sleepy comet', unb64(r.env.kdf.salt), r.env.kdf.iterations);
  const { code } = await cloud.enableRecovery({ username: 'sis', token: r.token, bits, vault: r.vault, env: r.env, session: r.session, baseRev: r.env.rev });
  assert.equal((await cloud.signIn('sis', 'violet harbor sleepy comet')).vault.recovery.code, code, 'vault and server agree');
  await rejects(cloud.recoverWithKey('sis', S.recoveryKey), 'wrong_recovery_key');
  assert.equal((await cloud.recoverWithKey('sis', code)).token, r.token);
});
await test('changing the passphrase in Settings replaces the recovery key', async () => {
  const r = await cloud.signIn('sis', 'violet harbor sleepy comet');
  const old = r.vault.recovery.code;
  const res = await cloud.setPassphrase({ username: 'sis', oldToken: r.token, vault: r.vault, env: r.env, baseRev: r.env.rev, passphrase: 'quiet meadow amber kite', newRecoveryKey: true });
  assert.notEqual(res.recoveryKey, old);
  await rejects(cloud.recoverWithKey('sis', old), 'wrong_recovery_key');
  assert.equal((await cloud.recoverWithKey('sis', res.recoveryKey)).token, res.token);
  // Put it back for the next test.
  await cloud.setPassphrase({ username: 'sis', oldToken: res.token, vault: res.vault, env: res.env, baseRev: res.env.rev, passphrase: 'violet harbor sleepy comet' });
});
await test('a slow request made with the old key can’t undo a passphrase change', async () => {
  const r = await cloud.signIn('sis', 'violet harbor sleepy comet');
  const oldHash = (await env.DB.prepare('SELECT auth_hash FROM accounts WHERE username = ?').bind('sis').first()).auth_hash;
  const res = await cloud.setPassphrase({ username: 'sis', oldToken: r.token, vault: r.vault, env: r.env, baseRev: r.env.rev, passphrase: 'brand new words here ok' });
  // Simulate the race: an UPDATE authorised under the old hash arriving after the change.
  const stale = await env.DB.prepare('UPDATE accounts SET rev = 999 WHERE username = ? AND auth_hash = ?').bind('sis', oldHash).run();
  assert.equal(stale.meta.changes, 0);
  assert.equal((await cloud.signIn('sis', 'brand new words here ok')).token, res.token);
  await cloud.setPassphrase({ username: 'sis', oldToken: res.token, vault: res.vault, env: res.env, baseRev: res.env.rev, passphrase: 'violet harbor sleepy comet' });
});
await test('a malformed username escape is a clean 400', async () => {
  const r = await worker.fetch(new Request('https://money.test/api/v1/accounts/%E0%A4%A/kdf'), env);
  assert.equal(r.status, 400);
});
await test('a passphrase change that can’t re-wrap the key drops the stale recovery blob', async () => {
  const r = await cloud.signIn('sis', 'violet harbor sleepy comet');
  const access = await cloud.deriveAccess('another passphrase entirely', 'BBBBBBBBBBBBBBBBBBBBBB==', 600000);
  const next = await seal(access.session, { ...r.vault, sync: { ...r.vault.sync, token: access.token } }, r.env.rev + 1);
  await cloud.push('sis', r.token, next, r.env.rev, { newToken: access.token });
  assert.equal(await env.DB.prepare('SELECT * FROM recovery WHERE username = ?').bind('sis').first(), null);
});
await test('deleting an account removes it', async () => {
  await cloud.deleteAccount('brother', B.token);
  await rejects(cloud.pull('brother', B.token), 'unauthorized');
  const s = await cloud.signIn('sis', 'another passphrase entirely');
  await cloud.deleteAccount('sis', s.token);
  assert.equal(await env.DB.prepare('SELECT * FROM recovery WHERE username = ?').bind('sis').first(), null);
});

console.log('Bank sync (through a stand-in for Plaid)');
let C;
await test('off until the Plaid keys are set', async () => {
  C = await cloud.createAccount({ invite: 'family-2026', username: 'banker', passphrase: 'green kettle sunny window', vault: emptyVault() });
  assert.equal((await cloud.serverStatus()).bank, false);
  await rejects(cloud.bank('banker', C.token, 'link'), 'bank_not_configured');
  liveEnv = { ...env, PLAID_CLIENT_ID: 'test-client', PLAID_SECRET: 'test-secret', PLAID_ENV: 'sandbox' };
  assert.equal((await cloud.serverStatus()).bank, true);
});
await test('every bank call needs the account’s token', async () => {
  await rejects(cloud.bank('banker', 'not-the-token', 'link'), 'unauthorized');
  await rejects(cloud.bank('abraar', C.token, 'link'), 'unauthorized');
});
let link, access;
await test('connect: Plaid’s hosted page, then the access token comes back to the browser only', async () => {
  link = await cloud.bank('banker', C.token, 'link');
  assert.match(link.url, /\/hosted\/link-sandbox-/);
  const s = plaid.sessions.get(link.linkToken);
  assert.equal(s.redirect, 'https://money.test/bank-done.html');
  assert.deepEqual(s.products, ['transactions']);
  assert.notEqual(s.user.client_user_id, 'banker', 'Plaid never sees the username');
  assert.equal((await cloud.bank('banker', C.token, 'finish', { linkToken: link.linkToken })).status, 'pending');
  plaid.complete(link.linkToken);
  const r = await cloud.bank('banker', C.token, 'finish', { linkToken: link.linkToken });
  assert.equal(r.status, 'done');
  assert.match(r.accessToken, /^access-sandbox-/);
  assert.equal(r.institution, 'Sample Bank');
  assert.deepEqual(r.accounts.map((a) => a.id), ['acc-chq', 'acc-card', 'acc-loan']);
  assert.ok(!JSON.stringify(r).includes('mask') && !JSON.stringify(r).includes('0000'), 'no account numbers');
  access = r.accessToken;
  // Nothing about the bank is stored on the server.
  const rows = JSON.stringify([await env.DB.prepare('SELECT * FROM accounts WHERE username = ?').bind('banker').first()]);
  assert.ok(!rows.includes(access) && !rows.includes('Sample Bank'));
});
await test('leaving Plaid’s page without finishing', async () => {
  const l = await cloud.bank('banker', C.token, 'link');
  plaid.complete(l.linkToken, { exit: true });
  assert.equal((await cloud.bank('banker', C.token, 'finish', { linkToken: l.linkToken })).status, 'exited');
});
await test('sync: every page, one account, trimmed to what Money needs', async () => {
  for (let i = 0; i < 620; i++) plaid.state.txns.push(plaid.txn(`t${i}`, `2026-10-${String(1 + (i % 9)).padStart(2, '0')}`, 4.5, 'Coffee Spot', { pfc: 'FOOD_AND_DRINK_COFFEE' }));
  plaid.state.txns.push(plaid.txn('card1', '2026-10-03', 30, 'Card thing', { account: 'acc-card' }));
  plaid.state.mutateOnce = true; // the bank updates mid-way: start again from the same cursor
  const r = await cloud.bank('banker', C.token, 'sync', { accessToken: access, cursor: '', accountId: 'acc-chq' });
  assert.equal(r.added.length, 620);
  assert.equal(r.cursor, 'c621');
  assert.deepEqual(Object.keys(r.added[0]).sort(), ['account', 'amount', 'currency', 'date', 'id', 'merchant', 'name', 'original', 'pending', 'pfc']);
  assert.equal(r.added[0].pfc, 'FOOD_AND_DRINK_COFFEE');
  assert.equal(r.accounts.find((a) => a.id === 'acc-chq').current, 1500.25);
  const again = await cloud.bank('banker', C.token, 'sync', { accessToken: access, cursor: r.cursor, accountId: 'acc-chq' });
  assert.equal(again.added.length, 0);
});
await test('bank errors come back with Plaid’s code', async () => {
  plaid.state.loginRequired = true;
  try { await cloud.bank('banker', C.token, 'sync', { accessToken: access, cursor: 'c621' }); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'bank_error'); assert.equal(e.plaid, 'ITEM_LOGIN_REQUIRED'); }
  plaid.state.loginRequired = false;
  // Reconnecting ("update mode") uses the same access token.
  const l = await cloud.bank('banker', C.token, 'link', { accessToken: access });
  assert.equal(plaid.sessions.get(l.linkToken).update, true);
  plaid.complete(l.linkToken);
  assert.equal((await cloud.bank('banker', C.token, 'finish', { linkToken: l.linkToken, update: true })).status, 'done');
  await rejects(cloud.bank('banker', C.token, 'sync', { accessToken: 'not a token' }), 'bad_request');
});
await test('disconnect removes the connection at Plaid', async () => {
  await cloud.bank('banker', C.token, 'remove', { accessToken: access });
  try { await cloud.bank('banker', C.token, 'sync', { accessToken: access, cursor: '' }); assert.fail('should throw'); } catch (e) { assert.equal(e.plaid, 'INVALID_ACCESS_TOKEN'); }
  liveEnv = env;
});


console.log('Bank emails: Gmail sign-in (through a stand-in for Google)');
const gEnv = { GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: 'g-secret', GOOGLE_BASE: 'https://google.test' };
const pkcePair = async () => {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) };
};
// Google's page: the person says yes, and Google sends the browser to the callback with a code.
// The app asks for the link (the browser keeps the cookie that comes with it).
async function mailLink(user, token, challenge) {
  const r = await worker.fetch(new Request(`https://money.test/api/v1/accounts/${user}/mail/link`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) }), liveEnv);
  const cookie = (r.headers.get('Set-Cookie') || '').split(';')[0];
  return { ...(await r.json()), cookie, setCookie: r.headers.get('Set-Cookie') };
}
async function consent(authUrl, { scope, deny = false, cookie = '' } = {}) {
  const u = new URL(authUrl);
  const code = `4/test-code-${crypto.randomUUID()}`;
  google.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri'), scope });
  const back = new URL(u.searchParams.get('redirect_uri'));
  back.searchParams.set('state', u.searchParams.get('state'));
  if (deny) back.searchParams.set('error', 'access_denied'); else back.searchParams.set('code', code);
  return worker.fetch(new Request(back, { headers: cookie ? { Cookie: cookie } : {} }), liveEnv);
}
let G;
const KEY = await newMailKey();
const PUB = publicOf(KEY);
await test('off until the Google keys are set', async () => {
  G = await cloud.createAccount({ invite: 'family-2026', username: 'mailer', passphrase: 'blue lantern quiet meadow', vault: emptyVault() });
  assert.equal((await cloud.serverStatus()).mail, false);
  await rejects(cloud.mail('mailer', G.token, 'link', { challenge: 'x'.repeat(43) }), 'mail_not_configured');
  liveEnv = { ...env, ...gEnv };
  assert.equal((await cloud.serverStatus()).mail, true);
});
await test('every mail call needs the account’s token', async () => {
  await rejects(cloud.mail('mailer', 'not-the-token', 'link', { challenge: 'x'.repeat(43) }), 'unauthorized');
  await rejects(cloud.mail('abraar', G.token, 'inbox'), 'unauthorized');
});
await test('connect: Google’s page, read-only Gmail, PKCE; the sign-in is kept encrypted for the hourly check', async () => {
  const p = await pkcePair();
  const link = await mailLink('mailer', G.token, p.challenge);
  assert.match(link.setCookie, /^__Host-money-mail=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  const u = new URL(link.url);
  assert.equal(u.origin + u.pathname, 'https://google.test/auth');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://money.test/api/v1/mail/callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.ok(!link.url.includes('g-secret'));
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'pending');
  const back = await consent(link.url, { cookie: link.cookie });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), 'https://money.test/mail-done.html');
  // The waiting code is stored under a hash of the state, never the state itself.
  const row = await env.DB.prepare('SELECT * FROM mail_handoff').first();
  assert.ok(row && row.state_hash !== link.state && row.username === 'mailer');
  // Someone else's account, or the wrong verifier, gets nothing.
  const H = await cloud.createAccount({ invite: 'family-2026', username: 'snooper', passphrase: 'red teapot windy harbour', vault: emptyVault() });
  assert.equal((await cloud.mail('snooper', H.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'expired');
  const done = await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB });
  assert.deepEqual(done, { status: 'done' }, 'no token goes back out');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM mail_handoff').first().then((r) => r.n), 0, 'the one-time code is gone');
  const w = await env.DB.prepare('SELECT * FROM mail_watch WHERE username = ?').bind('mailer').first();
  const [refresh] = google.refresh;
  assert.ok(w && !JSON.stringify(w).includes(refresh) && !JSON.stringify(w).includes('test-refresh'), 'the Google sign-in is stored encrypted');
  assert.deepEqual(JSON.parse(w.pubkey), PUB);
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'expired', 'a code works once');
});
await test('a wrong PKCE verifier can’t turn the code into a token', async () => {
  const p = await pkcePair();
  const link = await mailLink('mailer', G.token, p.challenge);
  await consent(link.url, { cookie: link.cookie });
  const other = await pkcePair();
  await rejects(cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: other.verifier, publicKey: PUB }), 'mail_reconnect');
});
await test('saying no, or unticking Gmail, is reported (and the grant is revoked)', async () => {
  let p = await pkcePair();
  let link = await mailLink('mailer', G.token, p.challenge);
  const back = await consent(link.url, { deny: true, cookie: link.cookie });
  assert.equal(back.headers.get('Location'), 'https://money.test/mail-done.html?error=1');
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'exited');
  p = await pkcePair();
  link = await mailLink('mailer', G.token, p.challenge);
  await consent(link.url, { scope: 'openid', cookie: link.cookie });
  const before = google.revoked.length;
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'no_scope');
  assert.equal(google.revoked.length, before + 1);
});
await test('someone else’s sign-in link can’t collect your Gmail (the code only counts in the browser that asked)', async () => {
  // An account holder makes a link and sends it to someone; that person says yes in their own browser.
  const p = await pkcePair();
  const link = await mailLink('mailer', G.token, p.challenge);
  const back = await consent(link.url); // no cookie: a different browser
  assert.equal(back.headers.get('Location'), 'https://money.test/mail-done.html?error=1');
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: link.state, verifier: p.verifier, publicKey: PUB })).status, 'other_browser');
  // A cookie from another link doesn't count either.
  const p2 = await pkcePair();
  const l2 = await mailLink('mailer', G.token, p2.challenge);
  const l3 = await mailLink('snooper', (await cloud.signIn('snooper', 'red teapot windy harbour')).token, p2.challenge);
  await consent(l2.url, { cookie: l3.cookie });
  assert.equal((await cloud.mail('mailer', G.token, 'finish', { state: l2.state, verifier: p2.verifier, publicKey: PUB })).status, 'other_browser');
});
await test('a made-up state at the callback goes nowhere', async () => {
  const r = await worker.fetch(new Request(`https://money.test/api/v1/mail/callback?state=${'ab'.repeat(32)}&code=4/x`), liveEnv);
  assert.equal(r.headers.get('Location'), 'https://money.test/mail-done.html?error=1');
});
await test('a key that isn’t a public P-256 key is refused', async () => {
  await rejects(cloud.mail('mailer', G.token, 'finish', { state: 'ab'.repeat(32), verifier: 'x'.repeat(43), publicKey: { ...KEY } }), 'bad_request');
});
const D = 'Fri, 09 Oct 2026 12:10:00 -0400';
await test('check now: alert emails are sealed so only the account’s devices can read them', async () => {
  gmailMsg('m1', 'CIBC Alerts <alerts@notifications.cibc.com>', 'Transaction alert', D, '<p>A purchase of <b>$12.48</b> was made at <b>TIM HORTONS #4412</b> on October 9, 2026 with your CIBC Visa card ending in 1234.</p>',
    [{ mimeType: 'application/pdf', filename: 'ad.pdf', headers: [], body: { attachmentId: 'a1' } }]);
  gmailMsg('m2', 'CIBC <alerts@cibc.com>', 'Your verification code', D, '<p>Your one-time code is 482913.</p>');
  const r = await cloud.mail('mailer', G.token, 'check');
  assert.deepEqual([r.fetched, r.more, r.connected, r.problem, r.waiting], [2, false, true, null, 1]);
  assert.ok(r.lastCheck);
  const raw = await env.DB.prepare('SELECT box FROM mail_inbox').first();
  assert.ok(!/TIM HORTONS|Transaction alert|cibc/i.test(raw.box), 'nothing readable on the server');
  const inbox = await cloud.mail('mailer', G.token, 'inbox');
  assert.equal(inbox.items.length, 1);
  const msgs = await openBox(KEY, inbox.items[0].box);
  assert.equal(msgs.length, 2);
  assert.ok(!JSON.stringify(msgs).includes('ad.pdf') && !JSON.stringify(msgs).includes('Received'), 'no attachments or extra headers');
  const parsed = readMessages(msgs, { today: '2026-10-10' });
  const tim = parsed.find((p) => p.ok);
  assert.deepEqual([tim.amount, tim.merchant, tim.date, tim.bank], [-12.48, 'Tim Hortons', '2026-10-09', 'CIBC']);
  assert.equal(parsed.filter((p) => !p.ok).length, 1, 'the code email is read and dropped on the device');
  const other = await newMailKey();
  await assert.rejects(openBox(other, inbox.items[0].box), 'another key can’t open it');
  await cloud.mail('mailer', G.token, 'ack', { ids: inbox.items.map((x) => x.id) });
  assert.equal((await cloud.mail('mailer', G.token, 'inbox')).items.length, 0, 'deleted once collected');
});
await test('every hour: new alerts are fetched once, with the app closed', async () => {
  gmailMsg('m3', 'TD <alerts@td.com>', 'Purchase alert', D, '<p>You made a purchase of $46.10 at SHOPPERS DRUG MART on Oct 9, 2026 with your TD Visa card.</p>');
  const run = async () => { const jobs = []; await worker.scheduled({ cron: '17 * * * *' }, liveEnv, { waitUntil: (p) => jobs.push(p) }); await Promise.all(jobs); };
  gmailCalls.length = 0;
  await run();
  assert.deepEqual(gmailCalls.filter((c) => !c.endsWith('/messages')), ['/gmail/v1/users/me/messages/m3'], 'only the new email is fetched');
  const inbox = await cloud.mail('mailer', G.token, 'inbox');
  const msgs = await openBox(KEY, inbox.items[0].box);
  assert.deepEqual(msgs.map((m) => m.id), ['m3']);
  await cloud.mail('mailer', G.token, 'ack', { ids: inbox.items.map((x) => x.id) });
  await run();
  assert.equal((await cloud.mail('mailer', G.token, 'inbox')).items.length, 0, 'nothing new, nothing sealed');
  // Someone else's account sees none of it.
  await rejects(cloud.mail('snooper', (await cloud.signIn('snooper', 'red teapot windy harbour')).token, 'check'), 'mail_not_connected');
});
await test('a sign-in Google ended asks to reconnect; disconnecting revokes it and deletes everything', async () => {
  const [refresh] = google.refresh;
  google.refresh.delete(refresh);
  const r = await cloud.mail('mailer', G.token, 'check');
  assert.equal(r.problem, 'login');
  google.refresh.add(refresh);
  gmailMsg('m4', 'TD <alerts@td.com>', 'Purchase alert', D, '<p>You made a purchase of $5.00 at A&amp;W on Oct 9, 2026.</p>');
  await cloud.mail('mailer', G.token, 'check'); // leaves a sealed box waiting
  await cloud.mail('mailer', G.token, 'remove');
  assert.ok(google.revoked.includes(refresh));
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM mail_watch').first().then((x) => x.n), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM mail_inbox').first().then((x) => x.n), 0);
  liveEnv = env;
});

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
