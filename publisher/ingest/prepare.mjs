import { readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { importLedger } from './importer.mjs';
import { catalog, mergeSnapshots, MAX_FILE_BYTES } from './market.mjs';

async function readStable(path) {
  const before = await stat(path);
  if (!before.isFile()) throw new Error('Input must be a regular file.');
  if (before.size > MAX_FILE_BYTES) throw new Error('File exceeds 64 MiB.');
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
    throw new Error('Input changed while it was being read.');
  }
  return bytes.toString('latin1');
}

const isLedger = snapshot => snapshot?.source === 'Auction Ledger';

export async function prepare({ config, historyPath, outputPath, remoteHistoryPath }) {
  if (!config || !Array.isArray(config.inputs) || !config.inputs.length) throw new Error('Config needs a nonempty inputs array.');
  if (config.inputs.some(input => !input || typeof input.path !== 'string' || !isAbsolute(input.path))) throw new Error('Each input needs an absolute file path.');
  if (!config.inputs.some(input => basename(input.path) === 'AuctionLedger.lua')) throw new Error('Config needs an AuctionLedger.lua input.');
  const output = resolve(outputPath);
  const sources = config.inputs.map(input => resolve(input.path));
  if (sources.includes(output)) throw new Error('Output path cannot replace an addon source file.');

  Object.assign(catalog, JSON.parse(await readFile(new URL('./items.json', import.meta.url), 'utf8')));
  const readHistory = async path => {
    const history = JSON.parse(await readFile(path, 'utf8'));
    if (history.version !== 1 || !Array.isArray(history.snapshots)) throw new Error('History must be version 1 with a snapshots array.');
    if (history.snapshots.some(snapshot => snapshot?.file !== undefined)) {
      if (!history.snapshots.every(snapshot => typeof snapshot?.file === 'string' && /^data\/history\/[a-f0-9]{64}\.json$/.test(snapshot.file))) {
        throw new Error('Remote archive contains an invalid snapshot path.');
      }
      const archiveRoot = resolve(dirname(dirname(path)));
      return Promise.all(history.snapshots.map(async entry => {
        const bytes = await readFile(resolve(archiveRoot, entry.file));
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== entry.file.slice('data/history/'.length, -'.json'.length)) throw new Error('Remote archive snapshot hash mismatch.');
        return JSON.parse(bytes.toString('utf8'));
      }));
    }
    return history.snapshots;
  };
  const remote = remoteHistoryPath ? await readHistory(remoteHistoryPath) : [];
  const local = await readHistory(historyPath);
  let snapshots = mergeSnapshots(remote.filter(isLedger), local.filter(isLedger));
  const warnings = [];
  if ([...remote, ...local].some(snapshot => !isLedger(snapshot))) warnings.push('Non-Auction Ledger history excluded from active reports.');
  let importedCount = 0;

  for (const [index, inputConfig] of config.inputs.entries()) {
    const path = sources[index];
    if (basename(path) !== 'AuctionLedger.lua') {
      warnings.push(`Input ${index + 1}: skipped; publishing accepts only AuctionLedger.lua.`);
      continue;
    }
    let source;
    try { source=await readStable(path); }
    catch(error) {
      if(inputConfig.optional===true && error.code==='ENOENT'){warnings.push(`Input ${index+1}: optional scan file is not saved yet.`);continue;}
      throw error;
    }
    const incoming = importLedger(source);
    if (!incoming.length) warnings.push(`Input ${index + 1}: no saved buyout observations yet. Complete a scan and /reload.`);
    importedCount += incoming.length;
    snapshots = mergeSnapshots(snapshots, incoming);
  }

  const payload = JSON.stringify({ version: 1, snapshots });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, payload, { flag: 'wx' });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { imported: importedCount, total: snapshots.length, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configPath, historyPath, outputPath, remoteHistoryPath, ...extra] = process.argv.slice(2);
  if (!configPath || !historyPath || !outputPath || extra.length) {
    console.error('Usage: node publisher/ingest/prepare.mjs CONFIG HISTORY OUTPUT [REMOTE_HISTORY]');
    process.exitCode = 1;
  } else {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const summary = await prepare({ config, historyPath, outputPath, remoteHistoryPath });
      console.log(JSON.stringify(summary));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    }
  }
}
