import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestBranchLoader } from '../src/github-branch-loader.js';

test('older branch response is marked stale when repository changes', async () => {
  const loader = new LatestBranchLoader();
  let resolveFirst;
  const first = loader.load({ name:'first' }, () => new Promise(resolve => { resolveFirst = resolve; }));
  const second = loader.load({ name:'second' }, async () => [{ name:'main' }]);
  assert.deepEqual(await second, { branches:[{ name:'main' }], error:null, stale:false });
  resolveFirst([{ name:'old' }]);
  assert.equal((await first).stale, true);
});

test('latest branch error remains actionable', async () => {
  const loader = new LatestBranchLoader();
  const result = await loader.load({}, async () => { throw new Error('network'); });
  assert.equal(result.stale, false);
  assert.match(result.error.message, /network/);
});
