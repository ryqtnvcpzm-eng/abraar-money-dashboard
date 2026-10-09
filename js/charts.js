// Charts drawn as inline SVG: Stocks-style scrubbable balance chart, stacked monthly columns,
// mini column chart, and Apple Watch-style activity rings.
import { moneyShort, money, monthLabel, dateLabel, esc } from './format.js';
import { haptic, reducedMotion } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const niceStep = (range, ticks) => {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
};

// ---------------------------------------------------------------------------
// Balance chart with finger scrubbing
// ---------------------------------------------------------------------------
/**
 * series: [{date, bal}] (bal in dollars). onScrub(pointOrNull).
 * Returns a cleanup function.
 */
export function balanceChart(wrap, series, { onScrub, height = 210 } = {}) {
  const W = Math.max(280, wrap.clientWidth);
  const H = height;
  const pad = { t: 14, r: 46, b: 24, l: 4 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  if (series.length < 2) { wrap.innerHTML = '<div class="empty" style="padding:40px 0">Not enough data yet</div>'; return () => {}; }

  const vals = series.map((p) => p.bal);
  let min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || Math.max(1, Math.abs(max) * 0.1);
  min -= span * 0.08; max += span * 0.1;
  const step = niceStep(max - min, 3);
  const X = (i) => pad.l + (iw * i) / (series.length - 1);
  const Y = (v) => pad.t + ih * (1 - (v - min) / (max - min));
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? 'var(--green)' : 'var(--red)';

  let grid = '';
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const y = Y(v);
    grid += `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${y}" y2="${y}" style="stroke:var(--separator)" stroke-width="1" shape-rendering="crispEdges"/>`;
    grid += `<text class="chart-axis" x="${W - 2}" y="${y + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }
  // month ticks along the bottom, thinned so labels never collide
  let xl = '';
  // Track where the previous label *ends*: the first one is left-aligned, so it reaches ~26px to the right.
  let lastEnd = -999;
  series.forEach((p, i) => {
    const first = i === 0 || p.date.slice(0, 7) !== series[i - 1].date.slice(0, 7);
    if (!first) return;
    const x = X(i);
    const start = i === 0 ? x : x - 13;
    if (start - lastEnd < 6 || x > W - pad.r - 10) return;
    lastEnd = i === 0 ? x + 26 : x + 13;
    xl += `<text class="chart-axis" x="${x}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${monthLabel(p.date.slice(0, 7), 'short')}</text>`;
  });

  const pts = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.bal).toFixed(1)}`);
  const line = 'M' + pts.join('L');
  const area = `${line}L${X(series.length - 1).toFixed(1)},${pad.t + ih}L${X(0).toFixed(1)},${pad.t + ih}Z`;
  const gid = 'g' + Math.random().toString(36).slice(2, 8);

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Daily balance from ${dateLabel(series[0].date, 'long')} to ${dateLabel(series[series.length - 1].date, 'long')}: ${money(vals[0])} to ${money(vals[vals.length - 1])}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.22"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
    ${grid}${xl}
    <path d="${area}" fill="url(#${gid})" class="area"/>
    <path d="${line}" fill="none" style="stroke:${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="line"/>
    <g class="cursor" style="opacity:0;transition:opacity 120ms">
      <line class="cl" y1="${pad.t - 6}" y2="${pad.t + ih}" style="stroke:var(--label-3)" stroke-width="1"/>
      <circle class="cd" r="5.5" style="fill:${color};stroke:var(--bg-2)" stroke-width="2.5"/>
    </g>
    <circle cx="${X(series.length - 1)}" cy="${Y(vals[vals.length - 1])}" r="4" style="fill:${color};stroke:var(--bg-2)" stroke-width="2" class="end"/>
  </svg>`;
  const svg = wrap.firstElementChild;
  const path = svg.querySelector('.line');
  if (!reducedMotion()) {
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    svg.querySelector('.area').style.opacity = '0';
    requestAnimationFrame(() => {
      path.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.2,.9,.25,1)';
      path.style.strokeDashoffset = '0';
      const a = svg.querySelector('.area');
      a.style.transition = 'opacity .8s ease .35s';
      a.style.opacity = '1';
    });
  }

  const cursor = svg.querySelector('.cursor');
  const cl = svg.querySelector('.cl');
  const cd = svg.querySelector('.cd');
  let active = false, lastI = -1;
  const at = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(series.length - 1, Math.round(((x - pad.l) / iw) * (series.length - 1))));
  };
  const show = (i) => {
    if (i === lastI) return;
    if (lastI !== -1 && (series[i].date.slice(0, 7) !== series[lastI].date.slice(0, 7))) haptic();
    lastI = i;
    const x = X(i), y = Y(series[i].bal);
    cl.setAttribute('x1', x); cl.setAttribute('x2', x);
    cd.setAttribute('cx', x); cd.setAttribute('cy', y);
    cursor.style.opacity = '1';
    onScrub?.(series[i]);
  };
  const hide = () => { active = false; lastI = -1; cursor.style.opacity = '0'; onScrub?.(null); };
  svg.addEventListener('pointerdown', (e) => { active = true; haptic(); show(at(e.clientX)); });
  svg.addEventListener('pointermove', (e) => { if (active || e.pointerType === 'mouse') show(at(e.clientX)); });
  svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') hide(); else active = false; });
  svg.addEventListener('pointercancel', hide);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  // keyboard scrubbing
  svg.tabIndex = 0;
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { if (e.key === 'Escape') hide(); return; }
    e.preventDefault();
    show(Math.max(0, Math.min(series.length - 1, (lastI < 0 ? series.length - 1 : lastI) + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1))));
  });
  svg.addEventListener('blur', hide);
  return () => {};
}

