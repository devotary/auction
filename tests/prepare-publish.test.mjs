import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
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
  realm, faction: 'Alliance', source: 'CSV', timestamp,
  items: [{ itemId: 13463, key: 'dreamfoil', name: 'Dreamfoil', minBuyout: price, quantity: 5 }],
});

test('imports without modifying addon source; merges sanitized snapshots and keeps markets isolated', async t => {
  const f = await fixture(t, [snap('2024-01-01T00:00:00Z')]);
  const one = join(f.dir, 'one.csv'), two = join(f.dir, 'two.csv');
  const body = 'itemId,name,minBuyout,realm,faction,source,timestamp\n13463,Dreamfoil,250,Elsewhere,Horde,CSV,2024-02-01T00:00:00Z\n';
  await writeFile(one, body); await writeFile(two, body.replace('Elsewhere', 'Other Realm').replace('Horde', 'Alliance'));
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

test('skips matching latest Auctionator cache even with a later timestamp', async t => {
  const old = sanitizeSnapshot({ realm: 'Test Realm', faction: 'Alliance', source: 'Auctionator cache', timestamp: '2024-01-01T00:00:00Z', items: [{ itemId: 13463, key: 'Dreamfoil', name: 'Dreamfoil', minBuyout: 123, quantity: null }] });
  const f = await fixture(t, [old]);
  const lua = join(f.dir, 'Auctionator.lua');
  await writeFile(lua, 'AUCTIONATOR_PRICE_DATABASE={__dbversion=7,["Test Realm-Alliance"]={Dreamfoil={id=13463,m=123,t="2024-01-02T00:00:00Z"}}}');
  const result = await prepare({ config: { inputs: [{ path: lua }] }, historyPath: f.historyPath, outputPath: f.outputPath });
  assert.equal(result.imported, 0);
  assert.equal(JSON.parse(await readFile(f.outputPath, 'utf8')).snapshots.length, 1);
});

test('warns and skips an empty Auctioneer scan without inventing data', async t => {
  const f = await fixture(t);
  const lua = join(f.dir, 'Auc-ScanData.lua');
  await writeFile(lua, 'AucScanData={scans={}}');
  const result = await prepare({ config: { inputs: [{ path: lua }] }, historyPath: f.historyPath, outputPath: f.outputPath });
  assert.equal(result.total, 0);
  assert.equal(result.warnings.length, 1);
});

test('malformed input fails atomically and leaves existing output intact', async t => {
  const f = await fixture(t, [snap('2024-01-01T00:00:00Z')]);
  const bad = join(f.dir, 'bad.csv');
  await writeFile(bad, 'not,a,valid\n1,2,3\n');
  await writeFile(f.outputPath, 'keep this exact output');
  await assert.rejects(prepare({ config: { inputs: [{ path: bad }] }, historyPath: f.historyPath, outputPath: f.outputPath }));
  assert.equal(await readFile(f.outputPath, 'utf8'), 'keep this exact output');
});

test('rejects overwriting an input source', async t => {
  const f = await fixture(t);
  const source = join(f.dir, 'source.csv');
  await writeFile(source, 'itemId,minBuyout\n13463,10\n');
  await assert.rejects(prepare({ config: { inputs: [{ path: source }] }, historyPath: f.historyPath, outputPath: source }), /cannot replace an addon source/);
});

test('merges remote archive first so local same-identity corrections win', async t => {
  const remoteOnly = sanitizeSnapshot({ realm: 'Remote Realm', faction: 'Shared', source: 'Auctionator daily lows', timestamp: '2024-01-01T00:00:00Z', items: [{ itemId: 13463, minBuyout: 90 }] });
  const remoteCorrection = snap('2024-02-01T00:00:00Z', 'Realm', 100);
  const localCorrection = snap('2024-02-01T00:00:00Z', 'Realm', 120);
  const f = await fixture(t, [remoteCorrection, localCorrection]);
  const remoteHistoryPath = join(f.dir, 'remote.json');
  await writeFile(remoteHistoryPath, JSON.stringify({ version: 1, snapshots: [remoteOnly, remoteCorrection] }));
  const empty = join(f.dir, 'empty.lua');
  await writeFile(empty, 'AucScanData={scans={}}');
  await prepare({ config: { inputs: [{ path: empty }] }, historyPath: f.historyPath, remoteHistoryPath, outputPath: f.outputPath });
  const snapshots = JSON.parse(await readFile(f.outputPath, 'utf8')).snapshots;
  assert.equal(snapshots.length, 2);
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
  const empty = join(f.dir, 'empty.lua');
  await writeFile(empty, 'AucScanData={scans={}}');
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
  const empty = join(f.dir, 'empty.lua');
  await writeFile(empty, 'AucScanData={scans={}}');
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
