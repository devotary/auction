import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepare } from '../publisher/ingest/prepare.mjs';
import { sanitizeSnapshot } from '../publisher/ingest/market.mjs';

async function fixture(t, snapshots = []) {
  const dir = await mkdtemp(join(tmpdir(), 'auction-publish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const historyPath = join(dir, 'history.json');
  const outputPath = join(dir, 'published.json');
  await writeFile(historyPath, JSON.stringify({ version: 1, snapshots }));
  return { dir, historyPath, outputPath };
}

const snap = (timestamp, realm = 'Realm', price = 100) => sanitizeSnapshot({
  realm, faction: 'Alliance', source: 'Auction Ledger', timestamp,
  items: [{ itemId: 13463, key: '13463', name: 'Dreamfoil', minBuyout: price, quantity: 5 }],
});
const ledger = (realm='Realm', faction='Alliance', price=250) => `AuctionLedgerDB={version=1,scans={{status="saved",realm=${JSON.stringify(realm)},faction=${JSON.stringify(faction)},startedAt=1706745540,timestamp=1706745600,captured=1,received=1,variants={{itemId=13463,itemString="item:13463",name="Dreamfoil",classID=7}},rows={"1;5;${price*5};0;0;4"}}}}`;
const emptyLedger = 'AuctionLedgerDB={version=1,scans={}}';

test('imports without modifying addon source; merges sanitized snapshots and keeps markets isolated', async t => {
  const f = await fixture(t, [snap('2024-01-01T00:00:00Z')]);
  await mkdir(join(f.dir,'one')); await mkdir(join(f.dir,'two'));
  const one = join(f.dir, 'one', 'AuctionLedger.lua'), two = join(f.dir, 'two', 'AuctionLedger.lua');
  const body = ledger('Elsewhere','Horde');
  await writeFile(one, body); await writeFile(two, ledger('Other Realm'));
  const before = await stat(one);
  const result = await prepare({ config: { inputs: [{ path: one }, { path: two }] }, historyPath: f.historyPath, outputPath: f.outputPath });
  assert.equal(await readFile(one, 'utf8'), body);
  assert.equal((await stat(one)).mtimeMs, before.mtimeMs);
  const output = JSON.parse(await readFile(f.outputPath, 'utf8'));
  assert.equal(output.version, 1);
  assert.equal(output.snapshots.length, 3);
  assert.deepEqual(new Set(output.snapshots.map(s => s.realm)), new Set(['Realm', 'Elsewhere', 'Other Realm']));
  assert.equal(result.imported, 2);
  assert.ok(!JSON.stringify(output).includes('seller'));
});

test('only reads Auction Ledger inputs and excludes legacy local history', async t => {
  const old = sanitizeSnapshot({ realm: 'Test Realm', faction: 'Alliance', source: 'Auctionator cache', timestamp: '2024-01-01T00:00:00Z', items: [{ itemId: 13463, key: 'Dreamfoil', name: 'Dreamfoil', minBuyout: 123, quantity: null }] });
  const f = await fixture(t, [old]);
  const lua = join(f.dir, 'AuctionLedger.lua');
  await writeFile(lua, ledger());
  // These required legacy paths do not exist; the publisher must skip them before reading.
  const inputs = [lua,join(f.dir,'Auctionator.lua'),join(f.dir,'Auc-ScanData.lua'),join(f.dir,'scan.csv')].map(path=>({path}));
  const result = await prepare({ config: { inputs }, historyPath: f.historyPath, outputPath: f.outputPath });
  assert.equal(result.imported, 1);
  const output=JSON.parse(await readFile(f.outputPath, 'utf8'));
  assert.equal(output.snapshots.length, 1);assert.equal(output.snapshots[0].source,'Auction Ledger');
  assert.equal(result.warnings.filter(w=>w.includes('skipped')).length,3);
  assert.ok(result.warnings.some(w=>w.includes('history excluded')));
});

test('requires an Auction Ledger input instead of publishing legacy sources', async t => {
  const f = await fixture(t);
  await writeFile(f.outputPath,'preserve');
  await assert.rejects(prepare({ config: { inputs: [{ path: join(f.dir,'Auctionator.lua') }] }, historyPath: f.historyPath, outputPath: f.outputPath }), /needs an AuctionLedger.lua input/);
  assert.equal(await readFile(f.outputPath,'utf8'),'preserve');
});

test('malformed input fails atomically and leaves existing output intact', async t => {
  const f = await fixture(t, [snap('2024-01-01T00:00:00Z')]);
  const bad = join(f.dir, 'AuctionLedger.lua');
  await writeFile(bad, 'AuctionLedgerDB = os.execute("unsafe")');
  await writeFile(f.outputPath, 'keep this exact output');
  await assert.rejects(prepare({ config: { inputs: [{ path: bad }] }, historyPath: f.historyPath, outputPath: f.outputPath }));
  assert.equal(await readFile(f.outputPath, 'utf8'), 'keep this exact output');
});

test('rejects another addon renamed to AuctionLedger.lua', async t => {
  const f=await fixture(t);
  const file=join(f.dir,'AuctionLedger.lua');
  await writeFile(file,'AUCTIONATOR_PRICE_DATABASE={}');
  await assert.rejects(prepare({config:{inputs:[{path:file}]},historyPath:f.historyPath,outputPath:f.outputPath}), /Expected Auction Ledger SavedVariables/);
});

test('rejects overwriting an input source', async t => {
  const f = await fixture(t);
  const source = join(f.dir, 'AuctionLedger.lua');
  await writeFile(source, ledger());
  await assert.rejects(prepare({ config: { inputs: [{ path: source }] }, historyPath: f.historyPath, outputPath: source }), /cannot replace an addon source/);
});

test('a not-yet-saved optional addon is skipped, while a malformed saved file still aborts',async t=>{
  const f=await fixture(t,[snap('2024-01-01T00:00:00Z')]);
  const file=join(f.dir,'AuctionLedger.lua');
  const args={config:{inputs:[{path:file,optional:true}]},historyPath:f.historyPath,outputPath:f.outputPath};
  const receipt=await prepare(args);
  assert.equal(receipt.total,1);assert.match(receipt.warnings[0],/not saved yet/);
  await writeFile(file,'AuctionLedgerDB = os.execute("unsafe")');
  const before=await readFile(f.outputPath,'utf8');
  await assert.rejects(prepare(args));assert.equal(await readFile(f.outputPath,'utf8'),before);
});

test('merges only Auction Ledger history without reviving legacy remote observations', async t => {
  const remoteOnly = snap('2024-01-01T00:00:00Z','Remote Realm',90);
  const legacy = {...remoteOnly,source:'Auctionator daily lows'};
  const remoteCorrection = snap('2024-02-01T00:00:00Z', 'Realm', 100);
  const localCorrection = snap('2024-02-01T00:00:00Z', 'Realm', 120);
  const f = await fixture(t, [remoteCorrection, localCorrection, {...legacy,source:'Auctioneer'}]);
  const remoteHistoryPath = join(f.dir, 'remote.json');
  await writeFile(remoteHistoryPath, JSON.stringify({ version: 1, snapshots: [remoteOnly, remoteCorrection,legacy] }));
  const empty = join(f.dir, 'AuctionLedger.lua');
  await writeFile(empty, emptyLedger);
  await prepare({ config: { inputs: [{ path: empty }] }, historyPath: f.historyPath, remoteHistoryPath, outputPath: f.outputPath });
  const snapshots = JSON.parse(await readFile(f.outputPath, 'utf8')).snapshots;
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every(s=>s.source==='Auction Ledger'));
  assert.equal(snapshots.find(s => s.realm === 'Realm').items[0].minBuyout, 120);
  assert.equal(snapshots.find(s => s.realm === 'Remote Realm').items[0].minBuyout, 90);
});

test('loads SHA-256 addressed snapshots from the remote archive index', async t => {
  const f = await fixture(t);
  const remoteHistoryPath = join(f.dir, 'data', 'history.json');
  const archiveDir = join(f.dir, 'data', 'history');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(archiveDir, { recursive: true });
  const snapshot = snap('2024-03-01T00:00:00Z', 'Archived Realm', 321);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(archiveDir, `${hash}.json`), bytes);
  await writeFile(remoteHistoryPath, JSON.stringify({ version: 1, snapshots: [{ realm: snapshot.realm, file: `data/history/${hash}.json` }] }));
  const empty = join(f.dir, 'AuctionLedger.lua');
  await writeFile(empty, emptyLedger);
  await prepare({ config: { inputs: [{ path: empty }] }, historyPath: f.historyPath, remoteHistoryPath, outputPath: f.outputPath });
  const output = JSON.parse(await readFile(f.outputPath, 'utf8'));
  assert.equal(output.snapshots.length, 1);
  assert.equal(output.snapshots[0].items[0].minBuyout, 321);
});

