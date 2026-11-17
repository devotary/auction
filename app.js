import {resale} from './trade.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = n => n == null ? '—' : new Intl.NumberFormat().format(n);
const net = n => n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${new Intl.NumberFormat(undefined, {maximumFractionDigits:1}).format(Math.abs(n))}`;
const interval = hours => hours == null ? 'Unknown interval' : hours < 1 / 60 ? `${count(Math.round(hours * 3600))} seconds apart` : hours < 1 ? `${new Intl.NumberFormat(undefined, {maximumFractionDigits:1}).format(hours * 60)} minutes apart` : `${new Intl.NumberFormat(undefined, {maximumFractionDigits:2}).format(hours)} hours apart`;
const shortDate = t => new Date(t).toLocaleDateString(undefined, {month:'short', day:'numeric'});
const fullDate = t => new Date(t).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
const percent = n => n == null ? '<span class="unknown">—</span>' : `<span class="change ${n >= 0 ? 'positive' : 'negative'}">${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%</span>`;
const money = value => {
  if (value == null || !Number.isFinite(value)) return '<span class="unknown">—</span>';
  const amount = Math.abs(Math.round(value)), g = Math.floor(amount / 10000), s = Math.floor(amount % 10000 / 100), c = amount % 100;
  return `<span class="money">${value < 0 ? '−' : ''}${g ? `${count(g)}<span class="coin gold">g</span>` : ''}${s || g ? `${s}<span class="coin silver">s</span>` : ''}${c || (!g && !s) ? `${c}<span class="coin copper">c</span>` : ''}</span>`;
};
const icon = i => `<img class="item-icon quality-${i.quality}" src="assets/icons/${escape(i.icon)}.jpg" data-fallback="${escape(i.icon)}" width="36" height="36" alt="" loading="lazy">`;
const views = ['overview','ledger','watchlist','flips','library'];
const state = {market:'', days:7, view:'overview', search:'', category:'', rank:'all', sort:'name', descending:false, activityDirection:'falling', page:0, current:null, report:null, loading:false,
  flipReport:null, flipDirection:'all', flipSearch:'', flipSort:'margin:desc', flipMin:0, flipMax:Infinity, flipHours:24, flipPage:0};
const reportCache = new Map();
const ledgerHead = $('#ledger-head').innerHTML;
let renderSequence = 0;
let favorites;
try {
  favorites = new Set(JSON.parse(localStorage.getItem('auction-ledger-watchlist') || '[]').filter(x => typeof x === 'string').map(key => {
    try {
      const divider = key.lastIndexOf('|'), market = JSON.parse(key.slice(0, divider));
      const house = market[1] === 'Neutral' ? 'Neutral' : ['Alliance', 'Horde', 'Faction'].includes(market[1]) ? 'Faction' : null;
      return market[2] === 'Auction Ledger' && house ? `${JSON.stringify(['Auction House', house, 'Auction Ledger'])}|${key.slice(divider + 1)}` : key;
    } catch { return key; }
  }));
} catch { favorites = new Set(); }
let toastTimer;
function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function watchKey(i) { return `${state.market}|${i.key}`; }
function isWatched(i) { return favorites.has(watchKey(i)); }

function chart(points, {price = false, id = 'chart-fill', label = 'Market price index'} = {}) {
  const p = points.filter(v => Number.isFinite(v.value));
  if (!p.length) return '<div class="empty-state"><h3>A little more history</h3><p>No common basket yet. Save and publish comparable scans to build this chart.</p></div>';
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
  const markets = new Map(state.report.markets.map(s => [s.key,s]));
  if (!markets.has(state.market)) state.market = markets.keys().next().value || '';
  $('#market-select').innerHTML = [...markets].map(([k, s]) => `<option value="${escape(k)}">${s.faction === 'Neutral' ? 'Neutral AH' : 'Faction AH'}</option>`).join('');
  $('#market-select').value = state.market;
}
async function loadReport(path) {
  if (!/^data\/reports\/[a-f0-9]{64}\.json$/.test(path || '')) throw new Error('This report is unavailable. Run the updated desktop publisher.');
  if (!reportCache.has(path)) reportCache.set(path, fetch(path).then(r => { if (!r.ok) throw new Error('Could not load the calculated report.'); return r.json(); }).catch(error => {reportCache.delete(path);throw error;}));
  return reportCache.get(path);
}
function setView() {
  const library = state.view === 'library', flips = state.view === 'flips';
  $('#overview-content').hidden = state.view !== 'overview';
  $('#masthead').hidden = state.view !== 'overview';
  $('#ledger-panel').hidden = library || flips;
  $('#library-panel').hidden = !library;
  $('#flips-panel').hidden = !flips;
  $('.market-toolbar').hidden = library || flips;
  $$('[data-view]').forEach(el => { if (el.dataset.view === state.view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#view-label').textContent = {overview:'Overview', ledger:'Item ledger', watchlist:'Watchlist', flips:'Cross-house flips', library:'Scans'}[state.view];
  $('#watch-count').textContent = favorites.size;
}
async function render() {
  const sequence = ++renderSequence;
  setMarketOptions();
  setView();
  state.loading = true;
  $('#ledger-panel').inert = true; $('#overview-content').inert = true; $('#flips-panel').inert = true;
  $('#data-notice').textContent = 'Loading calculated trends…';
  try {
    if (state.view === 'flips') {
      const report = await loadReport(state.report.flips);
      if (sequence !== renderSequence) return;
      if (report.version !== 1 || !Array.isArray(report.pairs)) throw new Error('Unsupported flip report. Run the updated desktop publisher.');
      state.flipReport = report;
      renderFlips();
      return;
    }
    const path = state.report.markets.find(m => m.key === state.market)?.periods[String(state.days)];
    const analysis = await loadReport(path);
    if (sequence !== renderSequence) return;
    state.analysis = analysis;
  } catch (error) {
    if (sequence === renderSequence) {
      $('#data-notice').textContent = `${error.message} Choose another period or refresh to try again.`;
      $('#ledger-panel').hidden=true;$('#overview-content').hidden=true;$('#flips-panel').hidden=true;
    }
    return;
  } finally {
    if (sequence === renderSequence) { state.loading = false; $('#ledger-panel').inert = false; $('#overview-content').inert = false; $('#flips-panel').inert = false; }
  }
  const a = state.analysis;
  $$('[data-days]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.days) === state.days)));
  $('#watch-count').textContent = favorites.size;
  $('#data-notice').innerHTML = `<p><strong>${count(state.report.snapshots.length)} saved scans.</strong> Latest observation: ${escape(fullDate(state.report.asOf))}.</p>`;
  $('#stat-items').textContent = count(a.items.length);
  const knownSupplyCount = a.summary.knownSupplyCount;
  $('#stat-supply').textContent = knownSupplyCount ? count(a.summary.listedSupply) : 'Unknown';
  $('#stat-supply-note').textContent = knownSupplyCount ? `${count(knownSupplyCount)} observed item types · buyout listings${a.latest.source === 'Auction Ledger' ? ' · partial capture' : ''}` : 'This source has no supply counts';
  $('#stat-date').textContent = a.latest ? shortDate(a.latest.timestamp) : 'No scans';
  $('#stat-date-label').textContent = a.latest?.source === 'Auctionator daily lows' ? 'Latest day bucket' : a.latest?.source === 'Auctionator cache' ? 'Cache captured' : 'Latest observation';
  $('#stat-date-note').textContent = a.latest ? `${new Date(a.latest.timestamp).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} · ${a.latest.source}` : 'Scan to begin';
  const index = a.series.at(-1)?.value;
  $('#stat-index').innerHTML = index != null ? `${index.toFixed(1)} ${a.series.length > 1 ? `<span class="stat-change">${percent(index - 100)}</span>` : ''}` : '—';
  $('#stat-index-note').textContent = `${a.basketSize} matched items · base 100`;
  $('#index-chart').innerHTML = chart(a.series);
  const omitted = a.summary.sparseScans;
  $('#index-caption').textContent = a.baseline ? `Reference: ${fullDate(a.baseline.timestamp)} · ${a.basketSize} fixed, matched items · equal weight${omitted ? ` · ${omitted} sparse scans omitted` : ''}${a.seriesCount > a.series.length ? ` · chart samples ${a.series.length} of ${a.seriesCount} observations` : ''}` : 'Publish snapshots to build a price index.';
  $('#mover-period').textContent = state.days === 36500 ? 'All history' : state.days === 1 ? '24h lookback' : `${state.days}d lookback`;
  const movers = a.summary.movers.map(key => a.items.find(i => i.key === key)).filter(Boolean);
  $('#movers').innerHTML = movers.length ? movers.map(i => `<button class="mover" data-item="${escape(i.key)}">${icon(i)}<span class="mover-info"><span class="mover-name">${escape(i.name)}</span>${money(i.minBuyout)}</span>${percent(i.change)}</button>`).join('') : '<div class="empty-state"><h3>Every story needs a second scan.</h3><p>Publish another observation to compare prices.</p></div>';
  const spreads = a.summary.positiveSpreads;
  $('#insight-text').innerHTML = spreads ? `<strong>${count(spreads)} items</strong> are below their observed median after a hypothetical 5% AH cut. Check the depth before you trade.` : 'No positive resale spreads against the observed median.';
  renderLedger(); renderLibrary();
}

function renderLedger() {
  const moving = state.rank === 'activity', activity = state.analysis.activity;
  $('#activity-controls').hidden = !moving;
  $('#activity-scans').hidden = !moving;
  $('#activity-note').hidden = !moving;
  $('#ledger-table').classList.toggle('movement-table', moving);
  $('#ledger-head').innerHTML = moving ? '<tr><th class="watch-column"><span class="sr-only">Watch</span></th><th><button data-sort="name">Item ↕</button></th><th class="number"><button data-sort="unitsPerHour">Net units / h ↕</button></th><th class="number">Listed units</th><th class="number"><button data-sort="listingsPerHour">Net auctions / h ↕</button></th><th class="number"><button data-sort="minBuyout">Unit buyout ↕</button></th><th class="number"><button data-sort="percentPerHour">Net supply % / h ↕</button></th><th><span class="sr-only">Open item</span></th></tr>' : ledgerHead;
  if (moving) {
    $('#activity-direction').value = state.activityDirection;
    $('#activity-sort').value = state.sort;
    $('#activity-scans').innerHTML = [['Previous scan', activity?.previous], ['Latest scan', activity?.latest]].map(([label, scan]) => {
      const capture = scan?.capture;
      const detail = capture ? `${count(capture.captured)} / ${count(capture.received)} returned rows captured` : scan ? 'Capture count unavailable' : 'Save and publish a second scan of this AH';
      return `<div><p>${label}</p><strong>${scan ? escape(fullDate(scan.timestamp)) : 'Not available'}</strong><small>${escape(detail)}${scan ? ` · ${escape(scan.coverage)} market coverage` : ''}</small></div>`;
    }).join('');
  }
  let items = state.analysis.items.filter(i => (!state.search || `${i.name} ${i.itemId}`.toLowerCase().includes(state.search.toLowerCase())) && (!state.category || i.category === state.category) && (state.view !== 'watchlist' || isWatched(i)));
  if (state.rank === 'spread') items = items.filter(i => i.spread > 0 && i.history.length > 1);
  if (state.rank === 'movers') items = items.filter(i => i.change != null);
  if (state.rank === 'supply') items = items.filter(i => i.quantity != null);
  if (moving) items = items.filter(i => i.activity && (state.activityDirection === 'falling' ? i.activity.unitChange < 0 : state.activityDirection === 'growing' ? i.activity.unitChange > 0 : i.activity.unitChange !== 0 || (i.activity.listingChange ?? 0) !== 0));
  const field = state.sort;
  const value = i => moving && ['unitsPerHour','percentPerHour','listingsPerHour'].includes(field) ? i.activity?.[field] : i[field];
  items.sort((a, b) => {
    if (value(a) == null) return value(b) == null ? a.name.localeCompare(b.name) : 1;
    if (value(b) == null) return -1;
    const order = field === 'name' ? a.name.localeCompare(b.name) : (state.rank === 'movers' && field === 'change' ? Math.abs(value(a)) - Math.abs(value(b)) : value(a) - value(b));
    return (state.descending ? -order : order) || a.name.localeCompare(b.name);
  });
  const size = 15, pages = Math.max(1, Math.ceil(items.length / size));
  state.page = Math.min(state.page, pages - 1);
  const visible = items.slice(state.page * size, (state.page + 1) * size);
  $('#ledger-title').firstChild.textContent = state.view === 'watchlist' ? 'Your watchlist ' : moving ? 'Moving fast ' : 'Item ledger ';
  $('#item-count').textContent = `${count(items.length)} items`;
  $$('[data-rank]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rank === state.rank)));
  $$('[data-sort]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort));
    b.closest('th').setAttribute('aria-sort', b.dataset.sort === state.sort ? state.descending ? 'descending' : 'ascending' : 'none');
  });
  $('#ranking-explainer').textContent = {
    all: 'Cheapest observed unit buyouts. Open an item for its history and resale calculator.',
    movers: 'Largest absolute changes vs the reference scan. New items without a reference are excluded.',
    supply: 'Most units listed in the latest snapshot. Listed volume is availability, not confirmed sales.',
    spread: 'Median observed minimum buyout × 95% − current minimum buyout. Per unit; excludes lost deposits. Not guaranteed profit.',
    activity: `${state.analysis.latest.faction} AH · net buyout supply changes between the latest two scans · ${interval(activity?.hours)} · ${count(activity?.matchedItems ?? 0)} matched item variants. Price-history period does not change this interval.`,
  }[state.rank];
  $('#ledger-body').innerHTML = visible.map(i => `<tr><td><button class="watch-button" data-watch="${escape(i.key)}" aria-pressed="${isWatched(i)}" aria-label="${isWatched(i) ? 'Unwatch' : 'Watch'} ${escape(i.name)}">${isWatched(i) ? '★' : '☆'}</button></td><td><button class="item-button" data-item="${escape(i.key)}">${icon(i)}<span><span class="item-name">${escape(i.name)}</span><span class="item-meta">${escape(i.category)} · #${i.itemId}</span></span></button></td>${moving ? `<td class="number activity-rate" data-label="Net units / hour">${net(i.activity.unitsPerHour)}<small>${net(i.activity.unitChange)} units between scans</small></td><td class="number" data-label="Listed units">${count(i.activity.quantityBefore)} → ${count(i.activity.quantityAfter)}</td><td class="number" data-label="Net auctions / hour">${net(i.activity.listingsPerHour)}<small>${i.activity.listingChange == null ? 'Auction counts unknown' : `${net(i.activity.listingChange)} auctions between scans`}</small></td><td class="number" data-label="Unit buyout">${money(i.minBuyout)}</td><td class="number" data-label="Net supply % / hour">${net(i.activity.percentPerHour)}${i.activity.percentPerHour == null ? '' : '%'}</td>` : `<td class="number">${money(i.minBuyout)}</td><td class="number">${percent(i.change)}</td><td class="number supply">${count(i.quantity)}</td><td class="number ${i.spread > 0 ? 'positive' : 'unknown'}">${i.history.length > 1 ? money(i.spread) : '—'}</td><td class="number">${sparkline(i.history)}</td>`}<td><button class="row-open" data-item="${escape(i.key)}" aria-label="View ${escape(i.name)} details">↗</button></td></tr>`).join('');
  $('#ledger-empty').hidden = items.length > 0;
  $('#ledger-empty h3').textContent = moving ? !activity ? 'Publish updated movement reports' : !activity.previous ? 'A second scan is needed' : 'No matching supply changes' : 'No items found';
  $('#ledger-empty p').textContent = moving ? !activity ? 'Run the updated desktop publisher, then refresh this page.' : !activity.previous ? 'Save another scan of this AH, /reload, and run the publisher.' : 'Try another direction, category or search. Only items with quantities in both scans are compared.' : 'Try another search or add an item to your watchlist using its star.';
  $('#table-summary').textContent = items.length ? `Showing ${state.page * size + 1}–${Math.min((state.page + 1) * size, items.length)} of ${count(items.length)} · ${moving ? 'net supply changes, not confirmed sales' : 'prices per unit'}` : 'No matching observations';
  $('#page-label').textContent = `${state.page + 1} / ${pages}`;
  $('#previous-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page === pages - 1;
}
function renderLibrary() {
  const real = [...state.report.snapshots].reverse();
  $('#library-body').innerHTML = real.map(s => `<tr><td>${escape(fullDate(s.timestamp))}</td><td>${s.faction === 'Neutral' ? 'Neutral AH' : 'Faction AH'}</td><td>${escape(s.source)}</td><td class="number">${count(s.itemCount)}</td></tr>`).join('');
}

function renderFlips() {
  const report = state.flipReport;
  if (!report) return;
  const pair = report.pairs[0];
  $('#data-notice').textContent = 'Buy on one Auction House, resell on the other. These are saved observations, not live offers or confirmed sales.';
  $('#flip-fees').textContent = `Assumed sale fees: Faction ${report.fees.factionPercent}% · Neutral ${report.fees.neutralPercent}%`;
  $('#flip-scans').innerHTML = [['Faction', pair?.factionScan],['Neutral', pair?.neutralScan]].map(([house, scan]) => `<div><p>${house} AH</p><strong>${scan ? escape(fullDate(scan.timestamp)) : 'Not scanned'}</strong><small>${scan ? `${count(scan.itemCount)} item variants · ${escape(scan.coverage)} capture` : 'Open this AH and save a scan'}</small></div>`).join('');
  const dates = [pair?.factionScan, pair?.neutralScan].map(scan => Date.parse(scan?.timestamp));
  const missing = !pair?.factionScan || !pair?.neutralScan;
  const now = Date.now(), future = !missing && dates.some(date => date > now + 300000);
  const stale = !missing && (future || dates.some(date => !Number.isFinite(date) || now - date > state.flipHours * 3600000));
  let items = missing || stale ? [] : pair.items.filter(item =>
    (state.flipDirection === 'all' || item.direction === state.flipDirection) &&
    (!state.flipSearch || `${item.name} ${item.itemId}`.toLowerCase().includes(state.flipSearch.toLowerCase())) &&
    item.margin >= state.flipMin * 10000 && item.roi <= state.flipMax);
  const [field, direction] = state.flipSort.split(':');
  items.sort((a, b) => {
    const order = field === 'name' ? a.name.localeCompare(b.name) : a[field] - b[field];
    return (direction === 'desc' ? -order : order) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
  $('#flip-sort').value = state.flipSort;
  const returnSort = $('#flip-roi-sort');
  returnSort.closest('th').setAttribute('aria-sort', field === 'roi' ? direction === 'desc' ? 'descending' : 'ascending' : 'none');
  returnSort.setAttribute('aria-label', `Sort return on cost, ${state.flipSort === 'roi:desc' ? 'lowest' : 'highest'} first`);
  returnSort.querySelector('span').textContent = field === 'roi' ? direction === 'desc' ? '↓' : '↑' : '↕';
  const size = 15, pages = Math.max(1, Math.ceil(items.length / size));
  state.flipPage = Math.min(state.flipPage, pages - 1);
  const visible = items.slice(state.flipPage * size, (state.flipPage + 1) * size);
  $('#flip-count').textContent = `${count(items.length)} opportunities`;
  $$('[data-flip-direction]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.flipDirection === state.flipDirection)));
  $('#flip-body').innerHTML = visible.map(item => {
    const route = item.direction === 'neutral-to-faction' ? 'Neutral → Faction' : 'Faction → Neutral';
    return `<tr><td><a class="item-button" href="https://www.wowhead.com/classic/item=${item.itemId}" target="_blank" rel="noreferrer">${icon(item)}<span><span class="item-name">${escape(item.name)}</span><span class="item-meta">${escape(item.category)} · #${item.itemId}${item.key.includes(':v1:') ? ' · variant' : ''}</span></span></a></td><td class="flip-route">${route}</td><td class="number" data-label="Buy / unit">${money(item.buy)}</td><td class="number" data-label="Sell / unit">${money(item.sell)}</td><td class="number positive" data-label="Margin / unit">${money(item.margin)}<small>${item.feePercent}% sale fee included</small></td><td class="number" data-label="Return on cost">${percent(item.roi)}</td></tr>`;
  }).join('');
  $('#flip-empty').hidden = items.length > 0;
  let title = 'No flips match these filters', explanation = 'Try another direction, a lower minimum margin, a higher return limit, or a different item search.';
  if (missing) {
    title = !pair?.neutralScan && pair?.factionScan ? 'Scan the Neutral Auction House' : !pair?.factionScan && pair?.neutralScan ? 'Scan your Faction Auction House' : 'Scan both Auction Houses';
    explanation = 'At each AH, use /ald scan faction or /ald scan neutral. Save, /reload, then run Auction Ledger Flips.';
  } else if (future) {
    title = 'Scan times are ahead of this device’s clock';
    explanation = 'Check the clocks on the scanning computer and this device, then publish fresh scans. Future-dated comparisons are hidden.';
  } else if (stale) {
    title = 'These scans are outside your age limit';
    explanation = 'Save and publish a fresh scan at each house, or choose a longer scan age to inspect older comparisons. Both scan times are shown above.';
  } else if (!pair.matchedItems) {
    title = 'No matching item variants in these scans';
    explanation = 'Only identical item variants can be compared. Partial captures may miss items; publish another scan at each house.';
  } else if (!pair.items.length) {
    title = 'No positive margins after sale fees';
    explanation = 'The shared items in these scans do not cover the destination house’s sale fee.';
  }
  $('#flip-empty h3').textContent = title;
  $('#flip-empty p').textContent = explanation;
  $('#flip-summary').textContent = `${count(pair?.matchedItems || 0)} shared item variants${items.length ? ` · showing ${state.flipPage * size + 1}–${Math.min((state.flipPage + 1) * size, items.length)} of ${count(items.length)}` : ''}${Number.isFinite(state.flipMax) ? ` · return capped at ${count(state.flipMax)}%` : ''}`;
  $('#flip-page-label').textContent = `${state.flipPage + 1} / ${pages}`;
  $('#flip-previous').disabled = state.flipPage === 0;
  $('#flip-next').disabled = state.flipPage === pages - 1;
}

function openItem(key) {
  const i = state.analysis.items.find(i => i.key === key);
  if (!i) return;
  state.current = i;
  $('#item-identity').innerHTML = `<div class="item-identity">${icon(i)}<div><h2 id="item-title">${escape(i.name)}</h2><p>${escape(state.analysis.latest.faction)} AH · #${i.itemId}</p></div></div>`;
  $('#item-stats').innerHTML = `<div><p>Lowest unit buyout</p><strong>${money(i.minBuyout)}</strong></div><div><p>Change vs reference</p><strong>${percent(i.change)}</strong></div><div><p>Listed units</p><strong class="mono">${count(i.quantity)}</strong></div>`;
  $('#item-activity').hidden = !i.activity;
  $('#item-activity').textContent = i.activity ? `Latest supply movement: ${count(i.activity.quantityBefore)} → ${count(i.activity.quantityAfter)} units; ${net(i.activity.unitsPerHour)} units/hour. Scans ${interval(state.analysis.activity?.hours)}. Net auction count: ${net(i.activity.listingChange)}. This does not confirm sales.` : '';
  $('#item-chart').innerHTML = chart(i.history.map(h => ({timestamp:h.timestamp, value:h.price})), {price:true, id:'item-fill', label:`${i.name} minimum unit buyout history`});
  $('#item-history-note').textContent = `${i.historyCount ?? i.history.length} observations · ${fullDate(i.history[0].timestamp)} to ${fullDate(i.history.at(-1).timestamp)}.${i.historyCount > i.history.length ? ` Chart shows ${i.history.length} measured samples; metrics use all observations.` : ''}`;
  $('#calc-buy').value = (i.minBuyout / 10000).toFixed(4);
  $('#calc-sell').value = (i.reference / 10000).toFixed(4);
  $('#calc-quantity').value = '1'; $('#calc-cut').value = '5'; $('#calc-expenses').value = '0';
  $('#item-reference-link').href = `https://www.wowhead.com/classic/item=${i.itemId}`;
  calculate(); $('#item-dialog').showModal();
}
function calculate() {
  try {
    if (!$('#calculator-form').checkValidity()) throw new Error('Enter valid amounts and a whole quantity.');
    const {fee, net} = resale({buy:Number($('#calc-buy').value) * 10000, sell:Number($('#calc-sell').value) * 10000, quantity:Number($('#calc-quantity').value), cut:Number($('#calc-cut').value), expenses:Number($('#calc-expenses').value) * 10000});
    $('#calc-result').innerHTML = `<div><span>Potential ${net < 0 ? 'loss' : 'net gain'}</span><small>After ${money(fee)} in AH fees and entered costs</small></div><strong class="${net < 0 ? 'negative' : 'positive'}">${money(net)}</strong>`;
  } catch (e) { $('#calc-result').textContent = e.message; }
}
document.addEventListener('click', async event => {
  const t = event.target.closest('button,a'); if (!t) return;
  if (t.dataset.item && !state.loading) openItem(t.dataset.item);
  if (t.dataset.watch && !state.loading) {
    const i = state.analysis.items.find(i => i.key === t.dataset.watch), key = watchKey(i);
    const next = new Set(favorites); next.has(key) ? next.delete(key) : next.add(key);
    try { localStorage.setItem('auction-ledger-watchlist', JSON.stringify([...next])); favorites = next; render(); } catch { notify('Could not save watchlist. Browser storage may be disabled.'); }
  }
  if (t.dataset.days) { state.days = Number(t.dataset.days); state.page = 0; render(); }
  if (t.dataset.rank) { state.rank = t.dataset.rank; state.sort = {all:'name',movers:'change',supply:'quantity',spread:'spread',activity:'unitsPerHour'}[state.rank]; state.descending = state.rank === 'activity' ? state.activityDirection === 'growing' : state.rank !== 'all'; state.page = 0; renderLedger(); }
  if (t.dataset.sort) { state.descending = state.sort === t.dataset.sort ? !state.descending : t.dataset.sort !== 'name'; state.sort = t.dataset.sort; state.page = 0; renderLedger(); }

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
$('#activity-button').addEventListener('click', () => { $('[data-rank="activity"]').click(); $('#ledger-panel').scrollIntoView({behavior:'auto',block:'start'}); });
$('#activity-direction').addEventListener('change', e => { state.activityDirection = e.target.value; state.descending = state.sort === 'name' ? false : state.activityDirection === 'growing'; state.page = 0; renderLedger(); });
$('#activity-sort').addEventListener('change', e => { state.sort = e.target.value; state.descending = state.sort === 'name' ? false : state.activityDirection === 'growing'; state.page = 0; renderLedger(); });
$('#flip-search').addEventListener('input', e => { state.flipSearch = e.target.value; state.flipPage = 0; renderFlips(); });
$('#flip-min').addEventListener('input', e => { if (!e.target.checkValidity()) return; state.flipMin = Number(e.target.value); state.flipPage = 0; renderFlips(); });
$('#flip-max').addEventListener('input', e => { if (!e.target.checkValidity()) return; state.flipMax = e.target.value === '' ? Infinity : Number(e.target.value); state.flipPage = 0; renderFlips(); });
$('#flip-age').addEventListener('change', e => { state.flipHours = Number(e.target.value); state.flipPage = 0; renderFlips(); });
$('#flip-sort').addEventListener('change', e => { state.flipSort = e.target.value; state.flipPage = 0; renderFlips(); });
$('#flip-roi-sort').addEventListener('click', () => { state.flipSort = state.flipSort === 'roi:desc' ? 'roi:asc' : 'roi:desc'; state.flipPage = 0; renderFlips(); });
$$('[data-flip-direction]').forEach(button => button.addEventListener('click', () => { state.flipDirection = button.dataset.flipDirection; state.flipPage = 0; renderFlips(); }));
$('#flip-previous').addEventListener('click', () => { state.flipPage--; renderFlips(); });
$('#flip-next').addEventListener('click', () => { state.flipPage++; renderFlips(); });
window.addEventListener('focus', () => { if (state.view === 'flips' && !state.loading) renderFlips(); });
document.addEventListener('keydown', e => { if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches('input,select,textarea') && !document.querySelector('dialog[open]')) { e.preventDefault(); if (state.view === 'library') location.hash = 'ledger'; $(state.view === 'flips' ? '#flip-search' : '#search').focus(); } });
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset.fallbackStage === 'remote') { delete img.dataset.fallbackStage; img.src = 'assets/icons/inv_misc_questionmark.jpg'; return; }
  if (!img.dataset.fallback) return;
  const name = img.dataset.fallback; delete img.dataset.fallback;
  img.dataset.fallbackStage = 'remote';
  img.src = `https://wow.zamimg.com/images/wow/icons/large/${encodeURIComponent(name)}.jpg`;
}, true);
function route() { state.view = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview'; state.page = 0; if (state.report) render(); }
window.addEventListener('hashchange', route);
async function boot() {
  $('.market-toolbar').inert=true;$('#ledger-panel').inert=true;$('#overview-content').inert=true;
  try {
    const response = await fetch('data/trends.json', {cache:'no-store'});
    if (!response.ok) throw new Error('Could not load the published trend index.');
    state.report = await response.json();
    if (state.report.version !== 1 || !state.report.markets?.length) throw new Error('Unsupported trend report. Run the local publisher to rebuild it.');
    $('.market-toolbar').inert=false;
    state.view = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    await render();
  } catch (error) { $('#data-notice').textContent = `${error.message} Try refreshing.`; }
}
boot();
