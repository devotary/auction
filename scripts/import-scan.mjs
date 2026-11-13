import {readFile, stat, writeFile, rename} from 'node:fs/promises';
import {basename} from 'node:path';
import {importText} from '../importer.js';
import {catalog, mergeSnapshots, MAX_FILE_BYTES} from '../market.js';

const args = process.argv.slice(2);
const filename = args.shift();
if (!filename || args.length % 2) {
  console.error('Usage: node scripts/import-scan.mjs /path/to/scan.lua [--realm Name] [--faction Alliance|Horde|Neutral|Shared] [--timestamp ISO-date]');
  process.exit(1);
}
const options = Object.create(null);
for (let n = 0; n < args.length; n += 2) {
  if (!['--realm','--faction','--timestamp'].includes(args[n])) throw new Error(`Unknown option ${args[n]}`);
  options[args[n].slice(2)] = args[n + 1];
}
const info = await stat(filename);
if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds 64 MiB.');
// Read SavedVariables only. mtime is a cache CAPTURE time, not an item scan timestamp.
options.timestamp ||= info.mtime.toISOString();
options.faction ||= 'Shared';
const raw = await readFile(filename);
const input = filename.toLowerCase().endsWith('.lua') ? raw.toString('latin1') : new TextDecoder('utf-8',{fatal:true}).decode(raw);
Object.assign(catalog, JSON.parse(await readFile(new URL('../data/items.json', import.meta.url), 'utf8')));
const incoming = importText(input, basename(filename), options);
const output = new URL('../data/scans.json', import.meta.url);
const previous = JSON.parse(await readFile(output, 'utf8'));
const snapshots = mergeSnapshots(previous.snapshots || [], incoming);
const temporary = new URL('../data/scans.json.tmp', import.meta.url);
await writeFile(temporary, JSON.stringify({version:1,snapshots}));
await rename(temporary, output);
console.log(`Merged ${incoming.length} sanitized snapshots. Ledger contains ${snapshots.length} snapshots. Original scan file unchanged.`);
console.log('Commit and push data/scans.json to publish it on GitHub Pages.');
