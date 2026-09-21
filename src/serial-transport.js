function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function serialOpenError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to open serial port/i.test(message) || error?.name === 'NetworkError') {
    return new Error('シリアルポートを開けませんでした。選択したM5Stackポートを使っているシリアルモニタやMaixPy IDEを閉じ、UnitVをリセットしてから再接続してください。', { cause:error });
  }
  return error instanceof Error ? error : new Error(message);
}

export class WebSerialTransport {
  constructor(serial = globalThis.navigator?.serial) {
    this.serial = serial;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.baudRate = 0;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.waiters = new Set();
    this.readError = null;
    this.closing = false;
    this.onDisconnect = null;
  }

  get supported() {
    return Boolean(this.serial?.requestPort);
  }

  get connected() {
    return Boolean(this.port && this.reader && this.writer);
  }

  async requestAndOpen(baudRate = 115200) {
    if (!this.supported) throw new Error('Web Serialに対応したChromeまたはEdgeで開いてください。');
    const authorized = typeof this.serial.getPorts === 'function' ? await this.serial.getPorts() : [];
    // Reuse a previously granted device when it is unambiguous. Besides being
    // quicker, this lets reconnects work without displaying the native chooser
    // again after an IDE-mode operation.
    this.port = authorized.length === 1 ? authorized[0] : await this.serial.requestPort();
    await this.open(baudRate);
    return this.port;
  }

  async open(baudRate) {
    if (!this.port) throw new Error('シリアルポートが選択されていません。');
    let opened = false;
    let reader = null;
    let writer = null;
    try {
      await this.port.open({ baudRate, dataBits:8, stopBits:1, parity:'none', flowControl:'none', bufferSize:64 * 1024 });
      opened = true;
      if (!this.port.readable || !this.port.writable) throw new Error('シリアルポートの読み書きストリームを開始できませんでした。');
      reader = this.port.readable.getReader();
      writer = this.port.writable.getWriter();
      this.baudRate = baudRate;
      this.closing = false;
      this.readError = null;
      this.reader = reader;
      this.writer = writer;
      this.readTask = this.#readLoop();
    } catch (error) {
      try { reader?.releaseLock(); } catch { /* best effort */ }
      try { writer?.releaseLock(); } catch { /* best effort */ }
      if (opened) try { await this.port.close(); } catch { /* best effort */ }
      this.reader = null;
      this.writer = null;
      this.readTask = null;
      this.baudRate = 0;
      throw serialOpenError(error);
    }
  }

  async #readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.byteLength) {
          const copy = new Uint8Array(value);
          this.chunks.push(copy);
          this.bufferedBytes += copy.byteLength;
          this.#notify();
        }
      }
      if (!this.closing) throw new Error('シリアル接続が切断されました。');
    } catch (error) {
      if (!this.closing) {
        this.readError = error instanceof Error ? error : new Error(String(error));
        this.#notify();
        this.onDisconnect?.(this.readError);
      }
    }
  }

  #notify() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async write(data) {
    if (!this.writer) throw new Error('シリアルポートが接続されていません。');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  discardBuffered() {
    this.chunks = [];
    this.bufferedBytes = 0;
  }

  takeBuffered(maxBytes = this.bufferedBytes) {
    const length = Math.max(0, Math.min(this.bufferedBytes, Number(maxBytes) || 0));
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.byteLength, length - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      this.bufferedBytes -= take;
      if (take === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    return result;
  }

  async readExact(length, timeoutMs = 2000) {
    if (!length) return new Uint8Array();
    const deadline = Date.now() + timeoutMs;
    while (this.bufferedBytes < length) {
      if (this.readError) throw this.readError;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`UnitVからの応答がタイムアウトしました（${length} byte待機）。`);
      await Promise.race([
        new Promise(resolve => this.waiters.add(resolve)),
        delay(remaining).then(() => { throw new Error(`UnitVからの応答がタイムアウトしました（${length} byte待機）。`); })
      ]);
    }
    return this.takeBuffered(length);
  }

  async readUntil(sequence, timeoutMs = 3000, maxBytes = 4096) {
    const expected = sequence instanceof Uint8Array ? sequence : new Uint8Array(sequence);
    if (!expected.byteLength) return new Uint8Array();
    const deadline = Date.now() + timeoutMs;
    const received = [];
    let matched = 0;
    while (received.length < maxBytes) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let byte;
      try {
        byte = (await this.readExact(1, remaining))[0];
      } catch (error) {
        if (/タイムアウト/.test(error?.message || '')) break;
        throw error;
      }
      received.push(byte);
      if (byte === expected[matched]) {
        matched += 1;
        if (matched === expected.byteLength) return new Uint8Array(received);
      } else {
        matched = byte === expected[0] ? 1 : 0;
      }
    }
    const preview = received.slice(0, 32).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`UnitVのIDE応答を確認できませんでした（受信 ${received.length} byte${preview ? `: ${preview}` : ''}）。`);
  }

  async reopen(baudRate) {
    await this.#closeStreams();
    try { await this.port.close(); } catch { /* already closed */ }
    // FTDI-based M5Stack interfaces need a little longer than one event loop
    // turn before Windows releases the COM handle for a different baud rate.
    await delay(350);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.open(baudRate);
        return;
      } catch (error) {
        lastError = error;
        await delay(220 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async #closeStreams() {
    this.closing = true;
    const reader = this.reader;
    const writer = this.writer;
    this.reader = null;
    this.writer = null;
    try { await reader?.cancel(); } catch { /* already disconnected */ }
    try { reader?.releaseLock(); } catch { /* already released */ }
    try { writer?.releaseLock(); } catch { /* already released */ }
    try { await this.readTask; } catch { /* handled by read loop */ }
    this.readTask = null;
    this.discardBuffered();
  }

  async close() {
    if (!this.port) return;
    await this.#closeStreams();
    try { await this.port.close(); } catch { /* physical disconnect */ }
    this.port = null;
    this.baudRate = 0;
    this.#notify();
  }
}