test('rejects archive path traversal and hash mismatch without replacing output', async t => {
  const f = await fixture(t);
  const remoteHistoryPath = join(f.dir, 'data', 'history.json');
  const archiveDir = join(f.dir, 'data', 'history');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(archiveDir, { recursive: true });
  const empty = join(f.dir, 'AuctionLedger.lua');
  await writeFile(empty, emptyLedger);
  await writeFile(f.outputPath, 'preserve');
  await writeFile(remoteHistoryPath, JSON.stringify({ version: 1, snapshots: [{ file: '../secret.json' }] }));
  await assert.rejects(prepare({ config: { inputs: [{ path: empty }] }, historyPath: f.historyPath, remoteHistoryPath, outputPath: f.outputPath }), /invalid snapshot path/);
  assert.equal(await readFile(f.outputPath, 'utf8'), 'preserve');

  const wrongHash = '0'.repeat(64);
  await writeFile(join(archiveDir, `${wrongHash}.json`), JSON.stringify(snap('2024-03-01T00:00:00Z')));
  await writeFile(remoteHistoryPath, JSON.stringify({ version: 1, snapshots: [{ file: `data/history/${wrongHash}.json` }] }));
  await assert.rejects(prepare({ config: { inputs: [{ path: empty }] }, historyPath: f.historyPath, remoteHistoryPath, outputPath: f.outputPath }), /hash mismatch/);
  assert.equal(await readFile(f.outputPath, 'utf8'), 'preserve');
});
