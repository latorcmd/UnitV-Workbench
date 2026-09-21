const ERROR_EXPLANATIONS = {
  SyntaxError: ['構文エラー', 'Pythonとして解釈できない書き方があります。括弧、コロン、カンマ、演算子の前後を確認してください。'],
  IndentationError: ['インデントエラー', '行頭の空白の深さが正しくありません。周囲のブロックと同じ4スペース単位にそろえてください。'],
  TabError: ['タブとスペースの混在', 'インデントにタブとスペースが混ざっています。スペース4個へ統一してください。'],
  NameError: ['未定義の名前', '変数や関数が定義される前に使われています。綴りと定義位置を確認してください。'],
  TypeError: ['型の不一致', '値の種類または関数へ渡した引数が、その処理で期待される形式と一致していません。'],
  AttributeError: ['属性が見つかりません', 'そのオブジェクトには指定されたメソッドまたは属性がありません。API名と戻り値を確認してください。'],
  ModuleNotFoundError: ['モジュールが見つかりません', 'import先のファイルまたは対応モジュールが見つかりません。ファイル名と配置を確認してください。'],
  ImportError: ['インポートエラー', 'モジュールから指定された名前を読み込めません。モジュール名と公開されている名前を確認してください。'],
  ValueError: ['値が不正です', '値の型は正しいものの、関数が受け付けない内容または範囲です。'],
  IndexError: ['リスト範囲外です', 'リストや配列に存在しない番号の要素を参照しています。要素数と添字を確認してください。'],
  KeyError: ['キーが見つかりません', '辞書に存在しないキーを参照しています。キーの綴りと存在確認をしてください。'],
  ZeroDivisionError: ['0で除算しています', '割る数が0になっています。除算前に0でないことを確認してください。'],
  MemoryError: ['メモリ不足です', '処理する画像またはデータが大きすぎます。画像サイズや保持する配列を小さくしてください。'],
  RuntimeError: ['実行時エラー', '実行中に処理を継続できない問題が発生しました。原文と直前の処理を確認してください。'],
  FormatterError: ['整形機能のエラー', 'Python整形機能を開始できませんでした。再読み込みするか、整形せず保存してください。'],
  TimeoutError: ['実行時間を超えました', '処理が制限時間内に完了しませんでした。ループ条件または処理量を確認してください。']
};

export function normalizePythonPath(value = '') {
  const path = String(value).replace(/\\/g, '/');
  const workspace = path.match(/\/unitv-project-[^/]+\/(.+)$/);
  return workspace ? workspace[1] : path.replace(/^\.\//, '');
}

function tracebackLines(message, stack) {
  const primary = String(message || '');
  const secondary = String(stack || '');
  if (primary.includes('Traceback') || /File "[^"]+", line \d+/.test(primary)) return primary.split(/\r?\n/);
  return secondary.split(/\r?\n/);
}

function markerRange(lines, frameIndex) {
  const codeLine = lines[frameIndex + 1] || '';
  const markerLine = lines[frameIndex + 2] || '';
  if (!/[\^~]/.test(markerLine)) return {};
  const traceIndent = codeLine.startsWith('    ') && markerLine.startsWith('    ') ? 4 : 0;
  const marker = markerLine.slice(traceIndent);
  const start = marker.search(/[\^~]/);
  if (start < 0) return {};
  let end = start;
  while (end < marker.length && /[\^~]/.test(marker[end])) end += 1;
  return { column:start + 1, endColumn:Math.max(start + 2, end + 1) };
}

export function parsePythonRuntimeError(message, stack = '') {
  const lines = tracebackLines(message, stack);
  const frames = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*File "([^"]+)", line (\d+)(?:, in (.+))?/);
    if (match) frames.push({ filename:normalizePythonPath(match[1]), line:Number(match[2]), functionName:match[3] || '', index });
  });
  const projectFrames = frames.filter(frame => frame.filename && !frame.filename.startsWith('<'));
  const frame = projectFrames.at(-1) || frames.at(-1) || null;
  const exceptionLine = [...lines].reverse().find(line => /^\s*[A-Za-z_][\w.]*?(?:Error|Exception|Interrupt)(?::|$)/.test(line))
    || String(message || '').split(/\r?\n/).at(-1) || 'PythonError';
  const exception = exceptionLine.trim().match(/^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt))(?::\s*(.*))?$/);
  const type = exception?.[1] || 'PythonError';
  const reason = exception?.[2] || exceptionLine.trim().replace(/^PythonError:\s*/, '') || '不明なPythonエラー';
  return {
    type,
    reason,
    filename:frame?.filename || '',
    line:frame?.line || null,
    endLine:frame?.line || null,
    ...(frame ? markerRange(lines, frame.index) : {}),
    rawMessage:String(message || ''),
    stack:String(stack || '')
  };
}

