import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createEntriesZip } from '../src/zip-download.js';

test('folder download keeps text and binary paths', async () => {
  const archive = await createEntriesZip([
    { path:'src/main.py', kind:'text', text:'print("ok")\n' },
    { path:'src/data.bin', kind:'binary', blob:new Blob([new Uint8Array([1, 2, 3])]) },
    { path:'src/empty', kind:'folder' }
  ], '');
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(new TextDecoder().decode(files['src/main.py']), 'print("ok")\n');
  assert.deepEqual([...files['src/data.bin']], [1, 2, 3]);
  assert.ok(files['src/empty/']);
});
