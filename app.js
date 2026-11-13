import {analyze, marketKey, snapshotKey, mergeSnapshots, resale, MAX_FILE_BYTES, catalog} from './market.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = n => n == null ? '—' : new Intl.NumberFormat().format(n);
const shortDate = t => new Date(t).toLocaleDateString(undefined, {month:'short', day:'numeric'});
const fullDate = t => new Date(t).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
const percent = n => n == null ? '<span class="unknown">—</span>' : `<span class="change ${n >= 0 ? 'positive' : 'negative'}">${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%</span>`;
const money = value => {
  if (value == null || !Number.isFinite(value)) return '<span class="unknown">—</span>';
  const amount = Math.abs(Math.round(value)), g = Math.floor(amount / 10000), s = Math.floor(amount % 10000 / 100), c = amount % 100;
  return `<span class="money">${value < 0 ? '−' : ''}${g ? `${count(g)}<span class="coin gold">g</span>` : ''}${s || g ? `${s}<span class="coin silver">s</span>` : ''}${c || (!g && !s) ? `${c}<span class="coin copper">c</span>` : ''}</span>`;
};
const icon = i => `<img class="item-icon quality-${i.quality}" src="assets/icons/${escape(i.icon)}.jpg" data-fallback="${escape(i.icon)}" width="36" height="36" alt="" loading="lazy">`;
const state = {published:[], local:[], demo:[], sample:false, market:'', days:7, view:'overview', search:'', category:'', rank:'all', sort:'name', descending:false, page:0, current:null};
let favorites;
try { favorites = new Set(JSON.parse(localStorage.getItem('auction-ledger-watchlist') || '[]').filter(x => typeof x === 'string')); } catch { favorites = new Set(); }
let dbPromise, toastTimer;
function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('auction-ledger', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('history');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error('Browser storage is unavailable. Export your ledger before closing this page.'));
  });
  return dbPromise;
}
async function storage(value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('history', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('history').get('snapshots') : tx.objectStore('history').put(value, 'snapshots');
    let result;
    req.onsuccess = () => result = req.result;
    tx.oncomplete = () => resolve(result || []);
    tx.onerror = () => reject(new Error('Could not save browser history. Export your ledger to avoid losing it.'));
    tx.onabort = tx.onerror;
  });
}
function allReal() { return mergeSnapshots(state.published, state.local); }
function activeSnapshots() { return state.sample ? state.demo : allReal(); }
function watchKey(i) { return `${state.market}|${i.key}`; }
function isWatched(i) { return favorites.has(watchKey(i)); }

