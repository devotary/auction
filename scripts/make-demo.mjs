import {writeFile} from 'node:fs/promises';
import {catalog} from '../market.js';

// Deterministic ILLUSTRATIVE observations. Never presented as live realm prices.
const end = Date.UTC(2026, 10, 13, 6);
const base = [24700, 1420000, 33100, 14800, 5200, 28400, 183000, 6800, 89000, 543000, 718000, 940, 67100, 229000, 87500, 2130000, 73500, 16200, 14500, 53000, 2100, 32000, 276000, 262000];
const snapshots = Array.from({length:61}, (_, n) => ({
  realm:'Sample realm', faction:'Alliance', source:'Sample Auctioneer', coverage:'full',
  timestamp:new Date(end - (60 - n) * 12 * 3600000).toISOString(),
  items:Object.entries(catalog).map(([id, [name, icon, category, quality]], k) => {
    const start = base[k];
    const trend = [1.18,.82,1.36,1.04,.75,1.22,.9,1.12,1.28,.93][k % 10];
    const market = start * (1 + (trend - 1) * n / 60) * (1 + Math.sin(n * .44 + k) * .055 + Math.cos(n * .19 + k * 2) * .035);
    const dip = n > 53 && [2,7,14,18].includes(k) ? 1 - (n - 53) * .045 : 1;
    const quantity = Math.max(5, Math.round((k % 5 === 0 ? 35 : k % 3 === 0 ? 2100 : 420) * (1 + Math.sin(n * .28 + k) * .27)));
    return {itemId:Number(id), key:`${id}:0:0`, name, icon, category, quality, minBuyout:Math.round(market * dip), medianBuyout:Math.round(market * 1.09), quantity, listings:Math.max(2, Math.round(quantity / (k % 5 === 0 ? 1.5 : 12)))};
  }),
}));
await writeFile(new URL('../data/demo.json', import.meta.url), JSON.stringify({version:1,sample:true,snapshots}));
console.log(`Generated ${snapshots.length} sample snapshots, ${snapshots[0].items.length} items each.`);
