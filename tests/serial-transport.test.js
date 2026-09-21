import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSerialTransport } from '../src/serial-transport.js';

function mockPort({ openError = null } = {}) {
  let finishRead;
  const pendingRead = new Promise(resolve => { finishRead = resolve; });
  const reader = {
    read:() => pendingRead,
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

test('turns Chrome open failures into an actionable COM-port message', async () => {
  const port = mockPort({ openError:new DOMException("Failed to open serial port.", 'NetworkError') });
  const transport = new WebSerialTransport({
    getPorts:async () => [port],
    requestPort:async () => port
  });
  await assert.rejects(
    transport.requestAndOpen(115200),
    /COM1を使っているシリアルモニタやMaixPy IDEを閉じ/
  );
});
