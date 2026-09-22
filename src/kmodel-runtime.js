const KMODEL_ERRORS = {
  1:'kmodelヘッダーが短すぎます', 2:'kmodel v3ではありません', 3:'16 bit重みのkmodelには未対応です',
  4:'K210以外のアーキテクチャです', 5:'レイヤーまたは出力定義が不正です', 6:'ヘッダーテーブルが壊れています',
  7:'出力メモリ範囲が不正です', 8:'レイヤー本体が壊れています', 9:'K210畳み込みレイヤーが不正です',
  10:'Dequantizeレイヤーが不正です', 11:'このkmodelに未対応のレイヤーがあります', 12:'入出力形状を取得できません',
  13:'kmodel実行用メモリを確保できません', 20:'入力画像のサイズが不足しています', 21:'畳み込みを実行できません',
  22:'Dequantizeのメモリ範囲が不正です', 23:'実行時に未対応レイヤーが見つかりました'
};

const readU32 = (view, offset) => view.getUint32(offset, true);

export function inspectKmodel(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 28) throw new Error('kmodelヘッダーが短すぎます。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = readU32(view, 0), flags = readU32(view, 4), arch = readU32(view, 8);
  const layers = readU32(view, 12), mainMemory = readU32(view, 20), outputs = readU32(view, 24);
  if (version !== 3) throw new Error(`kmodel v3のみ対応しています（このファイルはv${version}です）。`);
  if (arch !== 0) throw new Error(`K210用kmodelではありません（arch=${arch}）。`);
  if (!(flags & 1)) throw new Error('初版ランタイムは8 bit重みのkmodel v3のみ対応しています。');
  const tableEnd = 28 + outputs * 8 + layers * 8;
  if (!layers || !outputs || tableEnd > bytes.byteLength) throw new Error('kmodelのヘッダーまたはレイヤーテーブルが壊れています。');
  const outputList = Array.from({ length:outputs }, (_, index) => ({
    address:readU32(view, 28 + index * 8), size:readU32(view, 32 + index * 8)
  }));
  let bodyOffset = tableEnd;
  const layerList = Array.from({ length:layers }, (_, index) => {
    const header = 28 + outputs * 8 + index * 8;
    const item = { type:readU32(view, header), size:readU32(view, header + 4), offset:bodyOffset };
    bodyOffset += item.size;
    return item;
  });
  if (bodyOffset > bytes.byteLength) throw new Error('kmodelのレイヤー本体が途中で切れています。');
  const unsupported = layerList.filter(layer => ![12, 10240].includes(layer.type));
  return { version, flags, arch, layers, mainMemory, outputs:outputList, layerList, unsupported };
}

let compiledRuntimePromise;

async function compiledRuntime() {
  if (!compiledRuntimePromise) compiledRuntimePromise = (async () => {
    const url = new URL('/kpu/kmodel-runtime.wasm', self.location.href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`KPUランタイムを読み込めませんでした（HTTP ${response.status}）。`);
    return WebAssembly.compile(await response.arrayBuffer());
  })();
  return compiledRuntimePromise;
}

function runtimeError(exports, prefix) {
  const code = Number(exports.model_last_error());
  return new Error(`${prefix}: ${KMODEL_ERRORS[code] || `不明なKPUエラー (${code})`}`);
}

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^sd\//i, '');
}

function sigmoid(value) { return 1 / (1 + Math.exp(-value)); }

function overlap(x1, w1, x2, w2) {
  return Math.min(x1 + w1 / 2, x2 + w2 / 2) - Math.max(x1 - w1 / 2, x2 - w2 / 2);
}

