export const MAIXPY_COMMAND = Object.freeze({
  FRAME_SIZE:0x81,
  FRAME_DUMP:0x82,
  SCRIPT_EXEC:0x05,
  SCRIPT_STOP:0x06,
  SCRIPT_RUNNING:0x87,
  SYS_RESET:0x0c,
  FB_ENABLE:0x0d,
  QUERY_STATUS:0x8d,
  TX_BUF_LEN:0x8e,
  TX_BUF:0x8f
});

export const MAIXPY_IDE_BAUD = 1_500_000;
export const MAIXPY_CONSOLE_BAUD = 115_200;
export const MAIXPY_STATUS_MAGIC = 0xffeebbaa;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function commandHeader(command, length = 0) {
  const bytes = new Uint8Array(6);
  bytes[0] = 0x30;
  bytes[1] = command;
  new DataView(bytes.buffer).setUint32(2, length, true);
  return bytes;
}

function uint32(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export class MaixPyIdeClient {
  constructor(transport) {
    this.transport = transport;
    this.queue = Promise.resolve();
    this.ideReady = false;
  }

  #serialized(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async connectConsole() {
    await this.transport.requestAndOpen(MAIXPY_CONSOLE_BAUD);
    this.ideReady = false;
  }

  async activateIde() {
    return this.#serialized(async () => {
      if (this.ideReady) return;
      if (!this.transport.connected) throw new Error('先にUnitVを接続してください。');
      if (this.transport.baudRate !== MAIXPY_CONSOLE_BAUD) await this.transport.reopen(MAIXPY_CONSOLE_BAUD);
      this.transport.discardBuffered();
      await this.transport.write(new Uint8Array([0x0d, 0x03, 0x03]));
      await delay(180);
      this.transport.discardBuffered();
      await this.transport.write(new Uint8Array([0x0d, 0x01]));
      await delay(180);
      this.transport.discardBuffered();
      const bootstrap = 'from machine import UART\nUART.repl_uart().init(1500000, 8, None, 1, read_buf_len=2048, ide=True, from_ide=False)';
      const code = new TextEncoder().encode(bootstrap);
      const payload = new Uint8Array(code.byteLength + 1);
      payload.set(code);
      payload[payload.length - 1] = 0x04;
      await this.transport.write(payload);
      await delay(450);
      await this.transport.reopen(MAIXPY_IDE_BAUD);
      await delay(250);
      this.transport.discardBuffered();
      const status = await this.#query(MAIXPY_COMMAND.QUERY_STATUS, 4, 2500);
      if (uint32(status) !== MAIXPY_STATUS_MAGIC) throw new Error('UnitVをMaixPy IDEモードへ切り替えられませんでした。ファームウェアとUSB接続を確認してください。');
      this.ideReady = true;
    });
  }

  async #query(command, length, timeout = 2000) {
    await this.transport.write(commandHeader(command, length));
    return this.transport.readExact(length, timeout);
  }

  async execute(code) {
    return this.#serialized(async () => {
      if (!this.ideReady) throw new Error('UnitVがIDEモードではありません。');
      const bytes = new TextEncoder().encode(code);
      await this.transport.write(commandHeader(MAIXPY_COMMAND.SCRIPT_EXEC, bytes.byteLength));
      await this.transport.write(bytes);
    });
  }

  async setFrameBufferEnabled(enabled) {
    return this.#serialized(async () => {
      if (!this.ideReady) return;
      const packet = new Uint8Array(8);
      packet.set(commandHeader(MAIXPY_COMMAND.FB_ENABLE, 0));
      new DataView(packet.buffer).setInt16(6, enabled ? 1 : 0, true);
      await this.transport.write(packet);
    });
  }

  async stop() {
    return this.#serialized(async () => {
      if (!this.ideReady) return;
      await this.transport.write(commandHeader(MAIXPY_COMMAND.SCRIPT_STOP, 0));
    });
  }

  async poll() {
    return this.#serialized(async () => {
      if (!this.ideReady) throw new Error('UnitVがIDEモードではありません。');
      const txLength = uint32(await this.#query(MAIXPY_COMMAND.TX_BUF_LEN, 4));
      if (txLength > 4 * 1024 * 1024) throw new Error('UnitVの出力バッファが上限を超えました。');
      const stdout = txLength ? await this.#query(MAIXPY_COMMAND.TX_BUF, txLength, 5000) : new Uint8Array();
      const frameInfo = await this.#query(MAIXPY_COMMAND.FRAME_SIZE, 12);
      const width = uint32(frameInfo, 0);
      const height = uint32(frameInfo, 4);
      const frameLength = uint32(frameInfo, 8);
      let jpeg = null;
      if (width && height && frameLength) {
        if (width > 4096 || height > 4096 || frameLength > 16 * 1024 * 1024) throw new Error('UnitVから不正なフレーム情報を受信しました。');
        jpeg = await this.#query(MAIXPY_COMMAND.FRAME_DUMP, frameLength, 8000);
      }
      const running = Boolean(uint32(await this.#query(MAIXPY_COMMAND.SCRIPT_RUNNING, 4)));
      return { stdout, frame:jpeg ? { width, height, jpeg } : null, running };
    });
  }

  async resetAndClose() {
    try { await this.stop(); } catch { /* best effort */ }
    try { await this.setFrameBufferEnabled(false); } catch { /* best effort */ }
    try {
      if (this.ideReady) await this.#serialized(() => this.transport.write(commandHeader(MAIXPY_COMMAND.SYS_RESET, 0)));
    } catch { /* best effort */ }
    this.ideReady = false;
    await this.transport.close();
  }
}
