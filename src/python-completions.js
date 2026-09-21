const KEYWORDS = [
  'and','as','assert','async','await','break','class','continue','def','del','elif','else','except','False',
  'finally','for','from','global','if','import','in','is','lambda','None','nonlocal','not','or','pass','raise',
  'return','True','try','while','with','yield'
];

const BUILTINS = [
  'abs','all','any','bool','bytes','dict','enumerate','filter','float','int','len','list','map','max','min',
  'open','print','range','repr','reversed','round','set','sorted','str','sum','tuple','type','zip'
];

const UNITV_APIS = [
  'sensor','sensor.reset','sensor.snapshot','sensor.set_pixformat','sensor.set_framesize','sensor.set_windowing',
  'sensor.set_hmirror','sensor.set_vflip','sensor.skip_frames','sensor.set_auto_gain','sensor.set_auto_exposure',
  'sensor.set_auto_whitebal','sensor.set_brightness','sensor.set_saturation','sensor.set_contrast',
  'image','time','time.sleep','UART','GPIO','ws2812','fm','board_info',
  'img.find_blobs','img.draw_rectangle','img.draw_line','img.draw_circle','img.draw_cross','img.draw_string',
  'blob.x','blob.y','blob.w','blob.h','blob.cx','blob.cy','blob.rect'
];

function add(result, label, type, detail = '') {
  if (!label || result.has(label)) return;
  result.set(label, { label, type, detail });
}

/** Return keywords, UnitV APIs, and symbols declared in the current file. */
export function collectPythonCompletions(code) {
  const result = new Map();
  KEYWORDS.forEach(label => add(result, label, 'keyword', 'Pythonキーワード'));
  BUILTINS.forEach(label => add(result, label, 'function', 'Python組み込み'));
  UNITV_APIS.forEach(label => add(result, label, label.includes('.') ? 'property' : 'variable', 'UnitV互換API'));

  const text = String(code || '');
  for (const match of text.matchAll(/^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)/gm)) {
    add(result, match[1], 'function', 'このファイルの関数');
    match[2].split(',').map(value => value.trim().split(/[:=]/)[0].trim()).forEach(label => add(result, label, 'variable', '関数の引数'));
  }
  for (const match of text.matchAll(/^\s*class\s+([A-Za-z_]\w*)/gm)) add(result, match[1], 'class', 'このファイルのクラス');
  for (const match of text.matchAll(/^\s*([A-Za-z_]\w*)\s*=(?!=)/gm)) add(result, match[1], 'variable', 'このファイルの変数');
  for (const match of text.matchAll(/^\s*for\s+([A-Za-z_]\w*)\s+in\b/gm)) add(result, match[1], 'variable', 'ループ変数');
  for (const match of text.matchAll(/^\s*import\s+([^\n#]+)/gm)) {
    match[1].split(',').forEach(part => {
      const names = part.trim().match(/^([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?/);
      add(result, names?.[2] || names?.[1]?.split('.')[0], 'namespace', 'importした名前');
    });
  }
  for (const match of text.matchAll(/^\s*from\s+[\w.]+\s+import\s+([^\n#]+)/gm)) {
    match[1].split(',').forEach(part => {
      const names = part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/);
      add(result, names?.[2] || names?.[1], 'namespace', 'importした名前');
    });
  }
  return [...result.values()];
}