function iou(a, b) {
  const w = overlap(a.x, a.w, b.x, b.w), h = overlap(a.y, a.h, b.y, b.h);
  if (w < 0 || h < 0) return 0;
  const intersection = w * h;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

export function decodeYolo2(rawValues, shape, options) {
  const width = Number(shape.width), height = Number(shape.height), channels = Number(shape.channels);
  const anchors = Array.from(options.anchors || [], Number);
  const anchorCount = Number(options.anchorCount || anchors.length / 2);
  const threshold = Number(options.threshold ?? .5), nmsThreshold = Number(options.nmsThreshold ?? .3);
  if (!anchorCount || anchors.length < anchorCount * 2) throw new Error('YOLOアンカーの個数または値が不足しています。');
  const classes = channels / anchorCount - 5;
  if (!Number.isInteger(classes) || classes < 1) throw new Error(`出力チャンネル数 ${channels} とアンカー数 ${anchorCount} からクラス数を計算できません。`);
  const values = Float32Array.from(rawValues);
  const wh = width * height;
  const entry = (anchor, location, field) => anchor * wh * (classes + 5) + field * wh + location;
  for (let anchor = 0; anchor < anchorCount; anchor++) for (let location = 0; location < wh; location++) {
    values[entry(anchor, location, 0)] = sigmoid(values[entry(anchor, location, 0)]);
    values[entry(anchor, location, 1)] = sigmoid(values[entry(anchor, location, 1)]);
    values[entry(anchor, location, 4)] = sigmoid(values[entry(anchor, location, 4)]);
    let max = -Infinity, sum = 0;
    for (let c = 0; c < classes; c++) max = Math.max(max, values[entry(anchor, location, 5 + c)]);
    for (let c = 0; c < classes; c++) { const e = Math.exp(values[entry(anchor, location, 5 + c)] - max); values[entry(anchor, location, 5 + c)] = e; sum += e; }
    for (let c = 0; c < classes; c++) values[entry(anchor, location, 5 + c)] /= sum;
  }
  const boxes = [];
  for (let location = 0; location < wh; location++) {
    const row = Math.floor(location / width), column = location % width;
    for (let anchor = 0; anchor < anchorCount; anchor++) {
      const objectness = values[entry(anchor, location, 4)];
      const probabilities = Array.from({ length:classes }, (_, c) => {
        const probability = objectness * values[entry(anchor, location, 5 + c)];
        return probability > threshold ? probability : 0;
      });
      boxes.push({
        x:(column + values[entry(anchor, location, 0)]) / width,
        y:(row + values[entry(anchor, location, 1)]) / height,
        w:Math.exp(values[entry(anchor, location, 2)]) * anchors[anchor * 2] / width,
        h:Math.exp(values[entry(anchor, location, 3)]) * anchors[anchor * 2 + 1] / height,
        probabilities
      });
    }
  }
  for (let classId = 0; classId < classes; classId++) {
    const sorted = boxes.map((box, index) => ({ box, index })).sort((a, b) => b.box.probabilities[classId] - a.box.probabilities[classId]);
    for (let i = 0; i < sorted.length; i++) {
      if (!sorted[i].box.probabilities[classId]) continue;
      for (let j = i + 1; j < sorted.length; j++) if (iou(sorted[i].box, sorted[j].box) > nmsThreshold) sorted[j].box.probabilities[classId] = 0;
    }
  }
  const imageWidth = Number(options.imageWidth || shape.inputWidth), imageHeight = Number(options.imageHeight || shape.inputHeight);
  const detections = [];
  for (const box of boxes) {
    let classId = 0;
    for (let c = 1; c < classes; c++) if (box.probabilities[c] > box.probabilities[classId]) classId = c;
    const value = box.probabilities[classId];
    if (!(value > threshold)) continue;
    const x1 = Math.trunc((box.x - box.w / 2) * imageWidth), y1 = Math.trunc((box.y - box.h / 2) * imageHeight);
    const x2 = Math.trunc((box.x + box.w / 2) * imageWidth), y2 = Math.trunc((box.y + box.h / 2) * imageHeight);
    detections.push({ x:x1, y:y1, w:x2-x1, h:y2-y1, value, classId });
  }
  return detections;
}

class LoadedKmodel {
  constructor(module, name, buffer) {
    this.name = name;
    this.metadata = inspectKmodel(buffer);
    if (this.metadata.unsupported.length) {
      const types = [...new Set(this.metadata.unsupported.map(layer => layer.type))].join(', ');
      throw new Error(`このkmodelには初版ランタイム未対応のレイヤーがあります: ${types}`);
    }
    this.instance = new WebAssembly.Instance(module, {});
    const e = this.instance.exports;
    e.arena_reset();
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const modelPointer = e.arena_alloc(bytes.byteLength);
    if (!modelPointer) throw new Error('kmodel用メモリを確保できません。');
    new Uint8Array(e.memory.buffer, modelPointer, bytes.byteLength).set(bytes);
    if (e.model_init(modelPointer, bytes.byteLength)) throw runtimeError(e, 'kmodelを初期化できません');
    this.inputPointer = e.arena_alloc(e.model_input_width() * e.model_input_height() * e.model_input_channels());
    if (!this.inputPointer) throw new Error('KPU入力バッファを確保できません。');
    this.shape = {
      inputWidth:Number(e.model_input_width()), inputHeight:Number(e.model_input_height()), inputChannels:Number(e.model_input_channels()),
      width:Number(e.model_output_width()), height:Number(e.model_output_height()), channels:Number(e.model_output_channels())
    };
    this.yolo = null;
  }

  run(planar) {
    const e = this.instance.exports;
    if (planar.byteLength !== this.shape.inputWidth * this.shape.inputHeight * this.shape.inputChannels) throw new Error('KPU入力画像のサイズがモデルと一致しません。');
    new Uint8Array(e.memory.buffer, this.inputPointer, planar.byteLength).set(planar);
    if (e.model_run(this.inputPointer, planar.byteLength)) throw runtimeError(e, 'KPU推論に失敗しました');
    const count = Number(e.model_output_size()) / 4;
    return Float32Array.from(new Float32Array(e.memory.buffer, Number(e.model_output_ptr()), count));
  }
}

export class KmodelManager {
  static async create(modelFiles = []) {
    const manager = new KmodelManager();
    manager.module = modelFiles.length ? await compiledRuntime() : null;
    manager.files = new Map(modelFiles.map(file => [normalizePath(file.name), file.data]));
    manager.tasks = new Map();
    manager.nextId = 1;
    return manager;
  }

  available() { return this.files.size > 0; }

  load(path) {
    if (!this.available()) throw new Error('プロジェクトに.kmodelファイルがありません。FILESへ追加してください。');
    const normalized = normalizePath(path);
    let found = this.files.get(normalized);
    let name = normalized;
    if (!found) {
      const basename = normalized.split('/').pop();
      const match = [...this.files.entries()].find(([candidate]) => candidate === basename || candidate.endsWith(`/${basename}`));
      if (match) [name, found] = match;
    }
    if (!found && this.files.size === 1) [name, found] = this.files.entries().next().value;
    if (!found) throw new Error(`kmodelが見つかりません: ${path}`);
    const task = new LoadedKmodel(this.module, name, found);
    const id = this.nextId++;
    this.tasks.set(id, task);
    return id;
  }

  task(id) {
    const task = this.tasks.get(Number(id));
    if (!task) throw new Error('KPUタスクが無効です。kpu.load()を先に呼び出してください。');
    return task;
  }

  initYolo(id, threshold, nmsThreshold, anchorCount, anchors) {
    const task = this.task(id);
    task.yolo = { threshold:Number(threshold), nmsThreshold:Number(nmsThreshold), anchorCount:Number(anchorCount), anchors:Array.from(anchors, Number) };
    if (task.shape.channels !== task.yolo.anchorCount * (Math.floor(task.shape.channels / task.yolo.anchorCount))) throw new Error('モデル出力とアンカー数が一致しません。');
    return true;
  }

  forward(id, planar) { return this.task(id).run(planar); }

  runYolo(id, planar) {
    const task = this.task(id);
    if (!task.yolo) throw new Error('kpu.init_yolo2()を先に呼び出してください。');
    return decodeYolo2(task.run(planar), task.shape, { ...task.yolo, imageWidth:task.shape.inputWidth, imageHeight:task.shape.inputHeight });
  }

  deinit(id) { this.tasks.delete(Number(id)); }
}
