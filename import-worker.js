import {importText} from './importer.js';
self.onmessage = async ({data:{file, options}}) => {
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let input;
    if (file.name.toLowerCase().endsWith('.lua')) {
      // Preserve arbitrary byte strings (e.g. CBOR) embedded in Lua SavedVariables.
      const chunks = [];
      for (let p = 0; p < bytes.length; p += 8192) chunks.push(String.fromCharCode(...bytes.subarray(p, p + 8192)));
      input = chunks.join('');
    } else input = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    self.postMessage({snapshots:importText(input, file.name, options)});
  } catch (e) { self.postMessage({error:e.message}); }
};
