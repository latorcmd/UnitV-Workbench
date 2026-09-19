import './styles.css';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { HighlightStyle, bracketMatching, foldGutter, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { lintGutter, linter } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { createFile, listFiles, removeFile, saveFile } from './file-store.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const EXECUTION_LIMIT_MS = 8000;
const initialTheme = localStorage.getItem('unitv-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = initialTheme;

const samples = {
  color: `import sensor
import image
import time

sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)

img = sensor.snapshot()
threshold = [(20, 85, 15, 95, 5, 85)]
blobs = img.find_blobs(threshold, pixels_threshold=80, area_threshold=80)

for blob in blobs:
    img.draw_rectangle(blob.rect(), color=(255, 174, 66), thickness=3)
    img.draw_cross(blob.cx(), blob.cy(), color=(255, 255, 255), size=7)
    print("blob:", blob.cx(), blob.cy(), blob.pixels())

print("detected:", len(blobs))`,
  uart: `from machine import UART
from board import board_info
from fpioa_manager import fm

fm.register(board_info.CONNEXT_A, fm.fpioa.UART1_TX)
fm.register(board_info.CONNEXT_B, fm.fpioa.UART1_RX)
uart = UART(UART.UART1, 115200)

print("UART bytes:", uart.any())
data = uart.readline()
if data:
    print("RX:", data.decode("utf-8"))
    uart.write("echo: ")
    uart.write(data)`,
  io: `from Maix import GPIO
from modules import ws2812
from board import board_info
import sensor

sensor.reset()
img = sensor.snapshot()

button = GPIO(GPIO.GPIOHS0, GPIO.IN, GPIO.PULL_UP)
led_pin = GPIO(GPIO.GPIO0, GPIO.OUT)
led_pin.value(button.value())

leds = ws2812(board_info.CONNEXT_A, 4)
leds.set_led(0, (49, 227, 212))
leds.set_led(1, (255, 174, 66))
leds.set_led(2, (99, 174, 250))
leds.set_led(3, (255, 107, 107))
leds.display()
print("GPIOHS0:", button.value())`,
  unitv: `from machine import UART
from board import board_info
from fpioa_manager import fm
from Maix import GPIO
from modules import ws2812
import sensor
import image
import time

fm.register(35, fm.fpioa.UART1_TX, force=True)
fm.register(34, fm.fpioa.UART1_RX, force=True)
fm.register(18, fm.fpioa.GPIO1)
ButtonA = GPIO(GPIO.GPIO1, GPIO.IN, GPIO.PULL_UP)
fm.register(19, fm.fpioa.GPIO2)
ButtonB = GPIO(GPIO.GPIO2, GPIO.IN, GPIO.PULL_UP)

thresholds = ((11, 54, -4, 56, -86, -13),
              (33, 58, -62, -21, -7, 53),
              (70, 88, -19, 32, 67, 88),
              (45, 55, 60, 82, 51, 77),
              (4, 15, -28, 37, 5, 22))
point = (2, 1, 0, -1, -2)

sensor.reset()
sensor.set_hmirror(1)
sensor.set_vflip(1)
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)
com13 = sensor.__read_reg(0x13)
com13 &= ~(1 << 2)
com13 &= ~(1 << 0)
sensor.__write_reg(0x13, com13)
manual_gain = 0x200
sensor.__write_reg(0x00, manual_gain & 0xFF)
reg15 = sensor.__read_reg(0x15)
reg15 &= ~0x03
reg15 |= (manual_gain >> 8) & 0x03
sensor.__write_reg(0x15, reg15)
sensor.set_auto_gain(False, gain_db=20)
sensor.set_auto_exposure(False, exposure_us=10000)
sensor.set_auto_whitebal(False, rgb_gain_db=(40, 35, 65))
sensor.set_brightness(3)
sensor.set_saturation(3)
sensor.set_contrast(3)
sensor.set_windowing((224, 224))
sensor.skip_frames(time=2000)
sensor.snapshot()

class_ws2812 = ws2812(8, 1)
class_ws2812.set_led(0, (0, 0, 0))
class_ws2812.display()

while(True):
    img = sensor.snapshot()
    blobs = [img.find_blobs([thresholds[0]], merge=True, margin=20, pixels_threshold=100),
             img.find_blobs([thresholds[1]], merge=True, margin=20, pixels_threshold=100),
             img.find_blobs([thresholds[2]], merge=True, margin=20, pixels_threshold=100),
             img.find_blobs([thresholds[3]], merge=True, margin=20, pixels_threshold=100),
             img.find_blobs([thresholds[4]], merge=True, margin=20, pixels_threshold=100)]
    lst = []
    total = 3
    if any(blobs):
        print(blobs)
        for i in range(5):
            for blob in blobs[i]:
                lst.append([blob.x(), blob.y(), blob.x()+blob.w(), blob.y()+blob.h(), blob.h()*blob.w(), blob.cx(), blob.cy(), point[i]])
        lst_len = len(lst)
        if lst_len == 1 and lst[0][7] == 0 and lst[0][4] > 5000:
            total = 0
        elif lst_len >= 2:
            for i in range(5, 7):
                lst = sorted(lst, key=lambda x:x[i])
                mode = lst[(lst_len - 1) // 2][i]
                lst = [j for j in lst if mode - 50 < j[i] < mode + 50]
                lst_len = len(lst)
            if lst_len == 1 and lst[0][7] == 0 and lst[0][4] > 5000:
                total = 0
            elif 2 <= lst_len <= 4:
                lst = sorted(lst, key=lambda x:x[1])
                width = [[lst[i+1][1] - lst[i][1], lst[i][7]] for i in range(lst_len - 1)]
                width.append([lst[lst_len - 1][6] - lst[-1][1], lst[-1][7]])
                width = sorted(width, key=lambda x:x[0])
                minw = width[0][0]
                if minw != 0:
                    width = [[width[i][0] / minw, width[i][1]] for i in range(lst_len)]
                    total = 3
            elif lst_len == 5:
                total = sum(i[7] for i in lst)
    print(total)`
};

document.querySelector('#app').innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
        <div><h1>UnitV Browser Lab</h1><p>MaixPyを、ブラウザで試す。</p></div>
      </div>
      <div class="top-actions">
        <span class="privacy-pill"><span></span>画像・コードは端末内で処理</span>
        <button class="icon-button" id="theme-toggle" type="button" aria-label="ライトモードに切り替え" title="表示テーマ">☀</button>
        <button class="ghost-button" id="api-open" type="button">API一覧</button>
        <button class="ghost-button" id="github-open" type="button">GitHub</button>
        <button class="ghost-button" id="project-open" type="button">プロジェクトを開く</button>
        <button class="ghost-button" id="project-save" type="button">保存</button>
        <a class="ghost-button download-link" href="/unitv-browser-lab-offline.zip" download>オフライン版</a>
        <input id="project-file" class="visually-hidden" type="file" accept="application/json,.unitvproj" />
      </div>
    </header>

    <section class="control-strip" aria-label="実行コントロール">
      <label class="upload-card" for="image-file" tabindex="0">
        <span class="step">01</span><span><strong id="image-label">入力画像</strong><small id="image-detail">PNG / JPG / WebP・最大15 MB</small></span>
        <span class="upload-action">画像を選ぶ</span>
        <input id="image-file" type="file" accept="image/png,image/jpeg,image/webp" />
      </label>
      <button class="sample-image-button" id="sample-image" type="button">サンプル画像</button>
      <button class="sample-image-button camera-button" id="camera-toggle" type="button">カメラを開始</button>
      <button class="sample-image-button" id="threshold-open" type="button" disabled>LAB閾値</button>
      <div class="control-divider"></div>
      <div class="run-copy"><span class="step">02</span><span><strong>コードを実行</strong><small>実行上限 8秒</small></span></div>
      <button class="run-button" id="run" type="button"><span>▶</span> 実行</button>
      <button class="stop-button" id="stop" type="button" disabled>■ 停止</button>
      <div class="runtime-state" id="runtime-state"><span></span><div><strong>準備完了</strong><small>画像を選択してください</small></div></div>
    </section>

    <section class="workspace">
      <article class="panel code-panel">
        <div class="panel-head">
          <div><span class="panel-kicker">EDITOR</span><h2 id="active-file-name">main.py</h2></div>
          <div class="panel-tools">
            <label class="select-label" for="sample-select">サンプル</label>
            <select id="sample-select" aria-label="サンプルコード">
              <option value="color">色ブロブ検出</option>
              <option value="uart">UART送受信</option>
              <option value="io">GPIO・WS2812</option>
              <option value="unitv">カラー判定（実機コード）</option>
            </select>
            <span>Python / MaixPy</span>
          </div>
        </div>
        <div class="editor-workspace">
          <aside class="file-sidebar" aria-label="ローカルPythonファイル">
            <div class="file-sidebar-head"><span>FILES</span><button id="new-file" type="button" title="新規ファイル">＋</button></div>
            <div id="file-list" class="file-list"></div>
            <small>この端末に自動保存</small>
          </aside>
          <div class="editor-main">
            <div id="code-editor" aria-label="Pythonコードエディター"></div>
            <div class="editor-status"><span id="syntax-status">構文チェック中…</span><span id="save-status">ローカル保存</span><span>Ctrl / ⌘ + Enter で実行</span></div>
          </div>
        </div>
      </article>

      <div class="right-stack">
        <article class="panel output-panel">
          <div class="panel-head">
            <div><span class="panel-kicker amber">FRAME BUFFER</span><h2>画像出力</h2></div>
            <div class="panel-tools"><button id="download-image" type="button" disabled>PNG保存</button><span class="meta" id="frame-meta">—</span></div>
          </div>
          <div class="canvas-stage" id="canvas-stage">
            <canvas id="output-canvas" hidden></canvas>
            <video id="camera-preview" playsinline muted hidden></video>
            <div class="empty-frame" id="empty-frame">
              <span class="image-glyph">▧</span><strong>画像を選んでください</strong><small>アップロード画像が仮想カメラになります</small>
            </div>
          </div>
        </article>

        <article class="panel serial-panel">
          <div class="panel-head">
            <div><span class="panel-kicker blue">SERIAL MONITOR</span><h2>シリアルモニタ</h2></div>
            <div class="panel-tools"><button id="clear-log" type="button">消去</button><span>115200 baud</span></div>
          </div>
          <div class="terminal" id="terminal" role="log" aria-live="polite"></div>
        </article>
      </div>
    </section>

    <section class="io-dock panel">
      <div class="io-header">
        <div class="io-title"><span class="panel-kicker">DEVICE BAY</span><h2>仮想デバイス</h2></div>
        <span class="device-note">GPIO1 / GPIO2は実機のButton A / Bに対応</span>
      </div>
      <div class="device-pane active" id="io-pane" role="tabpanel">
        <div class="uart-field"><label for="uart-input">UART RX</label><input id="uart-input" value="hello UnitV\\n" /><select id="uart-format" aria-label="UART入力形式"><option value="text">TEXT</option><option value="hex">HEX</option></select><button id="uart-queue" type="button">受信キューへ</button></div>
        <div class="gpio-bank"><span>GPIO INPUT</span>${['GPIO1','GPIO2','GPIOHS0'].map(pin=>`<button type="button" data-gpio="${pin}" aria-pressed="false"><small>${pin}</small><b>LOW</b></button>`).join('')}</div>
        <div class="led-bank"><span>WS2812</span>${[0,1,2,3].map(n=>`<i data-led="${n}" title="LED ${n}"></i>`).join('')}</div>
      </div>
    </section>
  </main>

  <dialog id="api-dialog" class="dialog">
    <form method="dialog"><div class="dialog-head"><div><span class="panel-kicker">COMPATIBILITY</span><h2>対応API</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <div class="api-grid">
        <section><h3>sensor</h3><p>reset / set_pixformat / set_framesize / set_hmirror / set_vflip / skip_frames / snapshot</p></section>
        <section><h3>image</h3><p>resize / crop / copy / binary / find_blobs / draw_rectangle / draw_line / draw_circle / draw_cross / draw_string</p></section>
        <section><h3>UART・I/O</h3><p>UART read / readline / readchar / write / any、GPIO value、ws2812 set_led / display</p></section>
        <section><h3>カメラ設定</h3><p>レジスタ読書き、auto gain / exposure / white balance、brightness / saturation / contrast、windowing</p></section>
      </div><p class="dialog-note">固定画像モードではトップレベルの while(True) を1フレームだけ実行します。KPUは未対応です。</p>
    </form>
  </dialog>

  <dialog id="save-dialog" class="dialog small-dialog">
    <form method="dialog"><div class="dialog-head"><div><span class="panel-kicker">PROJECT FILE</span><h2>プロジェクトを保存</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <label class="check-row"><input id="embed-image" type="checkbox" checked><span><strong>入力画像を含める</strong><small>別の端末でも同じ状態から再開できます</small></span></label>
      <div class="dialog-actions"><button value="close" class="ghost-button">キャンセル</button><button type="button" class="run-button" id="confirm-save">ダウンロード</button></div>
    </form>
  </dialog>

  <dialog id="file-dialog" class="dialog small-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">LOCAL FILE</span><h2 id="file-dialog-title">Pythonファイルを作成</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <label class="dialog-field"><span>ファイル名</span><input id="file-name-input" autocomplete="off" value="untitled.py"></label>
      <p class="dialog-intro">コードはIndexedDBを使ってこの端末内に自動保存されます。</p>
      <div class="dialog-actions file-dialog-actions"><button type="button" class="danger-button" id="file-delete" hidden>削除</button><button type="button" class="ghost-button" id="file-duplicate" hidden>複製</button><button value="close" class="ghost-button">キャンセル</button><button type="button" class="run-button" id="file-confirm">作成</button></div>
    </form>
  </dialog>

  <dialog id="threshold-dialog" class="dialog threshold-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker amber">LAB THRESHOLD EDITOR</span><h2>画像からLAB閾値を作る</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <p class="dialog-intro">画像上をドラッグして色の範囲を選択してください。選択領域から外れ値を除いて閾値を計算します。</p>
      <div class="threshold-layout">
        <div class="threshold-stage"><canvas id="threshold-canvas"></canvas><span id="threshold-hint">ドラッグで範囲選択</span></div>
        <div class="threshold-controls">
          ${['L min','L max','a min','a max','b min','b max'].map((label,index)=>`<label><span>${label}</span><input type="number" data-threshold-index="${index}" ${index < 2 ? 'min="0" max="100"' : 'min="-128" max="127"'}></label>`).join('')}
          <div class="threshold-result"><span>MaixPy形式</span><code id="threshold-value">(0, 100, -128, 127, -128, 127)</code></div>
          <div class="threshold-stats" id="threshold-stats">画像上の対象色を選択してください。</div>
        </div>
      </div>
      <div class="dialog-actions"><button type="button" class="ghost-button" id="threshold-copy">コピー</button><button type="button" class="run-button" id="threshold-insert">コードへ挿入</button></div>
    </form>
  </dialog>

  <dialog id="github-dialog" class="dialog github-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">GITHUB SYNC</span><h2>GitHubリポジトリと連携</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <p class="dialog-intro">Personal access tokenはこのタブのメモリだけに保持し、UnitV Browser Labのサーバーには送信しません。</p>
      <div class="github-grid">
        <label><span>所有者</span><input id="github-owner" autocomplete="off" placeholder="octocat"></label>
        <label><span>リポジトリ</span><input id="github-repo" autocomplete="off" placeholder="unitv-project"></label>
        <label><span>ブランチ</span><input id="github-branch" autocomplete="off" value="main"></label>
        <label><span>ファイルパス</span><input id="github-path" autocomplete="off" value="main.py"></label>
        <label class="github-token"><span>Fine-grained token</span><input id="github-token" type="password" autocomplete="off" placeholder="github_pat_…"></label>
        <label class="github-token"><span>コミットメッセージ</span><input id="github-message" value="Update from UnitV Browser Lab"></label>
      </div>
      <div id="github-status" class="github-status">未接続</div>
      <div class="dialog-actions"><button type="button" class="ghost-button" id="github-load">GitHubから読み込む</button><button type="button" class="run-button" id="github-push">現在のファイルを保存</button></div>
    </form>
  </dialog>
`;

const $ = selector => document.querySelector(selector);
const refs = {
  editor: $('#code-editor'), imageFile: $('#image-file'), canvas: $('#output-canvas'), empty: $('#empty-frame'), camera: $('#camera-preview'),
  imageLabel: $('#image-label'), imageDetail: $('#image-detail'), frameMeta: $('#frame-meta'), terminal: $('#terminal'),
  run: $('#run'), stop: $('#stop'), runtime: $('#runtime-state'), uart: $('#uart-input'), uartFormat: $('#uart-format')
};

let sourceImage = null;
let sourceImageDataUrl = null;
let sourceImageName = '';
let worker = null;
let executionTimer = null;
let running = false;
let gpioState = { GPIO1: 0, GPIO2: 0, GPIOHS0: 0 };
let uartQueued = new Uint8Array();
let cameraStream = null;
let editorView = null;
let files = [];
let currentFileId = null;
let autosaveTimer = null;
let suppressAutosave = false;
let fileDialogTarget = null;
let fileDeleteArmed = false;
let thresholdValues = [0, 100, -128, 127, -128, 127];
let thresholdSelection = null;
let thresholdDragStart = null;
let githubToken = '';

const editorHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '650' },
  { tag: [tags.name, tags.variableName], color: 'var(--syntax-name)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--syntax-function)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syntax-operator)' },
  { tag: tags.className, color: 'var(--syntax-class)' }
]);

function buildIndentDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let position = from;
    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      const indent = line.text.match(/^[ \t]+/)?.[0] || '';
      let cursor = 0;
      let level = 0;
      while (cursor < indent.length) {
        const width = indent[cursor] === '\t' ? 1 : Math.min(4, indent.length - cursor);
        builder.add(line.from + cursor, line.from + cursor + width, Decoration.mark({ class: `cm-indent-guide cm-indent-${level % 4}` }));
        cursor += width;
        level += 1;
      }
      if (line.to >= to || line.number === view.state.doc.lines) break;
      position = line.to + 1;
    }
  }
  return builder.finish();
}

const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildIndentDecorations(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.decorations = buildIndentDecorations(update.view);
  }
}, { decorations: value => value.decorations });

function syntaxDiagnostics(view) {
  const diagnostics = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (!node.type.isError) return;
      const from = Math.min(node.from, Math.max(0, view.state.doc.length - 1));
      diagnostics.push({ from, to: Math.min(view.state.doc.length, Math.max(from + 1, node.to)), severity: 'error', message: 'Pythonの書式に誤りがあります' });
    }
  });
  return diagnostics;
}

function updateSyntaxStatus(view = editorView) {
  if (!view) return;
  const count = syntaxDiagnostics(view).length;
  const status = $('#syntax-status');
  status.textContent = count ? `⚠ 書式エラー ${count}件` : '✓ 書式エラーなし';
  status.classList.toggle('has-error', Boolean(count));
}

function getCode() {
  return editorView?.state.doc.toString() || '';
}

function setCode(code, addToHistory = false) {
  if (!editorView) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: String(code) },
    annotations: addToHistory ? [] : undefined
  });
  updateSyntaxStatus();
}

function addLog(level, text, time = new Date().toLocaleTimeString('ja-JP', { hour12: false })) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const safeText = String(text).replace(/\n$/, '');
  line.innerHTML = `<span class="time">${time}</span><span class="log-tag">[${level}]</span><span class="log-text"></span>`;
  line.querySelector('.log-text').textContent = safeText || ' ';
  refs.terminal.append(line); refs.terminal.scrollTop = refs.terminal.scrollHeight;
}

function setRuntime(state, detail, mode = '') {
  refs.runtime.className = `runtime-state ${mode}`;
  refs.runtime.querySelector('strong').textContent = state;
  refs.runtime.querySelector('small').textContent = detail;
}

function setRunning(value) {
  running = value; refs.run.disabled = value; refs.stop.disabled = !value;
  refs.run.innerHTML = value ? '<span class="spinner"></span> 実行中' : '<span>▶</span> 実行';
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeUniqueFilename(requested) {
  const clean = String(requested || 'untitled.py').trim().replace(/[\\/:*?"<>|]/g, '-') || 'untitled.py';
  const withExtension = clean.endsWith('.py') ? clean : `${clean}.py`;
  if (!files.some(file => file.name === withExtension)) return withExtension;
  const stem = withExtension.slice(0, -3);
  let number = 2;
  while (files.some(file => file.name === `${stem}-${number}.py`)) number += 1;
  return `${stem}-${number}.py`;
}

function renderFileList() {
  const list = $('#file-list');
  list.replaceChildren();
  files.forEach(file => {
    const row = document.createElement('div');
    row.className = `file-row${file.id === currentFileId ? ' active' : ''}`;
    row.dataset.fileId = file.id;
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'file-open'; open.title = file.name;
    open.innerHTML = '<span>PY</span><b></b>'; open.querySelector('b').textContent = file.name;
    open.addEventListener('click', () => selectFile(file.id));
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'file-menu'; menu.textContent = '•••'; menu.title = '名前変更・複製・削除';
    menu.addEventListener('click', () => editFile(file.id));
    row.append(open, menu); list.append(row);
  });
}

async function persistCurrentFile() {
  const file = files.find(item => item.id === currentFileId);
  if (!file || !editorView) return;
  file.code = getCode(); file.updatedAt = new Date().toISOString();
  $('#save-status').textContent = '保存中…';
  try {
    await saveFile(file);
    $('#save-status').textContent = '✓ この端末に保存済み';
  } catch (error) {
    $('#save-status').textContent = '保存に失敗';
    addLog('error', `ローカル保存に失敗しました: ${error.message}`);
  }
}

function scheduleAutosave() {
  $('#save-status').textContent = '未保存の変更';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(persistCurrentFile, 450);
}

async function selectFile(id) {
  if (id === currentFileId || !files.some(file => file.id === id)) return;
  clearTimeout(autosaveTimer); const previousSave = persistCurrentFile();
  currentFileId = id;
  const file = files.find(item => item.id === id);
  suppressAutosave = true; setCode(file.code); suppressAutosave = false;
  $('#active-file-name').textContent = file.name;
  $('#github-path').value = file.name;
  localStorage.setItem('unitv-active-file', id);
  renderFileList();
  $('#save-status').textContent = '✓ この端末に保存済み';
  await previousSave;
}

function openNewFileDialog() {
  fileDialogTarget = null; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'Pythonファイルを作成'; $('#file-name-input').value = makeUniqueFilename('untitled.py');
  $('#file-confirm').textContent = '作成'; $('#file-delete').hidden = true; $('#file-duplicate').hidden = true;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

function editFile(id) {
  const file = files.find(item => item.id === id); if (!file) return;
  fileDialogTarget = id; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'ファイルを管理'; $('#file-name-input').value = file.name;
  $('#file-confirm').textContent = '名前を保存'; $('#file-delete').hidden = false; $('#file-delete').textContent = '削除'; $('#file-duplicate').hidden = false;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

async function confirmFileDialog() {
  const requested = $('#file-name-input').value.trim(); if (!requested) return;
  if (!fileDialogTarget) {
    const file = createFile(makeUniqueFilename(requested), '# UnitV Browser Lab\n');
    file.order = files.length ? Math.max(...files.map(item => item.order ?? 0)) + 1 : 0;
    files.push(file); await saveFile(file); $('#file-dialog').close(); await selectFile(file.id); return;
  }
  const file = files.find(item => item.id === fileDialogTarget); if (!file) return;
  const otherFiles = files.filter(item => item.id !== fileDialogTarget); const before = files; files = otherFiles;
  file.name = makeUniqueFilename(requested); files = before; file.updatedAt = new Date().toISOString();
  await saveFile(file); renderFileList();
  if (file.id === currentFileId) { $('#active-file-name').textContent = file.name; $('#github-path').value = file.name; }
  $('#file-dialog').close();
}

async function duplicateFileDialog() {
  const file = files.find(item => item.id === fileDialogTarget); if (!file) return;
  const copy = createFile(makeUniqueFilename(file.name.replace(/\.py$/, '-copy.py')), file.code);
  copy.order = files.length; files.push(copy); await saveFile(copy); $('#file-dialog').close(); await selectFile(copy.id);
}

async function deleteFileDialog() {
  if (files.length === 1) { addLog('warning', '最後のファイルは削除できません。'); return; }
  if (!fileDeleteArmed) { fileDeleteArmed = true; $('#file-delete').textContent = 'もう一度押して削除'; return; }
  const id = fileDialogTarget; const deletingActive = id === currentFileId; files = files.filter(item => item.id !== id); await removeFile(id); $('#file-dialog').close();
  if (deletingActive) { currentFileId = null; await selectFile(files[0].id); } else renderFileList();
}

async function initializeEditor() {
  try { files = await listFiles(); } catch (error) { addLog('warning', `IndexedDBを利用できません: ${error.message}`); }
  if (!files.length) {
    const main = createFile('main.py', samples.color, 0); files = [main];
    try { await saveFile(main); } catch { /* Private browsing may disable IndexedDB. */ }
  }
  currentFileId = localStorage.getItem('unitv-active-file');
  if (!files.some(file => file.id === currentFileId)) currentFileId = files[0].id;
  const active = files.find(file => file.id === currentFileId);
  editorView = new EditorView({
    parent: refs.editor,
    state: EditorState.create({
      doc: active.code,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), history(), foldGutter(), drawSelection(), highlightActiveLine(),
        indentUnit.of('    '), python(), bracketMatching(), closeBrackets(), EditorView.lineWrapping,
        syntaxHighlighting(editorHighlight), indentGuides, lintGutter(), linter(syntaxDiagnostics, { delay: 250 }),
        keymap.of([
          { key: 'Mod-Enter', run: () => { runCode(); return true; } },
          indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            updateSyntaxStatus(update.view);
            if (!suppressAutosave) scheduleAutosave();
          }
        })
      ]
    })
  });
  $('#active-file-name').textContent = active.name;
  $('#github-path').value = active.name;
  renderFileList(); updateSyntaxStatus();
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}

async function dataUrlToImage(dataUrl, name = 'project-image.png') {
  const response = await fetch(dataUrl); const blob = await response.blob();
  return loadImageFile(new File([blob], name, { type: blob.type || 'image/png' }), dataUrl);
}

async function loadImageFile(file, knownDataUrl = null) {
  if (!file) return;
  if (cameraStream) stopCamera(false);
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('PNG、JPG、WebPの画像を選択してください。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('画像は15 MB以下にしてください。');
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 20_000_000) { bitmap.close(); throw new Error('画像の画素数が大きすぎます。最大20メガピクセルです。'); }
  const temp = document.createElement('canvas'); temp.width = bitmap.width; temp.height = bitmap.height;
  const ctx = temp.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
  sourceImage = ctx.getImageData(0, 0, temp.width, temp.height); sourceImageDataUrl = knownDataUrl || await fileToDataUrl(file); sourceImageName = file.name;
  drawFrame(sourceImage); refs.imageLabel.textContent = file.name; refs.imageDetail.textContent = `${sourceImage.width} × ${sourceImage.height}・${(file.size/1024/1024).toFixed(1)} MB`;
  $('#threshold-open').disabled = false;
  setRuntime('準備完了', 'コードを実行できます'); addLog('system', `画像を読み込みました: ${file.name} (${sourceImage.width} × ${sourceImage.height})`);
}

async function loadSampleImage() {
  try {
    const response = await fetch('/r5.png');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    await loadImageFile(new File([blob], 'r5.png', { type: blob.type || 'image/png' }));
    refs.imageDetail.textContent = `${sourceImage.width} × ${sourceImage.height}・添付サンプル`;
  } catch (error) {
    finishWithError(`サンプル画像を読み込めません: ${error.message}`);
  }
}

async function captureCameraFrame() {
  if (!cameraStream || refs.camera.readyState < 2) throw new Error('カメラの映像を準備中です。少し待ってから再実行してください。');
  const width = refs.camera.videoWidth; const height = refs.camera.videoHeight;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(refs.camera, 0, 0, width, height);
  sourceImage = context.getImageData(0, 0, width, height); sourceImageDataUrl = canvas.toDataURL('image/jpeg', .9); sourceImageName = 'camera-frame.jpg';
  $('#threshold-open').disabled = false;
  return sourceImage;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラ入力を利用できません。');
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  refs.camera.srcObject = cameraStream; await refs.camera.play();
  refs.camera.hidden = false; refs.canvas.hidden = true; refs.empty.hidden = true;
  $('#camera-toggle').textContent = 'カメラを停止'; $('#camera-toggle').classList.add('active');
  refs.imageLabel.textContent = 'リアルタイムカメラ'; refs.imageDetail.textContent = '実行時のフレームを使用・端末内のみ'; refs.frameMeta.textContent = `${refs.camera.videoWidth} × ${refs.camera.videoHeight} LIVE`;
  setRuntime('カメラ入力', '「実行」で現在のフレームを処理します', 'success'); addLog('system', '端末カメラを開始しました。映像はサーバーへ送信されません。');
}

function stopCamera(showLastFrame = true) {
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; refs.camera.srcObject = null; refs.camera.hidden = true;
  $('#camera-toggle').textContent = 'カメラを開始'; $('#camera-toggle').classList.remove('active');
  if (showLastFrame && sourceImage) drawFrame(sourceImage);
  addLog('system', 'カメラを停止しました。');
}

async function toggleCamera() {
  try {
    if (cameraStream) { stopCamera(); return; }
    await startCamera();
  } catch (error) { finishWithError(`カメラを開始できません: ${error.message}`); }
}

function drawFrame(imageData) {
  refs.canvas.width = imageData.width; refs.canvas.height = imageData.height;
  refs.canvas.getContext('2d').putImageData(imageData, 0, 0); refs.canvas.hidden = false; refs.camera.hidden = true; refs.empty.hidden = true;
  refs.frameMeta.textContent = `${imageData.width} × ${imageData.height}`; $('#download-image').disabled = false;
}

function rgbToLab(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  r = r > .04045 ? ((r + .055) / 1.055) ** 2.4 : r / 12.92;
  g = g > .04045 ? ((g + .055) / 1.055) ** 2.4 : g / 12.92;
  b = b > .04045 ? ((b + .055) / 1.055) ** 2.4 : b / 12.92;
  let x = (r * .4124 + g * .3576 + b * .1805) / .95047;
  let y = r * .2126 + g * .7152 + b * .0722;
  let z = (r * .0193 + g * .1192 + b * .9505) / 1.08883;
  const convert = value => value > .008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  x = convert(x); y = convert(y); z = convert(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function thresholdMatches(lab) {
  return lab[0] >= thresholdValues[0] && lab[0] <= thresholdValues[1] && lab[1] >= thresholdValues[2] && lab[1] <= thresholdValues[3] && lab[2] >= thresholdValues[4] && lab[2] <= thresholdValues[5];
}

function thresholdPoint(event) {
  const canvas = $('#threshold-canvas'); const bounds = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - bounds.left) * canvas.width / bounds.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - bounds.top) * canvas.height / bounds.height))) };
}

function drawThresholdPreview() {
  if (!sourceImage) return;
  const canvas = $('#threshold-canvas'); canvas.width = sourceImage.width; canvas.height = sourceImage.height;
  const output = new Uint8ClampedArray(sourceImage.data); let matched = 0;
  for (let i = 0; i < output.length; i += 4) {
    if (thresholdMatches(rgbToLab(output[i], output[i + 1], output[i + 2]))) { matched += 1; continue; }
    const gray = Math.round(output[i] * .299 + output[i + 1] * .587 + output[i + 2] * .114);
    output[i] = gray * .36; output[i + 1] = gray * .36; output[i + 2] = gray * .36;
  }
  const context = canvas.getContext('2d'); context.putImageData(new ImageData(output, sourceImage.width, sourceImage.height), 0, 0);
  if (thresholdSelection) {
    const { x, y, width, height } = thresholdSelection; context.strokeStyle = '#ffae42'; context.lineWidth = Math.max(2, sourceImage.width / 220); context.setLineDash([8, 5]); context.strokeRect(x, y, width, height); context.setLineDash([]);
  }
  const total = sourceImage.width * sourceImage.height;
  $('#threshold-stats').textContent = `一致: ${matched.toLocaleString()} px（${(matched / total * 100).toFixed(1)}%）`;
  $('#threshold-value').textContent = `(${thresholdValues.join(', ')})`;
  document.querySelectorAll('[data-threshold-index]').forEach(input => { input.value = thresholdValues[Number(input.dataset.thresholdIndex)]; });
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b); return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
}

function calculateThresholdFromSelection() {
  if (!sourceImage || !thresholdSelection) return;
  const { x, y, width, height } = thresholdSelection; const channels = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 18000)));
  for (let py = y; py < y + height; py += step) for (let px = x; px < x + width; px += step) {
    const index = (py * sourceImage.width + px) * 4; const lab = rgbToLab(sourceImage.data[index], sourceImage.data[index + 1], sourceImage.data[index + 2]);
    lab.forEach((value, channel) => channels[channel].push(value));
  }
  const low = channels.map(channel => percentile(channel, .05)); const high = channels.map(channel => percentile(channel, .95));
  thresholdValues = [
    Math.max(0, Math.floor(low[0] - 4)), Math.min(100, Math.ceil(high[0] + 4)),
    Math.max(-128, Math.floor(low[1] - 7)), Math.min(127, Math.ceil(high[1] + 7)),
    Math.max(-128, Math.floor(low[2] - 7)), Math.min(127, Math.ceil(high[2] + 7))
  ];
  drawThresholdPreview();
}

async function openThresholdEditor() {
  if (cameraStream) await captureCameraFrame();
  if (!sourceImage) { finishWithError('先に画像を選択してください。'); return; }
  thresholdSelection = null; thresholdValues = [0, 100, -128, 127, -128, 127];
  drawThresholdPreview(); $('#threshold-dialog').showModal();
}

function insertThreshold() {
  const value = `(${thresholdValues.join(', ')})`; const selection = editorView.state.selection.main;
  editorView.dispatch({ changes: { from: selection.from, to: selection.to, insert: value }, selection: { anchor: selection.from + value.length }, scrollIntoView: true });
  editorView.focus(); $('#threshold-dialog').close();
}

function parseUartInput() {
  const text = refs.uart.value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  if (refs.uartFormat.value === 'hex') {
    const clean = text.trim(); if (!clean) return new Uint8Array();
    const parts = clean.split(/[\s,]+/); if (parts.some(p => !/^[0-9a-f]{1,2}$/i.test(p))) throw new Error('HEX入力は「48 65 6C 6C 6F」のように入力してください。');
    return Uint8Array.from(parts.map(p => parseInt(p, 16)));
  }
  return new TextEncoder().encode(text);
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./simulator.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = event => finishWithError(`実行環境を開始できませんでした: ${event.message}`);
  return worker;
}

function handleWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === 'status') {
    const states = { 'loading-python':['Pythonを準備中',msg.text], 'loading-model':['モデルを準備中',msg.text], executing:['実行中',`最大${EXECUTION_LIMIT_MS/1000}秒で停止します`] };
    const state = states[msg.phase] || ['処理中',msg.text || '']; setRuntime(state[0], state[1], 'busy');
    if (msg.phase === 'executing') {
      clearTimeout(executionTimer); executionTimer = setTimeout(() => stopExecution('実行時間が8秒を超えたため停止しました。'), EXECUTION_LIMIT_MS);
    }
  } else if (msg.type === 'log') {
    addLog(msg.level || 'stdout', msg.text, msg.time);
  } else if (msg.type === 'gpio') {
    gpioState[msg.pin] = Number(msg.value); updateGpioUi(msg.pin, msg.value, msg.mode);
  } else if (msg.type === 'led') {
    updateLedUi(msg.colors);
  } else if (msg.type === 'result') {
    clearTimeout(executionTimer); executionTimer = null;
    drawFrame(new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height));
    if (msg.gpio) Object.assign(gpioState, msg.gpio); if (msg.leds) updateLedUi(msg.leds);
    setRunning(false); setRuntime('実行完了', `${msg.width} × ${msg.height} の画像を出力しました`, 'success'); addLog('system', '実行が完了しました。');
  } else if (msg.type === 'error') {
    finishWithError(formatPythonError(msg.message));
  }
}

function formatPythonError(message) {
  return String(message).replace('PythonError: ', '').replace(/File "main.py", line (\d+)/g, 'main.py:$1');
}

function finishWithError(message) {
  clearTimeout(executionTimer); executionTimer = null; setRunning(false); setRuntime('エラー', 'シリアルモニタを確認してください', 'error');
  addLog('error', message);
}

function stopExecution(reason = '手動で実行を停止しました。') {
  if (!running) return;
  clearTimeout(executionTimer); executionTimer = null; worker?.terminate(); worker = null; setRunning(false);
  setRuntime('停止', '次回実行時に環境を再起動します', 'error'); addLog('warning', reason);
}

async function runCode() {
  if (running) return;
  if (syntaxDiagnostics(editorView).length) { finishWithError('Pythonコードに書式エラーがあります。エディター内の赤い印を確認してください。'); editorView.focus(); return; }
  if (cameraStream) {
    try { await captureCameraFrame(); } catch (error) { finishWithError(error.message); return; }
  }
  if (!sourceImage) { finishWithError('先に入力画像を選択してください。'); refs.imageFile.focus(); return; }
  await persistCurrentFile();
  setRunning(true); setRuntime('開始中', '入力データを準備しています', 'busy'); addLog('system', 'コードを実行します。');
  const imageCopy = new Uint8ClampedArray(sourceImage.data);
  const uartCopy = new Uint8Array(uartQueued);
  const activeFile = files.find(file => file.id === currentFileId);
  const payload = { type:'run', code:getCode(), filename:activeFile?.name || 'main.py', files:files.map(file=>({name:file.name,code:file.id===currentFileId?getCode():file.code})), image:{width:sourceImage.width,height:sourceImage.height,data:imageCopy.buffer}, uart:uartCopy.buffer, gpio:{...gpioState} };
  const transfers = [imageCopy.buffer, uartCopy.buffer];
  ensureWorker().postMessage(payload, transfers);
}

function updateGpioUi(pin, value, mode = 'IN') {
  const button = document.querySelector(`[data-gpio="${pin}"]`); if (!button) return;
  button.classList.toggle('high', Boolean(value)); button.setAttribute('aria-pressed', String(Boolean(value)));
  button.querySelector('b').textContent = `${mode} ${value ? 'HIGH' : 'LOW'}`;
}

function updateLedUi(colors) {
  document.querySelectorAll('[data-led]').forEach((led, i) => {
    const c = colors[i] || [0,0,0]; led.style.setProperty('--led-color', `rgb(${c[0]},${c[1]},${c[2]})`); led.classList.toggle('on', c.some(Number));
  });
}

function uint8ToBase64(bytes) {
  let binary=''; const chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,i+chunk)); return btoa(binary);
}

function base64ToArrayBuffer(value) {
  const binary=atob(value); const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i); return bytes.buffer;
}

async function saveProject() {
  await persistCurrentFile();
  const project = { version:2, app:'UnitV Browser Lab', savedAt:new Date().toISOString(), activeFile:files.find(file=>file.id===currentFileId)?.name, files:files.map(file=>({name:file.name,code:file.code})), code:getCode(), uart:{value:refs.uart.value,format:refs.uartFormat.value}, gpio:{...gpioState}, image:{name:sourceImageName} };
  if ($('#embed-image').checked && sourceImageDataUrl) project.image.dataUrl=sourceImageDataUrl;
  downloadBlob(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}), 'unitv-project.unitvproj'); $('#save-dialog').close(); addLog('system','プロジェクトを保存しました。');
}

async function openProject(file) {
  const project=JSON.parse(await file.text()); if(![1,2].includes(project.version)) throw new Error(`未対応のプロジェクトバージョンです: ${project.version}`);
  if (project.version === 2 && Array.isArray(project.files) && project.files.length) {
    const imported=[];
    for (const item of project.files) { const local=createFile(makeUniqueFilename(item.name),String(item.code||''),files.length+imported.length); imported.push(local); await saveFile(local); }
    files.push(...imported); await selectFile((imported.find(item=>item.name===project.activeFile)||imported[0]).id);
  } else {
    setCode(String(project.code||samples.color)); scheduleAutosave();
  }
  refs.uart.value=project.uart?.value||''; refs.uartFormat.value=project.uart?.format||'text';
  gpioState={GPIO1:0,GPIO2:0,GPIOHS0:0,...(project.gpio||{})}; Object.entries(gpioState).forEach(([p,v])=>updateGpioUi(p,v));
  if(project.image?.dataUrl)await dataUrlToImage(project.image.dataUrl,project.image.name);
  addLog('system',`プロジェクトを開きました: ${file.name}`);
}

function githubSettings() {
  return {
    owner: $('#github-owner').value.trim(), repo: $('#github-repo').value.trim(), branch: $('#github-branch').value.trim() || 'main',
    path: $('#github-path').value.trim(), message: $('#github-message').value.trim() || 'Update from UnitV Browser Lab'
  };
}

function saveGithubSettings(settings) {
  localStorage.setItem('unitv-github-settings', JSON.stringify(settings));
}

function githubBase64Encode(text) {
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function githubBase64Decode(value) {
  const binary = atob(value.replace(/\s/g, '')); const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubRequest(endpoint, options = {}) {
  githubToken = $('#github-token').value.trim();
  if (!githubToken) throw new Error('Fine-grained personal access tokenを入力してください。');
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${githubToken}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})); const error = new Error(body.message || `GitHub API: HTTP ${response.status}`); error.status = response.status; throw error;
  }
  return response.status === 204 ? null : response.json();
}

function githubEndpoint(settings) {
  if (!settings.owner || !settings.repo || !settings.path) throw new Error('所有者、リポジトリ、ファイルパスを入力してください。');
  const path = settings.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${path}`;
}

async function loadFromGithub() {
  const status = $('#github-status'); status.textContent = 'GitHubから読み込み中…'; status.className = 'github-status busy';
  try {
    const settings = githubSettings(); saveGithubSettings(settings); const data = await githubRequest(`${githubEndpoint(settings)}?ref=${encodeURIComponent(settings.branch)}`);
    if (data.type !== 'file' || !data.content) throw new Error('指定したパスはPythonファイルではありません。');
    setCode(githubBase64Decode(data.content)); scheduleAutosave(); status.textContent = `読み込みました: ${settings.path}`; status.className = 'github-status success';
    $('#github-dialog').close(); addLog('system', `GitHubから読み込みました: ${settings.owner}/${settings.repo}/${settings.path}`);
  } catch (error) { status.textContent = error.message; status.className = 'github-status error'; }
}

async function pushToGithub() {
  const status = $('#github-status'); status.textContent = 'GitHubへ保存中…'; status.className = 'github-status busy';
  try {
    const settings = githubSettings(); saveGithubSettings(settings); const endpoint = githubEndpoint(settings); let sha;
    try { sha = (await githubRequest(`${endpoint}?ref=${encodeURIComponent(settings.branch)}`)).sha; } catch (error) { if (error.status !== 404) throw error; }
    const body = { message: settings.message, content: githubBase64Encode(getCode()), branch: settings.branch, ...(sha ? { sha } : {}) };
    await githubRequest(endpoint, { method: 'PUT', body: JSON.stringify(body) });
    status.textContent = `保存しました: ${settings.path}`; status.className = 'github-status success';
    addLog('system', `GitHubへ保存しました: ${settings.owner}/${settings.repo}/${settings.path}`);
  } catch (error) { status.textContent = error.message; status.className = 'github-status error'; }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme; localStorage.setItem('unitv-theme', theme);
  const light = theme === 'light'; $('#theme-toggle').textContent = light ? '☾' : '☀'; $('#theme-toggle').setAttribute('aria-label', light ? 'ダークモードに切り替え' : 'ライトモードに切り替え');
  document.querySelector('meta[name="theme-color"]').content = light ? '#f4f7f8' : '#071017';
}

applyTheme(initialTheme);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
$('#new-file').addEventListener('click', openNewFileDialog);
$('#file-confirm').addEventListener('click', confirmFileDialog); $('#file-duplicate').addEventListener('click', duplicateFileDialog); $('#file-delete').addEventListener('click', deleteFileDialog);
$('#file-name-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirmFileDialog(); } });
$('#sample-select').addEventListener('change', event => { setCode(samples[event.target.value]); scheduleAutosave(); editorView.focus(); });
refs.imageFile.addEventListener('change', async event => { try { await loadImageFile(event.target.files[0]); } catch(error){finishWithError(error.message);} });
$('#sample-image').addEventListener('click', loadSampleImage);
$('#camera-toggle').addEventListener('click', toggleCamera);
refs.run.addEventListener('click', runCode); refs.stop.addEventListener('click', () => stopExecution());
$('#clear-log').addEventListener('click', () => { refs.terminal.innerHTML=''; addLog('system','ログを消去しました。'); });
$('#download-image').addEventListener('click', () => refs.canvas.toBlob(blob => blob && downloadBlob(blob,'unitv-output.png'),'image/png'));
$('#uart-queue').addEventListener('click', () => { try { uartQueued=parseUartInput(); addLog('system',`UART受信キューに ${uartQueued.length} byte を設定しました。`); } catch(error){finishWithError(error.message);} });
document.querySelectorAll('[data-gpio]').forEach(button => button.addEventListener('click', () => { const pin=button.dataset.gpio; gpioState[pin]=gpioState[pin]?0:1; updateGpioUi(pin,gpioState[pin]); }));

$('#api-open').addEventListener('click',()=>$('#api-dialog').showModal());
$('#threshold-open').addEventListener('click', openThresholdEditor);
const thresholdCanvas = $('#threshold-canvas');
thresholdCanvas.addEventListener('pointerdown', event => { thresholdDragStart = thresholdPoint(event); thresholdCanvas.setPointerCapture(event.pointerId); thresholdSelection = { x:thresholdDragStart.x,y:thresholdDragStart.y,width:1,height:1 }; drawThresholdPreview(); });
thresholdCanvas.addEventListener('pointermove', event => { if (!thresholdDragStart) return; const point=thresholdPoint(event); thresholdSelection={x:Math.min(point.x,thresholdDragStart.x),y:Math.min(point.y,thresholdDragStart.y),width:Math.abs(point.x-thresholdDragStart.x)+1,height:Math.abs(point.y-thresholdDragStart.y)+1}; drawThresholdPreview(); });
thresholdCanvas.addEventListener('pointerup', event => { if (!thresholdDragStart) return; thresholdCanvas.releasePointerCapture(event.pointerId); thresholdDragStart=null; calculateThresholdFromSelection(); });
document.querySelectorAll('[data-threshold-index]').forEach(input => input.addEventListener('input', () => { const index=Number(input.dataset.thresholdIndex); thresholdValues[index]=Number(input.value); drawThresholdPreview(); }));
$('#threshold-copy').addEventListener('click', async () => { const value=`(${thresholdValues.join(', ')})`; try { await navigator.clipboard.writeText(value); $('#threshold-copy').textContent='コピーしました'; setTimeout(()=>$('#threshold-copy').textContent='コピー',1200); } catch { addLog('warning','クリップボードへコピーできませんでした。'); } });
$('#threshold-insert').addEventListener('click', insertThreshold);

$('#github-open').addEventListener('click',()=>$('#github-dialog').showModal());
$('#github-load').addEventListener('click',loadFromGithub); $('#github-push').addEventListener('click',pushToGithub);
try {
  const savedGithub=JSON.parse(localStorage.getItem('unitv-github-settings')||'{}');
  ['owner','repo','branch','path','message'].forEach(key=>{ if(savedGithub[key]) $(`#github-${key}`).value=savedGithub[key]; });
} catch { /* Invalid old settings are ignored. */ }
$('#project-save').addEventListener('click',()=>$('#save-dialog').showModal()); $('#confirm-save').addEventListener('click',saveProject);
$('#project-open').addEventListener('click',()=>$('#project-file').click()); $('#project-file').addEventListener('change',async event=>{try{await openProject(event.target.files[0]);}catch(error){finishWithError(`プロジェクトを開けません: ${error.message}`);}event.target.value='';});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if(event.target===dialog)dialog.close(); }));
window.addEventListener('beforeunload',()=>{ worker?.terminate(); cameraStream?.getTracks().forEach(track=>track.stop()); });

addLog('system', '画像を選択し、コードを確認して「実行」を押してください。');
await initializeEditor();
