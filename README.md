# UnitV Browser Lab

画像を仮想カメラとして、UnitV/MaixPy向けコードをブラウザ内で試す学習用シミュレーターです。画像、コード、UARTデータはサーバーへ送信されません。

## 使い方

1. 「画像を選ぶ」「サンプル画像」「カメラを開始」のいずれかで入力を用意します。
2. `main.py` にUnitV向けコードを貼り付けます。コードはこの端末のIndexedDBへ自動保存されます。
3. 必要ならUART受信データとGPIO1/GPIO2の入力状態を設定します。
4. 「実行」を押すと、処理画像とシリアル出力が表示されます。

静止画像モードでは、トップレベルの `while(True):` / `while True:` を1フレームだけ実行します。カメラモードでは実機と同様にループを継続し、`sensor.snapshot()` を呼ぶたびに新しいカメラフレームを撮影して処理します。カメラモードの実行は「停止」ボタンで終了します。

## 主な対応範囲

- `sensor`: 初期化、反転、フレームサイズ、ウィンドウ、レジスタ読書き、ゲイン・露出・ホワイトバランス設定、明度・彩度・コントラスト、snapshot
- `image`: 色しきい値、find_blobs、二値化、リサイズ、切り抜き、矩形・線・円・十字・文字描画
- 仮想UART: any、read、readline、readchar、write
- `fm` / `GPIO`: ピン登録、GPIO入力・出力
- `ws2812`: LED色設定と表示
- Python構文色分け、インデントガイド、リアルタイム書式エラー表示
- 複数の `.py` ファイルを端末内に永続保存し、ファイル間の `import` に利用可能
- 端末カメラのライブプレビューと、`sensor.snapshot()` ごとの連続撮影・画像処理（HTTPSまたはlocalhostが必要）
- フレームバッファの現在画像と保存した元画像を切り替え、選択領域からLAB閾値を算出。L・a・bの2点ゲージで微調整してMaixPy形式でコピーまたはコードへ挿入
- GitHub Appでログインし、許可したリポジトリを選んでプル、コミット、プッシュ、最近のコミットを確認
- ライト／ダーク表示。選択は端末内に保存

組み込みサンプル画像は `r5.png` です。カメラ映像とPythonコードはUnitV Browser Labのサーバーには保存されません。GitHubの認証情報は公開版のWorkerが暗号化したHttpOnly Cookieで保持し、ブラウザのJavaScriptやlocalStorageには公開しません。GitHub連携を実行した場合だけGitHub APIと通信します。プルで上書きされるローカル変更は、自動的に別のPythonファイルへバックアップされます。コミットとプッシュは分離され、プッシュ前にGitHub側が更新されていた場合は強制上書きせず停止します。

GitHub連携には `unitv-browser-lab` GitHub Appを使用します。Device Flowを有効にし、Repository permissions の Contents を Read and write、Metadata を Read-onlyに設定してください。サーバー側では `SESSION_SECRET` を秘密の環境変数として設定します。オフライン配布版は画像処理とプロジェクト保存に対応しますが、GitHubログインには公開版のWorkerが必要です。

KPUおよび `.kmodel` の推論は対応していません。

## ローカル利用

配布ZIPを展開し、同梱の `start-local.bat` を実行します。Pythonが利用できない場合は、フォルダーを任意の静的Webサーバーで公開してください。ブラウザの制約上、`index.html` を直接ダブルクリックする方式では動作しません。
