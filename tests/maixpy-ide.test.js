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
    this.buffered = [
      new TextEncoder().encode('init i2c2\\r\\n'),
      new TextEncoder().encode('[MAIXPY]: find ov7740\\r\\n'),
      new TextEncoder().encode('KeyboardInterrupt\\r\\n>>> '),
      new TextEncoder().encode('raw REPL; CTRL-B to exit\\r\\n>'),
      new TextEncoder().encode('OK')
    ];
  }
  async write(bytes) { this.writes.push(new Uint8Array(bytes)); }
  async reopen(baudRate) { this.reopens.push(baudRate); this.baudRate = baudRate; }
  discardBuffered() {}
  takeBuffered() { return this.buffered.shift() || new Uint8Array(); }
  async readExact(length) {
    const response = this.responses.shift();
    assert.equal(response.byteLength, length);
    return response;
  }
}

class ActiveIdeTransport {
  constructor() {
    this.connected = true;
    this.baudRate = MAIXPY_CONSOLE_BAUD;
    this.writes = [];
  }
  discardBuffered() {}
  async write(bytes) { this.writes.push(new Uint8Array(bytes)); }
  async readUntil(expected) {
    const received = new Uint8Array(expected.byteLength + 2);
    received.set([0xaa, 0x55]);
    received.set(expected, 2);
    return received;
  }
}

test('reconnect detects IDE mode before sending REPL control bytes', async () => {
  const transport = new ActiveIdeTransport();
  const traces = [];
  const client = new MaixPyIdeClient(transport, { onTrace:trace => traces.push(trace) });
  await client.activateIde();
  assert.equal(client.ideReady, true);
  assert.deepEqual(transport.writes.map(packet => [...packet]), [
    [...commandHeader(MAIXPY_COMMAND.QUERY_STATUS, 4)]
  ]);
  assert.match(traces.find(trace => trace.step === 'IDE-01R').message, /起動済みのIDEモード/);
  assert.equal(traces.some(trace => trace.step === 'IDE-02'), false);
});

test('IDE preparation can be cancelled while waiting for the REPL', async () => {
  const transport = new MockTransport();
  transport.buffered = [];
  const controller = new AbortController();
  const client = new MaixPyIdeClient(transport);
  const pending = client.activateIde({ signal:controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.equal(client.ideReady, false);
  assert.equal(transport.writes.some(packet => new TextDecoder().decode(packet).includes('from machine import UART')), false);
});

test('silent REPL recovery reopens the same baud rate and retries', async () => {
  const transport = new MockTransport([le32(MAIXPY_STATUS_MAGIC)]);
  transport.buffered = [];
  transport.recoveredReplies = [
    new TextEncoder().encode('KeyboardInterrupt\r\n>>> '),
    new TextEncoder().encode('raw REPL; CTRL-B to exit\r\n>'),
    new TextEncoder().encode('OK')
  ];
  transport.takeBuffered = () => transport.reopens.length ? (transport.recoveredReplies.shift() || new Uint8Array()) : new Uint8Array();
  const traces = [];
  const client = new MaixPyIdeClient(transport, {
    onTrace:trace => traces.push(trace),
    replInitialTimeoutMs:1,
    replRecoveryTimeoutMs:2_000
  });
  await client.activateIde();
  assert.equal(client.ideReady, true);
  assert.deepEqual(transport.reopens, [MAIXPY_CONSOLE_BAUD]);
  assert.match(traces.find(trace => trace.step === 'IDE-02B.1').message, /0 byte/);
  assert.match(traces.find(trace => trace.step === 'IDE-02BR.1').message, /開き直しました/);
});

test('stalled boot output triggers another automatic recovery cycle', async () => {
  const transport = new MockTransport([le32(MAIXPY_STATUS_MAGIC)]);
  let bootLogReturned = false;
  const successfulReplies = [
    new TextEncoder().encode('KeyboardInterrupt\r\n>>> '),
    new TextEncoder().encode('raw REPL; CTRL-B to exit\r\n>'),
    new TextEncoder().encode('OK')
  ];
  transport.takeBuffered = () => {
    if (transport.reopens.length === 1 && !bootLogReturned) {
      bootLogReturned = true;
      return new TextEncoder().encode('[MAIXPY] boot stalled');
    }
    if (transport.reopens.length >= 2) return successfulReplies.shift() || new Uint8Array();
    return new Uint8Array();
  };
  const traces = [];
  const client = new MaixPyIdeClient(transport, {
    onTrace:trace => traces.push(trace),
    replInitialTimeoutMs:1,
    replRecoveryTimeoutMs:1,
    replRecoveryAttempts:2
  });
  await client.activateIde();
  assert.equal(client.ideReady, true);
  assert.deepEqual(transport.reopens, [MAIXPY_CONSOLE_BAUD, MAIXPY_CONSOLE_BAUD]);
  assert.match(traces.find(trace => trace.step === 'IDE-02B.2').message, /boot stalled/);
});

test('IDE mode stays at the open console baud rate on Windows Web Serial', async () => {
  assert.equal(MAIXPY_IDE_BAUD, MAIXPY_CONSOLE_BAUD);
  const transport = new MockTransport([le32(MAIXPY_STATUS_MAGIC)]);
  const traces = [];
  const client = new MaixPyIdeClient(transport, { onTrace:trace => traces.push(trace) });
  await client.activateIde();
  assert.deepEqual(transport.reopens, []);
  const bootstrapPacket = transport.writes.find(packet => new TextDecoder().decode(packet).includes('from machine import UART'));
  const bootstrap = new TextDecoder().decode(bootstrapPacket);
  assert.match(bootstrap, /init\(115200,/);
  assert.match(bootstrap, /except TypeError:/);
  assert.equal(bootstrap.charCodeAt(bootstrap.length - 1), 0x04);
  assert.equal(client.ideReady, true);
  assert.equal(transport.writes.filter(packet => packet[0] === 0x03 && packet[1] === 0x03 && packet[2] === 0x02).length, 3);
  assert.match(traces.find(trace => trace.step === 'IDE-02R').message, /3回/);
  assert.deepEqual(traces.map(trace => trace.step), [
    'IDE-01', 'IDE-02', 'IDE-02R', 'IDE-03', 'IDE-03R', 'IDE-04', 'IDE-04R', 'IDE-05', 'IDE-06'
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
