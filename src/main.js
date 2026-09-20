import './styles.css';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { HighlightStyle, bracketMatching, ensureSyntaxTree, foldGutter, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { lintGutter, linter } from '@codemirror/lint';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { MergeView } from '@codemirror/merge';
import { unzipSync } from 'fflate';
import { LatestBranchLoader } from './github-branch-loader.js';
import { MaixPyIdeClient } from './maixpy-ide.js';
import { WebSerialTransport } from './serial-transport.js';
import {
  createEntry, createProject, deleteProject, listProjectEntries, listProjects,
  removeEntry, replaceProjectEntries, saveEntries, saveEntry, saveProjectRecord
} from './file-store.js';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const MAX_PROJECT_ENTRIES = 2000;
const EXECUTION_LIMIT_MS = 8000;
const initialTheme = localStorage.getItem('unitv-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = initialTheme;

document.querySelector('#app').innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
        <div><h1>UnitV Browser Lab</h1><p>MaixPyを、ブラウザで試す。</p></div>
      </div>
      <div class="top-actions">
        <span class="privacy-pill"><span></span>画像・コードは端末内で処理</span>
        <label class="project-switcher"><span>PROJECT</span><select id="project-select" aria-label="プロジェクトを選択"></select></label>
        <button class="ghost-button" id="project-new" type="button">新規</button>
        <button class="ghost-button" id="project-manage" type="button">管理</button>
        <button class="icon-button" id="theme-toggle" type="button" aria-label="ライトモードに切り替え" title="表示テーマ">☀</button>
        <button class="ghost-button" id="api-open" type="button">API一覧</button>
        <button class="ghost-button" id="github-open" type="button">GitHub</button>
        <button class="ghost-button" id="project-open" type="button">読込</button>
        <button class="ghost-button" id="project-save" type="button">書出</button>
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
      <div class="execution-target">
        <label><span>実行先</span><select id="execution-target"><option value="simulator">ブラウザ</option><option value="unitv">実機 UnitV</option></select></label>
        <div class="execution-target-buttons"><button class="sample-image-button" id="unitv-connect" type="button">実機接続</button><button class="sample-image-button flash-button" id="unitv-flash" type="button" disabled>実機へ書込</button></div>
        <small id="unitv-connection">未接続</small>
      </div>
      <div class="run-copy"><span class="step">02</span><span><strong>コードを実行</strong><small id="execution-limit-note">静止画像は実行上限 8秒</small></span></div>
      <button class="run-button" id="run" type="button"><span>▶</span> 実行</button>
      <button class="stop-button" id="stop" type="button" disabled>■ 停止</button>
      <div class="runtime-state" id="runtime-state"><span></span><div><strong>準備完了</strong><small>画像を選択してください</small></div></div>
    </section>

    <section class="workspace">
      <article class="panel code-panel">
        <div class="panel-head">
          <div><span class="panel-kicker">EDITOR</span><h2 id="active-file-name">main.py</h2></div>
          <div class="panel-tools">
            <span class="git-version" id="git-version">LOCAL</span>
            <button id="diff-open" type="button" disabled>差分</button>
            <button id="editor-fullscreen" type="button" aria-pressed="false">全画面</button>
          </div>
        </div>
        <div class="editor-workspace">
          <aside class="file-sidebar" aria-label="プロジェクトファイル">
            <div class="file-sidebar-head"><span>FILES</span><div><button id="new-folder" type="button" title="新規フォルダ">▣</button><button id="new-file" type="button" title="新規ファイル">＋</button></div></div>
            <div id="file-list" class="file-list"></div>
            <small>この端末に自動保存</small>
          </aside>
          <div class="editor-main">
            <div id="code-editor" aria-label="Pythonコードエディター"></div>
            <div id="asset-viewer" class="asset-viewer" hidden>
              <img id="asset-image" alt="選択した画像">
              <div><strong id="asset-name"></strong><small id="asset-meta"></small><button id="asset-to-frame" type="button">フレームバッファに適用</button></div>
            </div>
            <div id="binary-viewer" class="binary-viewer" hidden><strong>プレビューできないファイルです</strong><small id="binary-meta"></small><button id="binary-download" type="button" disabled>ファイルをダウンロード</button></div>
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
            <div class="panel-tools"><button id="clear-log" type="button">消去</button><span id="serial-baud">仮想UART · 115200 baud</span></div>
          </div>
          <div class="terminal" id="terminal" role="log" aria-live="polite"></div>
        </article>
      </div>
    </section>

    <section class="io-dock panel">
      <div class="io-header">
        <div class="io-title"><span class="panel-kicker">DEVICE BAY</span><h2>仮想デバイス</h2></div>
        <span class="device-note" id="device-note">GPIO1 / GPIO2は実機のButton A / Bに対応</span>
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
      </div><p class="dialog-note">静止画像ではトップレベルの while(True) を1フレームだけ実行します。カメラでは各 snapshot() で新しいフレームを取得し、停止まで連続実行します。KPUは未対応です。</p>
    </form>
  </dialog>

  <dialog id="save-dialog" class="dialog small-dialog">
    <form method="dialog"><div class="dialog-head"><div><span class="panel-kicker">PROJECT FILE</span><h2>プロジェクトを保存</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <label class="check-row"><input id="embed-image" type="checkbox" checked><span><strong>画像・バイナリを含める</strong><small>JPGやkmodelも含め、別の端末で同じ状態から再開できます</small></span></label>
      <div class="dialog-actions"><button value="close" class="ghost-button">キャンセル</button><button type="button" class="run-button" id="confirm-save">ダウンロード</button></div>
    </form>
  </dialog>

  <dialog id="flash-dialog" class="dialog small-dialog flash-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker amber">UNITV FLASH</span><h2>実機へプログラムを書き込む</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <p class="dialog-intro">選択中のPythonをUnitVの <code>/flash/main.py</code> へ保存します。既存のmain.pyは上書きされます。</p>
      <div class="flash-summary"><span>書き込むファイル</span><strong id="flash-source-name">main.py</strong><small id="flash-source-size">0 byte</small></div>
      <label class="check-row"><input id="flash-reboot" type="checkbox" checked><span><strong>書き込み後に再起動</strong><small>USB接続を切り、保存したmain.pyを自動実行します</small></span></label>
      <p class="flash-warning">プロジェクト内の他のPython、画像、kmodelは転送しません。必要なファイルはあらかじめUnitVへ用意してください。</p>
      <div class="dialog-actions"><button value="close" class="ghost-button" id="flash-cancel">キャンセル</button><button type="button" class="run-button" id="flash-confirm">上書きして書き込む</button></div>
    </form>
  </dialog>

  <dialog id="file-dialog" class="dialog small-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">PROJECT ENTRY</span><h2 id="file-dialog-title">ファイルを作成</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <label class="dialog-field"><span>プロジェクト内のパス</span><input id="file-name-input" autocomplete="off" value="untitled.py"></label>
      <p class="dialog-intro">フォルダは <code>src/main.py</code> のようにパスへ含められます。内容はこの端末へ自動保存されます。</p>
      <div class="dialog-actions file-dialog-actions"><button type="button" class="danger-button" id="file-delete" hidden>削除</button><button type="button" class="ghost-button" id="file-duplicate" hidden>複製</button><button value="close" class="ghost-button">キャンセル</button><button type="button" class="run-button" id="file-confirm">作成</button></div>
    </form>
  </dialog>

  <dialog id="project-dialog" class="dialog small-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">LOCAL PROJECT</span><h2 id="project-dialog-title">プロジェクトを作成</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <label class="dialog-field"><span>プロジェクト名</span><input id="project-name-input" autocomplete="off" value="新しいプロジェクト"></label>
      <p class="dialog-intro">プロジェクトとファイルはIndexedDBを使ってこの端末内だけに保存されます。</p>
      <div class="dialog-actions"><button type="button" class="danger-button" id="project-delete" hidden>削除</button><button value="close" class="ghost-button">キャンセル</button><button type="button" class="run-button" id="project-confirm">作成</button></div>
    </form>
  </dialog>

  <dialog id="diff-dialog" class="dialog diff-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">GIT CHANGES</span><h2>変更内容</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <div class="diff-layout">
        <aside><div class="diff-list-head"><strong>変更ファイル</strong><button id="diff-select-all" type="button">すべて選択</button></div><div id="diff-file-list" class="diff-file-list"></div></aside>
        <section><div class="diff-title"><strong id="diff-file-name">ファイルを選択</strong><span id="diff-file-status"></span></div><div id="diff-editor"></div><div id="diff-asset" class="diff-asset" hidden></div></section>
      </div>
      <div class="dialog-actions"><button value="close" class="ghost-button">閉じる</button></div>
    </form>
  </dialog>

  <dialog id="version-dialog" class="dialog version-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">GIT VERSION</span><h2 id="version-title">過去のバージョン</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <div class="version-layout"><aside id="version-tree"></aside><section id="version-preview"><p>左のファイルを選択してください。</p></section></div>
    </form>
  </dialog>

  <dialog id="threshold-dialog" class="dialog threshold-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker amber">LAB THRESHOLD EDITOR</span><h2>画像からLAB閾値を作る</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <p class="dialog-intro">画像上をドラッグして色の範囲を選択してください。選択領域から外れ値を除いて閾値を計算します。</p>
      <div class="threshold-source-picker" role="group" aria-label="閾値に使う画像">
        <div class="threshold-source-label"><strong>対象画像</strong><small>同じ閾値のまま切り替えられます</small></div>
        <button type="button" data-threshold-source="frame" aria-pressed="true"><span>フレームバッファ</span><small>現在の出力画像</small></button>
        <button type="button" data-threshold-source="saved" aria-pressed="false"><span>保存画像</span><small>読み込んだ元画像</small></button>
        <output id="threshold-source-meta">画像を選択してください</output>
      </div>
      <div class="threshold-layout">
        <div class="threshold-stage"><canvas id="threshold-canvas"></canvas><span id="threshold-hint">ドラッグで範囲選択</span></div>
        <div class="threshold-gauges" aria-label="LAB閾値ゲージ">
          ${[
            { key:'l', label:'L', description:'明るさ', min:0, max:100, low:0, high:1 },
            { key:'a', label:'a', description:'緑 ↔ 赤', min:-128, max:127, low:2, high:3 },
            { key:'b', label:'b', description:'青 ↔ 黄', min:-128, max:127, low:4, high:5 }
          ].map(channel=>`<section class="threshold-gauge threshold-gauge-${channel.key}" data-threshold-pair data-low-index="${channel.low}" data-high-index="${channel.high}" data-min="${channel.min}" data-max="${channel.max}">
            <div class="threshold-gauge-head"><span><b>${channel.label}</b>${channel.description}</span><output data-threshold-output>${channel.min} ～ ${channel.max}</output></div>
            <div class="threshold-gauge-scale"><span>${channel.min}</span><div class="threshold-dual-range">
              <div class="threshold-range-track" aria-hidden="true"><i></i></div>
              <input class="threshold-range threshold-range-low" type="range" min="${channel.min}" max="${channel.max}" step="1" value="${channel.min}" data-threshold-index="${channel.low}" aria-label="${channel.label} 下限">
              <input class="threshold-range threshold-range-high" type="range" min="${channel.min}" max="${channel.max}" step="1" value="${channel.max}" data-threshold-index="${channel.high}" aria-label="${channel.label} 上限">
            </div><span>${channel.max}</span></div>
          </section>`).join('')}
          <p class="threshold-gauge-help">2つの点をドラッグして範囲を調整します。つまみを選択して矢印キーを押すと1ずつ動かせます。</p>
          <div class="threshold-summary">
            <div class="threshold-result"><span>MaixPy形式</span><code id="threshold-value">(0, 100, -128, 127, -128, 127)</code></div>
            <div class="threshold-stats" id="threshold-stats">画像上の対象色を選択してください。</div>
          </div>
        </div>
      </div>
      <div class="dialog-actions"><button type="button" class="ghost-button" id="threshold-copy">コピー</button><button type="button" class="run-button" id="threshold-insert">コードへ挿入</button></div>
    </form>
  </dialog>

  <dialog id="github-dialog" class="dialog github-dialog">
    <form method="dialog">
      <div class="dialog-head"><div><span class="panel-kicker">GITHUB SYNC</span><h2>GitHubリポジトリと連携</h2></div><button value="close" aria-label="閉じる">×</button></div>
      <p class="dialog-intro">GitHubでログインし、アクセスを許可したリポジトリを選んでください。認証情報は暗号化されたセッションとして保持され、ブラウザのコードやlocalStorageには保存されません。</p>
      <div class="github-auth-bar">
        <div id="github-account"><strong>未ログイン</strong><small>GitHub Appで安全に接続します</small></div>
        <a id="github-install" href="https://github.com/apps/unitv-browser-lab/installations/new" target="_blank" rel="noreferrer" hidden>権限を設定</a>
        <button type="button" class="ghost-button" id="github-login">GitHubでログイン</button>
        <button type="button" class="ghost-button" id="github-logout" hidden>ログアウト</button>
      </div>
      <section class="github-device" id="github-device" hidden>
        <span>GitHubに入力する確認コード</span>
        <strong id="github-device-code">----</strong>
        <p>下のボタンからGitHubを開き、表示されたコードを入力して許可してください。この画面は自動的に接続を確認します。</p>
        <a class="run-button" id="github-device-open" href="https://github.com/login/device" target="_blank" rel="noreferrer">GitHubを開いて許可</a>
      </section>
      <div class="github-grid">
        <label class="github-repository-field"><span>許可済みリポジトリ</span><select id="github-repository" disabled><option value="">ログインすると選択できます</option></select></label>
        <input id="github-owner" type="hidden"><input id="github-repo" type="hidden">
        <label><span>ブランチ</span><select id="github-branch" disabled><option value="">リポジトリを選択してください</option></select></label>
        <label><span>操作対象</span><input id="github-project-target" value="プロジェクト全体" disabled></label>
        <label class="github-message-field"><span>コミットメッセージ</span><input id="github-message" value="Update from UnitV Browser Lab"></label>
      </div>
      <div class="github-repository-actions"><button type="button" class="ghost-button" id="github-refresh">リポジトリ一覧を更新</button><button type="button" class="run-button" id="github-clone">新規プロジェクトへクローン</button></div>
      <div class="github-worktree" id="github-worktree"><strong>GitHubの状態</strong><span>まず接続確認またはプルを実行してください。</span><button type="button" id="github-discard" hidden>保留コミットを破棄</button></div>
      <div id="github-status" class="github-status">未接続</div>
      <div class="github-flow" aria-label="GitHub操作">
        <button type="button" class="ghost-button" id="github-pull"><b>1</b><span>プル<small>GitHubから取得</small></span></button>
        <button type="button" class="ghost-button" id="github-commit"><b>2</b><span>コミット<small>変更を記録</small></span></button>
        <button type="button" class="run-button" id="github-push"><b>3</b><span>プッシュ<small>ブランチへ反映</small></span></button>
      </div>
      <section class="github-history"><h3>最近のコミット</h3><div id="github-history">接続すると履歴を表示します。</div></section>
    </form>
  </dialog>
`;

const $ = selector => document.querySelector(selector);
const refs = {
  editor: $('#code-editor'), imageFile: $('#image-file'), canvas: $('#output-canvas'), empty: $('#empty-frame'), camera: $('#camera-preview'),
  imageLabel: $('#image-label'), imageDetail: $('#image-detail'), frameMeta: $('#frame-meta'), terminal: $('#terminal'),
  run: $('#run'), stop: $('#stop'), runtime: $('#runtime-state'), uart: $('#uart-input'), uartFormat: $('#uart-format'),
  executionTarget: $('#execution-target'), unitvConnect: $('#unitv-connect'), unitvFlash:$('#unitv-flash'), unitvConnection: $('#unitv-connection')
};

let sourceImage = null;
let sourceImageDataUrl = null;
let sourceImageName = '';
let savedImage = null;
let savedImageName = '';
let frameBufferImage = null;
let imageLoadPromise = null;
let worker = null;
let executionTimer = null;
let running = false;
let gpioState = { GPIO1: 0, GPIO2: 0, GPIOHS0: 0 };
let uartQueued = new Uint8Array();
let cameraStream = null;
let lastCameraCaptureAt = 0;
let editorView = null;
let mergeView = null;
let projects = [];
let currentProject = null;
let files = [];
let currentFileId = null;
let autosaveTimer = null;
let suppressAutosave = false;
let fileDialogTarget = null;
let fileDialogMode = 'file';
let fileDeleteArmed = false;
let projectDialogMode = 'new';
let projectDeleteArmed = false;
let expandedFolders = new Set();
let selectedChanges = new Set();
let objectUrls = new Set();
let thresholdValues = [0, 100, -128, 127, -128, 127];
let thresholdSelection = null;
let thresholdDragStart = null;
let thresholdPreviewFrame = null;
let thresholdSourceImage = null;
let thresholdSourceKind = 'frame';
let githubAccount = null;
let githubRepositories = [];
let githubAuthBusy = false;
let githubPollGeneration = 0;
let githubPendingCommit = null;
let githubBranches = [];
let githubBranchBusy = false;
const githubBranchLoader = new LatestBranchLoader();
const serialTransport = new WebSerialTransport();
const realUnitV = new MaixPyIdeClient(serialTransport);
let executionTarget = localStorage.getItem('unitv-execution-target') === 'unitv' ? 'unitv' : 'simulator';
let realPollGeneration = 0;
let realConnectionBusy = false;
let realStdoutBuffer = '';
const realStdoutDecoder = new TextDecoder();

const languageCompartment = new Compartment();
const lintCompartment = new Compartment();

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
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100) || syntaxTree(view.state);
  tree.iterate({
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
  const active = activeEntry();
  if (!isPythonEntry(active)) {
    $('#syntax-status').textContent = active?.kind === 'text' ? 'テキストファイル' : 'プレビュー';
    $('#syntax-status').classList.remove('has-error');
    return;
  }
  const count = syntaxDiagnostics(view).length;
  const status = $('#syntax-status');
  status.textContent = count ? `⚠ 書式エラー ${count}件` : '✓ 書式エラーなし';
  status.classList.toggle('has-error', Boolean(count));
}

function configureEditorForEntry(entry) {
  if (!editorView) return;
  const isPython = isPythonEntry(entry);
  editorView.dispatch({ effects: [
    languageCompartment.reconfigure(isPython ? python() : []),
    lintCompartment.reconfigure(isPython ? [lintGutter(), linter(syntaxDiagnostics, { delay: 250 })] : [])
  ] });
  updateSyntaxStatus();
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
  refs.terminal.append(line);
  while (refs.terminal.children.length > 300) refs.terminal.firstElementChild?.remove();
  refs.terminal.scrollTop = refs.terminal.scrollHeight;
}

function setRuntime(state, detail, mode = '') {
  refs.runtime.className = `runtime-state ${mode}`;
  refs.runtime.querySelector('strong').textContent = state;
  refs.runtime.querySelector('small').textContent = detail;
}

function setRunning(value) {
  running = value; refs.run.disabled = value || !isPythonEntry(activeEntry()); refs.stop.disabled = !value;
  refs.run.innerHTML = value ? '<span class="spinner"></span> 実行中' : '<span>▶</span> 実行';
  refs.executionTarget.disabled = value;
  refs.unitvConnect.disabled = value || realConnectionBusy || !serialTransport.supported;
  refs.unitvFlash.disabled = value || realConnectionBusy || !serialTransport.connected || !isPythonEntry(activeEntry());
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderExecutionTarget() {
  const real = executionTarget === 'unitv';
  refs.executionTarget.value = executionTarget;
  document.querySelector('#io-pane').classList.toggle('hardware-disabled', real);
  document.querySelectorAll('#io-pane input, #io-pane select, #io-pane button, #io-pane [data-gpio]').forEach(control => { control.disabled = real; });
  $('#device-note').textContent = real ? '実機実行中は仮想UART・GPIO・WS2812を使用しません' : 'GPIO1 / GPIO2は実機のButton A / Bに対応';
  $('#serial-baud').textContent = real ? (realUnitV.ideReady ? '実機 · 1500000 baud' : '実機 · 115200 baud') : '仮想UART · 115200 baud';
  $('#execution-limit-note').textContent = real ? '実機では停止まで連続実行' : cameraStream ? 'カメラ時は停止まで連続実行' : '静止画像は実行上限 8秒';
  refs.unitvConnect.hidden = !real;
  refs.unitvFlash.hidden = !real;
  refs.unitvConnection.hidden = !real;
  refs.run.title = real ? '選択中のPythonを実機UnitVで実行' : '選択中のPythonをブラウザ内で実行';
  refs.empty.querySelector('strong').textContent = real ? 'UnitVのフレームを待っています' : '画像を選んでください';
  refs.empty.querySelector('small').textContent = real ? '実行すると実機のフレームバッファを表示します' : 'アップロード画像が仮想カメラになります';
  if (real) {
    refs.imageLabel.textContent = sourceImageName || '実機カメラを使用';
    refs.imageDetail.textContent = '画像入力はUnitVのsensor.snapshot()から取得';
  } else if (sourceImage) {
    refs.imageLabel.textContent = sourceImageName || '入力画像';
    refs.imageDetail.textContent = `${sourceImage.width} × ${sourceImage.height}・ブラウザ内で使用`;
  } else {
    refs.imageLabel.textContent = '入力画像'; refs.imageDetail.textContent = 'PNG / JPG / WebP・最大15 MB';
  }
  if (!running && real) setRuntime('実機モード', serialTransport.connected ? '選択中のPythonをUnitVで実行できます' : '「実機接続」からUnitVを選択してください');
  renderUnitVConnection();
}

function renderUnitVConnection(message = '') {
  const connected = serialTransport.connected;
  refs.unitvConnect.textContent = connected ? '切断' : '実機接続';
  refs.unitvConnect.disabled = running || realConnectionBusy || !serialTransport.supported;
  refs.unitvFlash.disabled = running || realConnectionBusy || !connected || !isPythonEntry(activeEntry());
  refs.unitvConnection.textContent = message || (connected ? (realUnitV.ideReady ? 'IDEモード接続中' : 'USB接続中') : serialTransport.supported ? '未接続' : 'Chrome / Edgeのみ対応');
  refs.unitvConnection.classList.toggle('connected', connected);
  if (executionTarget === 'unitv') $('#serial-baud').textContent = realUnitV.ideReady ? '実機 · 1500000 baud' : '実機 · 115200 baud';
}

function normalizeProjectPath(value, fallback = 'untitled.py') {
  const clean = String(value || fallback).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!clean || clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('利用できないパスです。');
  if (clean.length > 240 || /[\0:*?"<>|]/.test(clean)) throw new Error('パスが長すぎるか、利用できない文字が含まれています。');
  return clean;
}

function makeUniqueFilename(requested, ignoredId = null) {
  const path = normalizeProjectPath(requested);
  if (!files.some(file => !file.deleted && file.id !== ignoredId && file.path === path)) return path;
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? `${path.slice(0, slash + 1)}` : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let number = 2;
  while (files.some(file => !file.deleted && file.id !== ignoredId && file.path === `${directory}${stem}-${number}${extension}`)) number += 1;
  return `${directory}${stem}-${number}${extension}`;
}

function activeEntry() { return files.find(file => file.id === currentFileId && !file.deleted) || null; }
function visibleFiles() { return files.filter(file => !file.deleted); }
function isPythonEntry(entry) { return Boolean(entry?.kind === 'text' && entry.path.toLowerCase().endsWith('.py')); }

function entryStatus(entry) {
  if (!currentProject?.source || currentProject.source.type !== 'github') return '';
  if (entry.kind === 'folder') return '';
  if (entry.deleted) return 'D';
  if (!entry.basePath) return 'A';
  if (entry.path !== entry.basePath) return 'R';
  if (entry.kind === 'text' && entry.text !== entry.baseText) return 'M';
  return '';
}

function changedEntries() { return files.filter(entry => entryStatus(entry)); }
function hasLocalChanges() { return changedEntries().length > 0; }

function revokeObjectUrls() {
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob); objectUrls.add(url); return url;
}

function uniqueProjectName(requested) {
  const base = String(requested || '新しいプロジェクト').trim() || '新しいプロジェクト';
  if (!projects.some(project => project.name === base)) return base;
  let number = 2;
  while (projects.some(project => project.name === `${base} (${number})`)) number += 1;
  return `${base} (${number})`;
}

function renderProjectSelector() {
  const select = $('#project-select');
  select.replaceChildren();
  projects.forEach(project => {
    const option = document.createElement('option'); option.value = project.id; option.textContent = project.name;
    option.selected = project.id === currentProject?.id; select.append(option);
  });
}

function renderGitVersion() {
  const badge = $('#git-version'); const changes = changedEntries();
  if (currentProject?.source?.type !== 'github') {
    badge.textContent = 'LOCAL'; badge.className = 'git-version'; $('#diff-open').disabled = true; return;
  }
  const sha = currentProject.source.headSha?.slice(0, 7) || '-------';
  badge.textContent = `${currentProject.source.branch} · ${sha}${changes.length ? ` · ${changes.length}変更` : ' · clean'}`;
  badge.className = `git-version${changes.length ? ' changed' : ''}`;
  $('#diff-open').disabled = !changes.length;
}

function renderFileList() {
  const list = $('#file-list');
  list.replaceChildren();
  const folders = new Set();
  visibleFiles().forEach(file => {
    if (file.kind === 'folder') folders.add(file.path);
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join('/'));
  });
  const nodes = [
    ...[...folders].map(path => ({ type: 'folder', path })),
    ...visibleFiles().filter(file => file.kind !== 'folder').map(file => ({ type: 'file', path: file.path, file }))
  ].sort((a, b) => {
    const aParent = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
    const bParent = b.path.includes('/') ? b.path.slice(0, b.path.lastIndexOf('/')) : '';
    if (aParent === bParent && a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  nodes.forEach(node => {
    const parents = node.path.split('/').slice(0, -1);
    if (parents.some((_, index) => !expandedFolders.has(parents.slice(0, index + 1).join('/')))) return;
    const depth = node.path.split('/').length - 1;
    const row = document.createElement('div');
    row.className = `file-row${node.file?.id === currentFileId ? ' active' : ''}${node.type === 'folder' ? ' folder' : ''}`;
    row.style.setProperty('--tree-depth', depth);
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'file-open'; open.title = node.path;
    const label = node.path.split('/').pop();
    if (node.type === 'folder') {
      const expanded = expandedFolders.has(node.path);
      open.innerHTML = `<span>${expanded ? '▾' : '▸'}</span><b></b>`; open.querySelector('b').textContent = label;
      open.addEventListener('click', () => { expanded ? expandedFolders.delete(node.path) : expandedFolders.add(node.path); renderFileList(); });
    } else {
      const icon = node.file.kind === 'image' ? 'IMG' : node.file.kind === 'text' ? (node.path.toLowerCase().endsWith('.py') ? 'PY' : 'TXT') : 'BIN';
      open.innerHTML = '<span></span><b></b><i></i>'; open.querySelector('span').textContent = icon; open.querySelector('b').textContent = label;
      const status = entryStatus(node.file); open.querySelector('i').textContent = status;
      open.addEventListener('click', () => selectFile(node.file.id));
    }
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'file-menu'; menu.textContent = '•••'; menu.title = '名前変更・複製・削除';
    menu.addEventListener('click', () => node.type === 'folder' ? editFolder(node.path) : editFile(node.file.id));
    row.append(open, menu); list.append(row);
  });
  renderGitVersion();
}

async function persistCurrentFile() {
  const file = activeEntry();
  if (!file || file.kind !== 'text' || !editorView) return;
  file.text = getCode(); file.size = new Blob([file.text]).size; file.updatedAt = new Date().toISOString();
  $('#save-status').textContent = '保存中…';
  try {
    await saveEntry(file);
    if (currentProject && currentFileId === file.id) { currentProject.activePath = file.path; await saveProjectRecord(currentProject); }
    $('#save-status').textContent = '✓ この端末に保存済み';
    if (entryStatus(file)) selectedChanges.add(file.id); else selectedChanges.delete(file.id);
    renderFileList();
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
  if (!file || file.kind === 'folder') return;
  const parts = file.path.split('/'); for (let index = 1; index < parts.length; index += 1) expandedFolders.add(parts.slice(0, index).join('/'));
  revokeObjectUrls();
  refs.editor.hidden = file.kind !== 'text';
  $('#asset-viewer').hidden = file.kind !== 'image';
  $('#binary-viewer').hidden = !['binary', 'submodule'].includes(file.kind);
  $('#binary-download').disabled = file.kind !== 'binary' || !file.blob;
  if (file.kind === 'text') {
    suppressAutosave = true; setCode(file.text || ''); suppressAutosave = false;
    configureEditorForEntry(file); editorView.focus();
  } else if (file.kind === 'image') {
    $('#asset-image').src = objectUrl(file.blob);
    $('#asset-name').textContent = file.path;
    $('#asset-meta').textContent = `${file.mime || 'image'} · ${(file.size / 1024).toFixed(1)} KB`;
    updateSyntaxStatus();
  } else {
    const extension = file.path.split('.').pop()?.toLowerCase();
    $('#binary-meta').textContent = `${file.path} · ${file.size || 0} bytes${file.kind === 'submodule' ? ' · submodule' : extension === 'kmodel' ? ' · K210 kmodel（読み取り専用）' : ' · 読み取り専用'}`;
    updateSyntaxStatus();
  }
  $('#active-file-name').textContent = file.path;
  if (currentProject) { currentProject.activePath = file.path; void saveProjectRecord(currentProject); }
  localStorage.setItem('unitv-active-project', currentProject?.id || '');
  renderFileList();
  $('#save-status').textContent = '✓ この端末に保存済み';
  refs.run.disabled = running || !isPythonEntry(file);
  renderUnitVConnection();
  await previousSave;
}

function openNewFileDialog() {
  fileDialogTarget = null; fileDialogMode = 'file-new'; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'ファイルを作成'; $('#file-name-input').value = makeUniqueFilename('untitled.py');
  $('#file-confirm').textContent = '作成'; $('#file-delete').hidden = true; $('#file-duplicate').hidden = true;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

function openNewFolderDialog() {
  fileDialogTarget = null; fileDialogMode = 'folder-new'; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'フォルダを作成'; $('#file-name-input').value = 'new-folder';
  $('#file-confirm').textContent = '作成'; $('#file-delete').hidden = true; $('#file-duplicate').hidden = true;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

function editFile(id) {
  const file = files.find(item => item.id === id); if (!file) return;
  fileDialogTarget = id; fileDialogMode = 'file-edit'; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'ファイルを管理'; $('#file-name-input').value = file.path;
  $('#file-confirm').textContent = '名前を保存'; $('#file-delete').hidden = false; $('#file-delete').textContent = '削除'; $('#file-duplicate').hidden = false;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

function editFolder(path) {
  fileDialogTarget = path; fileDialogMode = 'folder-edit'; fileDeleteArmed = false;
  $('#file-dialog-title').textContent = 'フォルダを管理'; $('#file-name-input').value = path;
  $('#file-confirm').textContent = '名前を保存'; $('#file-delete').hidden = false; $('#file-delete').textContent = '削除'; $('#file-duplicate').hidden = true;
  $('#file-dialog').showModal(); $('#file-name-input').focus(); $('#file-name-input').select();
}

async function confirmFileDialog() {
  let requested;
  try { requested = normalizeProjectPath($('#file-name-input').value); } catch (error) { addLog('error', error.message); return; }
  if (fileDialogMode === 'folder-new') {
    if (files.some(file => !file.deleted && file.path === requested)) { addLog('error', '同じパスのファイルまたはフォルダがあります。'); return; }
    const folder = createEntry({ projectId:currentProject.id, path:requested, kind:'folder', order:files.length }); files.push(folder); expandedFolders.add(requested); await saveEntry(folder); $('#file-dialog').close(); renderFileList(); return;
  }
  if (fileDialogMode === 'file-new') {
    const path = makeUniqueFilename(requested);
    const file = createEntry({ projectId: currentProject.id, path, kind: 'text', text: '', order: files.length });
    files.push(file); selectedChanges.add(file.id); await saveEntry(file); $('#file-dialog').close(); currentFileId = null; await selectFile(file.id); return;
  }
  if (fileDialogMode === 'folder-edit') {
    const oldPath = String(fileDialogTarget); const affected = files.filter(file => !file.deleted && (file.path === oldPath || file.path.startsWith(`${oldPath}/`)));
    const replacements = affected.map(file => ({ file, path: `${requested}${file.path.slice(oldPath.length)}` }));
    if (replacements.some(item => files.some(other => !other.deleted && !affected.includes(other) && other.path === item.path))) { addLog('error', '同じ場所にファイルがあります。'); return; }
    replacements.forEach(item => { item.file.path = item.path; selectedChanges.add(item.file.id); }); await saveEntries(affected);
    expandedFolders.delete(oldPath); expandedFolders.add(requested); $('#file-dialog').close(); renderFileList(); return;
  }
  const file = files.find(item => item.id === fileDialogTarget); if (!file) return;
  file.path = makeUniqueFilename(requested, file.id);
  selectedChanges.add(file.id); await saveEntry(file); renderFileList();
  if (file.id === currentFileId) $('#active-file-name').textContent = file.path;
  $('#file-dialog').close();
}

async function duplicateFileDialog() {
  const file = files.find(item => item.id === fileDialogTarget); if (!file) return;
  const dot = file.path.lastIndexOf('.'); const requested = dot > 0 ? `${file.path.slice(0, dot)}-copy${file.path.slice(dot)}` : `${file.path}-copy`;
  const copy = createEntry({ projectId:currentProject.id, path:makeUniqueFilename(requested), kind:file.kind, text:file.text || '', blob:file.blob || null, mime:file.mime || '', size:file.size, mode:file.mode, order:files.length });
  files.push(copy); selectedChanges.add(copy.id); await saveEntry(copy); $('#file-dialog').close(); currentFileId = null; await selectFile(copy.id);
}

async function deleteFileDialog() {
  if (!fileDeleteArmed) { fileDeleteArmed = true; $('#file-delete').textContent = 'もう一度押して削除'; return; }
  let targets;
  if (fileDialogMode === 'folder-edit') {
    const folder = String(fileDialogTarget); targets = files.filter(file => !file.deleted && (file.path === folder || file.path.startsWith(`${folder}/`)));
  } else targets = files.filter(file => file.id === fileDialogTarget);
  const deletingActive = targets.some(file => file.id === currentFileId);
  for (const file of targets) {
    if (file.basePath) { file.deleted = true; selectedChanges.add(file.id); await saveEntry(file); }
    else { files = files.filter(item => item.id !== file.id); await removeEntry(file.id); }
  }
  $('#file-dialog').close();
  if (deletingActive) {
    currentFileId = null; const next = visibleFiles().find(file => file.kind !== 'folder'); if (next) await selectFile(next.id); else showEmptyProject();
  } else renderFileList();
}

function showEmptyProject() {
  refs.editor.hidden = true; $('#asset-viewer').hidden = true; $('#binary-viewer').hidden = false;
  $('#binary-meta').textContent = 'ファイルを作成してください。'; $('#active-file-name').textContent = 'ファイルなし';
  refs.run.disabled = true; renderFileList(); updateSyntaxStatus();
}

async function switchProject(projectId) {
  clearTimeout(autosaveTimer); await persistCurrentFile();
  const project = projects.find(item => item.id === projectId); if (!project) return;
  currentProject = project; files = await listProjectEntries(project.id); currentFileId = null;
  expandedFolders = new Set(); selectedChanges = new Set(changedEntries().map(entry => entry.id));
  localStorage.setItem('unitv-active-project', project.id); renderProjectSelector(); renderFileList();
  githubPendingCommit = project.source?.pendingCommit || null;
  const active = files.find(file => !file.deleted && file.kind !== 'folder' && file.path === project.activePath) || visibleFiles().find(file => file.kind !== 'folder');
  if (active) await selectFile(active.id); else showEmptyProject();
  renderGithubState(); renderGitVersion();
}

function openProjectDialog(mode) {
  projectDialogMode = mode; projectDeleteArmed = false;
  $('#project-dialog-title').textContent = mode === 'new' ? 'プロジェクトを作成' : 'プロジェクトを管理';
  $('#project-name-input').value = mode === 'new' ? uniqueProjectName('新しいプロジェクト') : currentProject?.name || '';
  $('#project-confirm').textContent = mode === 'new' ? '作成' : '名前を保存';
  $('#project-delete').hidden = mode === 'new'; $('#project-delete').textContent = '削除';
  $('#project-dialog').showModal(); $('#project-name-input').focus(); $('#project-name-input').select();
}

async function confirmProjectDialog() {
  const name = $('#project-name-input').value.trim(); if (!name) return;
  if (projectDialogMode === 'new') {
    const project = createProject(uniqueProjectName(name)); const main = createEntry({ projectId:project.id, path:'main.py', kind:'text', text:'', order:0 });
    projects.unshift(project); await saveProjectRecord(project); await saveEntry(main); $('#project-dialog').close(); await switchProject(project.id); return;
  }
  currentProject.name = name; await saveProjectRecord(currentProject); renderProjectSelector(); $('#project-dialog').close();
}

async function deleteCurrentProject() {
  if (!projectDeleteArmed) { projectDeleteArmed = true; $('#project-delete').textContent = 'もう一度押して削除'; return; }
  const deletingId = currentProject.id; await deleteProject(deletingId); projects = projects.filter(project => project.id !== deletingId);
  if (!projects.length) {
    const replacement = createProject('新しいプロジェクト'); projects.push(replacement);
    await saveProjectRecord(replacement); await saveEntry(createEntry({ projectId:replacement.id, path:'main.py', kind:'text', text:'', order:0 }));
  }
  $('#project-dialog').close(); await switchProject(projects[0].id);
}

async function initializeEditor() {
  editorView = new EditorView({
    parent: refs.editor,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), history(), foldGutter(), drawSelection(), highlightActiveLine(),
        indentUnit.of('    '), languageCompartment.of([]), lintCompartment.of([]), bracketMatching(), closeBrackets(),
        syntaxHighlighting(editorHighlight), indentGuides,
        keymap.of([
          { key: 'Mod-Enter', run: () => { if (isPythonEntry(activeEntry())) void runCode(); return true; } },
          indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && activeEntry()?.kind === 'text') {
            updateSyntaxStatus(update.view);
            if (!suppressAutosave) scheduleAutosave();
            renderGithubState(); renderGitVersion();
          }
        })
      ]
    })
  });
  try { projects = await listProjects(); } catch (error) { addLog('warning', `IndexedDBを利用できません: ${error.message}`); }
  if (!projects.length) {
    const project = createProject('新しいプロジェクト'); projects = [project];
    const main = createEntry({ projectId:project.id, path:'main.py', kind:'text', text:'', order:0 });
    await saveProjectRecord(project); await saveEntry(main);
  }
  const saved = localStorage.getItem('unitv-active-project');
  await switchProject(projects.some(project => project.id === saved) ? saved : projects[0].id);
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
  if (!['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'].includes(file.type)) throw new Error('PNG、JPG、WebP、GIF、SVGの画像を選択してください。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('画像は15 MB以下にしてください。');
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > 20_000_000) { bitmap.close(); throw new Error('画像の画素数が大きすぎます。最大20メガピクセルです。'); }
  const temp = document.createElement('canvas'); temp.width = bitmap.width; temp.height = bitmap.height;
  const ctx = temp.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
  sourceImage = ctx.getImageData(0, 0, temp.width, temp.height); sourceImageDataUrl = knownDataUrl || await fileToDataUrl(file); sourceImageName = file.name;
  savedImage = copyImageData(sourceImage); savedImageName = file.name;
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

async function captureCameraFrame(waitForFreshFrame = false, updateSavedImage = true) {
  if (!cameraStream || refs.camera.readyState < 2) throw new Error('カメラの映像を準備中です。少し待ってから再実行してください。');
  if (waitForFreshFrame) {
    const delay = Math.max(0, 90 - (performance.now() - lastCameraCaptureAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (typeof refs.camera.requestVideoFrameCallback === 'function') {
      await Promise.race([
        new Promise(resolve => refs.camera.requestVideoFrameCallback(() => resolve())),
        new Promise(resolve => setTimeout(resolve, 250))
      ]);
    }
  }
  const width = refs.camera.videoWidth; const height = refs.camera.videoHeight;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(refs.camera, 0, 0, width, height);
  sourceImage = context.getImageData(0, 0, width, height); sourceImageName = 'camera-frame.jpg'; lastCameraCaptureAt = performance.now();
  if (updateSavedImage) sourceImageDataUrl = canvas.toDataURL('image/jpeg', .9);
  $('#threshold-open').disabled = false;
  return sourceImage;
}

async function replyWithCameraFrame(requestId) {
  const targetWorker = worker;
  try {
    const frame = await captureCameraFrame(true, false);
    if (!targetWorker || worker !== targetWorker) return;
    const data = new Uint8ClampedArray(frame.data);
    targetWorker.postMessage({ type:'camera-frame', requestId, image:{ width:frame.width, height:frame.height, data:data.buffer } }, [data.buffer]);
  } catch (error) {
    if (targetWorker && worker === targetWorker) targetWorker.postMessage({ type:'camera-frame-error', requestId, message:error.message });
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラ入力を利用できません。');
  cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  refs.camera.srcObject = cameraStream; await refs.camera.play();
  refs.camera.hidden = false; refs.canvas.hidden = true; refs.empty.hidden = true;
  $('#camera-toggle').textContent = 'カメラを停止'; $('#camera-toggle').classList.add('active');
  $('#execution-limit-note').textContent = 'カメラ時は停止まで連続実行';
  refs.imageLabel.textContent = 'リアルタイムカメラ'; refs.imageDetail.textContent = '実行時のフレームを使用・端末内のみ'; refs.frameMeta.textContent = `${refs.camera.videoWidth} × ${refs.camera.videoHeight} LIVE`;
  setRuntime('カメラ入力', 'snapshot()ごとに新しいフレームを取得します', 'success'); addLog('system', '端末カメラを開始しました。snapshot()ごとに新しいフレームを取得します。映像はサーバーへ送信されません。');
}

function stopCamera(showLastFrame = true) {
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; refs.camera.srcObject = null; refs.camera.hidden = true;
  $('#camera-toggle').textContent = 'カメラを開始'; $('#camera-toggle').classList.remove('active');
  $('#execution-limit-note').textContent = '静止画像は実行上限 8秒';
  if (showLastFrame && sourceImage) drawFrame(sourceImage);
  addLog('system', 'カメラを停止しました。');
}

async function toggleCamera() {
  try {
    if (cameraStream) { if (running) stopExecution('カメラを停止したため実行を終了しました。'); stopCamera(); return; }
    await startCamera();
  } catch (error) { finishWithError(`カメラを開始できません: ${error.message}`); }
}

function drawFrame(imageData) {
  frameBufferImage = copyImageData(imageData);
  refs.canvas.width = imageData.width; refs.canvas.height = imageData.height;
  refs.canvas.getContext('2d').putImageData(frameBufferImage, 0, 0); refs.canvas.hidden = false; refs.camera.hidden = true; refs.empty.hidden = true;
  refs.frameMeta.textContent = `${imageData.width} × ${imageData.height}`; $('#download-image').disabled = false;
}

function copyImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
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

function updateThresholdGauges() {
  document.querySelectorAll('[data-threshold-pair]').forEach(gauge => {
    const lowIndex = Number(gauge.dataset.lowIndex); const highIndex = Number(gauge.dataset.highIndex);
    const min = Number(gauge.dataset.min); const max = Number(gauge.dataset.max); const span = max - min;
    const low = thresholdValues[lowIndex]; const high = thresholdValues[highIndex];
    gauge.style.setProperty('--threshold-low', `${(low - min) / span * 100}%`);
    gauge.style.setProperty('--threshold-high', `${(high - min) / span * 100}%`);
    gauge.querySelector('[data-threshold-output]').textContent = `${low} ～ ${high}`;
    gauge.querySelector(`[data-threshold-index="${lowIndex}"]`).value = low;
    gauge.querySelector(`[data-threshold-index="${highIndex}"]`).value = high;
  });
}

function scheduleThresholdPreview() {
  updateThresholdGauges();
  if (thresholdPreviewFrame !== null) return;
  thresholdPreviewFrame = requestAnimationFrame(() => {
    thresholdPreviewFrame = null;
    drawThresholdPreview();
  });
}

function drawThresholdPreview() {
  if (!thresholdSourceImage) return;
  const canvas = $('#threshold-canvas'); canvas.width = thresholdSourceImage.width; canvas.height = thresholdSourceImage.height;
  const output = new Uint8ClampedArray(thresholdSourceImage.data); let matched = 0;
  for (let i = 0; i < output.length; i += 4) {
    if (thresholdMatches(rgbToLab(output[i], output[i + 1], output[i + 2]))) { matched += 1; continue; }
    const gray = Math.round(output[i] * .299 + output[i + 1] * .587 + output[i + 2] * .114);
    output[i] = gray * .36; output[i + 1] = gray * .36; output[i + 2] = gray * .36;
  }
  const context = canvas.getContext('2d'); context.putImageData(new ImageData(output, thresholdSourceImage.width, thresholdSourceImage.height), 0, 0);
  if (thresholdSelection) {
    const { x, y, width, height } = thresholdSelection; context.strokeStyle = '#ffae42'; context.lineWidth = Math.max(2, thresholdSourceImage.width / 220); context.setLineDash([8, 5]); context.strokeRect(x, y, width, height); context.setLineDash([]);
  }
  const total = thresholdSourceImage.width * thresholdSourceImage.height;
  $('#threshold-stats').textContent = `一致: ${matched.toLocaleString()} px（${(matched / total * 100).toFixed(1)}%）`;
  $('#threshold-value').textContent = `(${thresholdValues.join(', ')})`;
  updateThresholdGauges();
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b); return values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
}

function calculateThresholdFromSelection() {
  if (!thresholdSourceImage || !thresholdSelection) return;
  const { x, y, width, height } = thresholdSelection; const channels = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt(width * height / 18000)));
  for (let py = y; py < y + height; py += step) for (let px = x; px < x + width; px += step) {
    const index = (py * thresholdSourceImage.width + px) * 4; const lab = rgbToLab(thresholdSourceImage.data[index], thresholdSourceImage.data[index + 1], thresholdSourceImage.data[index + 2]);
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

function updateThresholdSourceButtons() {
  document.querySelectorAll('[data-threshold-source]').forEach(button => {
    const image = button.dataset.thresholdSource === 'frame' ? frameBufferImage : savedImage;
    button.disabled = !image;
    const active = button.dataset.thresholdSource === thresholdSourceKind && Boolean(image);
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}

function selectThresholdSource(kind) {
  const image = kind === 'frame' ? frameBufferImage : savedImage;
  if (!image) return false;
  thresholdSourceKind = kind; thresholdSourceImage = copyImageData(image); thresholdSelection = null;
  const label = kind === 'frame' ? 'フレームバッファ' : `保存画像: ${savedImageName || '名称なし'}`;
  $('#threshold-source-meta').textContent = `${label}・${image.width} × ${image.height}`;
  updateThresholdSourceButtons(); drawThresholdPreview();
  return true;
}

async function openThresholdEditor() {
  if (cameraStream) await captureCameraFrame();
  if (!frameBufferImage && !savedImage) { finishWithError('先に画像を選択するか、コードを実行してください。'); return; }
  thresholdSelection = null; thresholdValues = [0, 100, -128, 127, -128, 127];
  thresholdSourceKind = frameBufferImage ? 'frame' : 'saved'; updateThresholdSourceButtons();
  selectThresholdSource(thresholdSourceKind); $('#threshold-dialog').showModal();
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
  if (msg.type === 'camera-frame-request') {
    replyWithCameraFrame(msg.requestId); return;
  } else if (msg.type === 'frame') {
    if (running) {
      drawFrame(new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height));
      setRuntime('カメラ実行中', '停止ボタンを押すまで連続処理します', 'busy');
    }
  } else if (msg.type === 'status') {
    const states = { 'loading-python':['Pythonを準備中',msg.text], 'loading-model':['モデルを準備中',msg.text], executing:['実行中',msg.liveCamera?'停止ボタンを押すまで連続処理します':`最大${EXECUTION_LIMIT_MS/1000}秒で停止します`] };
    const state = states[msg.phase] || ['処理中',msg.text || '']; setRuntime(state[0], state[1], 'busy');
    if (msg.phase === 'executing') {
      clearTimeout(executionTimer); executionTimer = null;
      if (!msg.liveCamera) executionTimer = setTimeout(() => stopExecution('実行時間が8秒を超えたため停止しました。'), EXECUTION_LIMIT_MS);
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
  return String(message).replace('PythonError: ', '').replace(/File "([^"]+)", line (\d+)/g, '$1:$2');
}

function finishWithError(message) {
  clearTimeout(executionTimer); executionTimer = null; setRunning(false); setRuntime('エラー', 'シリアルモニタを確認してください', 'error');
  addLog('error', message);
}

function flushRealStdout(final = false) {
  if (final) realStdoutBuffer += realStdoutDecoder.decode();
  if (final) {
    if (realStdoutBuffer) addLog('stdout', realStdoutBuffer);
    realStdoutBuffer = '';
    return;
  }
  const lines = realStdoutBuffer.split(/\r\n|\n|\r/);
  realStdoutBuffer = lines.pop() || '';
  lines.forEach(line => addLog('stdout', line));
}

function appendRealStdout(bytes) {
  if (!bytes?.byteLength) return;
  realStdoutBuffer += realStdoutDecoder.decode(bytes, { stream:true });
  flushRealStdout(false);
}

async function drawRealFrame(frame) {
  const bitmap = await createImageBitmap(new Blob([frame.jpeg], { type:'image/jpeg' }));
  refs.canvas.width = bitmap.width;
  refs.canvas.height = bitmap.height;
  const context = refs.canvas.getContext('2d', { willReadFrequently:true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  frameBufferImage = context.getImageData(0, 0, refs.canvas.width, refs.canvas.height);
  refs.canvas.hidden = false; refs.camera.hidden = true; refs.empty.hidden = true;
  refs.frameMeta.textContent = `${refs.canvas.width} × ${refs.canvas.height} LIVE UNITV`;
  $('#download-image').disabled = false; $('#threshold-open').disabled = false;
}

async function connectUnitV() {
  if (realConnectionBusy || running) return;
  if (serialTransport.connected) { await disconnectUnitV(); return; }
  realConnectionBusy = true; renderUnitVConnection('接続先を選択してください…');
  try {
    await realUnitV.connectConsole();
    renderUnitVConnection();
    setRuntime('UnitV接続', '実行するとIDEモードへ切り替えます', 'success');
    addLog('system', 'UnitVへUSB接続しました（115200 baud）。');
  } catch (error) {
    try { await serialTransport.close(); } catch { /* connection never fully opened */ }
    renderUnitVConnection('接続できません');
    finishWithError(`UnitVへ接続できません: ${error.message}`);
  } finally {
    realConnectionBusy = false; renderUnitVConnection();
  }
}

async function disconnectUnitV({ unexpected = false } = {}) {
  ++realPollGeneration;
  realConnectionBusy = true;
  if (running && executionTarget === 'unitv') setRunning(false);
  renderUnitVConnection(unexpected ? '接続が切れました' : '切断処理中…');
  try {
    if (unexpected) await serialTransport.close();
    else await realUnitV.resetAndClose();
  } catch (error) {
    if (!unexpected) addLog('warning', `切断処理の一部を完了できませんでした: ${error.message}`);
  } finally {
    realConnectionBusy = false; realUnitV.ideReady = false; renderUnitVConnection(unexpected ? '再起動後に再接続してください' : '未接続');
  }
  if (unexpected) {
    setRuntime('UnitV切断', '本体をリセットしてから再接続してください', 'error');
    addLog('error', 'UnitVとのUSB接続が切れました。本体をリセットしてから再接続してください。');
  } else {
    setRuntime('UnitV切断', '実機をリセットして安全に切断しました');
    addLog('system', 'UnitVの実行を停止・リセットして切断しました。');
  }
}

function openFlashDialog() {
  const file = activeEntry();
  if (!serialTransport.connected) { finishWithError('先にUnitVへ接続してください。'); return; }
  if (!isPythonEntry(file)) { finishWithError('実機へ書き込むPythonファイルを選択してください。'); return; }
  const bytes = new TextEncoder().encode(getCode()).byteLength;
  if (bytes > 512 * 1024) { finishWithError('実機へ書き込めるPythonは512 KB以下です。'); return; }
  $('#flash-source-name').textContent = file.path;
  $('#flash-source-size').textContent = `${bytes.toLocaleString('ja-JP')} byte → /flash/main.py`;
  $('#flash-confirm').textContent = $('#flash-reboot').checked ? '上書きして再起動' : '上書きして書き込む';
  $('#flash-dialog').showModal();
}

async function flashActiveProgram() {
  const file = activeEntry();
  if (!serialTransport.connected || !isPythonEntry(file) || realConnectionBusy) return;
  const codeBytes = new TextEncoder().encode(getCode());
  if (codeBytes.byteLength > 512 * 1024) { finishWithError('実機へ書き込めるPythonは512 KB以下です。'); return; }
  const reboot = $('#flash-reboot').checked;
  realConnectionBusy = true;
  $('#flash-confirm').disabled = true; $('#flash-cancel').disabled = true;
  refs.run.disabled = true; refs.stop.disabled = true; refs.executionTarget.disabled = true;
  renderUnitVConnection('書き込み準備中…');
  try {
    await persistCurrentFile();
    setRuntime('書き込み準備中', 'UnitVをMaixPy IDEモードへ切り替えています', 'busy');
    addLog('system', `${file.path} を /flash/main.py へ書き込みます。`);
    await realUnitV.activateIde(); renderUnitVConnection('IDEモード接続中');
    await realUnitV.stop(); await sleep(160);
    const saved = await realUnitV.saveFile('/flash/main.py', codeBytes, {
      onProgress: ratio => {
        const percent = Math.round(ratio * 100);
        setRuntime('実機へ書き込み中', `${percent}% · USBケーブルを抜かないでください`, 'busy');
        renderUnitVConnection(`書き込み中 ${percent}%`);
      }
    });
    addLog('system', `/flash/main.py へ ${saved.bytes.toLocaleString('ja-JP')} byteを書き込み、SHA-256検証に成功しました。`);
    $('#flash-dialog').close();
    if (reboot) {
      setRuntime('再起動中', '保存したmain.pyを起動します', 'busy');
      await realUnitV.resetAndClose();
      renderUnitVConnection('未接続');
      setRuntime('書き込み完了', 'UnitVを再起動し、main.pyを自動実行しました', 'success');
      addLog('system', 'UnitVを再起動しました。書き込んだmain.pyは本体上で動作します。');
    } else {
      renderUnitVConnection('IDEモード接続中');
      setRuntime('書き込み完了', '/flash/main.pyへ保存しました', 'success');
    }
  } catch (error) {
    finishWithError(`実機への書き込みに失敗しました: ${error.message}`);
  } finally {
    realConnectionBusy = false;
    $('#flash-confirm').disabled = false; $('#flash-cancel').disabled = false;
    setRunning(false); renderUnitVConnection();
  }
}

async function runOnUnitV(activeFile) {
  if (!serialTransport.connected) { finishWithError('「実機接続」を押してUnitVを選択してください。'); refs.unitvConnect.focus(); return; }
  await persistCurrentFile();
  setRunning(true); realStdoutBuffer = '';
  const generation = ++realPollGeneration;
  setRuntime('UnitV準備中', 'MaixPy IDEモードへ切り替えています', 'busy'); addLog('system', `実機で実行します: ${activeFile.path}`);
  try {
    await realUnitV.activateIde(); renderUnitVConnection();
    await realUnitV.setFrameBufferEnabled(true);
    await realUnitV.execute(getCode());
    setRuntime('実機で実行中', '停止ボタンを押すまでUnitV上で動作します', 'busy');
    let observedRunning = false;
    let idlePolls = 0;
    while (running && generation === realPollGeneration) {
      const result = await realUnitV.poll();
      appendRealStdout(result.stdout);
      if (result.frame && generation === realPollGeneration) await drawRealFrame(result.frame);
      if (result.running) { observedRunning = true; idlePolls = 0; }
      else idlePolls += 1;
      if ((observedRunning && !result.running) || (!observedRunning && idlePolls >= 3)) break;
      await sleep(70);
    }
    if (generation !== realPollGeneration) return;
    flushRealStdout(true); setRunning(false);
    setRuntime('実機実行完了', 'UnitVから最終結果を取得しました', 'success'); addLog('system', 'UnitVでの実行が完了しました。');
  } catch (error) {
    if (generation === realPollGeneration) finishWithError(`UnitV実行エラー: ${error.message}`);
  }
}

async function stopExecution(reason = '手動で実行を停止しました。') {
  if (!running) return;
  clearTimeout(executionTimer); executionTimer = null;
  if (executionTarget === 'unitv') {
    ++realPollGeneration;
    try { await realUnitV.stop(); } catch (error) { addLog('warning', `UnitVへ停止命令を送れませんでした: ${error.message}`); }
    flushRealStdout(true);
  } else { worker?.terminate(); worker = null; }
  setRunning(false);
  setRuntime('停止', '次回実行時に環境を再起動します', 'error'); addLog('warning', reason);
}

async function runCode() {
  if (running) return;
  const activeFile = activeEntry();
  if (!isPythonEntry(activeFile)) { finishWithError('実行するPythonファイルを選択してください。'); return; }
  if (syntaxDiagnostics(editorView).length) { finishWithError('Pythonコードに書式エラーがあります。エディター内の赤い印を確認してください。'); editorView.focus(); return; }
  if (executionTarget === 'unitv') { await runOnUnitV(activeFile); return; }
  if (imageLoadPromise) await imageLoadPromise;
  if (cameraStream) {
    try { await captureCameraFrame(); } catch (error) { finishWithError(error.message); return; }
  }
  if (!sourceImage) { finishWithError('先に入力画像を選択してください。'); refs.imageFile.focus(); return; }
  await persistCurrentFile();
  setRunning(true); setRuntime('開始中', '入力データを準備しています', 'busy'); addLog('system', 'コードを実行します。');
  const imageCopy = new Uint8ClampedArray(sourceImage.data);
  const uartCopy = new Uint8Array(uartQueued);
  const payload = { type:'run', code:getCode(), filename:activeFile.path, files:visibleFiles().filter(file=>isPythonEntry(file)).map(file=>({name:file.path,code:file.id===currentFileId?getCode():file.text})), cameraMode:Boolean(cameraStream), image:{width:sourceImage.width,height:sourceImage.height,data:imageCopy.buffer}, uart:uartCopy.buffer, gpio:{...gpioState} };
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
  const embedAssets = $('#embed-image').checked;
  const entries = await Promise.all(files.filter(entry => !entry.deleted).map(async entry => ({
    path:entry.path, kind:entry.kind, text:entry.kind === 'text' ? entry.text : undefined,
    dataUrl:['image','binary'].includes(entry.kind) && embedAssets && entry.blob ? await fileToDataUrl(entry.blob) : undefined,
    mime:entry.mime, size:entry.size, mode:entry.mode, basePath:entry.basePath, baseSha:entry.baseSha,
    baseText:entry.kind === 'text' ? entry.baseText : undefined
  })));
  const source = currentProject.source?.type === 'github' ? { ...currentProject.source, pendingCommit:undefined } : { type:'local' };
  const project = { version:4, app:'UnitV Browser Lab', name:currentProject.name, savedAt:new Date().toISOString(), activePath:activeEntry()?.path, source, entries, uart:{value:refs.uart.value,format:refs.uartFormat.value}, gpio:{...gpioState}, image:{name:sourceImageName} };
  if ($('#embed-image').checked && sourceImageDataUrl) project.image.dataUrl=sourceImageDataUrl;
  const safeName = currentProject.name.replace(/[\\/:*?"<>|]/g, '-');
  downloadBlob(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}), `${safeName}.unitvproj`); $('#save-dialog').close(); addLog('system','プロジェクトを書き出しました。');
}

async function openProject(file) {
  if (file.size > 80 * 1024 * 1024) throw new Error('プロジェクトファイルが大きすぎます。');
  const data=JSON.parse(await file.text()); if(![1,2,3,4].includes(data.version)) throw new Error(`未対応のプロジェクトバージョンです: ${data.version}`);
  const reusableGithubSource = data.version >= 3 && data.source?.type === 'github' && data.source.owner && data.source.repo && data.source.branch && data.source.headSha;
  const importedProject=createProject(uniqueProjectName(data.name || file.name.replace(/\.unitvproj$/i,'')), reusableGithubSource ? data.source : {type:'local'});
  const rawEntries = data.version >= 3 && Array.isArray(data.entries) ? data.entries : data.version === 2 && Array.isArray(data.files) ? data.files.map(item=>({path:item.name,kind:'text',text:item.code})) : [{path:'main.py',kind:'text',text:String(data.code||'')}];
  if (rawEntries.length > MAX_PROJECT_ENTRIES) throw new Error(`ファイル数が上限の${MAX_PROJECT_ENTRIES}件を超えています。`);
  const imported=[]; let importedBytes=0;
  for (const [index,item] of rawEntries.entries()) {
    const path=normalizeProjectPath(item.path || `file-${index+1}.txt`);
    let blob=null; if(['image','binary'].includes(item.kind) && item.dataUrl) blob=await (await fetch(item.dataUrl)).blob();
    const text=String(item.text||''); const size=item.kind === 'text' || !item.kind ? new Blob([text]).size : blob?.size || Number(item.size) || 0;
    if ((item.kind === 'text' || !item.kind) && size > MAX_TEXT_BYTES) throw new Error(`${path} はテキスト上限の1 MBを超えています。`);
    if (item.kind === 'image' && size > MAX_IMAGE_BYTES) throw new Error(`${path} は画像上限の15 MBを超えています。`);
    importedBytes += size; if (importedBytes > MAX_PROJECT_BYTES) throw new Error('プロジェクトの合計サイズが50 MBを超えています。');
    imported.push(createEntry({projectId:importedProject.id,path,kind:item.kind||'text',text,blob,mime:item.mime||blob?.type||'',size,mode:item.mode||'100644',basePath:item.basePath||null,baseSha:item.baseSha||null,baseText:item.baseText??null,order:index}));
  }
  if(!imported.length) imported.push(createEntry({projectId:importedProject.id,path:'main.py',kind:'text',text:'',order:0}));
  importedProject.activePath=data.activePath||data.activeFile||imported[0].path; projects.unshift(importedProject); await saveProjectRecord(importedProject); await saveEntries(imported);
  refs.uart.value=data.uart?.value||''; refs.uartFormat.value=data.uart?.format||'text';
  gpioState={GPIO1:0,GPIO2:0,GPIOHS0:0,...(data.gpio||{})}; Object.entries(gpioState).forEach(([p,v])=>updateGpioUi(p,v));
  if(data.image?.dataUrl)await dataUrlToImage(data.image.dataUrl,data.image.name);
  await switchProject(importedProject.id);
  addLog('system',`プロジェクトを開きました: ${file.name}`);
}

function githubSettings() {
  return {
    owner: $('#github-owner').value.trim(), repo: $('#github-repo').value.trim(), branch: $('#github-branch').value.trim() || 'main',
    message: $('#github-message').value.trim() || 'Update from UnitV Browser Lab'
  };
}

function saveGithubSettings(settings) {
  localStorage.setItem('unitv-github-settings', JSON.stringify(settings));
}

function githubSettingsKey(settings) {
  return `${settings.owner.toLowerCase()}/${settings.repo.toLowerCase()}/${settings.branch}`;
}

function githubRepoBase(settings) {
  if (!settings.owner || !settings.repo) throw new Error('所有者とリポジトリを入力してください。');
  return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
}

function githubEncodedBranch(settings) {
  if (!settings.branch) throw new Error('ブランチを入力してください。');
  return settings.branch.split('/').filter(Boolean).map(encodeURIComponent).join('/');
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
  if (!githubAccount) throw new Error('先にGitHubでログインしてください。');
  const response = await fetch(`/api/github/request?path=${encodeURIComponent(endpoint)}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const fallback = response.status === 401 ? 'GitHubへもう一度ログインしてください。' : response.status === 403 ? 'このリポジトリへのContents権限を確認してください。' : `GitHub API: HTTP ${response.status}`;
    const error = new Error(body.message || body.error || fallback); error.status = response.status; throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function githubRequestRaw(endpoint) {
  if (!githubAccount) throw new Error('先にGitHubでログインしてください。');
  const response = await fetch(`/api/github/request?path=${encodeURIComponent(endpoint)}`, { credentials:'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || body.error || `GitHub API: HTTP ${response.status}`); error.status=response.status; throw error;
  }
  return response;
}

async function githubApi(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin' });
  if (!(response.headers.get('Content-Type') || '').includes('application/json')) {
    const error = new Error('GitHubログインは公開版のサイトで利用してください。');
    error.status = response.status; throw error;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `GitHub連携: HTTP ${response.status}`);
    error.status = response.status; error.details = body.details; throw error;
  }
  return body;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function renderGithubAccount() {
  const account = $('#github-account');
  const login = $('#github-login'); const logout = $('#github-logout'); const install = $('#github-install');
  if (githubAccount) {
    account.querySelector('strong').textContent = `@${githubAccount.login}`;
    account.querySelector('small').textContent = githubRepositories.length
      ? `${githubRepositories.length}件のリポジトリを利用できます`
      : 'リポジトリへのアクセスを許可してください';
    login.hidden = true; logout.hidden = false; install.hidden = false;
  } else {
    account.querySelector('strong').textContent = '未ログイン';
    account.querySelector('small').textContent = 'GitHub Appで安全に接続します';
    login.hidden = false; logout.hidden = true; install.hidden = true;
  }
}

async function renderGithubRepositories(preferredFullName = '') {
  const select = $('#github-repository');
  const current = preferredFullName || `${$('#github-owner').value}/${$('#github-repo').value}`;
  select.replaceChildren();
  if (!githubRepositories.length) {
    githubBranchLoader.invalidate(); githubBranchBusy = false; githubBranches = [];
    const option = document.createElement('option');
    option.value = ''; option.textContent = githubAccount ? '許可済みリポジトリがありません' : 'ログインすると選択できます';
    select.append(option); select.disabled = true; $('#github-owner').value = ''; $('#github-repo').value = '';
    const branchSelect = $('#github-branch'); branchSelect.replaceChildren(new Option('リポジトリを選択してください', '')); branchSelect.disabled = true;
    setGithubControlsBusy(false);
    return;
  }
  githubRepositories.forEach(repository => {
    const option = document.createElement('option');
    option.value = repository.fullName; option.textContent = `${repository.fullName}${repository.private ? '（非公開）' : ''}`;
    select.append(option);
  });
  const preferred = githubRepositories.find(repository => repository.fullName === current);
  const selected = preferred || githubRepositories[0];
  select.value = selected.fullName; select.disabled = false;
  await applyGithubRepository(selected, !preferred);
}

async function applyGithubRepository(repository, useDefaultBranch = true) {
  if (!repository) return;
  $('#github-owner').value = repository.owner;
  $('#github-repo').value = repository.name;
  const branchSelect = $('#github-branch'); const previous = branchSelect.value;
  githubBranchBusy = true; branchSelect.disabled = true; branchSelect.replaceChildren(new Option('ブランチを取得中…', '')); setGithubControlsBusy(false);
  const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const result = await githubBranchLoader.load(repository, () => githubRequest(`${base}/branches?per_page=100`));
  if (result.stale) return;
  try {
    if (result.error) throw result.error;
    githubBranches = result.branches;
    branchSelect.replaceChildren(); githubBranches.forEach(branch => branchSelect.append(new Option(branch.name, branch.name)));
    const saved = JSON.parse(localStorage.getItem('unitv-github-settings') || '{}');
    const linked = currentProject?.source?.type === 'github' && currentProject.source.owner === repository.owner && currentProject.source.repo === repository.name;
    const preferred = linked ? currentProject.source.branch : useDefaultBranch ? repository.defaultBranch : previous || saved.branch || repository.defaultBranch;
    branchSelect.value = githubBranches.some(branch => branch.name === preferred) ? preferred : githubBranches[0]?.name || '';
    branchSelect.disabled = !githubBranches.length;
  } catch (error) {
    githubBranches = [];
    branchSelect.replaceChildren(new Option('ブランチを取得できません', '')); githubSetStatus(error.message, 'error');
  } finally {
    githubBranchBusy = false;
    setGithubControlsBusy(false);
  }
  saveGithubSettings(githubSettings()); renderGithubState();
}

async function refreshGithubSession({ quiet = false } = {}) {
  if (!quiet) githubSetStatus('GitHubの接続情報を確認中…', 'busy');
  try {
    const data = await githubApi('/api/github/session');
    if (!data.authenticated || !data.user?.login) throw new Error('GitHubのログイン情報を確認できませんでした。');
    githubAccount = data.user; githubRepositories = data.repositories || [];
    $('#github-install').href = data.installUrl || 'https://github.com/apps/unitv-browser-lab/installations/new';
    const saved = JSON.parse(localStorage.getItem('unitv-github-settings') || '{}');
    const linked = currentProject?.source?.type === 'github' ? `${currentProject.source.owner}/${currentProject.source.repo}` : '';
    await renderGithubRepositories(linked || (saved.owner && saved.repo ? `${saved.owner}/${saved.repo}` : ''));
    renderGithubAccount();
    githubSetStatus(githubRepositories.length
      ? 'ログインしました。利用するリポジトリを選択してください。'
      : 'ログインしました。「権限を設定」から利用するリポジトリを選んでください。', githubRepositories.length ? 'success' : 'busy');
    return true;
  } catch (error) {
    githubAccount = null; githubRepositories = []; await renderGithubRepositories(); renderGithubAccount();
    if (!quiet && error.status !== 401) githubSetStatus(error.message, 'error');
    else if (!quiet) githubSetStatus('GitHubでログインしてください。');
    return false;
  } finally {
    setGithubControlsBusy(false); renderGithubState();
  }
}

async function startGithubLogin() {
  if (githubAuthBusy) return;
  githubAuthBusy = true; setGithubControlsBusy(true); githubSetStatus('GitHubログインを準備中…', 'busy');
  const generation = ++githubPollGeneration;
  try {
    const data = await githubApi('/api/github/device/start', { method: 'POST' });
    $('#github-device-code').textContent = data.userCode;
    $('#github-device-open').href = data.verificationUri;
    $('#github-device').hidden = false;
    githubSetStatus('GitHubを開き、確認コードを入力してください。', 'busy');
    let retryAfter = Math.max(5, Number(data.interval) || 5);
    const expiresAt = Date.now() + Number(data.expiresIn || 900) * 1000;
    while (generation === githubPollGeneration && Date.now() < expiresAt) {
      await sleep(retryAfter * 1000);
      let result;
      try {
        result = await githubApi('/api/github/device/poll', { method: 'POST' });
      } catch (error) {
        if (error.status === 410 || error.details === 'access_denied') throw error;
        throw error;
      }
      if (result.status === 'authenticated') {
        $('#github-device').hidden = true;
        await refreshGithubSession();
        return;
      }
      retryAfter = Math.max(1, Number(result.retryAfter) || retryAfter);
    }
    if (generation === githubPollGeneration) throw new Error('確認コードの有効期限が切れました。もう一度ログインしてください。');
  } catch (error) {
    if (generation === githubPollGeneration) githubSetStatus(error.message, 'error');
  } finally {
    if (generation === githubPollGeneration) {
      githubAuthBusy = false; setGithubControlsBusy(false);
    }
  }
}

async function logoutGithub() {
  ++githubPollGeneration; githubAuthBusy = false;
  await runGithubAction('GitHubからログアウト中…', async () => {
    await githubApi('/api/github/logout', { method: 'POST' });
    githubAccount = null; githubRepositories = []; $('#github-device').hidden = true;
    await renderGithubRepositories(); renderGithubAccount();
    githubSetStatus('ログアウトしました。', 'success');
  });
}

function githubSetStatus(message, mode = '') {
  const status = $('#github-status'); status.textContent = message; status.className = `github-status${mode ? ` ${mode}` : ''}`;
}

function setGithubControlsBusy(busy) {
  busy = busy || githubBranchBusy;
  const connected = Boolean(githubAccount && $('#github-owner').value && $('#github-repo').value);
  $('#github-clone').disabled = busy || !connected || !$('#github-branch').value;
  const linked = Boolean(githubAccount && currentProject?.source?.type === 'github');
  ['github-pull','github-commit','github-push','github-discard'].forEach(id => { $(`#${id}`).disabled = busy || !linked; });
  $('#github-login').disabled = busy;
  $('#github-logout').disabled = busy || !githubAccount;
  $('#github-refresh').disabled = busy || !githubAccount;
  $('#github-repository').disabled = busy || !githubRepositories.length;
}

function persistGithubState() {
  if (currentProject?.source?.type !== 'github') return;
  currentProject.source.pendingCommit = githubPendingCommit || null;
  void saveProjectRecord(currentProject);
}

function renderGithubState() {
  const panel = $('#github-worktree'); const detail = panel.querySelector('span'); const discard = $('#github-discard');
  if (currentProject?.source?.type !== 'github') {
    discard.hidden = true; panel.className = 'github-worktree'; detail.textContent = 'GitHubからクローンするとバージョン管理を利用できます。'; $('#github-project-target').value = 'ローカルプロジェクト'; return;
  }
  $('#github-project-target').value = `${currentProject.source.owner}/${currentProject.source.repo} @ ${currentProject.source.branch}`;
  if (githubPendingCommit) {
    panel.className = 'github-worktree pending';
    detail.textContent = `コミット ${githubPendingCommit.commitSha.slice(0, 7)} は未プッシュです。`;
    discard.hidden = false; return;
  }
  discard.hidden = true; panel.className = 'github-worktree';
  const changes = changedEntries(); panel.classList.toggle('changed', Boolean(changes.length));
  detail.textContent = changes.length ? `${changes.length}件の未コミット変更があります。` : `GitHubと同期済み（${currentProject.source.headSha?.slice(0, 7) || '-------'}）`;
}

async function runGithubAction(progressMessage, action) {
  setGithubControlsBusy(true); githubSetStatus(progressMessage, 'busy');
  try {
    await action();
  } catch (error) { githubSetStatus(error.message, 'error'); }
  finally { setGithubControlsBusy(false); renderGithubState(); }
}

function linkedGithubSettings() {
  const source = currentProject?.source;
  if (source?.type !== 'github') throw new Error('GitHubからクローンしたプロジェクトを選択してください。');
  return { owner:source.owner, repo:source.repo, branch:source.branch, message:$('#github-message').value.trim() || 'Update from UnitV Browser Lab' };
}

function imageMime(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml' })[extension] || '';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value).replace(/\s/g, ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function blobToBase64(blob) { return bytesToBase64(new Uint8Array(await blob.arrayBuffer())); }

async function fetchRepositorySnapshot(settings) {
  const repo = githubRepoBase(settings); const branch = githubEncodedBranch(settings);
  const reference = await githubRequest(`${repo}/git/ref/heads/${branch}`);
  const commit = await githubRequest(`${repo}/git/commits/${reference.object.sha}`);
  const tree = await githubRequest(`${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('リポジトリが大きすぎるため一覧を完全に取得できません。');
  const tracked = (tree.tree || []).filter(item => item.type === 'blob' || item.type === 'commit');
  if (tracked.length > MAX_PROJECT_ENTRIES) throw new Error(`ファイル数が上限の${MAX_PROJECT_ENTRIES}件を超えています。`);
  const declaredBytes = tracked.reduce((total, item) => total + (Number(item.size) || 0), 0);
  if (declaredBytes > MAX_PROJECT_BYTES) throw new Error('プロジェクトの合計サイズが50 MBを超えています。');
  const oversizedImage = tracked.find(item => imageMime(item.path) && Number(item.size) > MAX_IMAGE_BYTES);
  if (oversizedImage) throw new Error(`${oversizedImage.path} は画像上限の15 MBを超えています。`);
  const archiveResponse = await githubRequestRaw(`${repo}/zipball/${branch}`);
  const archive = new Uint8Array(await archiveResponse.arrayBuffer());
  if (archive.byteLength > MAX_PROJECT_BYTES) throw new Error('リポジトリのダウンロードサイズが50 MBを超えています。');
  const unpacked = unzipSync(archive);
  const archiveNames = Object.keys(unpacked).filter(name => !name.endsWith('/'));
  const archiveFiles = new Map(archiveNames.map(name => [name.split('/').slice(1).join('/'), unpacked[name]]));
  const entries = []; let totalBytes = 0;
  for (const [order, item] of tracked.entries()) {
    const path = normalizeProjectPath(item.path);
    if (item.type === 'commit') {
      entries.push({ path, kind:'submodule', size:0, mode:item.mode, basePath:path, baseSha:item.sha, order });
      continue;
    }
    const bytes = archiveFiles.get(path);
    if (!bytes) throw new Error(`アーカイブ内に ${path} が見つかりません。`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROJECT_BYTES) throw new Error('展開後のプロジェクトサイズが50 MBを超えています。');
    const mime = imageMime(path);
    if (mime) {
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${path} は画像上限の15 MBを超えています。`);
      entries.push({ path, kind:'image', blob:new Blob([bytes], { type:mime }), mime, size:bytes.byteLength, mode:item.mode, basePath:path, baseSha:item.sha, order });
      continue;
    }
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      try {
        const decoded = new TextDecoder('utf-8', { fatal:true }).decode(bytes);
        if (!decoded.includes('\0')) throw new Error(`${path} はテキスト上限の1 MBを超えています。`);
      } catch (error) {
        if (error instanceof Error && error.message.includes('テキスト上限')) throw error;
      }
    }
    let text = null;
    if (bytes.byteLength <= MAX_TEXT_BYTES) {
      try { const decoded = new TextDecoder('utf-8', { fatal:true }).decode(bytes); if (!decoded.includes('\0')) text = decoded; } catch { /* read-only binary */ }
    }
    if (text !== null) entries.push({ path, kind:'text', text, size:bytes.byteLength, mode:item.mode, basePath:path, baseSha:item.sha, baseText:text, order });
    else entries.push({ path, kind:'binary', blob:new Blob([bytes], { type:'application/octet-stream' }), mime:'application/octet-stream', size:bytes.byteLength, mode:item.mode, basePath:path, baseSha:item.sha, order });
  }
  return { entries, headSha:reference.object.sha, treeSha:commit.tree.sha };
}

async function cloneFromGithub() {
  await runGithubAction('リポジトリをクローンしています…', async () => {
    if (!githubAccount && !(await refreshGithubSession())) throw new Error('先にGitHubへログインしてください。');
    const settings = githubSettings(); saveGithubSettings(settings);
    const snapshot = await fetchRepositorySnapshot(settings);
    const source = { type:'github', owner:settings.owner, repo:settings.repo, branch:settings.branch, headSha:snapshot.headSha, treeSha:snapshot.treeSha, lastSyncAt:new Date().toISOString(), pendingCommit:null };
    const project = createProject(uniqueProjectName(settings.repo), source);
    const entries = snapshot.entries.map(item => createEntry({ projectId:project.id, ...item }));
    project.activePath = entries.find(entry => entry.path.toLowerCase().endsWith('.py'))?.path || entries.find(entry => entry.kind === 'text')?.path || entries[0]?.path || '';
    projects.unshift(project); await saveProjectRecord(project); await saveEntries(entries); await switchProject(project.id);
    githubSetStatus(`${settings.owner}/${settings.repo} の ${entries.length}ファイルをクローンしました。`, 'success');
    addLog('system', `GitHubからクローンしました: ${settings.owner}/${settings.repo}@${settings.branch}`);
    await loadGithubHistory(linkedGithubSettings());
  });
}

async function pullFromGithub() {
  await runGithubAction('GitHubからプルしています…', async () => {
    await persistCurrentFile();
    if (githubPendingCommit) throw new Error('未プッシュのコミットがあります。先にプッシュするか破棄してください。');
    if (hasLocalChanges()) throw new Error('未コミットの変更があります。コミットするか変更を戻してからプルしてください。');
    const settings = linkedGithubSettings(); const snapshot = await fetchRepositorySnapshot(settings);
    const entries = snapshot.entries.map(item => createEntry({ projectId:currentProject.id, ...item }));
    currentProject.source = { ...currentProject.source, headSha:snapshot.headSha, treeSha:snapshot.treeSha, lastSyncAt:new Date().toISOString(), pendingCommit:null };
    currentProject.activePath = entries.some(entry => entry.path === currentProject.activePath) ? currentProject.activePath : entries.find(entry => entry.kind === 'text')?.path || entries[0]?.path || '';
    await replaceProjectEntries(currentProject.id, entries); await saveProjectRecord(currentProject);
    files = entries; currentFileId = null; selectedChanges.clear(); const next = entries.find(entry => entry.path === currentProject.activePath) || entries[0];
    if (next) await selectFile(next.id); else showEmptyProject();
    githubSetStatus(`${settings.branch} の最新版を取得しました（${snapshot.headSha.slice(0, 7)}）。`, 'success');
    await loadGithubHistory(settings);
  });
}

async function commitToGithub() {
  await runGithubAction('コミットを作成しています…', async () => {
    await persistCurrentFile();
    if (githubPendingCommit) throw new Error('未プッシュのコミットがあります。先にプッシュするか破棄してください。');
    const settings = linkedGithubSettings(); const changes = changedEntries();
    if (!changes.length) throw new Error('コミットする変更がありません。');
    const selected = changes.filter(entry => selectedChanges.has(entry.id));
    if (!selected.length) { openDiffDialog(); throw new Error('差分画面でコミットするファイルを選択してください。'); }
    const repo = githubRepoBase(settings); const branch = githubEncodedBranch(settings);
    const reference = await githubRequest(`${repo}/git/ref/heads/${branch}`);
    if (reference.object.sha !== currentProject.source.headSha) throw new Error('GitHub側が更新されています。ローカル変更を退避してからプルしてください。');
    const parent = await githubRequest(`${repo}/git/commits/${reference.object.sha}`);
    const treeItems = []; const snapshots = [];
    for (const entry of selected) {
      const status = entryStatus(entry); let sha = entry.baseSha;
      if (status === 'D') {
        treeItems.push({ path:entry.basePath, mode:entry.mode || '100644', type:entry.kind === 'submodule' ? 'commit' : 'blob', sha:null });
        snapshots.push({ id:entry.id, status, path:entry.path, basePath:entry.basePath, kind:entry.kind }); continue;
      }
      if (entry.kind === 'text' && (!entry.baseSha || entry.text !== entry.baseText)) {
        const blob = await githubRequest(`${repo}/git/blobs`, { method:'POST', body:JSON.stringify({ content:githubBase64Encode(entry.text), encoding:'base64' }) }); sha = blob.sha;
      } else if (entry.kind === 'image' && !entry.baseSha && entry.blob) {
        const blob = await githubRequest(`${repo}/git/blobs`, { method:'POST', body:JSON.stringify({ content:await blobToBase64(entry.blob), encoding:'base64' }) }); sha = blob.sha;
      }
      if (!sha) throw new Error(`${entry.path} の内容はこの画面からコミットできません。`);
      const gitType = entry.kind === 'submodule' ? 'commit' : 'blob';
      if (entry.basePath && entry.basePath !== entry.path) treeItems.push({ path:entry.basePath, mode:entry.mode || '100644', type:gitType, sha:null });
      treeItems.push({ path:entry.path, mode:entry.mode || '100644', type:gitType, sha });
      snapshots.push({ id:entry.id, status, path:entry.path, basePath:entry.basePath, kind:entry.kind, text:entry.kind === 'text' ? entry.text : undefined, sha, mode:entry.mode || '100644' });
    }
    const tree = await githubRequest(`${repo}/git/trees`, { method:'POST', body:JSON.stringify({ base_tree:parent.tree.sha, tree:treeItems }) });
    const commit = await githubRequest(`${repo}/git/commits`, { method:'POST', body:JSON.stringify({ message:settings.message, tree:tree.sha, parents:[reference.object.sha] }) });
    githubPendingCommit = { key:githubSettingsKey(settings), owner:settings.owner, repo:settings.repo, branch:settings.branch, message:settings.message, parentSha:reference.object.sha, commitSha:commit.sha, treeSha:tree.sha, snapshots, createdAt:new Date().toISOString() };
    currentProject.source.pendingCommit = githubPendingCommit; await saveProjectRecord(currentProject);
    githubSetStatus(`コミット ${commit.sha.slice(0, 7)} を作成しました。次にプッシュしてください。`, 'success');
  });
}

async function pushToGithub() {
  await runGithubAction('GitHubへプッシュしています…', async () => {
    if (!githubPendingCommit) throw new Error('先にコミットを作成してください。');
    const settings = linkedGithubSettings();
    if (githubPendingCommit.key !== githubSettingsKey(settings)) throw new Error('保留中のコミットは別のリポジトリまたはブランチ向けです。');
    const repo = githubRepoBase(settings); const branch = githubEncodedBranch(settings);
    const reference = await githubRequest(`${repo}/git/ref/heads/${branch}`);
    if (reference.object.sha !== githubPendingCommit.parentSha) throw new Error('GitHub側が更新されました。保留コミットを破棄してから同期し直してください。');
    await githubRequest(`${repo}/git/refs/heads/${branch}`, { method:'PATCH', body:JSON.stringify({ sha:githubPendingCommit.commitSha, force:false }) });
    const pushed = githubPendingCommit;
    for (const snapshot of pushed.snapshots) {
      const entry = files.find(item => item.id === snapshot.id); if (!entry) continue;
      if (snapshot.status === 'D') { files = files.filter(item => item.id !== entry.id); await removeEntry(entry.id); continue; }
      entry.basePath = snapshot.path; entry.baseSha = snapshot.sha; if (entry.kind === 'text') entry.baseText = snapshot.text; await saveEntry(entry);
    }
    currentProject.source = { ...currentProject.source, headSha:pushed.commitSha, treeSha:pushed.treeSha, lastSyncAt:new Date().toISOString(), pendingCommit:null };
    githubPendingCommit = null; await saveProjectRecord(currentProject); selectedChanges = new Set(changedEntries().map(entry => entry.id)); renderFileList();
    githubSetStatus(`プッシュしました: ${pushed.commitSha.slice(0, 7)} ${pushed.message}`, 'success'); await loadGithubHistory(settings);
  });
}

function discardGithubCommit() {
  if (!githubPendingCommit) return;
  const sha = githubPendingCommit.commitSha.slice(0, 7); githubPendingCommit = null; currentProject.source.pendingCommit = null;
  void saveProjectRecord(currentProject); renderGithubState(); githubSetStatus(`保留コミット ${sha} を破棄しました。ローカルの変更は残っています。`, 'success');
}

function destroyMergeView() { if (mergeView) { mergeView.destroy(); mergeView = null; } $('#diff-editor').replaceChildren(); }

function showDiffEntry(entry) {
  destroyMergeView(); $('#diff-file-name').textContent = entry.path; $('#diff-file-status').textContent = entryStatus(entry);
  const asset = $('#diff-asset'); asset.hidden = entry.kind === 'text';
  if (entry.kind !== 'text') {
    asset.replaceChildren(); const message = document.createElement('p');
    message.textContent = entry.kind === 'image' ? '画像はプレビューのみです。ファイル名や追加・削除を差分として記録します。' : 'バイナリ内容の差分プレビューには対応していません。'; asset.append(message);
    if (entry.kind === 'image' && entry.blob) { const image = document.createElement('img'); image.src = objectUrl(entry.blob); image.alt = entry.path; asset.append(image); }
    return;
  }
  const readonly = [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), entry.path.toLowerCase().endsWith('.py') ? python() : [], syntaxHighlighting(editorHighlight)];
  mergeView = new MergeView({ parent:$('#diff-editor'), a:{ doc:entry.baseText || '', extensions:readonly }, b:{ doc:entry.deleted ? '' : entry.text || '', extensions:readonly }, highlightChanges:true, gutter:true });
}