export function explainPythonError(error) {
  const [title, description] = ERROR_EXPLANATIONS[error?.type] || ['Python実行エラー', '処理中にエラーが発生しました。原文と強調されたコードを確認してください。'];
  return { title, description };
}

export function byteOffsetToLocation(text, byteOffset) {
  const target = Math.max(0, Number(byteOffset) || 0);
  let bytes = 0;
  let jsOffset = 0;
  for (const char of String(text)) {
    const next = new TextEncoder().encode(char).length;
    if (bytes + next > target) break;
    bytes += next;
    jsOffset += char.length;
  }
  const before = String(text).slice(0, jsOffset);
  const pieces = before.split('\n');
  return { offset:jsOffset, line:pieces.length, column:(pieces.at(-1)?.length || 0) + 1 };
}

export function parseFormatterError(error, code, filename = '') {
  const message = String(error?.message || error);
  const range = message.match(/byte range (\d+)\.\.(\d+)/);
  if (!range) return { type:'FormatterError', reason:message, filename, line:null, column:null, endLine:null, endColumn:null, rawMessage:message, stack:String(error?.stack || '') };
  const start = byteOffsetToLocation(code, range ? Number(range[1]) : 0);
  const end = byteOffsetToLocation(code, range ? Number(range[2]) : Number(range?.[1] || 0) + 1);
  return {
    type:'SyntaxError', reason:message, filename, line:start.line, column:start.column,
    endLine:end.line, endColumn:Math.max(start.column + 1, end.column), rawMessage:message, stack:String(error?.stack || '')
  };
}

function replaceWithColumnMappings(code, expression, replacementFactory) {
  const lines = String(code).split('\n');
  const mappings = [];
  const output = lines.map((line, lineIndex) => {
    let delta = 0;
    const replaced = line.replace(expression, (...args) => {
      const match = args[0];
      const originalStart = args.at(-2);
      const replacement = replacementFactory(match, ...args.slice(1, -2));
      const preparedStart = originalStart + delta;
      mappings.push({ line:lineIndex + 1, originalStart, originalLength:match.length, preparedStart, preparedLength:replacement.length });
      delta += replacement.length - match.length;
      return replacement;
    });
    return replaced;
  });
  return { code:output.join('\n'), mappings };
}

export function prepareUnitVCode(code, cameraMode = false) {
  if (cameraMode) {
    const transformed = replaceWithColumnMappings(code, /\bsensor\s*\.\s*snapshot\s*\(\s*\)/g, () => 'await sensor.snapshot_async()');
    return { prepared:transformed.code, mappings:transformed.mappings, limited:false };
  }
  const transformed = replaceWithColumnMappings(code, /^while\s*\(?\s*True\s*\)?\s*:/g, () => 'for __unitv_browser_frame in range(1):');
  return { prepared:transformed.code, mappings:transformed.mappings, limited:transformed.mappings.length > 0 };
}

export function mapPreparedError(error, mappings = []) {
  if (!error?.line || !error?.column) return error;
  const relevant = mappings.filter(item => item.line === error.line).sort((a, b) => a.preparedStart - b.preparedStart);
  const mapColumn = oneBased => {
    if (!oneBased) return oneBased;
    const column = oneBased - 1;
    let delta = 0;
    for (const item of relevant) {
      if (column < item.preparedStart) break;
      if (column <= item.preparedStart + item.preparedLength) {
        return item.originalStart + Math.min(Math.max(0, column - item.preparedStart), item.originalLength) + 1;
      }
      delta += item.preparedLength - item.originalLength;
    }
    return Math.max(1, column - delta + 1);
  };
  return { ...error, column:mapColumn(error.column), endColumn:mapColumn(error.endColumn || error.column + 1) };
}
