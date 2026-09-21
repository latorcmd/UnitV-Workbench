import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenProjectTree, nextAvailablePath, planEntryMove, remapExpandedFolders } from '../src/project-tree.js';

const entries = [
  { id:'1', path:'src/z.py', kind:'text' },
  { id:'2', path:'README.md', kind:'text' },
  { id:'3', path:'src/lib/a.py', kind:'text' },
  { id:'4', path:'assets/image.jpg', kind:'image' }
];

test('expanded folders are flattened directly below their parent', () => {
  const rows = flattenProjectTree(entries, new Set(['src', 'src/lib']));
  assert.deepEqual(rows.map(row => [row.path, row.depth]), [
    ['assets', 0], ['src', 0], ['src/lib', 1], ['src/lib/a.py', 2], ['src/z.py', 1], ['README.md', 0]
  ]);
});

test('collapsed folders hide descendants', () => {
  assert.deepEqual(flattenProjectTree(entries, new Set()).map(row => row.path), ['assets', 'src', 'README.md']);
});

test('moving a folder updates every descendant atomically', () => {
  const result = planEntryMove(entries, 'src', 'archive');
  assert.equal(result.destination, 'archive/src');
  assert.deepEqual(result.changes.map(change => change.path), ['archive/src/z.py', 'archive/src/lib/a.py']);
  assert.throws(() => planEntryMove(entries, 'src', 'src/lib'), /子フォルダ/);
  assert.throws(() => planEntryMove([...entries, { id:'5', path:'archive/src/keep.txt', kind:'text' }], 'src', 'archive'), /同じ名前/);
  assert.deepEqual([...remapExpandedFolders(new Set(['src', 'src/lib']), 'src', 'archive/src')], ['archive/src', 'archive/src/lib']);
});

test('copy names receive a non-destructive numeric suffix', () => {
  assert.equal(nextAvailablePath(new Set(['src/main.py', 'src/main-2.py']), 'src/main.py'), 'src/main-3.py');
});
