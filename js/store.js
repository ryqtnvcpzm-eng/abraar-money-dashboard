// Where the encrypted vault lives:
//   • data/vault.enc.json in the repo (published copy, fetched on launch)
//   • an encrypted working copy in this browser's localStorage (so imports survive a reload and work offline)
// Plaintext never touches storage. The GitHub token (optional) is sealed with the vault key.
import { isEnvelope, sealString, openString } from './crypto.js';

export const VAULT_PATH = 'data/vault.enc.json';
const K = { local: 'money.vault', published: 'money.publishedRev', token: 'money.ghToken', gh: 'money.github', lockPref: 'money.autoLock' };

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export async function fetchRemote() {
  try {
    const r = await fetch(`${VAULT_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return isEnvelope(j) ? j : null;
  } catch {
    return null; // offline: the service worker may still answer from cache via the plain URL
  }
}
export async function fetchRemoteCached() {
  try {
    const r = await fetch(VAULT_PATH);
    if (!r.ok) return null;
    const j = await r.json();
    return isEnvelope(j) ? j : null;
  } catch { return null; }
}

export function loadLocal() {
  const s = ls.get(K.local);
  if (!s) return null;
  try { const j = JSON.parse(s); return isEnvelope(j) ? j : null; } catch { return null; }
}
export function saveLocal(env) { return ls.set(K.local, JSON.stringify(env)); }
export function clearLocal() { Object.values(K).forEach((k) => ls.del(k)); }

/** The rev last known to be in the repo (to show "unsaved changes"). */
export const publishedRev = () => Number(ls.get(K.published) || 0);
export const setPublishedRev = (rev) => ls.set(K.published, String(rev));

/** Pick the newest of the repo copy and the local working copy. */
export function chooseVault(remote, local) {
  if (remote && local) return local.rev > remote.rev ? { env: local, source: 'local' } : { env: remote, source: 'remote' };
  if (remote) return { env: remote, source: 'remote' };
  if (local) return { env: local, source: 'local' };
  return null;
}

// ---------- GitHub ----------
export function guessRepo() {
  const host = location.hostname;
  const m = /^([^.]+)\.github\.io$/i.exec(host);
  if (!m) return { owner: '', repo: '', branch: 'main' };
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && !seg.includes('.') ? seg : `${m[1]}.github.io`, branch: 'main' };
}
export function githubConfig() {
  try { return { ...guessRepo(), ...JSON.parse(ls.get(K.gh) || '{}') }; } catch { return guessRepo(); }
}
export function setGithubConfig(cfg) { ls.set(K.gh, JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main' })); }
export const hasToken = () => !!ls.get(K.token);
export async function setToken(session, token) {
  if (!token) { ls.del(K.token); return; }
  ls.set(K.token, JSON.stringify(await sealString(session, token)));
}
export async function getToken(session) {
  const s = ls.get(K.token);
  if (!s) return null;
  try { return await openString(session, JSON.parse(s)); } catch { return null; }
}

/** Commit the encrypted vault to the repo through the GitHub contents API. */
export async function pushToGitHub(session, env) {
  const cfg = githubConfig();
  const token = await getToken(session);
  if (!token) throw new Error('Add a GitHub token in Settings first.');
  if (!cfg.owner || !cfg.repo) throw new Error('Set the repository owner and name in Settings.');
  const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${VAULT_PATH}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  let sha;
  const cur = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: 'no-store' });
  if (cur.status === 200) sha = (await cur.json()).sha;
  else if (cur.status === 401 || cur.status === 403) throw new Error('GitHub refused the token. Check that it has Contents: read and write on this repository.');
  else if (cur.status !== 404) throw new Error(`GitHub error ${cur.status}`);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(env, null, 1) + '\n')));
  const res = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Update encrypted vault (rev ${env.rev})`, content, sha, branch: cfg.branch }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message ? `GitHub: ${j.message}` : `GitHub error ${res.status}`);
  }
  setPublishedRev(env.rev);
  return res.json();
}

/** Hand the encrypted file to the user: share sheet on iPhone (Save to Files), download elsewhere. */
export async function exportFile(env) {
  const text = JSON.stringify(env, null, 1) + '\n';
  const file = new File([text], 'vault.enc.json', { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: 'vault.enc.json' }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = 'vault.enc.json';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}
