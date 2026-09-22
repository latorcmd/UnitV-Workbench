# UnitV Browser Lab

Current version: **0.4.0**

UnitV / MaixPy向けコードを、画像または端末カメラを入力としてブラウザ内で試す学習用シミュレーターです。画像・コード・UARTデータ・ローカルプロジェクトはサーバーへ保存しません。

## 主な機能

- `sensor` / `image` / UART / GPIO / WS2812の主要APIを疑似実行
- 静止画像とライブカメラに対応。ライブ時はトップレベルの`while(True)` / `while(1)`を維持し、ループごとに新しいフレームを取得
- K210用8 bit `kmodel v3`をWebAssemblyで直接実行し、MaixPyの`kpu.load` / `init_yolo2` / `run_yolo2`へ接続（ONNX不要）
- Python構文色分け、インデントガイド、構文・実行エラーの位置表示、入力補完、検索・置換、undo/redo、独立スクロール、全画面編集
- IndexedDBに複数プロジェクト、フォルダ、複数ファイルを永続保存。`Ctrl+S`ではRuffでPythonを整形して保存し、`Ctrl+Shift+S`で全ファイルを保存
- FILESでファイル／フォルダの作成・移動・コピー・ダウンロード、ドラッグ＆ドロップ、クリップボードのファイル貼り付け、独自右クリックメニューに対応
- Python以外のUTF-8テキストも編集可能。Pythonだけ構文チェックと実行の対象
- 画像ファイルはプレビュー専用で、必要に応じてフレームバッファへ適用
- JPGや`.kmodel`を含むバイナリをGitHubから保持し、読み取り専用でダウンロード・プロジェクト書き出し
- フレームバッファまたは保存画像を使うLAB閾値エディタ
- GitHub Appログイン、リポジトリ全体のクローン、ブランチ固定、行番号横とインラインの差分表示、差分選択、コミット、プッシュ、プル、履歴の読み取り専用表示
- Web Serialで実機UnitVへ接続し、選択中のPythonを一時実行。標準出力と実機フレームバッファをライブ表示
- 選択中のPythonをSHA-256で検証しながら実機の`/flash/main.py`へ書き込み、任意で再起動・自動実行
- ライト／ダークテーマ、プロジェクトファイルの書き出し・読み込み、オフライン配布版

## 使い方

1. 画像を選ぶか、サンプル画像またはカメラを開始します。
2. プロジェクトを作成し、ファイルツリーから編集するファイルを選びます。
3. 編集内容は`Ctrl+S`で保存します。Pythonは行長88・スペース4個で自動整形されます。`Ctrl+F`で現在のファイルを検索・置換できます。
4. Pythonファイルを選択して「実行」を押すと、処理画像とシリアル出力が表示されます。
5. GitHubを使う場合は、GitHub Appでログインしてリポジトリとブランチを選び、「新規プロジェクトへクローン」を押します。
6. 変更を保存後、「差分」で対象ファイルを選び、「コミット」→「プッシュ」の順に反映します。

KPUを使う場合は`.kmodel`をFILESへ追加し、UnitVコードと同じ名前で`kpu.load('/sd/m.kmodel')`のように指定します。`/sd/`は仮想パスとして扱うため、プロジェクト内の`m.kmodel`へ自動解決されます。設定JSONやONNXは不要で、アンカー・閾値・NMS値は実機と同じ`kpu.init_yolo2()`から取得します。

実機で試す場合はChromeまたはEdgeのHTTPS/localhost環境で「実行先」を「実機 UnitV」に切り替え、「実機接続」を押します。実行時だけ選択中のPythonを送信し、補助ファイルやkmodelはUnitVへ書き込みません。通常の切断操作ではスクリプト停止、フレームバッファ無効化、リセットを行います。Windows版ChromeでCOMポートを閉じ直す際の失敗を避けるため、REPLからIDEモードへの切替後も115200 baudを維持します。許可済みポートが1台だけなら再接続時に自動で再利用します。

本体へ残す場合は、実機接続後に「実機へ書込」を押します。確認画面で実行すると既存の`/flash/main.py`を上書きします。書き込み後の再起動を有効にすると、USB接続を安全に終了して保存したプログラムを起動します。書き込み対象は選択中のPythonだけです。

プルは未コミット変更または未プッシュコミットがある場合に停止します。GitHub側のブランチが先に更新された場合も強制上書きせず停止します。

## 対応範囲

- `sensor`: 初期化、反転、フレームサイズ、ウィンドウ、レジスタ読み書き、ゲイン／露出／ホワイトバランス、明度／彩度／コントラスト、`snapshot`
- `image`: LAB閾値、`find_blobs`、二値化、リサイズ、切り抜き、矩形／線／円／十字／文字描画
- UART: `any`、`read`、`readline`、`readchar`、`write`
- `fm` / `GPIO`: ピン登録、GPIO入出力
- `ws2812`: LED色設定と表示
- `KPU`: `load`、`init_yolo2`、`run_yolo2`、`forward`、`softmax`、`deinit`

