export const MAIXPY_COMMAND = Object.freeze({
  FRAME_SIZE:0x81,
  FRAME_DUMP:0x82,
  SCRIPT_EXEC:0x05,
  SCRIPT_STOP:0x06,
  FILE_SAVE:0x07,
  FILE_SAVE_STATUS:0x88,
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

export async function buildFileSavePayload(path, content, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('安全なファイル検証を利用できません。HTTPSまたはlocalhostで開いてください。');
  const normalizedPath = String(path || '');
  if (!normalizedPath.startsWith('/flash/') || normalizedPath.includes('\0') || normalizedPath.length > 240) throw new Error('書き込み先は/flash/内の有効なパスにしてください。');
  const filename = new TextEncoder().encode(normalizedPath);
  const data = content instanceof Uint8Array ? content : new Uint8Array(content);
  const filenameLength = Math.ceil((filename.byteLength + 1) / 4) * 4;
  const body = new Uint8Array(filenameLength + data.byteLength);
  body.set(filename, 0);
  body.set(data, filenameLength);
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', body));
  const payload = new Uint8Array(digest.byteLength + body.byteLength);
  payload.set(digest, 0);
  payload.set(body, digest.byteLength);
  return payload;
}

const FILE_SAVE_ERRORS = Object.freeze({
  2:'UnitVのメモリ不足により保存できませんでした。',
  3:'UnitVで保存先ファイルを開けませんでした。',
  4:'UnitVのフラッシュへの書き込みに失敗しました。',
  6:'転送データのSHA-256検証に失敗しました。',
  100:'UnitV側で予期しないファイル保存エラーが発生しました。'
});

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

  async saveFile(path, content, { onProgress = () => {}, timeoutMs = 20_000 } = {}) {
    return this.#serialized(async () => {
      if (!this.ideReady) throw new Error('UnitVがIDEモードではありません。');
      const data = content instanceof Uint8Array ? content : new Uint8Array(content);
      const payload = await buildFileSavePayload(path, data);
      const initialStatus = uint32(await this.#query(MAIXPY_COMMAND.FILE_SAVE_STATUS, 4));
      if (initialStatus !== 0) throw new Error(`UnitVが別の保存処理を実行中です（状態 ${initialStatus}）。`);
      await this.transport.write(commandHeader(MAIXPY_COMMAND.FILE_SAVE, payload.byteLength));
      const chunkSize = 4096;
      for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
        await this.transport.write(payload.subarray(offset, Math.min(payload.byteLength, offset + chunkSize)));
        onProgress(Math.min(1, (offset + chunkSize) / payload.byteLength));
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await delay(80);
        const status = uint32(await this.#query(MAIXPY_COMMAND.FILE_SAVE_STATUS, 4));
        if (status === 0) return { path, bytes:data.byteLength };
        if (status !== 1 && status !== 5) throw new Error(FILE_SAVE_ERRORS[status] || `UnitVのファイル保存に失敗しました（状態 ${status}）。`);
      }
      throw new Error('UnitVへの書き込み完了を確認できませんでした。');
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