// ---------------------------------------------------------------------------
// Stacked monthly columns
// ---------------------------------------------------------------------------
/**
 * months: [{ym, total (cents), rows:[{cat, cents}]}]; order: [catId...] stack order (rest → "Other");
 * selected: ym | 'all'; onSelect(ym)
 */
export function stackedColumns(wrap, months, { order, cats, selected, onSelect, height = 190 } = {}) {
  const W = Math.max(280, wrap.clientWidth);
  const H = height;
  const pad = { t: 22, r: 42, b: 22, l: 2 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxV = Math.max(1, ...months.map((m) => m.total)) / 100;
  const step = niceStep(maxV, 3);
  const top = Math.ceil(maxV / step) * step;
  const Y = (v) => pad.t + ih * (1 - v / top);
  const band = iw / months.length;
  const bw = Math.min(24, band * 0.62);

  let g = '';
  for (let v = step; v <= top + 1e-9; v += step) {
    g += `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--separator)" stroke-width="1" shape-rendering="crispEdges"/>`;
    g += `<text class="chart-axis" x="${W - 2}" y="${Y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }
  g += `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${Y(0)}" y2="${Y(0)}" style="stroke:var(--label-3)" stroke-width="1" shape-rendering="crispEdges"/>`;

  const peak = months.reduce((a, b) => (b.total > a.total ? b : a), months[0]);
  // Month names need ~26px each: with many months, label every Nth one (and always the selected month).
  const every = Math.max(1, Math.ceil(26 / band));
  const showLabel = (i, ym) => ym === selected || (months.length - 1 - i) % every === 0; // counted back from the latest month
  months.forEach((m, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - bw / 2;
    const dim = selected !== 'all' && selected !== m.ym;
    const parts = [];
    let other = 0;
    for (const r of m.rows) {
      if (order.includes(r.cat.id)) parts.push(r); else other += r.cents;
    }
    parts.sort((a, b) => order.indexOf(a.cat.id) - order.indexOf(b.cat.id));
    if (other > 0) parts.push({ cat: { id: '_other', color: 'gray', name: 'Other' }, cents: other });
    let y0 = Y(0);
    const segs = [];
    parts.forEach((p, k) => {
      const h = (ih * p.cents) / 100 / top;
      if (h <= 0) return;
      const isTop = k === parts.length - 1;
      const gap = isTop ? 0 : 2;
      const hh = Math.max(0, h - gap);
      const yTop = y0 - h;
      if (isTop) {
        const r = Math.min(4, hh, bw / 2);
        segs.push(`<path d="M${x},${y0}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + bw - r}Q${x + bw},${yTop} ${x + bw},${yTop + r}V${y0}Z" style="fill:var(--${p.cat.color})"/>`);
      } else {
        segs.push(`<rect x="${x}" y="${yTop + gap}" width="${bw}" height="${hh}" style="fill:var(--${p.cat.color})"/>`);
      }
      y0 = yTop;
    });
    const label = (selected === m.ym || (selected === 'all' && m === peak)) && m.total > 0
      ? `<text class="chart-axis" x="${cx}" y="${Y(m.total / 100) - 6}" text-anchor="middle" style="fill:var(--label);font-weight:600">${moneyShort(m.total / 100)}</text>` : '';
    g += `<g class="col" data-ym="${m.ym}" style="opacity:${dim ? 0.32 : 1};transition:opacity 250ms;cursor:pointer">
      <title>${esc(monthLabel(m.ym))}: ${money(m.total / 100)}</title>
      <rect x="${pad.l + band * i}" y="${pad.t - 10}" width="${band}" height="${ih + 32}" fill="transparent"/>
      <g class="stack" style="transform-origin:${cx}px ${Y(0)}px">${segs.join('')}</g>${label}
      ${showLabel(i, m.ym) ? `<text class="chart-axis" x="${cx}" y="${H - 6}" text-anchor="middle" style="${selected === m.ym ? 'fill:var(--label);font-weight:600' : ''}">${monthLabel(m.ym, every > 1 && m.ym.endsWith('-01') ? 'shortYear' : 'short')}</text>` : ''}</g>`;
  });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Spending by month, stacked by category">${g}</svg>`;
  if (!reducedMotion()) {
    wrap.querySelectorAll('.stack').forEach((s, i) => {
      s.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 700, delay: i * 30, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'backwards' });
    });
  }
  wrap.querySelectorAll('.col').forEach((c) => c.addEventListener('click', () => { haptic(); onSelect?.(c.dataset.ym); }));
}

