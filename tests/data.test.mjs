import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLua, parseCSV, importText, decodeCBOR} from '../publisher/ingest/importer.mjs';
import {aggregateListings, sanitizeSnapshot, mergeSnapshots} from '../publisher/ingest/market.mjs';
import {analyze} from './reference-analysis.mjs';
import {resale} from '../trade.js';

const date = '2026-11-01T12:00:00.000Z';
const item = (id, price, quantity = null) => ({itemId:id, minBuyout:price, quantity});
const scan = (timestamp = date, items = [item(13463, 10000)]) => sanitizeSnapshot({realm:'Test Realm', faction:'Alliance', source:'test', timestamp, items});

test('literal Lua parsing preserves byte strings and rejects executable input', () => {
  const result = parseLua('-- saved data\nDB = { ["x"] = {1, nil, true, [7] = "a\\000\\255",}, flag=false, name=[=[two\nlines]=] }');
  assert.equal(result.DB.x[1], 1);
  assert.equal(result.DB.x[2], null);
  assert.equal(result.DB.x[7], 'a\x00\xff');
  assert.equal(result.DB.flag, false);
  assert.equal(result.DB.name, 'two\nlines');
  assert.equal(parseLua('return {{1,2}}')[1][2], 2);
  for (const bad of ['X = os.execute("bad")', 'X = (function() return {} end)()', 'X = {} do end', 'return {} print(1)', 'X = {a=1,a=2}', `X = ${'{'.repeat(70)}${'}'.repeat(70)}`]) assert.throws(() => parseLua(bad));
});

test('CSV supports quoted commas, escaped quotes and CRLF without executing formulas', () => {
  const rows = parseCSV('itemId,name,minBuyout\r\n13463,"Herb, +""Special""",10000\r\n');
  assert.equal(rows[0].name, 'Herb, +"Special"');
  assert.throws(() => parseCSV('a,b\n1,2,3'));
  assert.throws(() => parseCSV('a,b\n"1,2'));
});

test('stack buyouts are converted to unit prices and quantities are summed', () => {
  const rows = aggregateListings([{itemId:13463,buyout:20000,count:20}, {itemId:13463,buyout:12000,count:10}, {itemId:13463,buyout:0,count:20}]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minBuyout, 1000);
  assert.equal(rows[0].medianBuyout, 1000);
  assert.equal(rows[0].quantity, 30);
  assert.equal(rows[0].listings, 2);
});

test('Auctioneer ropes use observed timestamps and strip all seller/account data', () => {
  const row = '{"item:13463",60,7,0,0,0,3,1793534400,"Dreamfoil","Interface\\\\Icons\\\\INV_Misc_Herb_Dreamfoil",20,1,true,0,1,0,500000,0,false,"PRIVATE_SELLER",0,99,13463,0,0,0,0}';
  const rope = `return {${row},${row}}`;
  const lua = `AucScanData = {Version=1.3, scans={TestRealm={Alliance={ropes={${JSON.stringify(rope)}}}}}}`;
  const snapshots = importText(lua, 'Auc-ScanData.lua');
  assert.equal(snapshots[0].items[0].minBuyout, 25000);
  assert.equal(snapshots[0].items[0].quantity, 40);
  assert.equal(snapshots[0].items[0].listings, 2);
  assert.equal(snapshots[0].items[0].icon, 'inv_misc_herb_dreamfoil');
  assert.equal(snapshots[0].timestamp, '2026-11-01T12:00:00.000Z');
  assert.ok(!JSON.stringify(snapshots).includes('PRIVATE_SELLER'));
});

test('Auctioneer v1.4 flat server keys import rope images and exclude unseen/expired listings', () => {
  const row = flag => `{[8]=1793534400,[9]="Dreamfoil",[11]=20,[12]=1,[17]=500000,[21]=${flag},[23]=13463}`;
  const rope = `return {${row(0)},${row(2)},${row(4)},${row(128)}}`;
  const data = `AucScanData={Version=1.4,scans={["TestRealm_Alliance"]={image="rope",ropes={${JSON.stringify(rope)}},scanstats={ImageUpdated=1793534400}}}}`;
  const [scan] = importText(data,'Auc-ScanData.lua');
  assert.equal(scan.realm,'TestRealm');assert.equal(scan.faction,'Alliance');
  assert.equal(scan.items[0].quantity,20);assert.equal(scan.items[0].listings,1);
});

test('safe exports preserve unknown supply and remove unrecognized fields', () => {
  const result = sanitizeSnapshot({...scan(), seller:'PRIVATE', account:'PRIVATE', items:[{...item(13463,100),seller:'PRIVATE', icon:'https://bad.example/icon.jpg', quantity:null}]});
  assert.equal(result.items[0].quantity, null);
  assert.equal(result.items[0].icon, 'icon');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.throws(() => sanitizeSnapshot({...scan(),items:[item(13463,-1)]}));
  assert.throws(() => sanitizeSnapshot({...scan(),items:[item(13463,1.5)]}));
  assert.throws(() => sanitizeSnapshot({...scan(),items:[item(13463,1),item(13463,2)]}));
});

test('imports deduplicate timestamps but keep realms, factions and sources separate', () => {
  const s = scan();
  assert.equal(mergeSnapshots([s,s]).length,1);
  assert.equal(mergeSnapshots([s,{...s,faction:'Horde'},{...s,source:'Auctioneer'}]).length,3);
  const imported = importText('itemId,name,minBuyout,quantity\n13463,Dreamfoil,12300,100', 'sample.csv', {realm:'Test Realm',faction:'Alliance',timestamp:date});
  assert.equal(imported[0].items[0].minBuyout,12300);
  assert.equal(imported[0].items[0].quantity,100);
  assert.throws(() => importText('itemId,buyout,count\n13463,10,0','scan.csv',{realm:'Test',faction:'Alliance',timestamp:date}));
});

