// Add Statements: read statement files from any bank on this device, reconcile, dedupe, categorize, then encrypt.
// PDFs go through pdf.js; CSV / OFX / QFX / QIF downloads are read as text. Nothing is uploaded.
import { app } from '../state.js';
import { money, monthLabel, dateLabel, esc, plural } from '../format.js';
import { loadFile, parseLoaded, ACCEPT, isStatementFile, describeSource } from '../statements.js';
import { prepareImport, commitImport } from '../ledger.js';
import { icon, openSheet, haptic, toast } from '../ui.js';
import { statusChip } from './settings.js';

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export function openImporter({ welcome = false } = {}) {
  // files: { name, status: 'reading'|'ready'|'error', error, loaded, options, statements: [{ parsed, prep, include, touched }] }
  const files = [];
  let done = null;
  const sheet = openSheet({ title: 'Add Statements', size: 'full', body: '' });
  const statements = () => files.flatMap((f, fi) => (f.status === 'ready' ? f.statements.map((s, si) => ({ ...s, f, fi, si })) : []));

  const reconcileOf = (x) => x.f.statements[x.si].parsed && x.f.statements[x.si].prep?.reconciliation?.ok;
  const covers = (a, b) => a && b && a.start <= b.start && a.end >= b.end;
  /** Re-check every statement against the vault and against each other (duplicates across files). */
  function prepareAll() {
    const work = structuredClone(app.vault);
    // Per month, a statement that reconciles goes first, so it's the one kept when two files cover it.
    const score = (x) => (x.f.statements[x.si].include === false && x.f.statements[x.si].touched ? 2 : 0) + (reconcileOf(x) === true ? 0 : 1);
    const list = statements().sort((a, b) => (a.parsed.period.end.slice(0, 7) < b.parsed.period.end.slice(0, 7) ? -1 : a.parsed.period.end.slice(0, 7) > b.parsed.period.end.slice(0, 7) ? 1 : score(a) - score(b)));
    const seen = new Set(); // statements already added to the working copy
    for (const s of list) {
      const st = s.f.statements[s.si];
      const prep = prepareImport(work, st.parsed, app.rules);
      prep.alreadyImported = app.vault.statements.some((x) => x.id === prep.id);
      // Two files for the same dates (a PDF and a CSV of one month): keep one. Overlapping parts of a month merge.
      prep.sameBatch = list.some((o) => o !== s && seen.has(o) && o.f.statements[o.si].prep?.id === prep.id && covers(o.parsed.period, prep.period));
      st.prep = prep;
      if (!st.touched) {
        const ok = prep.reconciliation.ok;
        const existing = app.vault.statements.find((x) => x.id === prep.id);
        // Re-adding a month only replaces the dates this file covers. Don't let a thinner copy of the same
        // dates replace a fuller one by default (the person can still switch it on).
        const thinner = existing && covers(prep.period, existing) && prep.parsedCount < existing.count;
        st.include = !prep.sameBatch && ok !== false && !thinner;
      }
      if (st.include && !prep.sameBatch) { commitImport(work, prep); seen.add(s); }
    }
  }

  const draw = () => {
    if (done) {
      sheet.setBody(`
        <div class="sheet-hero" style="padding-top:24px">
          <span class="cat-icon lg" style="--c:var(--green)">${icon('check')}</span>
          <div class="name">Added ${plural(done.statements, 'statement')}</div>
          <div class="when">${plural(done.txns, 'transaction')} · encrypted on this device</div>
        </div>
        ${done.unknown ? `<div class="card" style="margin:6px 0 16px;text-align:center">
          <div style="font:600 17px/1.3 var(--font)">${plural(done.unknown, 'place')} ${done.unknown === 1 ? 'needs' : 'need'} a category</div>
          <p class="list-foot" style="margin:4px 0 12px">Money didn’t recognise ${done.unknown === 1 ? 'it' : 'them'}. Pick once and it’s remembered.</p>
          <button class="btn" data-act="teach">Categorize Now</button></div>` : ''}
        ${app.demo ? '<p class="list-foot" style="text-align:center">Sample mode: nothing is saved.</p>' : app.account ? `
        <p class="list-foot" style="text-align:center;margin-bottom:12px">Syncing to @${esc(app.account)}, so your other devices get it automatically.</p>
        <div class="btn-row"><button class="btn" data-close>Done</button></div>` : `
        <p class="list-foot" style="margin-bottom:12px">Your repo still has the old file. Save the updated encrypted vault so your other devices get it.</p>
        <div class="btn-row">
          <button class="btn" data-act="push">${icon('github')} Save to GitHub</button>
          <button class="btn secondary" data-act="export">${icon('share')} Export Vault File</button>
          <button class="btn plain" data-close>Later</button>
        </div>`}`);
      return;
    }
    const all = statements().sort((a, b) => (a.prep?.id || '').localeCompare(b.prep?.id || ''));
    const ready = all.filter((s) => s.include && !s.prep.sameBatch);
    const pendingOrErr = files.filter((f) => f.status !== 'ready');
    sheet.setBody(`
      ${!files.length ? `
        <div class="sheet-hero" style="padding-top:18px">
          <span class="cat-icon lg" style="--c:var(--blue)">${icon('doc')}</span>
          <div class="name">${welcome ? 'Welcome! Add your statements' : 'Add Statements'}</div>
          <p class="when" style="max-width:350px;margin:8px auto 0">PDF statements from any bank, or the CSV, OFX or QIF file your online banking lets you download. They’re read right here on your device. Nothing is uploaded, and the file itself isn’t kept.</p>
        </div>` : ''}
      <label class="btn ${files.length ? 'secondary' : ''}" style="margin-top:8px">
        ${icon('plus')} ${files.length ? 'Choose More Files' : 'Choose Files'}
        <input type="file" accept="${ACCEPT}" multiple hidden id="imp-file">
      </label>
      ${!files.length ? `<div class="list-head"><span>Other ways to add</span></div>
      <div class="list">
        <button class="row with-icon tap" data-act="bank"><span class="cat-icon sm" style="--c:var(--blue)">${icon('arrows')}</span>
          <span class="main"><span class="title">${app.vault.bank?.accessToken ? 'Sync From Your Bank' : 'Connect Your Bank'}</span><span class="subtitle">${app.vault.bank?.accessToken ? `${esc(app.vault.bank.institution || 'Connected')} · new transactions come in on their own` : 'New transactions come in on their own'}</span></span>${icon('chev-r', 'chev')}</button>
        <button class="row with-icon tap" data-act="amazon"><span class="cat-icon sm" style="--c:var(--orange)">${icon('box')}</span>
          <span class="main"><span class="title">Amazon Orders</span><span class="subtitle">See what each Amazon charge bought</span></span>${icon('chev-r', 'chev')}</button>
      </div>` : ''}
      ${pendingOrErr.map(fileCard).join('')}
      <div id="imp-items">${all.map(card).join('')}</div>
      ${all.length ? `<div class="btn-row" style="position:sticky;bottom:0;padding:12px 0 4px;background:linear-gradient(transparent,var(--sheet-bg) 30%)">
        <button class="btn" data-act="commit" ${ready.length ? '' : 'disabled'}>${ready.length ? `Add ${plural(ready.length, 'Statement')}` : 'Nothing to add yet'}</button></div>` : ''}
      <p class="list-foot">Each statement is checked: opening balance + deposits − withdrawals must equal the closing balance, and every running balance must add up. Money in and out is read from the columns, signs and balances. Reversals and waived fees are netted out automatically.</p>`);
  };

  const fileCard = (f) => {
    if (f.status === 'reading') return `<div class="list" style="margin-top:14px"><div class="row"><span class="spinner dark"></span><span class="main"><span class="title">${esc(f.name)}</span><span class="subtitle">Reading…</span></span></div></div>`;
    return `<div class="list" style="margin-top:14px"><div class="row with-icon"><span class="cat-icon sm" style="--c:var(--red)">${icon('warn')}</span><span class="main"><span class="title">${esc(f.name)}</span><span class="subtitle" style="white-space:normal">${esc(f.error)}</span></span></div></div>`;
  };

  const card = (s) => {
    const p = s.prep;
    const rec = p.reconciliation;
    const meta = p.meta || {};
    const key = `${s.fi}:${s.si}`;
    const find = (label) => rec.checks.find((c) => c.label === label);
    const line = (label, stmt, found, ok) => `<div class="row"><span class="main"><span class="title">${label}</span></span>
      <span class="value-sub" style="text-align:right">${stmt != null ? money(stmt) : found != null ? money(found) : '—'}${found != null && ok === false ? `<br><span class="neg">found ${money(found)}</span>` : ''}</span>
      <span style="color:var(--${ok === false ? 'red' : ok ? 'green' : 'gray'});width:20px">${icon(ok === false ? 'close' : ok ? 'check' : 'ellipsis')}</span></div>`;
    const notes = [];
    if (meta.partial) notes.push(`Covers ${dateLabel(p.period.start, 'short')} – ${dateLabel(p.period.end, 'short')} only.`);
    if (meta.unverified && !meta.derivedBalances) notes.push('This file has no balances, so it can’t be checked against the bank. Glance over the transactions before adding.');
    if (meta.derivedBalances) notes.push('Balances worked out from the end balance in the file.');
    if (meta.signSource === 'keywords' && !rec.ok) notes.push('Money in vs out was worked out from the descriptions. Check a few in Review.');
    if (meta.dateOrderCertain === false) notes.push(`Dates read as ${meta.dateOrder === 'mdy' ? 'month/day' : 'day/month'}. Change it in Review if that’s wrong.`);
    if (p.sameBatch) notes.push(`${monthLabel(p.id)} is already in this batch from another file.`);
    return `<div class="list-head"><span>${esc(p.label)}</span>${statusChip(rec.ok)}</div>
      <div class="list">
        <div class="row"><span class="main"><span class="title">${esc(describeSource(meta))}</span><span class="subtitle">${esc(s.f.name)}</span></span></div>
        ${line('Opening balance', p.opening, null, p.opening != null ? true : null)}
        ${line('Withdrawals', p.summaryTotals?.withdrawals, find('Withdrawals')?.computed, find('Withdrawals')?.ok)}
        ${line('Deposits', p.summaryTotals?.deposits, find('Deposits')?.computed, find('Deposits')?.ok)}
        ${line('Closing balance', p.closing, find('Closing balance')?.computed, find('Closing balance')?.ok)}
        <button class="row tap" data-review="${key}"><span class="main"><span class="title">Review ${plural(p.transactions.length, 'transaction')}</span>
          <span class="subtitle">${p.duplicates ? `${plural(p.duplicates, 'duplicate')} skipped` : 'Dates, descriptions and amounts'}</span></span>${icon('chev-r', 'chev')}</button>
        ${notes.map((x) => `<div class="row"><span class="main"><span class="subtitle" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
        ${rec.issues.slice(0, 4).map((x) => `<div class="row"><span class="main"><span class="subtitle neg" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
        ${(p.warnings || []).slice(0, 2).map((x) => `<div class="row"><span class="main"><span class="subtitle" style="white-space:normal">${esc(x)}</span></span></div>`).join('')}
        ${p.sameBatch ? '' : p.alreadyImported ? toggle(key, 'Update this month', 'Already imported. Updates the dates this file covers and keeps your category changes.', s.include)
          : rec.ok === false ? toggle(key, 'Import anyway', 'It will be flagged until it reconciles.', s.include)
          : toggle(key, 'Include', rec.ok ? 'Checked against the bank’s balances.' : 'Not checked: no balances in the file.', s.include)}
      </div>`;
  };
  const toggle = (key, title, sub, on) => `<label class="row"><span class="main"><span class="title">${title}</span><span class="subtitle" style="white-space:normal">${sub}</span></span>
    <span class="switch"><input type="checkbox" data-include="${key}" ${on ? 'checked' : ''} aria-label="${esc(title)}"><span></span></span></label>`;

  function parseFile(f) {
    const parsed = parseLoaded(f.loaded, f.options);
    const prev = f.statements || [];
    f.statements = parsed.map((p) => {
      const old = prev.find((x) => x.parsed.period.end.slice(0, 7) === p.period.end.slice(0, 7));
      return { parsed: p, prep: null, include: old?.include ?? true, touched: old?.touched ?? false };
    });
    f.status = 'ready';
  }

  async function addFiles(picked) {
    // Copy now: the picker's FileList is emptied as soon as this returns to the event loop.
    let list = [...picked];
    // Amazon's order history (its zip, or the CSV inside) sorts Amazon charges rather than adding a statement.
    const amazonFiles = [];
    for (const f of list) {
      if (/\.zip$/i.test(f.name) || /zip/i.test(f.type || '')) amazonFiles.push(f);
      else if (/\.csv$/i.test(f.name) && /order id|order date/i.test(await f.slice(0, 2000).text())) amazonFiles.push(f);
    }
    if (amazonFiles.length) {
      try {
        const r = await (await import('./amazon-import.js')).importAmazonFiles(amazonFiles);
        toast(r.matched ? `Sorted ${plural(r.matched, 'Amazon charge')}` : 'Amazon orders saved', { icon: 'box', color: 'orange' });
      } catch (e) { toast(e?.message || 'Couldn’t read the Amazon file', { icon: 'warn', color: 'orange' }); }
      list = list.filter((f) => !amazonFiles.includes(f));
      if (!list.length) return;
    }
    const chosen = list.filter(isStatementFile);
    if (!chosen.length) { toast('Choose PDF, CSV, OFX or QIF files', { icon: 'warn', color: 'orange' }); return; }
    const needsPdf = chosen.some((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    const lib = needsPdf ? await loadPdfjs().catch(() => null) : null;
    for (const file of chosen) {
      const f = { name: file.name, status: 'reading', options: {} };
      files.push(f);
      draw();
      try {
        f.loaded = await loadFile({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, { pdfjs: lib });
        parseFile(f);
        prepareAll();
        haptic(f.statements.every((s) => s.prep.reconciliation.ok !== false) ? 'light' : 'error');
      } catch (e) {
        Object.assign(f, { status: 'error', error: e?.message || 'Couldn’t read this file.' });
        haptic('error');
      }
      draw();
    }
  }

  function openReview(fi, si) {
    const f = files[fi];
    const rs = openSheet({ title: 'Review', size: 'full', body: '' });
    const render = () => {
      const s = f.statements[si] || f.statements[0];
      const p = s.prep;
      const meta = p.meta || {};
      const signsProven = p.reconciliation.ok === true && meta.signSource !== 'keywords';
      rs.setTitle(p.label);
      rs.setBody(`
        ${!signsProven || meta.dateOrderCertain === false || f.options.dateOrder ? `<div class="list-head"><span>If something looks off</span></div><div class="list">
          ${!signsProven ? `<label class="row"><span class="main"><span class="title">Swap money in and out</span><span class="subtitle" style="white-space:normal">Use this if purchases show as money in.</span></span>
            <span class="switch"><input type="checkbox" data-opt="flip" ${f.options.flip ? 'checked' : ''} aria-label="Swap money in and out"><span></span></span></label>` : ''}
          ${meta.dateOrderCertain === false || f.options.dateOrder ? `<label class="row"><span class="main"><span class="title">Month comes first</span><span class="subtitle" style="white-space:normal">For dates like 03/04 meaning March 4. Off means 3 April.</span></span>
            <span class="switch"><input type="checkbox" data-opt="mdy" ${meta.dateOrder === 'mdy' ? 'checked' : ''} aria-label="Month comes first"><span></span></span></label>` : ''}
        </div>` : ''}
        <div class="list-head"><span>${plural(p.transactions.length, 'transaction')}</span><span>${statusChip(p.reconciliation.ok)}</span></div>
        <div class="list">${p.transactions.map((t) => { const c = app.rules.cats.get(t.category); return `<div class="row with-icon">${c ? `<span class="cat-icon sm" style="--c:var(--${esc(c.color)})">${icon(c.icon)}</span>` : ''}<span class="main"><span class="title">${esc(t.name || t.merchant)}</span>
          <span class="subtitle">${esc(dateLabel(t.date, 'medium'))} · ${t.category === 'other' && t.amount < 0 ? 'Needs a category' : esc(c?.name || 'Other')}</span></span>
          <span class="detail num ${t.amount > 0 ? 'pos' : ''}">${money(t.amount, { sign: true })}</span></div>`; }).join('')}</div>
        <p class="list-foot">${signsProven ? 'Money in and out is confirmed by the running balance.' : 'Money in shows in green with a +.'} Nothing is saved until you tap Add.</p>`);
    };
    render();
    rs.el.addEventListener('change', (e) => {
      const opt = e.target.dataset.opt;
      if (!opt) return;
      haptic();
      if (opt === 'flip') f.options = { ...f.options, flip: e.target.checked };
      if (opt === 'mdy') f.options = { ...f.options, dateOrder: e.target.checked ? 'mdy' : 'dmy' };
      try { parseFile(f); prepareAll(); } catch (ex) { toast(ex.message || 'Couldn’t re-read the file', { icon: 'warn', color: 'orange' }); }
      render();
      draw();
    });
  }

  draw();
  sheet.el.addEventListener('change', (e) => {
    if (e.target.id === 'imp-file') { addFiles(e.target.files); e.target.value = ''; }
    if (e.target.dataset.include != null) {
      haptic();
      const [fi, si] = e.target.dataset.include.split(':').map(Number);
      Object.assign(files[fi].statements[si], { include: e.target.checked, touched: true });
      prepareAll();
      draw();
    }
  });
  sheet.el.addEventListener('dragover', (e) => { e.preventDefault(); });
  sheet.el.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  sheet.el.addEventListener('click', async (e) => {
    const rev = e.target.closest('[data-review]');
    if (rev) { haptic(); const [fi, si] = rev.dataset.review.split(':').map(Number); openReview(fi, si); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'commit') {
      haptic('heavy');
      const chosen = statements().filter((s) => s.include && !s.prep.sameBatch).sort((a, b) => (a.parsed.period.end < b.parsed.period.end ? -1 : 1));
      let n = 0;
      for (const s of chosen) {
        // re-prepare against the live vault so duplicate checks reflect exactly what's being added
        const prep = prepareImport(app.vault, s.parsed, app.rules);
        commitImport(app.vault, prep);
        n += prep.transactions.length;
      }
      // Amazon orders added earlier find their charges in the new statements.
      if (app.vault.orders?.length) (await import('../amazon.js')).matchWaiting(app.vault);
      await app.commit({ silent: true });
      done = { statements: chosen.length, txns: n, unknown: (await import('./teach.js')).uncategorized().length };
      draw();
      toast(`Added ${plural(chosen.length, 'statement')}`);
    }
    if (act === 'bank') { haptic(); (await import('./bank.js')).openBank(); return; }
    if (act === 'amazon') { haptic(); (await import('./amazon-import.js')).openAmazonImport(); return; }
    if (act === 'teach') { (await import('./teach.js')).openTeach({ onDone: () => { done.unknown = 0; draw(); } }); }
    if (act === 'push') { const s = await import('./settings.js'); await s.saveToRepo(); sheet.close(); }
    if (act === 'export') { const s = await import('./settings.js'); await s.exportVault(); }
  });
}
