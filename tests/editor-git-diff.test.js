import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { gitDiffExtension, setGitBaseline } from '../src/editor-git-diff.js';

test('Git gutter state accepts additions, deletions, and replacements', () => {
  let state = EditorState.create({ doc:'one\nchanged\nthree\nadded', extensions:[gitDiffExtension] });
  state = state.update({ effects:setGitBaseline.of({ enabled:true, text:'one\ntwo\nthree\ndeleted' }) }).state;
  assert.equal(state.doc.toString(), 'one\nchanged\nthree\nadded');
  state = state.update({ changes:{ from:state.doc.length, insert:'\nlast' } }).state;
  assert.match(state.doc.toString(), /last$/);
  state = state.update({ effects:setGitBaseline.of({ enabled:false, text:'' }) }).state;
  assert.equal(state.doc.lines, 5);
});
