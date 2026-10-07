// Add Statement: read CIBC PDFs on this device with pdf.js, reconcile, dedupe, categorize, then encrypt.
import { app } from '../state.js';
import { money, monthLabel, esc, plural } from '../format.js';
import { parseCibcStatement } from '../cibc-parser.js';
import { pdfToPages } from '../pdf-text.js';
import { prepareImport, commitImport } from '../ledger.js';
import { icon, openSheet, haptic, toast } from '../ui.js';

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export function openImporter({ welcome = false } = {}) {
  const items = []; // { name, status, error, parsed, prep, include }
  let done = null;
  const sheet = openSheet({ title: 'Add Statements', size: 'full', body: '' });

  const draw = () => {
    if (done) {
      sheet.setBody(`
        <div class="sheet-hero" style="padding-top:24px">
          <span class="cat-icon lg" style="--c:var(--green)">${icon('check')}</span>
          <div class="name">Added ${plural(done.statements, 'statement')}</div>
          <div class="when">${plural(done.txns, 'transaction')} · encrypted on this device</div>
        </div>
        ${app.demo ? '<p class="list-foot" style="text-align:center">Sample mode: nothing is saved.</p>' : `
        <p class="list-foot" style="margin-bottom:12px">Your repo still has the old file. Save the updated encrypted vault so your other devices get it.</p>
        <div class="btn-row">
          <button class="btn" data-act="push">${icon('github')} Save to GitHub</button>
          <button class="btn secondary" data-act="export">${icon('share')} Export Vault File</button>
          <button class="btn plain" data-close>Later</button>
        </div>`}`);
      return;
    }
    const ready = items.filter((i) => i.status === 'ready' && i.include);
    sheet.setBody(`
      ${!items.length ? `
        <div class="sheet-hero" style="padding-top:18px">
          <span class="cat-icon lg" style="--c:var(--blue)">${icon('doc')}</span>
          <div class="name">${welcome ? 'Welcome! Add your statements' : 'Add CIBC Statements'}</div>
          <p class="when" style="max-width:340px;margin:8px auto 0">Choose one or more PDF statements. They’re read right here on your device. Nothing is uploaded, and the PDF itself isn’t kept.</p>
        </div>` : ''}
      <label class="btn ${items.length ? 'secondary' : ''}" style="margin-top:8px">
        ${icon('plus')} ${items.length ? 'Choose More PDFs' : 'Choose PDFs'}
        <input type="file" accept="application/pdf,.pdf" multiple hidden id="imp-file">
      </label>
      <div id="imp-items">${items.map((it, i) => [it, i]).sort((a, b) => (a[0].prep?.id || '9999').localeCompare(b[0].prep?.id || '9999')).map(([it, i]) => card(it, i)).join('')}</div>
      ${items.length ? `<div class="btn-row" style="position:sticky;bottom:0;padding:12px 0 4px;background:linear-gradient(transparent,var(--sheet-bg) 30%)">
        <button class="btn" data-act="commit" ${ready.length ? '' : 'disabled'}>${ready.length ? `Add ${plural(ready.length, 'Statement')}` : 'Nothing to add yet'}</button></div>` : ''}
      <p class="list-foot">Each statement is checked: opening balance + deposits − withdrawals must equal the closing balance, and totals must match the bank’s summary. Reversals and waived fees are netted out automatically.</p>`);
  };

  const card = (it, i) => {
    if (it.status === 'reading') return `<div class="list" style="margin-top:14px"><div class="row"><span class="spinner dark"></span><span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle">Reading…</span></span></div></div>`;
    if (it.status === 'error') return `<div class="list" style="margin-top:14px"><div class="row with-icon"><span class="cat-icon sm" style="--c:var(--red)">${icon('warn')}</span><span class="main"><span class="title">${esc(it.name)}</span><span class="subtitle" style="white-space:normal">${esc(it.error)}</span></span></div></div>`;
    const p = it.prep;
    const rec = p.reconciliation;
    const chip = rec.ok ? '<span class="chip ok">Reconciled</span>' : '<span class="chip bad">Doesn’t match</span>';
    const find = (label) => rec.checks.find((c) => c.label === label);
    const line = (label, stmt, found, ok) => `<div class="row"><span class="main"><span class="title">${label}</span></span>
      <span class="value-sub" style="text-align:right">${stmt != null ? money(stmt) : '—'}${found != null && ok === false ? `<br><span class="neg">found ${money(found)}</span>` : ''}</span>
      <span style="color:var(--${ok === false ? 'red' : ok ? 'green' : 'gray'});width:20px">${icon(ok === false ? 'close' : ok ? 'check' : 'ellipsis')}</span></div>`;
    return `<div class="list-head"><span>${esc(p.label)}</span>${chip}</div>
      <div class="list">
        ${line('Opening balance', p.opening, null, p.opening != null ? true : null)}
        ${line('Withdrawals', p.summaryTotals.withdrawals, find('Withdrawals')?.computed, find('Withdrawals')?.ok)}
        ${line('Deposits', p.summaryTotals.deposits, find('Deposits')?.computed, find('Deposits')?.ok)}
        ${line('Closing balance', p.closing, find('Closing balance')?.computed, find('Closing balance')?.ok)}
        <div class="row"><span class="main"><span class="title">${plural(p.transactions.length, 'transaction')}</span>
          <span class="subtitle">${p.duplicates ? `${plural(p.duplicates, 'duplicate')} skipped · ` : ''}${esc(it.name)}</span></span></div>
        ${rec.issues.map((x) => `<div class="row"><span class="main"><span class="subtitle neg" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
        ${p.warnings.slice(0, 3).map((x) => `<div class="row"><span class="main"><span class="subtitle" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
        ${p.alreadyImported ? toggle(i, 'Replace the existing statement', 'Already imported. Replacing keeps your category changes.', it.include) : ''}
        ${!rec.ok && !p.alreadyImported ? toggle(i, 'Import anyway', 'It will be flagged until it reconciles.', it.include) : ''}
      </div>`;
  };
  const toggle = (i, title, sub, on) => `<label class="row"><span class="main"><span class="title">${title}</span><span class="subtitle" style="white-space:normal">${sub}</span></span>
    <span class="switch"><input type="checkbox" data-include="${i}" ${on ? 'checked' : ''} aria-label="${esc(title)}"><span></span></span></label>`;

  // Prepare each file against a working copy, so files in the same batch are de-duplicated against each other too.
  const working = () => {
    const v = structuredClone(app.vault);
    for (const it of items) if (it.status === 'ready' && it.include) commitImport(v, it.prep);
    return v;
  };

  async function addFiles(files) {
    const list = [...files].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!list.length) return;
    const lib = await loadPdfjs().catch(() => null);
    for (const f of list) {
      const it = { name: f.name, status: 'reading', include: true };
      items.push(it);
      draw();
      if (!lib) { Object.assign(it, { status: 'error', error: 'Couldn’t load the PDF reader. Connect to the internet once so it can be cached.' }); continue; }
      try {
        const pages = await pdfToPages(lib, new Uint8Array(await f.arrayBuffer()));
        const parsed = parseCibcStatement(pages);
        if (!parsed.period) throw new Error('Couldn’t find a statement period. Is this a CIBC account statement?');
        if (!parsed.transactions.length) throw new Error('No transactions found in this PDF.');
        const prep = prepareImport(working(), parsed, app.rules);
        prep.alreadyImported = app.vault.statements.some((s) => s.id === prep.id);
        if (items.some((x) => x !== it && x.prep?.id === prep.id)) throw new Error(`${monthLabel(prep.id)} is already in this batch.`);
        Object.assign(it, { status: 'ready', parsed, prep, include: prep.reconciliation.ok || prep.alreadyImported });
        if (prep.alreadyImported && !prep.reconciliation.ok) it.include = false;
        haptic(prep.reconciliation.ok ? 'light' : 'error');
      } catch (e) {
        const msg = e?.name === 'PasswordException' ? 'This PDF is password-protected. Open it once and save an unprotected copy.' : (e?.message || 'Couldn’t read this PDF.');
        Object.assign(it, { status: 'error', error: msg });
      }
      draw();
    }
  }

  draw();
  sheet.el.addEventListener('change', (e) => {
    if (e.target.id === 'imp-file') { addFiles(e.target.files); e.target.value = ''; }
    if (e.target.dataset.include != null) { haptic(); items[+e.target.dataset.include].include = e.target.checked; draw(); }
  });
  sheet.el.addEventListener('dragover', (e) => { e.preventDefault(); });
  sheet.el.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  sheet.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'commit') {
      haptic('heavy');
      const chosen = items.filter((i) => i.status === 'ready' && i.include);
      let n = 0;
      for (const it of chosen) {
        // re-prepare against the live vault so duplicate checks reflect exactly what's being added
        const prep = prepareImport(app.vault, it.parsed, app.rules);
        commitImport(app.vault, prep);
        n += prep.transactions.length;
      }
      await app.commit({ silent: true });
      done = { statements: chosen.length, txns: n };
      draw();
      toast(`Added ${plural(chosen.length, 'statement')}`);
    }
    if (act === 'push') { const s = await import('./settings.js'); await s.saveToRepo(); sheet.close(); }
    if (act === 'export') { const s = await import('./settings.js'); await s.exportVault(); }
  });
}
