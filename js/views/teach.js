// "Needs a category": places Money couldn't recognise, each sorted with one tap.
// A choice becomes a merchant rule in the encrypted vault, so it applies to every past and future visit.
import { app } from '../state.js';
import { money, fromCents, dateLabel, esc, plural } from '../format.js';
import { userRuleFor } from '../categorize.js';
import { icon, openSheet, haptic, toast } from '../ui.js';
import { pickCategory } from './sheets.js';

// The categories most unknown places turn out to be, in the order the chips show.
const QUICK = ['dining', 'coffee', 'groceries', 'shopping', 'transport', 'health', 'fitness', 'entertainment'];

/** Spending at places with no rule: [{ name, sign, count, cents, last }], most visits first. */
export function uncategorized(model = app.model) {
  if (!model) return [];
  const ruled = new Set((app.vault?.userRules || []).map((r) => `${r.name.toLowerCase()}|${r.sign ?? ''}`));
  const map = new Map();
  for (const t of model.txns) {
    if (t.cat?.id !== 'other' || t.c >= 0 || t.netted || t.locked || t.partOf) continue;
    if (ruled.has(`${t.name.toLowerCase()}|-1`) || ruled.has(`${t.name.toLowerCase()}|`)) continue;
    const e = map.get(t.name) || { name: t.name, sign: -1, count: 0, cents: 0, last: t.date };
    e.count++;
    e.cents -= t.c;
    if (t.date > e.last) e.last = t.date;
    map.set(t.name, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.cents - a.cents);
}

/** Save "this place is that category" and re-sort everything from it. */
async function teach(name, catId) {
  const rule = userRuleFor({ name, amount: -1 }, catId);
  app.vault.userRules = (app.vault.userRules || []).filter((r) => !(r.name.toLowerCase() === name.toLowerCase() && (r.sign == null || r.sign === -1)));
  app.vault.userRules.push(rule);
  for (const t of app.vault.transactions) if (t.name === name && t.amount < 0 && !t.locked) t.category = catId;
  await app.commit({ silent: true });
}

export function openTeach({ onDone } = {}) {
  const cats = app.model.cats;
  const sheet = openSheet({ title: 'Needs a Category', size: 'full', body: '', onClose: () => onDone?.() });
  let taught = 0;
  const draw = () => {
    const list = uncategorized();
    if (!list.length) {
      sheet.setBody(`
        <div class="sheet-hero" style="padding-top:28px">
          <span class="cat-icon lg" style="--c:var(--green)">${icon('check')}</span>
          <div class="name">All sorted</div>
          <p class="when" style="max-width:320px;margin:8px auto 0">${taught ? `Money will remember ${plural(taught, 'place')} from now on, in this statement and every future one.` : 'Every place you spend at has a category.'}</p>
        </div>
        <div class="btn-row"><button class="btn" data-close>Done</button></div>`);
      return;
    }
    sheet.setBody(`
      <p class="list-foot" style="margin:4px 4px 14px">Money couldn’t tell what ${list.length === 1 ? 'this place is' : `these ${list.length} places are`}. Pick a category once and it’s remembered for every visit, past and future. Saved only in your encrypted vault.</p>
      ${list.map((p) => `
        <div class="teach-card" data-name="${esc(p.name)}">
          <div class="teach-head">
            <span class="main"><span class="title">${esc(p.name)}</span>
            <span class="subtitle">${plural(p.count, 'visit')} · ${money(fromCents(p.cents))} · last ${esc(dateLabel(p.last, 'short'))}</span></span>
          </div>
          <div class="teach-chips" role="group" aria-label="Category for ${esc(p.name)}">
            ${QUICK.filter((id) => cats.has(id)).map((id) => { const c = cats.get(id); return `<button type="button" class="teach-chip" data-cat="${esc(id)}" style="--c:var(--${esc(c.color)})">${icon(c.icon)}<span>${esc(c.name)}</span></button>`; }).join('')}
            <button type="button" class="teach-chip" data-cat="__more">${icon('ellipsis')}<span>More…</span></button>
            <button type="button" class="teach-chip plain" data-cat="other">Keep as Other</button>
          </div>
        </div>`).join('')}`);
  };
  draw();
  sheet.el.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    const card = chip.closest('[data-name]');
    const name = card.dataset.name;
    let catId = chip.dataset.cat;
    if (catId === '__more') { catId = await pickCategory('other', false); if (!catId) return; }
    haptic();
    card.classList.add('done');
    await teach(name, catId);
    taught++;
    if (catId !== 'other') toast(`${name} → ${cats.get(catId)?.name || 'Other'}`, { icon: 'tag', color: 'blue' });
    setTimeout(draw, 220);
  });
}