test('trend lookback uses latest observation time and a fixed intersection basket', () => {
  const scans = [scan(date,[item(13463,100),item(13468,1000)]),scan('2026-11-02T12:00:00Z',[item(13463,120)]),scan('2026-11-03T12:00:00Z',[item(13463,150),item(13468,900)])];
  const a = analyze(scans,7);
  assert.equal(a.basketSize,2);
  assert.deepEqual(a.series.map(s => s.value),[100,null,120]);
  assert.equal(a.items[0].change,50);
  assert.equal(a.items[0].quantity,null);
  const day = analyze(scans,1);
  assert.equal(day.baseline.timestamp,'2026-11-02T12:00:00.000Z');
  assert.equal(analyze([scans[0]],7).items[0].change,null);
});

test('resale net includes cost, quantity, configurable cut and lost deposits', () => {
  assert.deepEqual(resale({buy:10000,sell:20000,quantity:10,cut:5,expenses:1200}),{gross:200000,fee:10000,net:88800});
  assert.equal(resale({buy:20000,sell:10000,cut:15}).net,-11500);
  assert.throws(() => resale({buy:1,sell:2,quantity:1.5}));
  assert.throws(() => resale({buy:1,sell:2,cut:101}));
  assert.throws(() => resale({buy:1e14,sell:1e14,quantity:1e8}));
});

function cbor(value) {
  const head = (major, n) => n < 24 ? [major * 32 + n] : n < 256 ? [major * 32 + 24, n] : n < 65536 ? [major * 32 + 25, n >> 8, n & 255] : [major * 32 + 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  if (Number.isInteger(value)) return head(0,value);
  if (typeof value === 'string') return [...head(2,value.length), ...Buffer.from(value)];
  return [...head(5,Object.keys(value).length), ...Object.entries(value).flatMap(([k,v]) => [...cbor(k),...cbor(v)])];
}
test('Auctionator CBOR v8/realm2 imports cache and daily lows without fabricating supply', () => {
  const day = String(Math.floor((new Date(2026,10,1) - new Date(2020,0,1)) / 86400000));
  const encoded = cbor({version:2,'13463':{m:15000,h:{[day]:18000},l:{[day]:12000},a:{[day]:400}}});
  const binary = String.fromCharCode(...encoded);
  assert.equal(decodeCBOR(binary)['13463'].m,15000);
  const literal = '"' + encoded.map(b => '\\' + String(b).padStart(3,'0')).join('') + '"';
  const result = importText(`AUCTIONATOR_PRICE_DATABASE={__dbversion=8,["Test Realm"]=${literal}}`,'Auctionator.lua',{faction:'Shared',timestamp:date});
  const cached = result.find(s=>s.source==='Auctionator cache');
  const daily = result.find(s=>s.source==='Auctionator daily lows');
  assert.equal(cached.items[0].minBuyout,15000);
  assert.equal(daily.items[0].minBuyout,12000);
  assert.equal(cached.items[0].quantity,null);
  assert.equal(daily.items[0].quantity,null);
  assert.equal(cached.realm,'Test Realm');
  assert.throws(()=>decodeCBOR(binary+'x'));
  assert.throws(()=>decodeCBOR(String.fromCharCode(0xbf,0xff)));
  assert.throws(()=>decodeCBOR(binary.slice(0,-1)));
});

test('Auction Ledger compact rows preserve item variants, stack prices and privacy',()=>{
  const make=(change='')=>`AuctionLedgerDB={version=1,scans={{status="saved",realm="Test",faction="Alliance",startedAt=1793534400,timestamp=1793534500,coverage="full",captured=4,received=4,
    seller="PRIVATE_OWNER",variants={
      {itemId=13463,itemString="item:13463:0:0:0:0:0:0:111:60:0",name="Dreamfoil",classID=7},
      {itemId=13463,itemString="item:13463:0:0:0:0:0:0:222:55:99",name="Dreamfoil",classID=7},
      {itemId=13463,itemString="item:13463:0:0:0:0:0:-18:333:60:0",name="Variant",classID=7}},
    rows={"1;20;20000;100;0;4","2;10;12000;100;0;4","1;5;0;100;0;4","3;1;50000;100;0;4"}${change}}}}`;
  const [scan]=importText(make(),'AuctionLedger.lua');
  assert.equal(scan.source,'Auction Ledger');assert.equal(scan.coverage,'partial');
  assert.equal(scan.items.length,2);assert.equal(scan.items[0].quantity,30);assert.equal(scan.items[0].listings,2);
  assert.equal(scan.items[0].minBuyout,1000);assert.equal(scan.items[0].medianBuyout,1000);
  assert.notEqual(scan.items[1].key,scan.items[0].key);assert.ok(scan.items[1].key.length<120);
  assert.doesNotMatch(JSON.stringify(scan),/PRIVATE_OWNER|seller|received|itemString/);
  assert.deepEqual(importText('AuctionLedgerDB={version=1,scans={}}','AuctionLedger.lua'),[]);
  assert.deepEqual(importText('AuctionLedgerDB={version=1,scans={{status="capturing"}}}','AuctionLedger.lua'),[]);
  for(const [from,to] of [['version=1','version=2'],['captured=4','captured=9'],['item:13463:0','item:999:0'],['1;20;20000','9;20;20000'],['1;20;20000','1;0;20000'],['1;20;20000','1;20;-20000'],[';0;4"',';0;9"']]){
    assert.throws(()=>importText(make().replace(from,to),'AuctionLedger.lua'));
  }
});