// ---------------------------------------------------------------------------
// Small single-series columns (category sheet)
// ---------------------------------------------------------------------------
export function miniColumns(months, color) {
  const W = 320, H = 96, pad = { t: 16, b: 18 };
  const max = Math.max(1, ...months.map((m) => m.v));
  const band = W / months.length;
  const bw = Math.min(18, band * 0.55);
  const ih = H - pad.t - pad.b;
  const peak = months.reduce((a, b) => (b.v > a.v ? b : a), months[0]);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:380px;margin:0 auto" role="img" aria-label="Monthly totals">${months.map((m, i) => {
    const h = Math.max(m.v > 0 ? 2 : 0, (ih * m.v) / max);
    const x = band * i + (band - bw) / 2;
    const y = pad.t + ih - h;
    const r = Math.min(4, h);
    return `<path d="M${x},${pad.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${pad.t + ih}Z" style="fill:var(--${color})"><title>${esc(monthLabel(m.ym))}: ${money(m.v)}</title></path>
      ${m === peak && m.v > 0 ? `<text class="chart-axis" x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" style="fill:var(--label);font-weight:600">${moneyShort(m.v)}</text>` : ''}
      <text class="chart-axis" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${monthLabel(m.ym, 'short').slice(0, 1)}</text>`;
  }).join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Column chart with a readout (Health-style): highlight one bar, optional reference line,
// touch or hover any bar to read its value.
// ---------------------------------------------------------------------------
/**
 * bars: [{ key, label, title, v }]   (label = axis text, title = readout text)
 * opts: { color, highlight: key, ref: { v, label }, format(v) -> string, height, unit }
 */
export function columnChart(wrap, bars, { color = 'blue', highlight = null, ref = null, format = moneyShort, readout = null, refFormat = null, height = 190 } = {}) {
  // Axis ticks stay compact; the readout and the reference label show the exact figure.
  const exact = readout || (format === moneyShort ? (x) => money(x, { cents: false }) : format);
  const refFmt = refFormat || exact;
  const W = Math.max(260, wrap.clientWidth || 320);
  const H = height;
  const pad = { t: 18, r: 40, b: 22, l: 2 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  // Supports negative values (e.g. a month that saved less than nothing): the baseline sits at 0.
  const maxV = Math.max(1e-9, ...bars.map((b) => b.v), ref ? ref.v : 0);
  const minV = Math.min(0, ...bars.map((b) => b.v));
  const step = niceStep(maxV - minV, 3);
  const top = Math.ceil((maxV * 1.08) / step) * step || step;
  const bottom = minV < 0 ? Math.floor((minV * 1.08) / step) * step : 0;
  const Y = (v) => pad.t + ih * ((top - v) / (top - bottom));
  const band = iw / bars.length;
  const bw = Math.min(24, band * 0.62);
  const def = bars.findIndex((b) => b.key === highlight);
  let grid = '';
  for (let v = bottom; v <= top + 1e-9; v += step) {
    if (Math.abs(v) < 1e-9) continue;
    grid += `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--separator)" stroke-width="1" shape-rendering="crispEdges"/>`;
    grid += `<text class="chart-axis" x="${W - 2}" y="${Y(v) + 4}" text-anchor="end">${esc(format(v))}</text>`;
  }
  grid += `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${Y(0)}" y2="${Y(0)}" style="stroke:var(--label-3)" stroke-width="1" shape-rendering="crispEdges"/>`;
  if (bottom < 0) grid += `<text class="chart-axis" x="${W - 2}" y="${Y(0) + 4}" text-anchor="end">${esc(format(0))}</text>`;
  const thin = bars.length > 14;
  const cols = bars.map((b, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - bw / 2;
    const y0 = Y(0);
    const h = b.v === 0 ? 0 : Math.max(2, Math.abs(Y(b.v) - y0));
    const r = Math.min(4, h, bw / 2);
    let path = '';
    if (h && b.v > 0) { const y = y0 - h; path = `M${x},${y0}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y0}Z`; }
    if (h && b.v < 0) { const y = y0 + h; path = `M${x},${y0}V${y - r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y - r}V${y0}Z`; }
    // Labels need ~26px each: every Nth one, counted back from the latest, plus the highlighted bar.
    const every = Math.max(thin ? 2 : 1, Math.ceil(26 / band));
    const showLabel = (bars.length - 1 - i) % every === 0 || i === def;
    return `<g class="cc-bar" data-i="${i}">
      <rect x="${pad.l + band * i}" y="${pad.t - 12}" width="${band}" height="${ih + 34}" fill="transparent"/>
      ${path ? `<path d="${path}" style="fill:var(--${b.color || color});transition:opacity 180ms"/>` : ''}
      <text class="chart-axis cc-x" x="${cx}" y="${H - 6}" text-anchor="middle">${showLabel ? esc(b.label) : ''}</text></g>`;
  }).join('');
  const refLine = ref ? `<line x1="${pad.l}" x2="${W - pad.r + 6}" y1="${Y(ref.v)}" y2="${Y(ref.v)}" style="stroke:var(--label)" stroke-opacity=".55" stroke-width="1.5"/>
    <text class="chart-axis" x="${pad.l + 2}" y="${Y(ref.v) - 5}" style="fill:var(--label-2);font-weight:600;paint-order:stroke;stroke:var(--sheet-row, var(--bg-2));stroke-width:4px;stroke-linejoin:round">${esc(ref.label)} ${esc(refFmt(ref.v))}</text>` : '';
  wrap.innerHTML = `<div class="chart-readout"><span class="k"></span><b class="v"></b></div>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(bars.map((b) => `${b.title}: ${exact(b.v)}`).join(', '))}">${grid}${cols}${refLine}</svg>`;
  const svg = wrap.querySelector('svg');
  const k = wrap.querySelector('.chart-readout .k');
  const v = wrap.querySelector('.chart-readout .v');
  const groups = [...svg.querySelectorAll('.cc-bar')];
  let active = -2;
  const show = (i) => {
    if (i === active) return;
    if (active !== -2 && i >= 0) haptic();
    active = i;
    groups.forEach((g, j) => {
      const p = g.querySelector('path');
      if (p) p.style.opacity = i < 0 ? 1 : j === i ? 1 : 0.35;
      const t = g.querySelector('.cc-x');
      t.style.fill = j === i ? 'var(--label)' : '';
      t.style.fontWeight = j === i ? '600' : '';
    });
    if (i >= 0) { k.textContent = bars[i].title; v.textContent = exact(bars[i].v); }
    else if (ref) { k.textContent = ref.label; v.textContent = refFmt(ref.v); }
    else { k.textContent = ''; v.textContent = ''; }
  };
  show(def);
  if (!reducedMotion()) {
    svg.querySelectorAll('.cc-bar path').forEach((p, i) => {
      p.style.transformOrigin = `0 ${Y(0)}px`; // grows out of the zero line in either direction
      p.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 650, delay: i * 25, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'backwards' });
    });
  }
  const at = (clientX) => {
    const rr = svg.getBoundingClientRect();
    const x = ((clientX - rr.left) / rr.width) * W;
    return Math.max(0, Math.min(bars.length - 1, Math.floor((x - pad.l) / band)));
  };
  let down = false;
  svg.addEventListener('pointerdown', (e) => { down = true; show(at(e.clientX)); });
  svg.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') show(at(e.clientX)); });
  const reset = () => { down = false; show(def); };
  svg.addEventListener('pointerup', (e) => { down = false; if (e.pointerType === 'mouse') return; setTimeout(() => show(def), 1200); });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') reset(); });
  svg.addEventListener('pointercancel', reset);
  svg.tabIndex = 0;
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(Math.max(0, Math.min(bars.length - 1, (active < 0 ? bars.length - 1 : active) + (e.key === 'ArrowLeft' ? -1 : 1))));
  });
}

