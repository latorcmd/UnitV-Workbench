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

export const MAIXPY_CONSOLE_BAUD = 115_200;
// Keep the USB serial port open while switching from REPL to IDE mode. Closing
// COM ports only to reopen them at 1.5 Mbaud is unreliable in Chrome on
// Windows (and some USB-UART bridges reject that rate entirely). The MaixPy
// IDE protocol itself is baud-rate independent, so the console rate is slower
// but substantially more reliable for browser use.
export const MAIXPY_IDE_BAUD = MAIXPY_CONSOLE_BAUD;
export const MAIXPY_STATUS_MAGIC = 0xffeebbaa;
export const MAIXPY_DIAGNOSTIC_VERSION = 6;

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

function statusMagicBytes() {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, MAIXPY_STATUS_MAGIC, true);
  return bytes;
}

function receivedPreview(bytes, limit = 160) {
  if (!bytes?.byteLength) return '0 byte';
  const shown = bytes.subarray(0, limit);
  const text = new TextDecoder('utf-8', { fatal:false }).decode(shown)
    .replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const suffix = bytes.byteLength > shown.byteLength ? '…' : '';
  return `${bytes.byteLength} byte: "${text}${suffix}"`;
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
  constructor(transport, { onTrace = () => {} } = {}) {
    this.transport = transport;
    this.queue = Promise.resolve();
    this.ideReady = false;
    this.onTrace = onTrace;
  }

  #trace(step, message, level = 'debug') {
    this.onTrace({ step, message, level });
  }

  #serialized(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  #takeBuffered(step, label, level = 'debug') {
    if (typeof this.transport.takeBuffered !== 'function') return new Uint8Array();
    const bytes = this.transport.takeBuffered(4096);
    this.#trace(step, `${label}: ${receivedPreview(bytes)}`, level);
    return bytes;
  }

  async #waitForReplPrompt({ raw = false, timeoutMs = 8_000 } = {}) {
    if (typeof this.transport.takeBuffered !== 'function') {
      await delay(raw ? 300 : 600);
      return new Uint8Array();
    }
    const received = [];
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let nextProgressAt = startedAt + 5_000;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      if (raw) await this.transport.write(new Uint8Array([0x01]));
      else await this.transport.write(new Uint8Array([0x03, 0x03, 0x02]));
      await delay(raw ? 220 : 420);
      const chunk = this.transport.takeBuffered(4096);
      for (const byte of chunk) if (received.length < 8192) received.push(byte);
      const bytes = new Uint8Array(received);
      const text = new TextDecoder().decode(bytes);
      if (raw ? text.includes('raw REPL') : text.includes('>>>')) return { bytes, attempts };
      if (!raw && Date.now() >= nextProgressAt) {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        this.#trace('IDE-02W', `REPL応答を待機中です（${seconds}秒、Ctrl+C ${attempts}回、${receivedPreview(bytes)}）。`);
        nextProgressAt += 5_000;
      }
    }
    const mode = raw ? 'raw REPL' : 'friendly REPL';
    throw new Error(`${mode}のプロンプトを確認できませんでした（${receivedPreview(new Uint8Array(received))}）。`);
  }

  async #detectActiveIde() {
    if (typeof this.transport.readUntil !== 'function') return false;
    const expectedStatus = statusMagicBytes();
    this.transport.discardBuffered();
    await this.transport.write(commandHeader(MAIXPY_COMMAND.QUERY_STATUS, 4));
    try {
      const received = await this.transport.readUntil(expectedStatus, 1_000, 4096);
      this.#trace('IDE-01R', `起動済みのIDEモードを検出しました（前置き ${received.byteLength - expectedStatus.byteLength} byte）。`);
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      if (!/IDE応答を確認できませんでした|タイムアウト/.test(message)) throw error;
      this.#trace('IDE-01R', `IDEモード応答はありませんでした。REPLからの切り替えを続けます（${message}）`);
      return false;
    }
  }

  async connectConsole() {
    this.#trace('SERIAL-01', `通信診断 v${MAIXPY_DIAGNOSTIC_VERSION}: 許可済みポートまたは選択ポートを ${MAIXPY_CONSOLE_BAUD} baudで開きます。`);
    try {
      const port = await this.transport.requestAndOpen(MAIXPY_CONSOLE_BAUD);
      const info = port?.getInfo?.() || {};
      const usbId = info.usbVendorId == null ? '' : ` (USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${String(info.usbProductId ?? 0).toString(16).padStart(4, '0')})`;
      this.#trace('SERIAL-02', `ポートを開きました${usbId}。`);
      this.ideReady = false;
    } catch (error) {
      this.#trace('SERIAL-01', `失敗: ${error.message}`, 'error');
      throw error;
    }
  }

  async activateIde() {
    return this.#serialized(async () => {
      let stage = 'IDE-00';
      try {
        if (this.ideReady) { this.#trace('IDE-00', 'IDEモードは既に準備済みです。'); return; }
        if (!this.transport.connected) throw new Error('先にUnitVを接続してください。');
        if (this.transport.baudRate !== MAIXPY_CONSOLE_BAUD) {
          stage = 'IDE-01';
          this.#trace(stage, `${MAIXPY_CONSOLE_BAUD} baudのREPLへ戻します。`);
          await this.transport.reopen(MAIXPY_CONSOLE_BAUD);
        }
        stage = 'IDE-01';
        this.#trace(stage, '前回の接続でIDEモードが本体に残っていないか確認します。');
        if (await this.#detectActiveIde()) {
          this.ideReady = true;
          return;
        }
        stage = 'IDE-02';
        this.#trace(stage, '実行中スクリプトを停止し、friendly REPLプロンプトを待ちます（カメラ初期化中もCtrl+Cを再送します、最大30秒）。');
        this.transport.discardBuffered();
        const friendlyReply = await this.#waitForReplPrompt({ timeoutMs:30_000 });
        this.#trace('IDE-02R', `friendly REPLを確認しました（${friendlyReply.attempts}回、${receivedPreview(friendlyReply.bytes)}）。`);
        stage = 'IDE-03';
        this.#trace(stage, 'raw REPLへ切り替え、プロンプトを確認します（Ctrl+A）。');
        this.transport.discardBuffered();
        const rawReply = await this.#waitForReplPrompt({ raw:true, timeoutMs:3_000 });
        this.#trace('IDE-03R', `raw REPLを確認しました（${rawReply.attempts}回、${receivedPreview(rawReply.bytes)}）。`);
        stage = 'IDE-04';
        this.#trace(stage, `UART.repl_uart()をIDEモードへ初期化します（${MAIXPY_IDE_BAUD} baud）。`);
        this.transport.discardBuffered();
        const bootstrap = [
          'from machine import UART',
          '_repl = UART.repl_uart()',
          'try:',
          `    _repl.init(${MAIXPY_IDE_BAUD}, 8, None, 1, read_buf_len=2048, ide=True, from_ide=False)`,
          'except TypeError:',
          `    _repl.init(${MAIXPY_IDE_BAUD}, 8, None, 1, read_buf_len=2048, ide=True)`
        ].join('\n');
        const code = new TextEncoder().encode(bootstrap);
        const payload = new Uint8Array(code.byteLength + 1);
        payload.set(code);
        payload[payload.length - 1] = 0x04;
        await this.transport.write(payload);
        await delay(700);
        const bootstrapReply = this.#takeBuffered('IDE-04R', 'IDE初期化コードのREPL応答');
        const bootstrapText = new TextDecoder().decode(bootstrapReply);
        if (/Traceback|(?:^|\s)(?:TypeError|ValueError|AttributeError|ImportError|SyntaxError):/m.test(bootstrapText)) {
          throw new Error(`IDE初期化コードでPython例外が発生しました（${receivedPreview(bootstrapReply)}）。`);
        }
        if (this.transport.baudRate !== MAIXPY_IDE_BAUD) await this.transport.reopen(MAIXPY_IDE_BAUD);
        await delay(250);
        stage = 'IDE-05';
        this.#trace(stage, 'IDE状態応答 0xFFEEBBAA を要求します（最大3回）。');
        const expectedStatus = statusMagicBytes();
        if (typeof this.transport.readUntil === 'function') {
          let received = null;
          let lastError = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            this.transport.discardBuffered();
            this.#trace(`IDE-05.${attempt}`, `状態確認を送信します（${attempt}/3）。`);
            await this.transport.write(commandHeader(MAIXPY_COMMAND.QUERY_STATUS, 4));
            try {
              received = await this.transport.readUntil(expectedStatus, 1300, 4096);
              break;
            } catch (error) {
              lastError = error;
              this.#trace(`IDE-05.${attempt}R`, error.message, attempt === 3 ? 'error' : 'warning');
              if (attempt < 3) await delay(180);
            }
          }
          if (!received) throw lastError || new Error('UnitVのIDE応答を確認できませんでした。');
          this.#trace('IDE-06', `IDE応答を確認しました（前置き ${received.byteLength - expectedStatus.byteLength} byte）。`);
        } else {
          this.transport.discardBuffered();
          await this.transport.write(commandHeader(MAIXPY_COMMAND.QUERY_STATUS, 4));
          const status = await this.transport.readExact(4, 3500);
          if (uint32(status) !== MAIXPY_STATUS_MAGIC) {
            const hex = [...status].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
            throw new Error(`IDE状態応答が一致しません（受信: ${hex}）。`);
          }
          this.#trace('IDE-06', 'IDE応答を確認しました。');
        }
        this.ideReady = true;
      } catch (error) {
        this.ideReady = false;
        throw new Error(`${stage} で失敗: ${error.message}`, { cause:error });
      }
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
      this.#trace('RUN-01', `スクリプト ${bytes.byteLength} byteをUnitVへ送信します。`);
      await this.transport.write(commandHeader(MAIXPY_COMMAND.SCRIPT_EXEC, bytes.byteLength));
      await this.transport.write(bytes);
      this.#trace('RUN-02', 'スクリプト実行命令を送信しました。');
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
      this.#trace('FLASH-01', `${path} のSHA-256付き転送データを作成します（${data.byteLength} byte）。`);
      const payload = await buildFileSavePayload(path, data);
      const initialStatus = uint32(await this.#query(MAIXPY_COMMAND.FILE_SAVE_STATUS, 4));
      if (initialStatus !== 0) throw new Error(`UnitVが別の保存処理を実行中です（状態 ${initialStatus}）。`);
      this.#trace('FLASH-02', `UnitVへ ${payload.byteLength} byteを転送します。`);
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
        if (status === 0) {
          this.#trace('FLASH-03', 'UnitV側の保存とSHA-256検証が完了しました。');
          return { path, bytes:data.byteLength };
        }
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