function chart(points, {price = false, id = 'chart-fill', label = 'Market price index'} = {}) {
  const p = points.filter(v => Number.isFinite(v.value));
  if (!p.length) return '<div class="empty-state"><h3>A little more history</h3><p>No common basket yet. Import comparable scans to build this chart.</p></div>';
  const width = 660, height = 250, left = 52, right = 16, top = 20, bottom = 32;
  const values = p.map(x => x.value), min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * .2, max * .015, 1);
  const low = Math.max(0, min - pad), high = max + pad;
  const first = Date.parse(p[0].timestamp), last = Date.parse(p.at(-1).timestamp);
  const x = t => first === last ? (width + left - right) / 2 : left + (Date.parse(t) - first) / (last - first) * (width - left - right);
  const y = v => top + (high - v) / (high - low) * (height - top - bottom);
  const path = p.map((v, i) => `${i ? 'L' : 'M'}${x(v.timestamp).toFixed(2)},${y(v.value).toFixed(2)}`).join(' ');
  const axis = v => price ? (v >= 10000 ? `${(v / 10000).toFixed(v > 1000000 ? 0 : 1)}g` : `${(v / 100).toFixed(0)}s`) : v.toFixed(1);
  const grid = Array.from({length:4}, (_, n) => { const v = low + (high - low) * n / 3; return `<path class="gridline" d="M${left} ${y(v)}H${width - right}"/><text x="${left - 10}" y="${y(v) + 3}" text-anchor="end">${axis(v)}</text>`; }).join('');
  const ticks = [...new Set([0, Math.floor((p.length - 1) / 3), Math.floor((p.length - 1) * 2 / 3), p.length - 1])];
  const dates = ticks.map(n => `<text x="${x(p[n].timestamp)}" y="${height - 8}" text-anchor="${n === 0 ? 'start' : n === p.length - 1 ? 'end' : 'middle'}">${escape(shortDate(p[n].timestamp))}</text>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}. ${p.length} observations, ${escape(fullDate(p[0].timestamp))} to ${escape(fullDate(p.at(-1).timestamp))}."><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#d4b16a" stop-opacity=".14"/><stop offset="100%" stop-color="#d4b16a" stop-opacity="0"/></linearGradient></defs>${grid}<path fill="url(#${id})" d="${path} L${x(p.at(-1).timestamp)},${height - bottom} L${x(p[0].timestamp)},${height - bottom}Z"/><path class="price-line" d="${path}"/>${p.map(v => `<circle class="hit-point" cx="${x(v.timestamp)}" cy="${y(v.value)}" r="8"><title>${escape(fullDate(v.timestamp))}: ${price ? `${(v.value / 10000).toFixed(4)} gold` : v.value.toFixed(2)}</title></circle>`).join('')}<circle class="point" cx="${x(p.at(-1).timestamp)}" cy="${y(p.at(-1).value)}" r="4"/>${dates}</svg>`;
}
function sparkline(history) {
  if (history.length < 2) return '<span class="subtle">One observation</span>';
  const v = history.map(h => h.price), min = Math.min(...v), max = Math.max(...v);
  const path = v.map((n, i) => `${i ? 'L' : 'M'}${2 + i / (v.length - 1) * 84},${max === min ? 13 : 23 - (n - min) / (max - min) * 20}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 88 26" role="img" aria-label="Price history: ${(v[0]/10000).toFixed(4)} to ${(v.at(-1)/10000).toFixed(4)} gold"><path d="${path}"/></svg>`;
}
function setMarketOptions() {
  const markets = new Map(activeSnapshots().map(s => [marketKey(s), s]));
  if (!markets.has(state.market)) state.market = markets.keys().next().value || '';
  $('#market-select').innerHTML = [...markets].map(([k, s]) => `<option value="${escape(k)}">${escape(s.realm)} · ${escape(s.faction)} · ${escape(s.source)}</option>`).join('');
  $('#market-select').value = state.market;
}
function render() {
  setMarketOptions();
  state.analysis = analyze(activeSnapshots().filter(s => marketKey(s) === state.market), state.days);
  const a = state.analysis;
  const library = state.view === 'library';
  $('#overview-content').hidden = state.view !== 'overview';
  $('#masthead').hidden = state.view !== 'overview';
  $('#ledger-panel').hidden = library;
  $('#library-panel').hidden = !library;
  $('.market-toolbar').hidden = library;
  $$('[data-view]').forEach(el => { if (el.dataset.view === state.view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#view-label').textContent = {overview:'Overview', ledger:'Item ledger', watchlist:'Watchlist', library:'Scan library'}[state.view];
  $$('[data-days]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.days) === state.days)));
  $('#watch-count').textContent = favorites.size;
  const real = allReal();
  $('#data-notice').innerHTML = state.sample
    ? `<p><strong>Sample market.</strong> Illustrative data, not current Auction House prices. Import your scans to make this ledger yours.</p><button class="text-button" ${real.length ? 'id="leave-sample"' : 'data-import'}>${real.length ? 'Use my scans →' : 'Add your data →'}</button>`
    : `<p><strong>Your scan data.</strong> ${count(state.local.length)} browser snapshots · ${count(state.published.length)} published snapshots.</p>`;
  $('#stat-items').textContent = count(a.items.length);
  const knownSupply = a.items.filter(i => i.quantity != null);
  $('#stat-supply').textContent = knownSupply.length ? count(knownSupply.reduce((s, i) => s + i.quantity, 0)) : 'Unknown';
  $('#stat-supply-note').textContent = knownSupply.length ? `${count(knownSupply.length)} observed item types · buyout listings` : 'This source has no supply counts';
  $('#stat-date').textContent = a.latest ? shortDate(a.latest.timestamp) : 'No scans';
  $('#stat-date-label').textContent = a.latest?.source === 'Auctionator daily lows' ? 'Latest day bucket' : a.latest?.source === 'Auctionator cache' ? 'Cache captured' : 'Latest observation';
  $('#stat-date-note').textContent = a.latest ? `${new Date(a.latest.timestamp).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} · ${a.latest.source}` : 'Import to begin';
  const index = a.series.at(-1)?.value;
  $('#stat-index').innerHTML = index != null ? `${index.toFixed(1)} ${a.series.length > 1 ? `<span class="stat-change">${percent(index - 100)}</span>` : ''}` : '—';
  $('#stat-index-note').textContent = `${a.basketSize} matched items · base 100`;
  $('#index-chart').innerHTML = chart(a.series);
  const omitted = a.series.filter(p => p.value == null).length;
  $('#index-caption').textContent = a.baseline ? `Reference: ${fullDate(a.baseline.timestamp)} · ${a.basketSize} fixed, matched items · equal weight${omitted ? ` · ${omitted} sparse scans omitted` : ''}` : 'Import snapshots to build a price index.';
  $('#mover-period').textContent = state.days === 36500 ? 'All history' : state.days === 1 ? '24h lookback' : `${state.days}d lookback`;
  const movers = [...a.items].filter(i => i.change != null).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 5);
  $('#movers').innerHTML = movers.length ? movers.map(i => `<button class="mover" data-item="${escape(i.key)}">${icon(i)}<span class="mover-info"><span class="mover-name">${escape(i.name)}</span>${money(i.minBuyout)}</span>${percent(i.change)}</button>`).join('') : '<div class="empty-state"><h3>Every story needs a second scan.</h3><p>Import another observation to compare prices.</p></div>';
  const spreads = a.items.filter(i => i.spread > 0 && i.history.length > 1);
  $('#insight-text').innerHTML = spreads.length ? `<strong>${count(spreads.length)} items</strong> are below their observed median after a hypothetical 5% AH cut. Check the depth before you trade.` : 'No positive resale spreads against the observed median.';
  renderLedger(); renderLibrary();
}

function renderLedger() {
  let items = state.analysis.items.filter(i => (!state.search || `${i.name} ${i.itemId}`.toLowerCase().includes(state.search.toLowerCase())) && (!state.category || i.category === state.category) && (state.view !== 'watchlist' || isWatched(i)));
  if (state.rank === 'spread') items = items.filter(i => i.spread > 0 && i.history.length > 1);
  if (state.rank === 'movers') items = items.filter(i => i.change != null);
  if (state.rank === 'supply') items = items.filter(i => i.quantity != null);
  const field = state.sort;
  items.sort((a, b) => {
    if (a[field] == null) return b[field] == null ? a.name.localeCompare(b.name) : 1;
    if (b[field] == null) return -1;
    const order = field === 'name' ? a.name.localeCompare(b.name) : (state.rank === 'movers' && field === 'change' ? Math.abs(a[field]) - Math.abs(b[field]) : a[field] - b[field]);
    return (state.descending ? -order : order) || a.name.localeCompare(b.name);
  });
  const size = 15, pages = Math.max(1, Math.ceil(items.length / size));
  state.page = Math.min(state.page, pages - 1);
  const visible = items.slice(state.page * size, (state.page + 1) * size);
  $('#ledger-title').firstChild.textContent = state.view === 'watchlist' ? 'Your watchlist ' : 'Item ledger ';
  $('#item-count').textContent = `${count(items.length)} items`;
  $$('[data-rank]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rank === state.rank)));
  $$('[data-sort]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
  $('#ranking-explainer').textContent = {
    all: 'Cheapest observed unit buyouts. Open an item for its history and resale calculator.',
    movers: 'Largest absolute changes vs the reference scan. New items without a reference are excluded.',
    supply: 'Most units listed in the latest snapshot. Listed volume is availability, not confirmed sales.',
    spread: 'Median observed minimum buyout × 95% − current minimum buyout. Per unit; excludes lost deposits. Not guaranteed profit.',
  }[state.rank];
  $('#ledger-body').innerHTML = visible.map(i => `<tr><td><button class="watch-button" data-watch="${escape(i.key)}" aria-pressed="${isWatched(i)}" aria-label="${isWatched(i) ? 'Unwatch' : 'Watch'} ${escape(i.name)}">${isWatched(i) ? '★' : '☆'}</button></td><td><button class="item-button" data-item="${escape(i.key)}">${icon(i)}<span><span class="item-name">${escape(i.name)}</span><span class="item-meta">${escape(i.category)} · #${i.itemId}</span></span></button></td><td class="number">${money(i.minBuyout)}</td><td class="number">${percent(i.change)}</td><td class="number supply">${count(i.quantity)}</td><td class="number ${i.spread > 0 ? 'positive' : 'unknown'}">${i.history.length > 1 ? money(i.spread) : '—'}</td><td class="number">${sparkline(i.history)}</td><td><button class="row-open" data-item="${escape(i.key)}" aria-label="View ${escape(i.name)} details">↗</button></td></tr>`).join('');
  $('#ledger-empty').hidden = items.length > 0;
  $('#table-summary').textContent = items.length ? `Showing ${state.page * size + 1}–${Math.min((state.page + 1) * size, items.length)} of ${count(items.length)} · prices per unit` : 'No matching observations';
  $('#page-label').textContent = `${state.page + 1} / ${pages}`;
  $('#previous-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page === pages - 1;
}
function renderLibrary() {
  const localKeys = new Set(state.local.map(snapshotKey));
  const real = allReal().toReversed();
  $('#library-body').innerHTML = real.length ? real.map((s, index) => `<tr><td>${escape(fullDate(s.timestamp))}</td><td>${escape(s.realm)} · ${escape(s.faction)}</td><td>${escape(s.source)}</td><td class="number">${count(s.items.length)}</td><td><span class="storage-badge">${localKeys.has(snapshotKey(s)) ? 'This browser' : 'Published'}</span></td><td>${localKeys.has(snapshotKey(s)) ? `<button class="text-button danger" data-delete="${index}">Remove local copy</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><h3>Your story starts with a scan.</h3><p>Sample data is not part of your library. Import your first real observation above.</p></div></td></tr>';
  $('#export-button').disabled = !real.length;
  $('#clear-button').disabled = !state.local.length;
}

function openItem(key) {
  const i = state.analysis.items.find(i => i.key === key);
  if (!i) return;
  state.current = i;
  $('#item-identity').innerHTML = `<div class="item-identity">${icon(i)}<div><h2 id="item-title">${escape(i.name)}</h2><p>${escape(state.analysis.latest.realm)} · ${escape(state.analysis.latest.faction)} · #${i.itemId}</p></div></div>`;
  $('#item-stats').innerHTML = `<div><p>Lowest unit buyout</p><strong>${money(i.minBuyout)}</strong></div><div><p>Change vs reference</p><strong>${percent(i.change)}</strong></div><div><p>Listed units</p><strong class="mono">${count(i.quantity)}</strong></div>`;
  $('#item-chart').innerHTML = chart(i.history.map(h => ({timestamp:h.timestamp, value:h.price})), {price:true, id:'item-fill', label:`${i.name} minimum unit buyout history`});
  $('#item-history-note').textContent = `${i.history.length} observations · ${fullDate(i.history[0].timestamp)} to ${fullDate(i.history.at(-1).timestamp)}. ${state.sample ? 'Illustrative sample data.' : ''}`;
  $('#calc-buy').value = (i.minBuyout / 10000).toFixed(4);
  $('#calc-sell').value = (i.reference / 10000).toFixed(4);
  $('#calc-quantity').value = '1'; $('#calc-cut').value = '5'; $('#calc-expenses').value = '0';
  $('#wowhead-link').href = `https://www.wowhead.com/classic/item=${i.itemId}`;
  calculate(); $('#item-dialog').showModal();
}
function calculate() {
  try {
    if (!$('#calculator-form').checkValidity()) throw new Error('Enter valid amounts and a whole quantity.');
    const {fee, net} = resale({buy:Number($('#calc-buy').value) * 10000, sell:Number($('#calc-sell').value) * 10000, quantity:Number($('#calc-quantity').value), cut:Number($('#calc-cut').value), expenses:Number($('#calc-expenses').value) * 10000});
    $('#calc-result').innerHTML = `<div><span>Potential ${net < 0 ? 'loss' : 'net gain'}</span><small>After ${money(fee)} in AH fees and entered costs</small></div><strong class="${net < 0 ? 'negative' : 'positive'}">${money(net)}</strong>`;
  } catch (e) { $('#calc-result').textContent = e.message; }
}
function download(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], {type}));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function showImport() {
  const s = state.analysis?.latest;
  $('#import-realm').value = state.sample ? '' : s?.realm || '';
  $('#import-faction').value = s && !state.sample && ['Alliance','Horde','Neutral','Shared'].includes(s.faction) ? s.faction : 'Shared';
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); $('#import-time').value = d.toISOString().slice(0,16);
  $('#import-dialog').showModal();
}
function parseFile(file, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.js', import.meta.url), {type:'module'});
    worker.onmessage = e => { worker.terminate(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.snapshots); };
    worker.onerror = () => { worker.terminate(); reject(new Error('Could not parse this file. Check its format and try again.')); };
    worker.postMessage({file, options});
  });
}
let importing = false;
async function importFiles(files) {
  if (importing || !files.length) return;
  if (files.length > 30) { $('#import-result').textContent = 'Import at most 30 files at a time.'; return; }
  if (!$('#import-time').value || !Number.isFinite(+new Date($('#import-time').value))) { $('#import-result').textContent = 'Choose the scan observation time.'; return; }
  importing = true; $('#file-input').disabled = true;
  $('#import-result').textContent = 'Reading scan data locally…';
  const results = [];
  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('File exceeds the 64 MiB limit.');
      const snapshots = await parseFile(file, {realm:$('#import-realm').value.trim(), faction:$('#import-faction').value, timestamp:new Date($('#import-time').value).toISOString()});
      const next = mergeSnapshots(state.local, snapshots);
      await storage(next); // Persist before claiming success or discarding a previous state.
      state.local = next; state.sample = false; state.market = marketKey(snapshots.at(-1));
      results.push(`<p class="positive">${escape(file.name)}: imported ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}. Saved in this browser.</p>`);
    } catch (e) { results.push(`<p class="negative">${escape(file.name)}: ${escape(e.message)}</p>`); }
    $('#import-result').innerHTML = results.join('');
  }
  importing = false; $('#file-input').disabled = false; $('#file-input').value = ''; state.page = 0; render();
}

document.addEventListener('click', async event => {
  const t = event.target.closest('button,a'); if (!t) return;
  if (t.matches('[data-import]')) showImport();
  if (t.id === 'leave-sample') { state.sample = false; render(); }
  if (t.dataset.item) openItem(t.dataset.item);
  if (t.dataset.watch) {
    const i = state.analysis.items.find(i => i.key === t.dataset.watch), key = watchKey(i);
    const next = new Set(favorites); next.has(key) ? next.delete(key) : next.add(key);
    try { localStorage.setItem('auction-ledger-watchlist', JSON.stringify([...next])); favorites = next; render(); } catch { notify('Could not save watchlist. Browser storage may be disabled.'); }
  }
  if (t.dataset.days) { state.days = Number(t.dataset.days); state.page = 0; render(); }
  if (t.dataset.rank) { state.rank = t.dataset.rank; state.sort = {all:'name',movers:'change',supply:'quantity',spread:'spread'}[state.rank]; state.descending = state.rank !== 'all'; state.page = 0; renderLedger(); }
  if (t.dataset.sort) { state.descending = state.sort === t.dataset.sort ? !state.descending : t.dataset.sort !== 'name'; state.sort = t.dataset.sort; state.page = 0; renderLedger(); }
  if (t.dataset.delete) {
    const s = allReal().toReversed()[Number(t.dataset.delete)];
    if (!s || !confirm(`Remove the browser copy of ${fullDate(s.timestamp)}? Export a backup first if needed.`)) return;
    try { const next = state.local.filter(x => snapshotKey(x) !== snapshotKey(s)); await storage(next); state.local = next; state.sample = !allReal().length; render(); } catch (e) { notify(e.message); }
  }
});
$('#search').addEventListener('input', e => { state.search = e.target.value; state.page = 0; renderLedger(); });
$('#category').addEventListener('change', e => { state.category = e.target.value; state.page = 0; renderLedger(); });
$('#market-select').addEventListener('change', e => { state.market = e.target.value; state.page = 0; render(); });
$('#previous-page').addEventListener('click', () => { state.page--; renderLedger(); });
$('#next-page').addEventListener('click', () => { state.page++; renderLedger(); });
$('#calculator-form').addEventListener('input', calculate);
$('#calculator-form').addEventListener('submit', e => e.preventDefault());
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#opportunities-button').addEventListener('click', () => { state.rank = 'spread'; state.sort = 'spread'; state.descending = true; state.page = 0; renderLedger(); $('#ledger-panel').scrollIntoView({behavior:'auto',block:'start'}); });
$('#file-input').addEventListener('change', e => importFiles([...e.target.files]));
$('#drop-zone').addEventListener('dragover', e => { e.preventDefault(); $('#drop-zone').classList.add('dragging'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('dragging'));
$('#drop-zone').addEventListener('drop', e => { e.preventDefault(); $('#drop-zone').classList.remove('dragging'); importFiles([...e.dataTransfer.files]); });
$('#export-button').addEventListener('click', () => { download('scans.json', JSON.stringify({version:1,snapshots:allReal()},null,2), 'application/json'); notify('Sanitized ledger exported. Upload scans.json to data/ to publish it.'); });
$('#template-button').addEventListener('click', () => download('scan-template.csv', `itemId,name,minBuyout,quantity,listings,realm,faction,timestamp,source\n13463,Dreamfoil,24500,240,12,Your Realm,Alliance,${new Date().toISOString()},CSV\n13468,Black Lotus,1420000,16,16,Your Realm,Alliance,${new Date().toISOString()},CSV\n`, 'text/csv'));
$('#sample-button').addEventListener('click', () => { state.sample = true; state.market = ''; state.view = 'overview'; location.hash = 'overview'; $('#import-dialog').close(); render(); });
$('#clear-button').addEventListener('click', async () => {
  if (!confirm('Clear all browser imports? Export your ledger first if you need a backup. Published data is unaffected.')) return;
  try { await storage([]); state.local = []; state.sample = !state.published.length; state.market = ''; render(); notify('Browser imports cleared.'); } catch (e) { notify(e.message); }
});
document.addEventListener('keydown', e => { if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches('input,select,textarea') && !document.querySelector('dialog[open]')) { e.preventDefault(); if (state.view === 'library') location.hash = 'ledger'; $('#search').focus(); } });
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.fallbackStage === 'remote') { delete img.dataset.fallbackStage; img.src = 'assets/icons/inv_misc_questionmark.jpg'; return; }
  if (!img.dataset.fallback) return;
  const name = img.dataset.fallback; delete img.dataset.fallback;
  img.dataset.fallbackStage = 'remote';
  img.src = `https://wow.zamimg.com/images/wow/icons/large/${encodeURIComponent(name)}.jpg`;
}, true);
function route() { state.view = ['overview','ledger','watchlist','library'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview'; state.page = 0; if (state.analysis) render(); }
window.addEventListener('hashchange', route);
async function boot() {
  try {
    const get = async path => { const r = await fetch(path, {cache:'no-cache'}); if (!r.ok) throw new Error(`Could not load ${path} (${r.status}).`); return r.json(); };
    const results = await Promise.allSettled([get('data/scans.json'), get('data/demo.json'), storage(), get('data/items.json')]);
    if (results[3].status === 'fulfilled') Object.assign(catalog, results[3].value);
    if (results[0].status === 'fulfilled') state.published = mergeSnapshots(results[0].value.snapshots || []);
    else notify('Published scan history could not be loaded. Showing browser data or samples.');
    if (results[1].status === 'fulfilled') state.demo = mergeSnapshots(results[1].value.snapshots || []);
    if (results[2].status === 'fulfilled') state.local = mergeSnapshots(results[2].value);
    else notify(results[2].reason.message);
    state.sample = !allReal().length; route(); render();
  } catch (e) { $('#data-notice').textContent = `Could not open the ledger: ${e.message}. Try refreshing or checking the published data file.`; }
}
boot();
