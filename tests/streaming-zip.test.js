import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { streamZipResponse } from '../src/streaming-zip.js';

function chunkedResponse(bytes, chunkSize = 17) {
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    }
  });
  return new Response(body, { headers:{ 'Content-Length':String(bytes.length), 'Content-Type':'application/zip' } });
}

test('ZIP responses are downloaded and extracted incrementally', async () => {
  const encoder = new TextEncoder();
  const archive = zipSync({
    'repo-root/main.py':encoder.encode('print("ok")\n'),
    'repo-root/assets/data.bin':new Uint8Array([1, 2, 3, 4])
  });
  const files = new Map(); const progress = [];
  const result = await streamZipResponse(chunkedResponse(archive), {
    onProgress:value => progress.push(value),
    onFile:({ name, chunks, size }) => {
      const bytes = new Uint8Array(size); let offset = 0;
      chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.length; });
      files.set(name, bytes);
    }
  });

  assert.equal(new TextDecoder().decode(files.get('repo-root/main.py')), 'print("ok")\n');
  assert.deepEqual([...files.get('repo-root/assets/data.bin')], [1, 2, 3, 4]);
  assert.equal(result.downloadedBytes, archive.length);
  assert.equal(result.extractedFiles, 2);
  assert.ok(progress.some(item => item.phase === 'download'));
  assert.ok(progress.some(item => item.phase === 'extract'));
});
