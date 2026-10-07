// Shared app state. Lives only in memory; cleared on lock.
export const app = {
  rules: null,      // compiled data/rules.json
  env: null,        // encrypted envelope (safe to keep while locked)
  session: null,    // { key: CryptoKey (non-extractable), salt, iterations }
  vault: null,      // decrypted vault — only while unlocked
  model: null,      // derived numbers for the UI
  demo: false,
  tab: 'overview',
  stale: new Set(),
  ui: { range: 'ALL', month: null, mode: 'everyday', search: '', filter: 'all', planMonth: null },
};
