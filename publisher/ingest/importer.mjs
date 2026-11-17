import {aggregateListings, sanitizeSnapshot, mergeSnapshots, isoDate, MAX_FILE_BYTES} from './market.mjs';
import {createHash} from 'node:crypto';

// SavedVariables are DATA. This parser accepts literals, never Lua execution.
export function parseLua(input) {
  if (input.length > MAX_FILE_BYTES) throw new Error('File exceeds the 64 MiB import limit.');
  let p = 0, count = 0;
  const error = () => { throw new Error(`Unsupported Lua syntax near character ${p}. Only SavedVariables table literals are accepted.`); };
  const longString = () => {
    const open = input.slice(p).match(/^\[(=*)\[/);
    if (!open) return null;
    p += open[0].length;
    const end = input.indexOf(`]${open[1]}]`, p);
    if (end < 0) error();
    const result = input.slice(p, end).replace(/^\r?\n/, '');
    p = end + open[1].length + 2; return result;
  };
  function space() {
    while (p < input.length) {
      if (/\s/.test(input[p])) { p++; continue; }
      if (input.slice(p, p + 2) !== '--') break;
      p += 2;
      if (input.slice(p).match(/^\[(=*)\[/)) longString();
      else { while (p < input.length && input[p] !== '\n') p++; }
    }
  }
  function word() { const m = input.slice(p).match(/^[A-Za-z_][A-Za-z0-9_]*/); if (!m) error(); p += m[0].length; return m[0]; }
  function value(depth = 0) {
    if (depth > 64 || ++count > 3000000) throw new Error('Lua table exceeds import complexity limit.');
    space(); const c = input[p];
    if (c === '"' || c === "'") {
      p++; let result = '';
      while (p < input.length && input[p] !== c) {
        let ch = input[p++];
        if (ch === '\\') {
          ch = input[p++];
          const escapes = {a:'\x07', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t', v:'\v', '\\':'\\', '"':'"', "'":"'", '\n':'\n'};
          if (/\d/.test(ch)) { let digits = ch; for (let j = 0; j < 2 && /\d/.test(input[p] || 'x'); j++) digits += input[p++]; if (+digits > 255) error(); ch = String.fromCharCode(+digits); }
          else if (ch === 'x') { const hex = input.slice(p, p + 2); if (!/^[a-f\d]{2}$/i.test(hex)) error(); ch = String.fromCharCode(parseInt(hex, 16)); p += 2; }
          else if (ch === 'z') { while (/\s/.test(input[p] || 'x')) p++; ch = ''; }
          else if (Object.hasOwn(escapes, ch)) ch = escapes[ch];
          else error();
        }
        result += ch;
      }
      if (input[p++] !== c) error();
      return result;
    }
    if (c === '[') { const v = longString(); if (v === null) error(); return v; }
    if (c === '{') {
      p++; const table = Object.create(null); let index = 1;
      space();
      while (input[p] !== '}') {
        if (p >= input.length) error();
        let key, v;
        if (input[p] === '[' && !/^\[(=*)\[/.test(input.slice(p))) {
          p++; key = value(depth + 1); space(); if (input[p++] !== ']') error(); space(); if (input[p++] !== '=') error(); v = value(depth + 1);
        } else {
          const start = p;
          const name = input.slice(p).match(/^[A-Za-z_][A-Za-z0-9_]*/);
          if (name) { p += name[0].length; space(); }
          if (name && input[p] === '=') { key = name[0]; p++; v = value(depth + 1); }
          else { p = start; key = index++; v = value(depth + 1); }
        }
        if (!['string', 'number'].includes(typeof key)) error();
        if (Object.hasOwn(table, key)) throw new Error('Duplicate key in Lua table.');
        table[key] = v; space();
        if (input[p] === ',' || input[p] === ';') { p++; space(); }
        else if (input[p] !== '}') error();
      }
      p++; return table;
    }
    const n = input.slice(p).match(/^-?(?:0x[\da-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i);
    if (n) { p += n[0].length; const number = Number(n[0]); if (!Number.isFinite(number)) error(); return number; }
    const name = word();
    if (name === 'nil') return null;
    if (name === 'true') return true;
    if (name === 'false') return false;
    error();
  }
  space();
  if (/^return\b/.test(input.slice(p))) { word(); const result = value(); space(); if (input[p] === ';') { p++; space(); } if (p !== input.length) error(); return result; }
  const root = Object.create(null);
  while (p < input.length) { const name = word(); space(); if (input[p++] !== '=') error(); root[name] = value(); space(); if (input[p] === ';') { p++; space(); } }
  return root;
}

export function parseCSV(input) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let p = 0; p <= input.length; p++) {
    const c = input[p];
    if (quoted) {
      if (c === undefined) throw new Error('Unclosed CSV quote.');
      if (c === '"' && input[p + 1] === '"') { field += '"'; p++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') { if (field) throw new Error('Unexpected CSV quote.'); quoted = true; }
    else if (c === ',' || c === '\n' || c === undefined) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c !== ',') { if (row.some(x => x.trim())) rows.push(row); row = []; }
    } else field += c;
  }
  if (rows.length < 2) throw new Error('CSV needs a header and at least one item.');
  const headers = rows.shift().map(h => h.replace(/^\uFEFF/, '').trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV has duplicate headers.');
  return rows.map(r => { if (r.length !== headers.length) throw new Error('CSV rows must match the header.'); return Object.fromEntries(headers.map((h, i) => [h, r[i]])); });
}

const values = obj => obj && typeof obj === 'object' ? Object.values(obj) : [];

// Minimal RFC 8949 reader for Auctionator's integer/string/map CBOR database.
// Reject executable Lua, indefinite lengths, tags, floats, duplicate keys and trailing bytes.
export function decodeCBOR(binary) {
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  let p = 0, elements = 0;
  function take(n) { if (!Number.isSafeInteger(n) || n < 0 || p + n > bytes.length) throw new Error('Truncated Auctionator CBOR data.'); const start = p; p += n; return start; }
  function read(depth = 0) {
    if (depth > 32 || ++elements > 2000000) throw new Error('Auctionator CBOR complexity limit exceeded.');
    const initial = bytes[take(1)], major = initial >> 5, info = initial & 31;
    let length;
    if (info < 24) length = info;
    else if (info === 24) length = bytes[take(1)];
    else if (info === 25) length = view.getUint16(take(2));
    else if (info === 26) length = view.getUint32(take(4));
    else if (info === 27) { const n = view.getBigUint64(take(8)); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR integer exceeds safe range.'); length = Number(n); }
    else throw new Error('Unsupported indefinite CBOR encoding.');
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) {
      const begin = take(length), part = bytes.subarray(begin, begin + length);
      if (major === 3) return new TextDecoder('utf-8', {fatal:true}).decode(part);
      const chunks = []; for (let i = 0; i < part.length; i += 8192) chunks.push(String.fromCharCode(...part.subarray(i, i + 8192)));
      return chunks.join('');
    }
    if (major === 4 || major === 5) {
      if (length > 200000) throw new Error('CBOR collection is too large.');
      const result = Object.create(null);
      for (let i = 0; i < length; i++) {
        const key = major === 5 ? read(depth + 1) : i + 1;
        if (!['string','number'].includes(typeof key) || Object.hasOwn(result,key)) throw new Error('Invalid or duplicate CBOR key.');
        result[key] = read(depth + 1);
      }
      return result;
    }
    if (major === 7 && info === 20) return false;
    if (major === 7 && info === 21) return true;
    if (major === 7 && info === 22) return null;
    throw new Error('Unsupported CBOR type. Expected an Auctionator price database.');
  }
  const result = read();
  if (p !== bytes.length) throw new Error('Trailing bytes in Auctionator CBOR data.');
  return result;
}
function utf8(value) {
  if (typeof value !== 'string') return value;
  try { return new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(value,c => c.charCodeAt(0))); } catch { return value; }
}

function ledger(root) {
  const db = root.AuctionLedgerDB;
  if (db.version !== 1 || !db.scans || typeof db.scans !== 'object') throw new Error('Unsupported Auction Ledger saved-data format.');
  const scans=values(db.scans);
  if (scans.length>3) throw new Error('Auction Ledger file exceeds its retained scan limit.');
  const result=[];
  for (const scan of scans) {
    if (scan?.status !== 'saved') continue; // Interrupted work is never an observation.
    const variants=scan.variants,rawRows=values(scan.rows);
    if (!variants || typeof variants !== 'object' || rawRows.length>500000 || scan.captured!==rawRows.length || !Number.isInteger(scan.received) || scan.received<rawRows.length) throw new Error('Invalid Auction Ledger listing counts.');
    const timestamp=isoDate(scan.timestamp),startedAt=isoDate(scan.startedAt);
    if (Date.parse(startedAt)>Date.parse(timestamp)) throw new Error('Invalid Auction Ledger scan interval.');
    const metadata=new Map();
    for (const [index,m] of Object.entries(variants)) {
      if (!/^\d+$/.test(index) || !m || !Number.isInteger(m.itemId) || m.itemId<1 || m.itemId>1e9 || typeof m.itemString!=='string' || m.itemString.length>2048 || !/^item:\d+(?::[-\d]*)*$/.test(m.itemString)) throw new Error('Invalid Auction Ledger item variant.');
      const fields=m.itemString.split(':').map(field=>field===''?'0':field);
      if (Number(fields[1])!==m.itemId || fields.length>256 || fields.slice(1).some(field=>!Number.isSafeInteger(Number(field)))) throw new Error('Invalid Auction Ledger item identity.');
      for (const index of [8,9,10]) if (index<fields.length) fields[index]='0';
      while (fields.length>2 && fields.at(-1)==='0') fields.pop();
      const key=fields.length===2 ? String(m.itemId) : `${m.itemId}:v1:${createHash('sha256').update(fields.join(':')).digest('hex')}`;
      metadata.set(Number(index),{itemId:m.itemId,key,name:utf8(m.name),quality:m.quality,
        category:m.classID===7?'Trade goods':m.classID===0?'Consumables':[2,4].includes(m.classID)?'Equipment':m.classID===9?'Recipes':'Other'});
    }
    const rows=rawRows.map(row=>{
      if (typeof row!=='string' || row.length>200 || !/^\d+;\d+;\d+;\d+;\d+;\d+$/.test(row)) throw new Error('Invalid Auction Ledger compact listing.');
      const [variant,count,buyout,minBid,bid,timeLeft]=row.split(';').map(Number);
      if (![variant,count,buyout,minBid,bid,timeLeft].every(Number.isSafeInteger) || count<1 || count>1e9 || Math.max(buyout,minBid,bid)>1e14 || timeLeft>4 || !metadata.has(variant)) throw new Error('Invalid Auction Ledger listing values.');
      return {...metadata.get(variant),count,buyout};
    });
    const items=aggregateListings(rows);
    if (items.length) result.push(sanitizeSnapshot({realm:utf8(scan.realm),faction:scan.faction,source:'Auction Ledger',timestamp,coverage:'partial',capture:{captured:scan.captured,received:scan.received},items}));
  }
  return mergeSnapshots(result);
}
function auctioneer(root, options) {
  const result = [];
  const db = root.AucScanData;
  if (!db?.scans) throw new Error('No Auctioneer scans found. Choose Auc-ScanData.lua after completing a full scan and logging out.');
  const markets = [];
  for (const [realm, factions] of Object.entries(db.scans)) {
    if (factions && typeof factions === 'object' && (factions.image || factions.ropes)) {
      const split = realm.match(/^(.*)_(Alliance|Horde|Neutral)$/);
      if (!split) throw new Error('Unknown Auctioneer market key. Expected Realm_Alliance, Realm_Horde, or Realm_Neutral.');
      markets.push({realm:utf8(split[1]), faction:split[2], scan:factions});
      continue;
    }
    for (const [faction, scan] of Object.entries(factions)) {
      if (!scan || typeof scan !== 'object') continue;
      markets.push({realm:utf8(realm),faction,scan});
    }
  }
  for (const {realm, faction, scan} of markets) {
      let image = values(scan.image);
      for (const rope of values(scan.ropes)) {
        if (typeof rope !== 'string') throw new Error('Unsupported Auctioneer rope encoding.');
        for (const row of values(parseLua(rope))) image.push(row);
      }
      if (!image.length) continue;
      const rows = image.filter(r => r && typeof r === 'object' && !(Number(r[21]) & (2 | 4 | 128)));
      const observed = rows.map(r => Number(r[8])).filter(n => n > 1e9 && n < Date.now() / 1000 + 86400);
      const timestamp = scan.scanstats?.ImageUpdated || scan.scanstats?.LastFullScan || (observed.length ? observed.reduce((a, b) => Math.max(a, b), 0) : options.timestamp);
      const listings = rows.map(r => ({
        itemId: r[23] || String(r[1]).match(/item:(\d+)/)?.[1],
        key: `${r[23] || String(r[1]).match(/item:(\d+)/)?.[1]}:${r[24] || 0}:${r[26] || 0}${typeof r[22] === 'string' ? ':' + r[22] : ''}${[2,4].includes(r[3]) ? ':ilvl' + r[2] : ''}`,
        name: utf8(r[9]), icon: r[10], count: r[11], quality: r[12], buyout: r[17],
        category: r[3] === 7 ? 'Trade goods' : r[3] === 0 ? 'Consumables' : [2, 4].includes(r[3]) ? 'Equipment' : r[3] === 9 ? 'Recipes' : 'Other',
      }));
      const items = aggregateListings(listings);
      if (items.length) result.push(sanitizeSnapshot({realm, faction, timestamp, source: 'Auctioneer', coverage: 'partial', items}));
  }
  if (!result.length) throw new Error('Auctioneer file contains no buyout listings. Run a scan, then log out to save it.');
  return result;
}

function auctionator(root, options) {
  const db = root.AUCTIONATOR_PRICE_DATABASE;
  if (db.__dbversion != null && ![4,5,6,7,8].includes(Number(db.__dbversion))) throw new Error('Unsupported Auctionator database version. Use the CSV template instead.');
  const result = [];
  for (const [server, encoded] of Object.entries(db || {})) {
    if (server.startsWith('_') || server === 'version') continue;
    const records = typeof encoded === 'string' ? decodeCBOR(encoded) : encoded;
    if (!records || typeof records !== 'object') continue;
    if (typeof encoded === 'string' && records.version != null && Number(records.version) !== 2) throw new Error('Unsupported Auctionator realm database version. Use the CSV template instead.');
    const match = server.match(/^(.*)[_-](Alliance|Horde|Neutral)$/);
    const realm = utf8(match?.[1] || server);
    const faction = match?.[2] || options.faction;
    const byDate = new Map();
    const days = new Map();
    for (const [key, record] of Object.entries(records)) {
      if (!record || typeof record !== 'object') continue;
      const itemId = Number(record.id || key.match(/^(?:gr?:)?(\d+)(?::|$)/)?.[1]);
      if (!itemId) continue;
      const name = /^\d|^g[r]?:/.test(key) ? undefined : utf8(key);
      // m = last observed minimum. No per-item timestamp or current quantity is stored.
      // The import dialog requires the user to supply the capture time for this snapshot.
      const price = Number(record.m || record.mr || record.price);
      const timestamp = record.t || record.timestamp || options.timestamp;
      if (price > 0 && timestamp) {
        const date = isoDate(timestamp);
        const items = byDate.get(date) || [];
        items.push({itemId, key, name, minBuyout: Math.round(price), quantity: null, listings: null}); byDate.set(date, items);
      }
      // Auctionator's modern daily h/l buckets are measured from local midnight 2020-01-01.
      // h = highest minimum; l = lowest minimum when different; a = daily MAX availability.
      // Max daily availability is deliberately not presented as contemporaneous listed supply.
      if (Number(db.__dbversion) === 8 && record.h && typeof record.h === 'object') {
        for (const [day, high] of Object.entries(record.h)) {
          if (!/^\d{1,5}$/.test(day)) continue;
          const low = Number(record.l?.[day] ?? high);
          if (!(low > 0)) continue;
          const date = isoDate(new Date(2020,0,1).getTime() + Number(day) * 86400000);
          const items = days.get(date) || [];
          items.push({itemId,key,name,minBuyout:Math.round(low),quantity:null,listings:null}); days.set(date,items);
        }
      }
    }
    for (const [timestamp, items] of byDate) if (items.length) result.push(sanitizeSnapshot({realm, faction, timestamp, source: 'Auctionator cache', coverage: 'partial', items}));
    for (const [timestamp, items] of days) if (items.length) result.push(sanitizeSnapshot({realm,faction,timestamp,source:'Auctionator daily lows',coverage:'partial',items}));
  }
  if (!result.length) throw new Error('No supported Auctionator price observations found. Use Export Results CSV.');
  return result;
}

export function importLedger(input) {
  const root = parseLua(input.replace(/^\uFEFF/, ''));
  if (!root.AuctionLedgerDB) throw new Error('Expected Auction Ledger SavedVariables in AuctionLedger.lua.');
  return ledger(root);
}

export function importText(input, filename, options = {}) {
  if (input.length > MAX_FILE_BYTES) throw new Error('File exceeds the 64 MiB import limit.');
  const extension = filename.split('.').at(-1).toLowerCase();
  if (extension === 'json') {
    let data; try { data = JSON.parse(input); } catch { throw new Error('Invalid JSON file.'); }
    const raw = Array.isArray(data) ? data : data.snapshots || [data];
    if (!Array.isArray(raw) || raw.length > 20000) throw new Error('Invalid snapshot collection.');
    return mergeSnapshots(raw);
  }
  if (extension === 'lua') {
    const root = parseLua(input.replace(/^\uFEFF/, ''));
    if (root.AuctionLedgerDB) return ledger(root);
    if (root.AucScanData) return auctioneer(root, options);
    if (root.AUCTIONATOR_PRICE_DATABASE) return auctionator(root, options);
    throw new Error('Select AuctionLedger.lua, Auc-ScanData.lua or Auctionator.lua, not a configuration file.');
  }
  if (extension !== 'csv') throw new Error('Choose a .lua, .csv, or .json file.');
  const raw = parseCSV(input);
  const groups = new Map();
  for (const r of raw) {
    const itemId = r.itemId || r.ItemID || r.itemID || r['Item ID'] || r['Item Link']?.match(/item:(\d+)/)?.[1];
    if (!itemId) throw new Error('CSV needs itemId (or Item ID / Item Link) so items are identified reliably. Use the template.');
    const realm = r.realm || options.realm, faction = r.faction || options.faction;
    const timestamp = isoDate(r.timestamp || options.timestamp);
    const source = r.source || 'CSV';
    const key = JSON.stringify([realm, faction, source, timestamp]);
    const g = groups.get(key) || {realm, faction, timestamp, source, coverage: 'partial', rows: [], items: []};
    const name = r.name || r.Name || r['Item Name'];
    if (r.buyout !== undefined) {
      const buyout = Number(r.buyout), count = Number(r.count || 1);
      if (!Number.isSafeInteger(buyout) || buyout <= 0 || !Number.isSafeInteger(count) || count <= 0) throw new Error('CSV buyout/count must be positive integer copper/units.');
      g.rows.push({itemId, key: r.key, name, icon: r.icon, category: r.category, buyout, count});
    } else {
      const minBuyout = r.minBuyout ?? r.priceCopper ?? r['Price (copper)'];
      if (minBuyout === undefined) throw new Error('CSV needs minBuyout or priceCopper in copper, or buyout and count for stack listings.');
      g.items.push({itemId, key: r.key, name, icon: r.icon, category: r.category, minBuyout: Number(minBuyout), quantity: r.quantity || null, listings: r.listings || null});
    }
    groups.set(key, g);
  }
  return mergeSnapshots([...groups.values()].map(g => sanitizeSnapshot({...g, items: [...g.items, ...aggregateListings(g.rows)]})));
}
