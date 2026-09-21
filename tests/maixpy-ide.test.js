import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFileSavePayload, commandHeader, MaixPyIdeClient, MAIXPY_COMMAND,
  MAIXPY_CONSOLE_BAUD, MAIXPY_IDE_BAUD, MAIXPY_STATUS_MAGIC
} from '../src/maixpy-ide.js';

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
  constructor(responses = []) {
    this.responses = responses;
    this.writes = [];
    this.reopens = [];
    this.connected = true;
    this.baudRate = MAIXPY_CONSOLE_BAUD;
  }
  async write(bytes) { this.writes.push(new Uint8Array(bytes)); }
  async reopen(baudRate) { this.reopens.push(baudRate); this.baudRate = baudRate; }
  discardBuffered() {}
  takeBuffered() { return new Uint8Array(); }
  async readExact(length) {
    const response = this.responses.shift();
    assert.equal(response.byteLength, length);
    return response;
  }
}

test('IDE mode stays at the open console baud rate on Windows Web Serial', async () => {
  assert.equal(MAIXPY_IDE_BAUD, MAIXPY_CONSOLE_BAUD);
  const transport = new MockTransport([le32(MAIXPY_STATUS_MAGIC)]);
  const traces = [];
  const client = new MaixPyIdeClient(transport, { onTrace:trace => traces.push(trace) });
  await client.activateIde();
  assert.deepEqual(transport.reopens, []);
  const bootstrap = new TextDecoder().decode(transport.writes[3]);
  assert.match(bootstrap, /init\(115200,/);
  assert.match(bootstrap, /except TypeError:/);
  assert.equal(bootstrap.charCodeAt(bootstrap.length - 1), 0x04);
  assert.equal(client.ideReady, true);
  assert.deepEqual(traces.map(trace => trace.step), [
    'IDE-02', 'IDE-02R', 'IDE-03', 'IDE-03R', 'IDE-04', 'IDE-04R', 'IDE-05', 'IDE-06'
  ]);
});

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

test('file-save payload contains digest, aligned filename and program bytes', async () => {
  const content = new TextEncoder().encode('print(1)\n');
  const payload = await buildFileSavePayload('/flash/main.py', content);
  const body = payload.subarray(32);
  const filename = new TextDecoder().decode(body.subarray(0, 14));
  assert.equal(filename, '/flash/main.py');
  assert.deepEqual([...body.subarray(14, 16)], [0, 0]);
  assert.equal(new TextDecoder().decode(body.subarray(16)), 'print(1)\n');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  assert.deepEqual([...payload.subarray(0, 32)], [...digest]);
});

test('saveFile waits for UnitV flash verification status', async () => {
  const transport = new MockTransport([le32(0), le32(5), le32(0)]);
  const client = new MaixPyIdeClient(transport);
  client.ideReady = true;
  const progress = [];
  const result = await client.saveFile('/flash/main.py', new TextEncoder().encode('x=1\n'), { onProgress:value => progress.push(value) });
  assert.deepEqual(result, { path:'/flash/main.py', bytes:4 });
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(transport.writes.filter(packet => packet.byteLength === 6 && packet[0] === 0x30).map(packet => packet[1]), [
    MAIXPY_COMMAND.FILE_SAVE_STATUS, MAIXPY_COMMAND.FILE_SAVE, MAIXPY_COMMAND.FILE_SAVE_STATUS, MAIXPY_COMMAND.FILE_SAVE_STATUS
  ]);
});
