import { StateEffect, StateField, RangeSetBuilder, Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter } from '@codemirror/view';
import { Chunk } from '@codemirror/merge';

export const setGitBaseline = StateEffect.define();
const toggleGitHunk = StateEffect.define();

class DiffMarker extends GutterMarker {
  constructor(kind) { super(); this.kind = kind; }
  eq(other) { return other.kind === this.kind; }
  get elementClass() { return `cm-git-marker cm-git-${this.kind}`; }
}

class DeletedLinesWidget extends WidgetType {
  constructor(lines, startLine) { super(); this.lines = lines; this.startLine = startLine; }
  eq(other) { return other.lines === this.lines && other.startLine === this.startLine; }
  toDOM() {
    const wrapper = document.createElement('div'); wrapper.className = 'cm-inline-diff';
    const header = document.createElement('div'); header.className = 'cm-inline-diff-head'; header.textContent = '直前のコミットで削除された行'; wrapper.append(header);
    const list = document.createElement('div');
    const values = this.lines ? this.lines.replace(/\n$/, '').split('\n') : [''];
    values.forEach((value, index) => {
      const row = document.createElement('div'); const number = document.createElement('span'); const code = document.createElement('code');
      number.textContent = String(this.startLine + index); code.textContent = value || ' '; row.append(number, code); list.append(row);
    });
    wrapper.append(list); return wrapper;
  }
  ignoreEvent() { return false; }
}

const marker = kind => new DiffMarker(kind);

function markerPosition(chunk, doc) {
  return doc.lineAt(Math.min(chunk.fromB, doc.length)).from;
}

function createValue(baseline, doc, openIndex = null) {
  if (!baseline?.enabled) return { baseline, chunks:[], markers:Decoration.none, decorations:Decoration.none, openIndex:null };
  const original = Text.of(String(baseline.text || '').split('\n'));
  const chunks = Chunk.build(original, doc, { scanLimit:1000, timeout:60 });
  const markerBuilder = new RangeSetBuilder();
  const decorations = [];
  chunks.forEach((chunk, index) => {
    const hasOriginal = chunk.toA > chunk.fromA;
    const hasCurrent = chunk.toB > chunk.fromB;
    const first = markerPosition(chunk, doc);
    markerBuilder.add(first, first, marker(hasOriginal && hasCurrent ? 'modified' : hasCurrent ? 'added' : 'deleted'));
    if (index !== openIndex) return;
    if (hasOriginal) {
      const deleted = original.sliceString(chunk.fromA, chunk.endA);
      const startLine = original.lineAt(Math.min(chunk.fromA, original.length)).number;
      decorations.push(Decoration.widget({ widget:new DeletedLinesWidget(deleted, startLine), block:true, side:-1 }).range(first));
    }
    if (hasCurrent) {
      let position = chunk.fromB;
      while (position <= chunk.endB && position <= doc.length) {
        const line = doc.lineAt(position); decorations.push(Decoration.line({ class:'cm-inline-diff-current' }).range(line.from));
        if (line.to >= chunk.endB || line.number === doc.lines) break;
        position = line.to + 1;
      }
    }
  });
  return { baseline, chunks, markers:markerBuilder.finish(), decorations:Decoration.set(decorations, true), openIndex:openIndex != null && chunks[openIndex] ? openIndex : null };
}

const gitDiffField = StateField.define({
  create(state) { return createValue({ enabled:false, text:'' }, state.doc); },
  update(value, transaction) {
    let baseline = value.baseline;
    let openIndex = value.openIndex;
    for (const effect of transaction.effects) {
      if (effect.is(setGitBaseline)) { baseline = effect.value; openIndex = null; }
      if (effect.is(toggleGitHunk)) openIndex = openIndex === effect.value ? null : effect.value;
    }
    if (transaction.docChanged || baseline !== value.baseline || openIndex !== value.openIndex) return createValue(baseline, transaction.state.doc, openIndex);
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const gitGutter = gutter({
  class:'cm-git-diff-gutter',
  markers:view => view.state.field(gitDiffField).markers,
  initialSpacer:() => marker('added'),
  domEventHandlers:{
    mousedown(view, line, event) {
      if (event.button !== 0) return false;
      const state = view.state.field(gitDiffField);
      const index = state.chunks.findIndex(chunk => markerPosition(chunk, view.state.doc) === line.from);
      if (index < 0) return false;
      event.preventDefault(); view.dispatch({ effects:toggleGitHunk.of(index) }); return true;
    }
  }
});

export const gitDiffExtension = [gitDiffField, gitGutter];
