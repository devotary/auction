import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'market.js',
  'importer.js',
  'import-worker.js',
  '.nojekyll',
  'data/scans.json',
  'data/demo.json',
  'data/items.json',
];

async function copyAssetTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyAssetTree(from, to);
    else if (entry.isFile()) await cp(from, to);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  const source = join(root, file);
  const target = join(dist, file);
  try {
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Required public file is missing: ${file}`);
    throw error;
  }
}

await copyAssetTree(join(root, 'assets'), join(dist, 'assets'));
console.log(`Built static site in ${dist}`);