function renderDiffList() {
  const list = $('#diff-file-list'); const changes = changedEntries(); list.replaceChildren();
  changes.forEach((entry, index) => {
    const row = document.createElement('label'); const check = document.createElement('input'); const name = document.createElement('button'); const status = document.createElement('b');
    check.type = 'checkbox'; check.checked = selectedChanges.has(entry.id); check.addEventListener('change', () => check.checked ? selectedChanges.add(entry.id) : selectedChanges.delete(entry.id));
    name.type = 'button'; name.textContent = entry.path; name.addEventListener('click', () => showDiffEntry(entry)); status.textContent = entryStatus(entry); row.append(check, name, status); list.append(row);
    if (index === 0) showDiffEntry(entry);
  });
}

function openDiffDialog() {
  const changes = changedEntries(); if (!changes.length) return;
  if (![...selectedChanges].some(id => changes.some(entry => entry.id === id))) changes.forEach(entry => selectedChanges.add(entry.id));
  renderDiffList(); $('#diff-dialog').showModal();
}

async function loadGithubHistory(settings = currentProject?.source?.type === 'github' ? linkedGithubSettings() : null) {
  const container = $('#github-history'); container.replaceChildren(); if (!settings) { container.textContent = 'GitHubプロジェクトを選択すると履歴を表示します。'; return; }
  try {
    const query = new URLSearchParams({ sha:settings.branch, per_page:'30', page:'1' }); const commits = await githubRequest(`${githubRepoBase(settings)}/commits?${query}`);
    if (!commits.length) { container.textContent = 'コミット履歴はありません。'; return; }
    commits.forEach(commit => {
      const row = document.createElement('button'); row.type = 'button'; const title = document.createElement('strong'); const meta = document.createElement('small');
      title.textContent = commit.commit.message.split('\n')[0]; const date = new Date(commit.commit.author?.date || commit.commit.committer?.date).toLocaleString('ja-JP');
      meta.textContent = `${commit.sha.slice(0, 7)} ・ ${commit.author?.login || commit.commit.author?.name || 'unknown'} ・ ${date}`;
      row.append(title, meta); row.addEventListener('click', () => void openHistoricalVersion(settings, commit)); container.append(row);
    });
  } catch (error) { container.textContent = `履歴を取得できません: ${error.message}`; }
}

