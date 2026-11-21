// All prices are integer copper. Only allowlisted aggregate fields leave the importer.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const CATEGORIES = ['Trade goods', 'Consumables', 'Equipment', 'Recipes', 'Other'];
export const catalog = {
  13463: ['Dreamfoil', 'inv_misc_herb_dreamfoil', 'Trade goods', 1],
  13468: ['Black Lotus', 'inv_misc_herb_blacklotus', 'Trade goods', 2],
  13465: ['Mountain Silversage', 'inv_misc_herb_mountainsilversage', 'Trade goods', 1],
  13467: ['Icecap', 'inv_misc_herb_icecap', 'Trade goods', 1],
  13464: ['Golden Sansam', 'inv_misc_herb_sansamroot', 'Trade goods', 1],
  13466: ['Plaguebloom', 'inv_misc_herb_plaguebloom', 'Trade goods', 1],
  14344: ['Large Brilliant Shard', 'inv_enchant_shardbrilliantlarge', 'Trade goods', 3],
  16204: ['Illusion Dust', 'inv_enchant_dustillusion', 'Trade goods', 1],
  16203: ['Greater Eternal Essence', 'inv_enchant_essenceeternallarge', 'Trade goods', 2],
  12363: ['Arcane Crystal', 'inv_misc_gem_topaz_01', 'Trade goods', 2],
  12360: ['Arcanite Bar', 'inv_ingot_02', 'Trade goods', 2],
  14047: ['Runecloth', 'inv_fabric_purplefire_01', 'Trade goods', 1],
  14256: ['Felcloth', 'inv_fabric_felcloth_ebon', 'Trade goods', 1],
  15407: ['Cured Rugged Hide', 'inv_misc_pelt_bear_03', 'Trade goods', 1],
  13452: ['Elixir of the Mongoose', 'inv_potion_32', 'Consumables', 1],
  13510: ['Flask of the Titans', 'inv_potion_62', 'Consumables', 1],
  13457: ['Greater Fire Protection Potion', 'inv_potion_24', 'Consumables', 1],
  13444: ['Major Mana Potion', 'inv_potion_76', 'Consumables', 1],
  13931: ['Nightfin Soup', 'inv_drink_17', 'Consumables', 1],
  12800: ['Azerothian Diamond', 'inv_misc_gem_diamond_01', 'Trade goods', 2],
  8150: ['Deeprock Salt', 'inv_misc_dust_02', 'Trade goods', 1],
  7068: ['Elemental Fire', 'spell_fire_fire', 'Trade goods', 1],
  7078: ['Essence of Fire', 'spell_fire_volcano', 'Trade goods', 2],
  7080: ['Essence of Water', 'spell_nature_acid_01', 'Trade goods', 2],
};

export function marketKey(s) { return JSON.stringify([s.realm, s.faction, s.source]); }
export function snapshotKey(s) { return JSON.stringify([s.realm, s.faction, s.source, s.timestamp]); }
export function text(value, fallback = '', max = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, max) : fallback;
}
function number(value, {nullable = false, min = 0, max = 1e14, integer = false} = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error('Invalid price, quantity, or item ID in scan.');
  return n;
}
export function isoDate(value) {
  if (value === null || value === undefined || value === '') throw new Error('A scan needs an observation date.');
  const d = new Date(typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : value);
  if (!Number.isFinite(+d) || +d < Date.UTC(2004, 0, 1) || +d > Date.now() + 86400000) throw new Error('Invalid scan date. Use an ISO date or Unix seconds.');
  return d.toISOString();
}
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100000) throw new Error('A snapshot needs 1–100,000 item observations.');
  let realm = text(raw.realm).trim();
  let faction = text(raw.faction).trim();
  if (raw.source === 'Auction Ledger') {
    realm = 'Auction House';
    if (['Alliance', 'Horde'].includes(faction)) faction = 'Faction';
    if (!['Faction', 'Neutral'].includes(faction)) throw new Error('Auction Ledger scans must identify Faction or Neutral AH.');
  }
  if (!realm || !faction) throw new Error('Choose a realm and faction before importing.');
  const items = raw.items.map(i => {
    const itemId = number(i.itemId, {min: 1, max: 1e9, integer: true});
    const known = catalog[itemId];
    const genericName = !i.name || i.name === `Item #${itemId}`;
    const icon = text(i.icon === 'inv_misc_questionmark' && known ? known[1] : i.icon, known?.[1] || 'inv_misc_questionmark', 100).toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(blp|tga|jpg|png)$/, '');
    return {
      itemId, key: text(i.key, String(itemId), 120),
      name: genericName && known ? known[0] : text(i.name, `Item #${itemId}`),
      icon: /^[a-z0-9_-]+$/.test(icon) ? icon : 'inv_misc_questionmark',
      category: i.category === 'Other' && known ? known[2] : CATEGORIES.includes(i.category) ? i.category : known?.[2] || 'Other',
      quality: number(genericName && known ? known[3] : i.quality ?? known?.[3] ?? 1, {max: 8, integer: true}),
      minBuyout: number(i.minBuyout, {min: 1, integer: true}),
      medianBuyout: i.medianBuyout === null ? null : number(i.medianBuyout ?? i.minBuyout, {min: 1, integer: true}),
      quantity: number(i.quantity, {nullable: true, integer: true}),
      listings: number(i.listings, {nullable: true, integer: true}),
    };
  });
  if (new Set(items.map(i => i.key)).size !== items.length) throw new Error('Duplicate item keys in snapshot. Import individual listings as CSV instead.');
  let capture;
  if (raw.source === 'Auction Ledger' && raw.capture != null) {
    const captured = number(raw.capture.captured, {min: 1, max: 500000, integer: true});
    const received = number(raw.capture.received, {min: captured, max: 1e9, integer: true});
    capture = {captured, received};
  }
  return {realm, faction, source: text(raw.source, 'JSON', 40), timestamp: isoDate(raw.timestamp),
    ...(raw.source === 'Auction Ledger' && raw.detail === 'summary' ? {detail:'summary'} : {}),
    coverage: raw.coverage === 'full' ? 'full' : 'partial', ...(capture ? {capture} : {}), items};
}
export function mergeSnapshots(...groups) {
  const map = new Map();
  for (const group of groups) for (const raw of group) {
    const s = sanitizeSnapshot(raw);
    map.set(snapshotKey(s), s);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
export function aggregateListings(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!(Number(row.buyout) > 0) || !(Number(row.count) > 0)) continue; // Bid-only auctions have no buyout.
    const key = row.key || String(row.itemId);
    const g = groups.get(key) || { ...row, key, prices: [], quantity: 0, listings: 0 };
    g.prices.push({price: Number(row.buyout) / Number(row.count), count: Number(row.count)});
    g.quantity += Number(row.count); g.listings++;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    g.prices.sort((a, b) => a.price - b.price);
    let units = 0, middle = g.prices[0].price;
    for (const p of g.prices) { units += p.count; if (units >= g.quantity / 2) { middle = p.price; break; } }
    return {itemId: g.itemId, key: g.key, name: g.name, icon: g.icon, quality: g.quality, category: g.category,
      minBuyout: Math.round(g.prices[0].price), medianBuyout: Math.round(middle), quantity: g.quantity, listings: g.listings};
  }).filter(i => i.minBuyout > 0);
}
