import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStorageCapacity, evaluateStorageCapacity, formatByteSize } from '../src/storage-capacity.js';

test('repository sizes over 50 MB are accepted when browser storage is available', async () => {
  const required = 120 * 1024 * 1024;
  const result = await ensureStorageCapacity(required, { estimate:async () => ({ quota:2 * 1024 ** 3, usage:100 * 1024 ** 2 }) });
  assert.equal(result.enough, true);
  assert.equal(result.required, required);
});

test('capacity check gives an actionable error when storage is insufficient', async () => {
  await assert.rejects(
    ensureStorageCapacity(200 * 1024 * 1024, { estimate:async () => ({ quota:256 * 1024 ** 2, usage:100 * 1024 ** 2 }) }),
    /必要: 200 MB.*利用可能/
  );
});

test('storage estimates remain optional and byte sizes are readable', () => {
  assert.equal(evaluateStorageCapacity(75 * 1024 * 1024, null).enough, true);
  assert.equal(formatByteSize(75 * 1024 * 1024), '75.0 MB');
});