async function openHistoricalVersion(settings, summary) {
  const dialog = $('#version-dialog'); const treePanel = $('#version-tree'); const preview = $('#version-preview');
  $('#version-title').textContent = `${summary.sha.slice(0, 7)} — ${summary.commit.message.split('\n')[0]}`; treePanel.textContent = 'ファイル一覧を取得しています…'; preview.innerHTML = '<p>ファイルを選択してください。</p>'; dialog.showModal();
  try {
    const commit = await githubRequest(`${githubRepoBase(settings)}/git/commits/${summary.sha}`); const tree = await githubRequest(`${githubRepoBase(settings)}/git/trees/${commit.tree.sha}?recursive=1`);
    treePanel.replaceChildren(); (tree.tree || []).filter(item => item.type === 'blob').forEach(item => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = item.path; button.style.setProperty('--tree-depth', item.path.split('/').length - 1);
      button.addEventListener('click', async () => {
        preview.textContent = '読み込み中…';
        try {
          const blob = await githubRequest(`${githubRepoBase(settings)}/git/blobs/${item.sha}`); const bytes = base64ToBytes(blob.content); const mime = imageMime(item.path); preview.replaceChildren();
          if (mime) { const image = document.createElement('img'); image.src = objectUrl(new Blob([bytes], { type:mime })); image.alt = item.path; preview.append(image); }
          else { let text; try { text = new TextDecoder('utf-8', { fatal:true }).decode(bytes); } catch { text = 'このバイナリファイルは表示できません。'; } const pre = document.createElement('pre'); pre.textContent = text; preview.append(pre); }
        } catch (error) { preview.textContent = error.message; }
      }); treePanel.append(button);
    });
  } catch (error) { treePanel.textContent = error.message; }
}

