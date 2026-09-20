import test from 'node:test';
import assert from 'node:assert/strict';
import { commandHeader, MaixPyIdeClient, MAIXPY_COMMAND } from '../src/maixpy-ide.js';

function le32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function frameInfo(width, height, length) {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width, true); view.setUint32(4, height, true); view.setUint32(8, length, true);
  return bytes;
}

class MockTransport {
  constructor(responses = []) { this.responses = responses; this.writes = []; this.connected = true; this.baudRate = 1_500_000; }
  async write(bytes) { this.writes.push(new Uint8Array(bytes)); }
  async readExact(length) {
    const response = this.responses.shift();
    assert.equal(response.byteLength, length);
    return response;
  }
}

test('command header uses MaixPy little-endian framing', () => {
  assert.deepEqual([...commandHeader(MAIXPY_COMMAND.SCRIPT_EXEC, 0x12345678)], [0x30, 0x05, 0x78, 0x56, 0x34, 0x12]);
});

test('poll reads stdout, framebuffer JPEG and running state in order', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const transport = new MockTransport([
    le32(3), new TextEncoder().encode('ok\n'), frameInfo(224, 224, jpeg.length), jpeg, le32(1)
  ]);
  const client = new MaixPyIdeClient(transport);
  client.ideReady = true;
  const result = await client.poll();
  assert.equal(new TextDecoder().decode(result.stdout), 'ok\n');
  assert.equal(result.frame.width, 224);
  assert.deepEqual([...result.frame.jpeg], [...jpeg]);
  assert.equal(result.running, true);
  assert.deepEqual(transport.writes.map(packet => packet[1]), [
    MAIXPY_COMMAND.TX_BUF_LEN, MAIXPY_COMMAND.TX_BUF, MAIXPY_COMMAND.FRAME_SIZE,
    MAIXPY_COMMAND.FRAME_DUMP, MAIXPY_COMMAND.SCRIPT_RUNNING
  ]);
});

test('framebuffer enable packet includes the trailing int16 flag', async () => {
  const transport = new MockTransport();
  const client = new MaixPyIdeClient(transport);
  client.ideReady = true;
  await client.setFrameBufferEnabled(true);
  assert.deepEqual([...transport.writes[0]], [0x30, MAIXPY_COMMAND.FB_ENABLE, 0, 0, 0, 0, 1, 0]);
});
