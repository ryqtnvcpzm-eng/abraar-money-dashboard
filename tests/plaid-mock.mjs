// A small stand-in for Plaid's API (only what bank sync uses), for tests and local end-to-end runs.
// Made-up institutions, accounts and transactions; no real data.
export function plaidMock({ base = 'https://sandbox.plaid.com', clientId = 'test-client', secret = 'test-secret' } = {}) {
  const sessions = new Map(); // link_token -> { update, redirect, done, exit, public_token }
  const items = new Map(); // access_token -> { removed }
  const publicTokens = new Map(); // public_token -> link_token
  const state = {
    txns: [], // Plaid-shaped transactions, oldest first
    pending: { modified: [], removed: [] },
    mutateOnce: false,
    loginRequired: false,
    calls: [],
  };
  const accounts = () => [
    { account_id: 'acc-chq', balances: { current: 1500.25, available: 1450.25, limit: null, iso_currency_code: 'CAD', unofficial_currency_code: null }, mask: '0000', name: 'Chequing', official_name: 'Sample Everyday Chequing', type: 'depository', subtype: 'checking' },
    { account_id: 'acc-card', balances: { current: 220.4, available: 1779.6, limit: 2000, iso_currency_code: 'CAD', unofficial_currency_code: null }, mask: '1111', name: 'Card', official_name: 'Sample Rewards Card', type: 'credit', subtype: 'credit card' },
    { account_id: 'acc-loan', balances: { current: 9000, available: null, limit: null, iso_currency_code: 'CAD', unofficial_currency_code: null }, mask: '2222', name: 'Loan', official_name: null, type: 'loan', subtype: 'student' },
  ];
  const fail = (status, code, message) => ({ status, body: { error_type: 'API_ERROR', error_code: code, error_message: message, display_message: null } });

  function handle(path, b) {
    state.calls.push(path);
    if (b.client_id !== clientId || b.secret !== secret) return fail(400, 'INVALID_API_KEYS', 'invalid client_id or secret provided');
    if (path === '/link/token/create') {
      const token = `link-sandbox-${crypto.randomUUID()}`;
      sessions.set(token, { update: !!b.access_token, redirect: b.hosted_link?.completion_redirect_uri || null, done: false, exit: false, products: b.products, countries: b.country_codes, user: b.user });
      return { status: 200, body: { link_token: token, expiration: new Date(Date.now() + 1800e3).toISOString(), hosted_link_url: `${base}/hosted/${token}`, request_id: 'r' } };
    }
    if (path === '/link/token/get') {
      const s = sessions.get(b.link_token);
      if (!s) return fail(400, 'INVALID_LINK_TOKEN', 'link token not found');
      const link_sessions = [];
      if (s.done) {
        const institution = { name: 'Sample Bank', institution_id: 'ins_sample' };
        const accts = accounts().map((a) => ({ id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype }));
        link_sessions.push({ link_session_id: 'ls-1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
          on_success: { public_token: s.public_token, metadata: { institution, accounts: accts } },
          results: { item_add_results: s.update ? [] : [{ public_token: s.public_token, accounts: accts, institution }] } });
      } else if (s.exit) {
        link_sessions.push({ link_session_id: 'ls-1', exit: { error: null, metadata: { status: 'requires_credentials' } } });
      }
      return { status: 200, body: { link_token: b.link_token, created_at: '', expiration: '', link_sessions, metadata: {}, request_id: 'r' } };
    }
    if (path === '/item/public_token/exchange') {
      if (!publicTokens.has(b.public_token)) return fail(400, 'INVALID_PUBLIC_TOKEN', 'bad public token');
      const access = `access-sandbox-${crypto.randomUUID()}`;
      items.set(access, { removed: false });
      return { status: 200, body: { access_token: access, item_id: 'item-1', request_id: 'r' } };
    }
    const item = items.get(b.access_token);
    if (!item || item.removed) return fail(400, 'INVALID_ACCESS_TOKEN', 'bad access token');
    if (path === '/accounts/get') return { status: 200, body: { accounts: accounts(), item: { institution_name: 'Sample Bank' }, request_id: 'r' } };
    if (path === '/item/remove') { item.removed = true; return { status: 200, body: { request_id: 'r' } }; }
    if (path === '/transactions/sync') {
      if (state.loginRequired) return fail(400, 'ITEM_LOGIN_REQUIRED', 'the login details of this item have changed');
      if (state.mutateOnce && b.cursor) { state.mutateOnce = false; return fail(400, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'mutation'); }
      const from = b.cursor ? Number(String(b.cursor).slice(1)) : 0;
      const count = b.count || 100;
      const added = state.txns.slice(from, from + count).map((t) => (b.options?.include_original_description ? t : { ...t, original_description: null }));
      const next = from + added.length;
      const has_more = next < state.txns.length;
      let modified = [], removed = [];
      if (!has_more) { modified = state.pending.modified; removed = state.pending.removed; state.pending = { modified: [], removed: [] }; }
      return { status: 200, body: { added, modified, removed, next_cursor: `c${next}`, has_more, accounts: accounts(), transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE', request_id: 'r' } };
    }
    return fail(404, 'NOT_FOUND', `no mock for ${path}`);
  }

  /** The person finishes (or leaves) Plaid's hosted page. */
  function complete(linkToken, { exit = false } = {}) {
    const s = sessions.get(linkToken);
    if (!s) return null;
    if (exit) { s.exit = true; return s; }
    s.done = true;
    s.public_token = `public-sandbox-${crypto.randomUUID()}`;
    publicTokens.set(s.public_token, linkToken);
    return s;
  }

  /** A Plaid-shaped transaction (amount positive = money out, as Plaid sends it). */
  const txn = (id, date, amount, name, extra = {}) => ({
    transaction_id: id, account_id: 'acc-chq', date, amount, iso_currency_code: 'CAD', unofficial_currency_code: null,
    name, merchant_name: extra.merchant ?? null, original_description: extra.original ?? name.toUpperCase(), pending: !!extra.pending,
    personal_finance_category: extra.pfc ? { primary: extra.pfc.split('_').slice(0, 2).join('_'), detailed: extra.pfc, confidence_level: 'HIGH' } : null,
    ...(extra.account ? { account_id: extra.account } : {}),
  });

  return { handle, complete, state, sessions, txn, base };
}
