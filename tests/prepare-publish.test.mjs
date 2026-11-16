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
const ledger = (realm='Realm', faction='Alliance', price=250, timestamp=1706745600) => `AuctionLedgerDB={version=1,scans={{status="saved",realm=${JSON.stringify(realm)},faction=${JSON.stringify(faction)},startedAt=${timestamp-60},timestamp=${timestamp},captured=1,received=1,variants={{itemId=13463,itemString="item:13463",name="Dreamfoil",classID=7}},rows={"1;5;${price*5};0;0;4"}}}}`;
const emptyLedger = 'AuctionLedgerDB={version=1,scans={}}';

async function accountFile(f, account, body) {
  const folder=join(f.dir,'game','WTF','Account',account,'SavedVariables');
  await mkdir(folder,{recursive:true});
  const path=join(folder,'AuctionLedger.lua');
  if(body!==undefined)await writeFile(path,body);
  return path;
}

test('discovers saved scans across accounts without duplicate reads or account identifiers in output',async t=>{
  const f=await fixture(t);
  const one=await accountFile(f,'FIRST_TEST_ACCOUNT',ledger('Realm','Alliance'));
  const two=await accountFile(f,'SECOND_TEST_ACCOUNT',ledger('Realm','Neutral',100));
  const future=await accountFile(f,'FUTURE_TEST_ACCOUNT');
  await writeFile(future+'.bak','not an active scan');
  const elsewhere=join(f.dir,'other-game','WTF','Account','UNRELATED','SavedVariables');
  await mkdir(elsewhere,{recursive:true});await writeFile(join(elsewhere,'AuctionLedger.lua'),'must not read another installation');
  const originals=await Promise.all([one,two].map(async path=>({path,body:await readFile(path,'utf8'),mtime:(await stat(path)).mtimeMs})));
  const args={config:{inputs:[{path:one}]},historyPath:f.historyPath,outputPath:f.outputPath};
  const receipt=await prepare(args);
  assert.equal(receipt.filesRead,2);assert.equal(receipt.imported,2);assert.equal(receipt.total,2);
  let output=await readFile(f.outputPath,'utf8');
  assert.doesNotMatch(output,/FIRST_TEST_ACCOUNT|SECOND_TEST_ACCOUNT|SavedVariables|WTF/);
  assert.deepEqual(new Set(JSON.parse(output).snapshots.map(s=>s.faction)),new Set(['Faction','Neutral']));
  const explicit=await prepare({...args,config:{inputs:[{path:one},{path:two}]}});
  assert.equal(explicit.filesRead,2);assert.equal(explicit.imported,2);assert.equal(explicit.total,2);
  await writeFile(future,ledger('Other Realm','Horde',400,1706745660));
  const later=await prepare(args);
  assert.equal(later.filesRead,3);assert.equal(later.total,3); // New accounts are discovered on the next run.
  for(const original of originals){
    assert.equal(await readFile(original.path,'utf8'),original.body);
    assert.equal((await stat(original.path)).mtimeMs,original.mtime);
  }
});

test('discovers other accounts when the configured optional scanner file is not yet saved',async t=>{
  const f=await fixture(t);
  const missing=await accountFile(f,'UNSAVED_TEST_ACCOUNT');
  await accountFile(f,'SCANNED_TEST_ACCOUNT',ledger());
  const receipt=await prepare({config:{inputs:[{path:missing,optional:true}]},historyPath:f.historyPath,outputPath:f.outputPath});
  assert.equal(receipt.filesRead,1);assert.equal(receipt.total,1);
  assert.match(receipt.warnings[0],/not saved yet/);
});

test('protects discovered source files and aborts atomically on a malformed account scan',async t=>{
  const f=await fixture(t);
  const one=await accountFile(f,'VALID_TEST_ACCOUNT',ledger());
  const two=await accountFile(f,'INVALID_TEST_ACCOUNT','AuctionLedgerDB=os.execute("unsafe")');
  const args={config:{inputs:[{path:one}]},historyPath:f.historyPath,outputPath:f.outputPath};
  await assert.rejects(prepare({...args,outputPath:two}),/cannot replace an addon source/);
  assert.equal(await readFile(two,'utf8'),'AuctionLedgerDB=os.execute("unsafe")');
  await writeFile(f.outputPath,'preserve previous output');
  await assert.rejects(prepare(args));
  assert.equal(await readFile(f.outputPath,'utf8'),'preserve previous output');
});

test('imports without modifying addon source; unifies realm labels and keeps AH types separate', async t => {
  const f = await fixture(t, [snap('2024-01-01T00:00:00Z')]);
  await mkdir(join(f.dir,'one')); await mkdir(join(f.dir,'two'));
  const one = join(f.dir, 'one', 'AuctionLedger.lua'), two = join(f.dir, 'two', 'AuctionLedger.lua');
  const body = ledger('Elsewhere','Horde');
  await writeFile(one, body); await writeFile(two, ledger('Other Realm','Neutral'));
  const before = await stat(one);
  const result = await prepare({ config: { inputs: [{ path: one }, { path: two }] }, historyPath: f.historyPath, outputPath: f.outputPath });
  assert.equal(await readFile(one, 'utf8'), body);
  assert.equal((await stat(one)).mtimeMs, before.mtimeMs);
  const output = JSON.parse(await readFile(f.outputPath, 'utf8'));
  assert.equal(output.version, 1);
  assert.equal(output.snapshots.length, 3);
  assert.deepEqual(new Set(output.snapshots.map(s => s.realm)), new Set(['Auction House']));
  assert.deepEqual(new Set(output.snapshots.map(s => s.faction)), new Set(['Faction','Neutral']));
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
  assert.equal(snapshots.find(s => s.timestamp.startsWith('2024-02-01')).items[0].minBuyout, 120);
  assert.equal(snapshots.find(s => s.timestamp.startsWith('2024-01-01')).items[0].minBuyout, 90);
  assert.ok(snapshots.every(s=>s.realm==='Auction House'&&s.faction==='Faction'));
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
