import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSerialTransport } from '../src/serial-transport.js';

function mockPort({ openError = null, incoming = [] } = {}) {
  let finishRead;
  const pendingRead = new Promise(resolve => { finishRead = resolve; });
  const chunks = incoming.map(bytes => new Uint8Array(bytes));
  const reader = {
    read:async () => chunks.length ? { value:chunks.shift(), done:false } : pendingRead,
    cancel:async () => finishRead({ done:true }),
    releaseLock() {}
  };
  const writer = {
    async write() {},
    releaseLock() {}
  };
  return {
    opened:false,
    readable:{ getReader:() => reader },
    writable:{ getWriter:() => writer },
    async open() {
      if (openError) throw openError;
      this.opened = true;
    },
    async close() { this.opened = false; }
  };
}

test('reuses one previously authorized Web Serial port', async () => {
  const port = mockPort();
  let requested = 0;
  const transport = new WebSerialTransport({
    getPorts:async () => [port],
    requestPort:async () => { requested += 1; return port; }
  });
  await transport.requestAndOpen(115200);
  assert.equal(requested, 0);
  assert.equal(transport.connected, true);
  assert.equal(transport.baudRate, 115200);
  await transport.close();
});

test('finds an IDE status sequence after leftover REPL bytes', async () => {
  const port = mockPort({ incoming:[[0x4f, 0x4b, 0x04, 0x3e, 0xaa, 0xbb, 0xee, 0xff]] });
  const transport = new WebSerialTransport({ getPorts:async () => [port], requestPort:async () => port });
  await transport.requestAndOpen(115200);
  const received = await transport.readUntil(new Uint8Array([0xaa, 0xbb, 0xee, 0xff]), 100);
  assert.deepEqual([...received], [0x4f, 0x4b, 0x04, 0x3e, 0xaa, 0xbb, 0xee, 0xff]);
  await transport.close();
});

test('turns Chrome open failures into an actionable COM-port message', async () => {
  const port = mockPort({ openError:new DOMException("Failed to open serial port.", 'NetworkError') });
  const transport = new WebSerialTransport({
    getPorts:async () => [port],
    requestPort:async () => port
  });
  await assert.rejects(
    transport.requestAndOpen(115200),
    /選択したM5Stackポートを使っているシリアルモニタやMaixPy IDEを閉じ/
  );
});
