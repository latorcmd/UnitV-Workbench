import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeYolo2, inspectKmodel } from '../src/kmodel-runtime.js';

function syntheticKmodel() {
  const bytes = new Uint8Array(100);
  const view = new DataView(bytes.buffer);
  const put = (offset, value) => view.setUint32(offset, value, true);
  put(0, 3); put(4, 1); put(8, 0); put(12, 2); put(20, 128); put(24, 1);
  put(28, 0); put(32, 16);
  put(36, 10240); put(40, 24);
  put(44, 12); put(48, 24);
  return bytes;
}

test('inspects kmodel v3 metadata without ONNX', () => {
  const info = inspectKmodel(syntheticKmodel());
  assert.equal(info.version, 3);
  assert.equal(info.layers, 2);
  assert.equal(info.mainMemory, 128);
  assert.deepEqual(info.layerList.map(layer => layer.type), [10240, 12]);
  assert.deepEqual(info.unsupported, []);
});

test('rejects newer kmodel formats with an actionable message', () => {
  const model = syntheticKmodel();
  new DataView(model.buffer).setUint32(0, 4, true);
  assert.throws(() => inspectKmodel(model), /v3のみ対応/);
});

test('decodes MaixPy YOLO2 output into UnitV-style detections', () => {
  const output = new Float32Array([0, 0, 0, 0, 10, 10, 0, 0]);
  const detections = decodeYolo2(output, { width:1, height:1, channels:8, inputWidth:100, inputHeight:100 }, {
    anchors:[1, 1], anchorCount:1, threshold:.2, nmsThreshold:.4, imageWidth:100, imageHeight:100
  });
  assert.equal(detections.length, 1);
  assert.equal(detections[0].classId, 0);
  assert.ok(detections[0].value > .99);
  assert.deepEqual({ x:detections[0].x, y:detections[0].y, w:detections[0].w, h:detections[0].h }, { x:0, y:0, w:100, h:100 });
});
