import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompleteGitTree } from '../src/github-tree.js';

test('recursive tree accepts more than 2,000 files without an app limit', async () => {
  const tree = Array.from({ length:2501 }, (_, index) => ({
    path:`files/file-${index}.py`, type:'blob', sha:`sha-${index}`, size:1, mode:'100644'
  }));
  const result = await loadCompleteGitTree({ rootSha:'root', getTree:async (_sha, recursive) => {
    assert.equal(recursive, true);
    return { truncated:false, tree };
  } });
  assert.equal(result.length, 2501);
  assert.equal(result.at(-1).path, 'files/file-2500.py');
});

test('truncated recursive tree is reloaded one subtree at a time', async () => {
  const calls = [];
  const trees = {
    root:{ tree:[
      { path:'main.py', type:'blob', sha:'main', size:10, mode:'100644' },
      { path:'assets', type:'tree', sha:'assets', mode:'040000' }
    ] },
    assets:{ tree:[
      { path:'image.jpg', type:'blob', sha:'image', size:20, mode:'100644' },
      { path:'models', type:'tree', sha:'models', mode:'040000' }
    ] },
    models:{ tree:[{ path:'sample.kmodel', type:'blob', sha:'model', size:30, mode:'100644' }] }
  };
  const result = await loadCompleteGitTree({ rootSha:'root', concurrency:2, getTree:async (sha, recursive) => {
    calls.push([sha, recursive]);
    if (recursive) return { truncated:true, tree:[] };
    return trees[sha];
  } });

  assert.deepEqual(calls, [['root', true], ['root', false], ['assets', false], ['models', false]]);
  assert.deepEqual(result.filter(item => item.type === 'blob').map(item => item.path), [
    'main.py', 'assets/image.jpg', 'assets/models/sample.kmodel'
  ]);
});
