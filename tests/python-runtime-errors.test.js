import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byteOffsetToLocation, explainPythonError, mapPreparedError, parseFormatterError,
  parsePythonRuntimeError, prepareUnitVCode
} from '../src/python-runtime-errors.js';

test('parses the final project traceback frame and caret range', () => {
  const traceback = `Traceback (most recent call last):
  File "/unitv-project-a1/main.py", line 4, in <module>
    total = missing + 1
            ^^^^^^^
NameError: name 'missing' is not defined`;
  const error = parsePythonRuntimeError(traceback);
  assert.equal(error.filename, 'main.py');
  assert.equal(error.line, 4);
  assert.equal(error.column, 9);
  assert.equal(error.endColumn, 16);
  assert.equal(error.type, 'NameError');
  assert.match(explainPythonError(error).description, /変数|関数/);
});

test('keeps imported file paths when choosing the last traceback frame', () => {
  const traceback = `Traceback (most recent call last):
  File "main.py", line 2, in <module>
  File "/unitv-project-123/lib/colors.py", line 8, in value
ZeroDivisionError: division by zero`;
  const error = parsePythonRuntimeError(traceback);
  assert.equal(error.filename, 'lib/colors.py');
  assert.equal(error.line, 8);
  assert.equal(error.type, 'ZeroDivisionError');
});

test('maps camera replacement columns back to original source', () => {
  const source = 'value = sensor.snapshot() + missing';
  const transformed = prepareUnitVCode(source, true);
  assert.equal(transformed.prepared, 'value = await sensor.snapshot_async() + missing');
  const preparedColumn = transformed.prepared.indexOf('missing') + 1;
  const mapped = mapPreparedError({ line:1, column:preparedColumn, endColumn:preparedColumn + 7 }, transformed.mappings);
  assert.equal(mapped.column, source.indexOf('missing') + 1);
  assert.equal(mapped.endColumn, source.indexOf('missing') + 8);
});

test('limits only top-level while True in static-image mode', () => {
  const source = 'while(True):\n    print(1)\n    while True:\n        print(2)';
  const transformed = prepareUnitVCode(source, false);
  assert.equal(transformed.limited, true);
  assert.match(transformed.prepared, /^for __unitv_browser_frame in range\(1\):/);
  assert.match(transformed.prepared, /\n    while True:/);
});

test('converts UTF-8 formatter byte ranges to line and UTF-16 column', () => {
  const source = '名前 = 1\nx =\n';
  const byteStart = new TextEncoder().encode('名前 = 1\nx ').length;
  assert.deepEqual(byteOffsetToLocation(source, byteStart), { offset:9, line:2, column:3 });
  const error = parseFormatterError(new Error(`Expected an expression at byte range ${byteStart}..${byteStart + 1}`), source, 'main.py');
  assert.equal(error.filename, 'main.py');
  assert.equal(error.line, 2);
  assert.equal(error.column, 3);
});
