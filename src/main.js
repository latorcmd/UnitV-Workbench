import './styles.css';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const EXECUTION_LIMIT_MS = 8000;

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
        <button class="ghost-button" id="api-open" type="button">API一覧</button>
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
      <div class="control-divider"></div>
      <div class="run-copy"><span class="step">02</span><span><strong>コードを実行</strong><small>実行上限 8秒</small></span></div>
      <button class="run-button" id="run" type="button"><span>▶</span> 実行</button>
      <button class="stop-button" id="stop" type="button" disabled>■ 停止</button>
      <div class="runtime-state" id="runtime-state"><span></span><div><strong>準備完了</strong><small>画像を選択してください</small></div></div>
    </section>

    <section class="workspace">
      <article class="panel code-panel">
        <div class="panel-head">
          <div><span class="panel-kicker">EDITOR</span><h2>main.py</h2></div>
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
        <div class="editor-wrap">
          <pre class="line-numbers" id="line-numbers" aria-hidden="true"></pre>
          <textarea id="code-editor" aria-label="Pythonコードエディター" spellcheck="false"></textarea>
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
`;

const $ = selector => document.querySelector(selector);
const refs = {
  code: $('#code-editor'), lines: $('#line-numbers'), imageFile: $('#image-file'), canvas: $('#output-canvas'), empty: $('#empty-frame'),
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

refs.code.value = samples.color;
updateLineNumbers();
addLog('system', '画像を選択し、コードを確認して「実行」を押してください。');

function updateLineNumbers() {
  refs.lines.textContent = Array.from({ length: refs.code.value.split('\n').length }, (_, i) => i + 1).join('\n');
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

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
}

async function dataUrlToImage(dataUrl, name = 'project-image.png') {
  const response = await fetch(dataUrl); const blob = await response.blob();
  return loadImageFile(new File([blob], name, { type: blob.type || 'image/png' }), dataUrl);
}

async function loadImageFile(file, knownDataUrl = null) {
  if (!file) return;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('PNG、JPG、WebPの画像を選択してください。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('画像は15 MB以下にしてください。');
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 20_000_000) { bitmap.close(); throw new Error('画像の画素数が大きすぎます。最大20メガピクセルです。'); }
  const temp = document.createElement('canvas'); temp.width = bitmap.width; temp.height = bitmap.height;
  const ctx = temp.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
  sourceImage = ctx.getImageData(0, 0, temp.width, temp.height); sourceImageDataUrl = knownDataUrl || await fileToDataUrl(file); sourceImageName = file.name;
  drawFrame(sourceImage); refs.imageLabel.textContent = file.name; refs.imageDetail.textContent = `${sourceImage.width} × ${sourceImage.height}・${(file.size/1024/1024).toFixed(1)} MB`;
  setRuntime('準備完了', 'コードを実行できます'); addLog('system', `画像を読み込みました: ${file.name} (${sourceImage.width} × ${sourceImage.height})`);
}

function loadSampleImage() {
  const temp = document.createElement('canvas'); temp.width = 640; temp.height = 480;
  const ctx = temp.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 640, 480); bg.addColorStop(0, '#162b38'); bg.addColorStop(1, '#071017'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#ffae42'; ctx.beginPath(); ctx.arc(190, 230, 92, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#31e3d4'; ctx.fillRect(350, 130, 170, 190);
  ctx.fillStyle = '#63aefa'; ctx.beginPath(); ctx.moveTo(230, 390); ctx.lineTo(320, 285); ctx.lineTo(410, 390); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('UnitV sample', 210, 62);
  sourceImage = ctx.getImageData(0, 0, 640, 480); sourceImageDataUrl = temp.toDataURL('image/png'); sourceImageName = 'unitv-sample.png';
  drawFrame(sourceImage); refs.imageLabel.textContent = sourceImageName; refs.imageDetail.textContent = '640 × 480・組み込みサンプル';
  setRuntime('準備完了', 'コードを実行できます'); addLog('system', 'サンプル画像を読み込みました。');
}

function drawFrame(imageData) {
  refs.canvas.width = imageData.width; refs.canvas.height = imageData.height;
  refs.canvas.getContext('2d').putImageData(imageData, 0, 0); refs.canvas.hidden = false; refs.empty.hidden = true;
  refs.frameMeta.textContent = `${imageData.width} × ${imageData.height}`; $('#download-image').disabled = false;
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
  if (!sourceImage) { finishWithError('先に入力画像を選択してください。'); refs.imageFile.focus(); return; }
  setRunning(true); setRuntime('開始中', '入力データを準備しています', 'busy'); addLog('system', 'コードを実行します。');
  const imageCopy = new Uint8ClampedArray(sourceImage.data);
  const uartCopy = new Uint8Array(uartQueued);
  const payload = { type:'run', code:refs.code.value, image:{width:sourceImage.width,height:sourceImage.height,data:imageCopy.buffer}, uart:uartCopy.buffer, gpio:{...gpioState} };
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
  const project = { version:1, app:'UnitV Browser Lab', savedAt:new Date().toISOString(), code:refs.code.value, uart:{value:refs.uart.value,format:refs.uartFormat.value}, gpio:{...gpioState}, image:{name:sourceImageName} };
  if ($('#embed-image').checked && sourceImageDataUrl) project.image.dataUrl=sourceImageDataUrl;
  downloadBlob(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}), 'unitv-project.unitvproj'); $('#save-dialog').close(); addLog('system','プロジェクトを保存しました。');
}

async function openProject(file) {
  const project=JSON.parse(await file.text()); if(project.version!==1) throw new Error(`未対応のプロジェクトバージョンです: ${project.version}`);
  refs.code.value=String(project.code||samples.color); updateLineNumbers(); refs.uart.value=project.uart?.value||''; refs.uartFormat.value=project.uart?.format||'text';
  gpioState={GPIO1:0,GPIO2:0,GPIOHS0:0,...(project.gpio||{})}; Object.entries(gpioState).forEach(([p,v])=>updateGpioUi(p,v));
  if(project.image?.dataUrl)await dataUrlToImage(project.image.dataUrl,project.image.name);
  addLog('system',`プロジェクトを開きました: ${file.name}`);
}

refs.code.addEventListener('input', updateLineNumbers);
refs.code.addEventListener('scroll', () => { refs.lines.scrollTop=refs.code.scrollTop; });
refs.code.addEventListener('keydown', event => { if(event.key==='Tab'){event.preventDefault();const s=refs.code.selectionStart,e=refs.code.selectionEnd;refs.code.setRangeText('    ',s,e,'end');updateLineNumbers();} if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();runCode();} });
$('#sample-select').addEventListener('change', event => { refs.code.value=samples[event.target.value]; updateLineNumbers(); });
refs.imageFile.addEventListener('change', async event => { try { await loadImageFile(event.target.files[0]); } catch(error){finishWithError(error.message);} });
$('#sample-image').addEventListener('click', loadSampleImage);
refs.run.addEventListener('click', runCode); refs.stop.addEventListener('click', () => stopExecution());
$('#clear-log').addEventListener('click', () => { refs.terminal.innerHTML=''; addLog('system','ログを消去しました。'); });
$('#download-image').addEventListener('click', () => refs.canvas.toBlob(blob => blob && downloadBlob(blob,'unitv-output.png'),'image/png'));
$('#uart-queue').addEventListener('click', () => { try { uartQueued=parseUartInput(); addLog('system',`UART受信キューに ${uartQueued.length} byte を設定しました。`); } catch(error){finishWithError(error.message);} });
document.querySelectorAll('[data-gpio]').forEach(button => button.addEventListener('click', () => { const pin=button.dataset.gpio; gpioState[pin]=gpioState[pin]?0:1; updateGpioUi(pin,gpioState[pin]); }));

$('#api-open').addEventListener('click',()=>$('#api-dialog').showModal());
$('#project-save').addEventListener('click',()=>$('#save-dialog').showModal()); $('#confirm-save').addEventListener('click',saveProject);
$('#project-open').addEventListener('click',()=>$('#project-file').click()); $('#project-file').addEventListener('change',async event=>{try{await openProject(event.target.files[0]);}catch(error){finishWithError(`プロジェクトを開けません: ${error.message}`);}event.target.value='';});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if(event.target===dialog)dialog.close(); }));
window.addEventListener('beforeunload',()=>worker?.terminate());