function toggleEditorFullscreen() {
  const panel = document.querySelector('.code-panel'); const active = !panel.classList.contains('editor-fullscreen'); panel.classList.toggle('editor-fullscreen', active); document.body.classList.toggle('has-editor-fullscreen', active);
  $('#editor-fullscreen').textContent = active ? '元に戻す' : '全画面'; $('#editor-fullscreen').setAttribute('aria-pressed', String(active)); setTimeout(() => editorView?.requestMeasure(), 0);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme; localStorage.setItem('unitv-theme', theme);
  const light = theme === 'light'; $('#theme-toggle').textContent = light ? '☾' : '☀'; $('#theme-toggle').setAttribute('aria-label', light ? 'ダークモードに切り替え' : 'ライトモードに切り替え');
  document.querySelector('meta[name="theme-color"]').content = light ? '#f4f7f8' : '#071017';
}

applyTheme(initialTheme);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
$('#new-file').addEventListener('click', openNewFileDialog);
$('#new-folder').addEventListener('click', openNewFolderDialog);
$('#file-confirm').addEventListener('click', confirmFileDialog); $('#file-duplicate').addEventListener('click', duplicateFileDialog); $('#file-delete').addEventListener('click', deleteFileDialog);
$('#file-name-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirmFileDialog(); } });
$('#project-select').addEventListener('change', event => void switchProject(event.target.value));
$('#project-new').addEventListener('click', () => openProjectDialog('new')); $('#project-manage').addEventListener('click', () => openProjectDialog('edit'));
$('#project-confirm').addEventListener('click', confirmProjectDialog); $('#project-delete').addEventListener('click', deleteCurrentProject);
$('#project-name-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void confirmProjectDialog(); } });
$('#editor-fullscreen').addEventListener('click', toggleEditorFullscreen); $('#diff-open').addEventListener('click', openDiffDialog);
$('#diff-select-all').addEventListener('click', () => { const changes = changedEntries(); const allSelected = changes.every(entry => selectedChanges.has(entry.id)); changes.forEach(entry => allSelected ? selectedChanges.delete(entry.id) : selectedChanges.add(entry.id)); renderDiffList(); });
$('#diff-dialog').addEventListener('close', destroyMergeView);
$('#asset-to-frame').addEventListener('click', () => { const entry = activeEntry(); if (!entry?.blob) return; imageLoadPromise = loadImageFile(new File([entry.blob], entry.path, { type:entry.mime || entry.blob.type })).catch(error => finishWithError(error.message)).finally(() => { imageLoadPromise = null; }); });
$('#binary-download').addEventListener('click', () => { const entry = activeEntry(); if (entry?.kind === 'binary' && entry.blob) downloadBlob(entry.blob, entry.path.split('/').pop()); });
refs.imageFile.addEventListener('change', event => { imageLoadPromise=loadImageFile(event.target.files[0]).catch(error=>finishWithError(error.message)).finally(()=>{imageLoadPromise=null;}); });
$('#sample-image').addEventListener('click', () => { imageLoadPromise=loadSampleImage().finally(()=>{imageLoadPromise=null;}); });
$('#camera-toggle').addEventListener('click', toggleCamera);
refs.executionTarget.addEventListener('change', () => {
  executionTarget = refs.executionTarget.value === 'unitv' ? 'unitv' : 'simulator';
  localStorage.setItem('unitv-execution-target', executionTarget);
  if (executionTarget === 'unitv' && cameraStream) stopCamera();
  renderExecutionTarget();
  setRuntime(executionTarget === 'unitv' ? '実機モード' : 'ブラウザモード', executionTarget === 'unitv' ? 'USB接続したUnitVでPythonを実行します' : '画像を選択して疑似UnitV環境で実行します');
});
refs.unitvConnect.addEventListener('click', () => void connectUnitV());
refs.unitvFlash.addEventListener('click', openFlashDialog);
$('#flash-confirm').addEventListener('click', () => void flashActiveProgram());
$('#flash-reboot').addEventListener('change', () => { $('#flash-confirm').textContent = $('#flash-reboot').checked ? '上書きして再起動' : '上書きして書き込む'; });
serialTransport.onDisconnect = () => { if (!realConnectionBusy) void disconnectUnitV({ unexpected:true }); };
refs.run.addEventListener('click', runCode); refs.stop.addEventListener('click', () => void stopExecution());
$('#clear-log').addEventListener('click', () => { refs.terminal.innerHTML=''; addLog('system','ログを消去しました。'); });
$('#download-image').addEventListener('click', () => refs.canvas.toBlob(blob => blob && downloadBlob(blob,'unitv-output.png'),'image/png'));
$('#uart-queue').addEventListener('click', () => { try { uartQueued=parseUartInput(); addLog('system',`UART受信キューに ${uartQueued.length} byte を設定しました。`); } catch(error){finishWithError(error.message);} });
document.querySelectorAll('[data-gpio]').forEach(button => button.addEventListener('click', () => { const pin=button.dataset.gpio; gpioState[pin]=gpioState[pin]?0:1; updateGpioUi(pin,gpioState[pin]); }));

$('#api-open').addEventListener('click',()=>$('#api-dialog').showModal());
$('#threshold-open').addEventListener('click', openThresholdEditor);
document.querySelectorAll('[data-threshold-source]').forEach(button => button.addEventListener('click', () => selectThresholdSource(button.dataset.thresholdSource)));
const thresholdCanvas = $('#threshold-canvas');
thresholdCanvas.addEventListener('pointerdown', event => { thresholdDragStart = thresholdPoint(event); thresholdCanvas.setPointerCapture(event.pointerId); thresholdSelection = { x:thresholdDragStart.x,y:thresholdDragStart.y,width:1,height:1 }; drawThresholdPreview(); });
thresholdCanvas.addEventListener('pointermove', event => { if (!thresholdDragStart) return; const point=thresholdPoint(event); thresholdSelection={x:Math.min(point.x,thresholdDragStart.x),y:Math.min(point.y,thresholdDragStart.y),width:Math.abs(point.x-thresholdDragStart.x)+1,height:Math.abs(point.y-thresholdDragStart.y)+1}; drawThresholdPreview(); });
thresholdCanvas.addEventListener('pointerup', event => { if (!thresholdDragStart) return; thresholdCanvas.releasePointerCapture(event.pointerId); thresholdDragStart=null; calculateThresholdFromSelection(); });
document.querySelectorAll('[data-threshold-index]').forEach(input => {
  const activate = () => {
    document.querySelectorAll('.threshold-range').forEach(range => range.classList.remove('active'));
    input.classList.add('active');
  };
  input.addEventListener('pointerdown', activate); input.addEventListener('focus', activate);
  input.addEventListener('input', () => {
    const index=Number(input.dataset.thresholdIndex); const pairIndex=index % 2 === 0 ? index + 1 : index - 1;
    const next=Number(input.value); thresholdValues[index]=index % 2 === 0 ? Math.min(next,thresholdValues[pairIndex]) : Math.max(next,thresholdValues[pairIndex]);
    scheduleThresholdPreview();
  });
});
$('#threshold-copy').addEventListener('click', async () => { const value=`(${thresholdValues.join(', ')})`; try { await navigator.clipboard.writeText(value); $('#threshold-copy').textContent='コピーしました'; setTimeout(()=>$('#threshold-copy').textContent='コピー',1200); } catch { addLog('warning','クリップボードへコピーできませんでした。'); } });
$('#threshold-insert').addEventListener('click', insertThreshold);

$('#github-open').addEventListener('click',()=>{ renderGithubState(); renderGithubAccount(); setGithubControlsBusy(false); $('#github-dialog').showModal(); void refreshGithubSession({ quiet: true }).then(() => loadGithubHistory()); });
$('#github-login').addEventListener('click',startGithubLogin); $('#github-logout').addEventListener('click',logoutGithub); $('#github-refresh').addEventListener('click',()=>refreshGithubSession());
$('#github-device-open').addEventListener('click', () => { void navigator.clipboard?.writeText($('#github-device-code').textContent).catch(() => {}); });
$('#github-clone').addEventListener('click',cloneFromGithub); $('#github-pull').addEventListener('click',pullFromGithub); $('#github-commit').addEventListener('click',commitToGithub); $('#github-push').addEventListener('click',pushToGithub); $('#github-discard').addEventListener('click',discardGithubCommit);
try {
  const savedGithub=JSON.parse(localStorage.getItem('unitv-github-settings')||'{}');
  ['owner','repo','message'].forEach(key=>{ if(savedGithub[key]) $(`#github-${key}`).value=savedGithub[key]; });
} catch { /* Invalid old settings are ignored. */ }
['branch','message'].forEach(key => $(`#github-${key}`).addEventListener('input', () => { saveGithubSettings(githubSettings()); renderGithubState(); }));
$('#github-repository').addEventListener('change', async event => {
  const repository = githubRepositories.find(item => item.fullName === event.target.value);
  await applyGithubRepository(repository, true);
});
renderGithubAccount(); renderGithubState(); setGithubControlsBusy(false); renderExecutionTarget();
$('#project-save').addEventListener('click',()=>$('#save-dialog').showModal()); $('#confirm-save').addEventListener('click',saveProject);
$('#project-open').addEventListener('click',()=>$('#project-file').click()); $('#project-file').addEventListener('change',async event=>{try{await openProject(event.target.files[0]);}catch(error){finishWithError(`プロジェクトを開けません: ${error.message}`);}event.target.value='';});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if(event.target===dialog)dialog.close(); }));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.querySelector('.code-panel')?.classList.contains('editor-fullscreen')) toggleEditorFullscreen(); });
window.addEventListener('beforeunload',()=>{ worker?.terminate(); cameraStream?.getTracks().forEach(track=>track.stop()); if (serialTransport.connected) { void realUnitV.stop(); void realUnitV.setFrameBufferEnabled(false); } });

addLog('system', '画像を選択し、コードを確認して「実行」を押してください。');
await initializeEditor();
