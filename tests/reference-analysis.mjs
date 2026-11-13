// Independent reference retained to verify the native calculation engine. Never shipped to the browser.
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
export function analyze(snapshots, days = 7) {
  if (!snapshots.length) return {items: [], series: [], latest: null, baseline: null, basketSize: 0};
  const ordered = [...snapshots].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = ordered.at(-1);
  const target = Date.parse(latest.timestamp) - days * 86400000;
  const baseline = ordered.findLast(s => Date.parse(s.timestamp) <= target) || ordered[0];
  const window = ordered.filter(s => Date.parse(s.timestamp) >= Date.parse(baseline.timestamp));
  const maps = window.map(s => new Map(s.items.map(i => [i.key, i])));
  const old = maps[0];
  const histories = new Map(latest.items.map(i => [i.key, []]));
  window.forEach((s, index) => { for (const [key, i] of maps[index]) histories.get(key)?.push({timestamp: s.timestamp, price: i.minBuyout, quantity: i.quantity}); });
  const items = latest.items.map(i => {
    const history = histories.get(i.key);
    const previous = old.get(i.key);
    const reference = median(history.map(h => h.price));
    return {...i, history, change: previous && baseline !== latest ? (i.minBuyout / previous.minBuyout - 1) * 100 : null,
      supplyChange: previous?.quantity != null && i.quantity != null && baseline !== latest ? i.quantity - previous.quantity : null,
      reference, spread: Math.floor(reference * 0.95) - i.minBuyout};
  });
  // Fix the basket at both endpoints. Sparse intermediate scans must not erase the
  // whole history or change the composition of an otherwise comparable basket.
  const basket = items.filter(i => old.has(i.key));
  const series = window.map((s, index) => {
    const complete = basket.length && basket.every(i => maps[index].has(i.key));
    return {timestamp: s.timestamp, value: complete ? basket.reduce((sum, i) => sum + maps[index].get(i.key).minBuyout / old.get(i.key).minBuyout, 0) / basket.length * 100 : null};
  });
  return {items, latest, baseline, series, basketSize: basket.length};
}
