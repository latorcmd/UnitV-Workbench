import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPythonCompletions } from '../src/python-completions.js';

test('Python completion includes keywords, UnitV APIs, and current-file symbols', () => {
  const labels = collectPythonCompletions(`
import sensor as camera
from machine import UART as Serial
value = 1
def detect(img, threshold=3):
    for blob in img.find_blobs([]):
        pass
class Runner:
    pass
`).map(item => item.label);
  for (const expected of ['import', 'sensor.snapshot', 'camera', 'Serial', 'value', 'detect', 'img', 'threshold', 'blob', 'Runner']) {
    assert.ok(labels.includes(expected), `missing ${expected}`);
  }
});