// ---------------------------------------------------------------------------
// Activity rings
// ---------------------------------------------------------------------------
/** rings: [{p (0..n), c1, c2, label}] outer → inner. Animate with animateRings(el). */
export function ringsSVG(rings, size = 148) {
  const sw = 17;
  const gap = 2.5;
  const cx = size / 2;
  let out = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(rings.map((r) => `${r.label} ${Math.round(r.p * 100)}%`).join(', '))}"><defs>`;
  rings.forEach((r, i) => {
    out += `<linearGradient id="rg${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${r.c1}"/><stop offset="1" stop-color="${r.c2}"/></linearGradient>`;
  });
  out += `<filter id="capShadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#000" flood-opacity=".55"/></filter></defs>`;
  rings.forEach((r, i) => {
    const rad = cx - sw / 2 - i * (sw + gap);
    const C = 2 * Math.PI * rad;
    const p = Math.max(0, r.p);
    const first = Math.min(1, p);
    out += `<circle cx="${cx}" cy="${cx}" r="${rad}" fill="none" stroke="${r.c1}" stroke-opacity=".22" stroke-width="${sw}"/>`;
    out += `<circle class="ring-arc" cx="${cx}" cy="${cx}" r="${rad}" fill="none" stroke="url(#rg${i})" stroke-width="${sw}" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - first)}" transform="rotate(-90 ${cx} ${cx})" ${first === 0 ? 'stroke-opacity="0"' : ''}/>`;
    if (p > 1) {
      // second lap, with a shadowed end cap like the Fitness app
      const extra = Math.min(1, p - 1);
      out += `<circle class="ring-arc" cx="${cx}" cy="${cx}" r="${rad}" fill="none" stroke="${r.c2}" stroke-width="${sw}" stroke-linecap="round" filter="url(#capShadow)"
        stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - extra)}" transform="rotate(-90 ${cx} ${cx})"/>`;
    }
  });
  return out + '</svg>';
}
export function animateRings(root) {
  const arcs = root.querySelectorAll('.ring-arc');
  if (reducedMotion()) { arcs.forEach((a) => (a.style.strokeDashoffset = a.dataset.target)); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => arcs.forEach((a, i) => {
    a.style.transitionDelay = `${i * 90}ms`;
    a.style.strokeDashoffset = a.dataset.target;
  })));
}