ブラウザ内KPUは、K210向け・8 bit重みの`kmodel v3`のうちK210畳み込みレイヤーとDequantizeで構成されたモデルに対応します。YOLOのクラス数はモデル出力とアンカー数から算出します。非対応レイヤー、v4、暗号化モデル、16 bit重みは実行前に理由を表示して停止します。推論はブラウザ内で完結し、モデルをサーバーへ送信しません。

## 制限

- リポジトリのファイル数にはアプリ独自の2,000件上限を設けていません。GitHubの一括一覧が省略される大規模リポジトリはフォルダ単位で継続取得します
- リポジトリの合計サイズにはアプリ独自の50 MB上限を設けていません。ZIPをストリーム展開し、ブラウザが報告する保存可能容量を基準に判定します
- 編集可能なテキストは1ファイル1 MBまで
- 画像は1ファイル15 MBまで
- kmodel推論はCPU上のWebAssemblyでK210命令を再現するため、実機KPUより低速です。静止画像のkmodel実行だけは上限を60秒に拡張します
- GitHub連携には公開版のWorkerが必要です。オフライン配布版ではローカル編集・画像処理・プロジェクト保存を利用できます。
- 英語の実行エラーは、対応するデスクトップ版Chromeでのみ内蔵Language Detector／Translatorによる端末内翻訳を選択できます。その他の環境でも基本の日本語説明は表示します。
- Web Serial実機接続はデスクトップ版Chrome/Edgeで利用できます。実機側のMaixPyファームウェアやUSB変換回路によってはIDEモード切替を確認する必要があります。

## ローカル利用

配布ZIPを展開し、`start-local.bat`を実行します。Python 3が利用できない場合は、展開先を任意の静的Webサーバーで公開してください。ブラウザの制約により`index.html`の直接ダブルクリックではPython実行機能を利用できません。

KPUランタイムをソースから再生成する場合はClangを導入し、PowerShellで`npm run build:kpu`を実行します。通常の`npm run build`ではリポジトリに含まれる生成済みWASMをそのまま配布物へ収録します。

## GitHub App設定

GitHub App `unitv-browser-lab`を使用します。Device Flowを有効にし、Repository permissionsでContentsをRead and write、MetadataをRead-onlyに設定します。公開Workerには32文字以上の`SESSION_SECRET`を秘密の環境変数として設定します。アクセストークンは暗号化したHttpOnly Cookie内に保持され、ブラウザのJavaScriptやlocalStorageへ公開しません。

## GitHubへパブリック公開する

このリポジトリには実行時の秘密情報を含めません。GitHub AppのClient IDは公開情報です。`SESSION_SECRET`、GitHubアクセストークン、秘密鍵はコミットせず、公開先のSecret／環境変数にだけ設定してください。`.codex-remote-attachments/`、ビルド成果物、依存パッケージ、ローカルキャッシュは`.gitignore`で除外しています。

1. GitHubの「New repository」で空のリポジトリを作り、Visibilityを`Public`にします。既存履歴と衝突しないよう、README・LICENSE・`.gitignore`の自動作成は選択しません。
2. PowerShellでこのプロジェクトのルートへ移動し、次を実行します。`YOUR_NAME`と`REPOSITORY`は作成したリポジトリに置き換えてください。

   ```powershell
   git status
   git remote add origin https://github.com/YOUR_NAME/REPOSITORY.git
   git branch -M main
   git push -u origin main
   ```

3. `origin`が既に存在する場合は、`git remote add`の代わりに次を実行します。このプロジェクトのSites用remoteは`sites`という別名なので、そのまま残せます。

   ```powershell
   git remote set-url origin https://github.com/YOUR_NAME/REPOSITORY.git
   ```

4. GitHubのリポジトリ画面で、`LICENSE`、`THIRD_PARTY_NOTICES.md`、README、ソースコードだけが公開され、`.codex-remote-attachments`や秘密情報が含まれていないことを確認します。

GitHub Pagesは静的なシミュレーター部分だけなら利用できますが、現在のビルドはサイト直下での配信を前提にしています。また、GitHubログイン／プッシュ機能には`worker/github-worker.js`を動かすHTTPSバックエンドと`SESSION_SECRET`が必要なため、GitHub PagesだけではGitHub連携は動作しません。

## ライセンス

UnitV Browser Labの自作部分は[MIT License](LICENSE)で公開します。利用しているOSSとそのライセンスは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)にまとめています。アプリ画面右上の「ライセンス」からも主要な同梱OSSを確認できます。
