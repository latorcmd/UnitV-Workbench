import { parseFormatterError } from './python-runtime-errors.js';
import ruffWasmUrl from '@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url';

let workspacePromise = null;

async function loadWorkspace() {
  if (!workspacePromise) {
    workspacePromise = import('@astral-sh/ruff-wasm-web').then(async module => {
      await module.default({ module_or_path:ruffWasmUrl });
      return new module.Workspace({
        'line-length':88,
        'indent-width':4,
        format:{ 'indent-style':'space', 'quote-style':'double' }
      }, module.PositionEncoding.UTF16);
    }).catch(error => {
      workspacePromise = null;
      throw error;
    });
  }
  return workspacePromise;
}

export async function formatPythonCode(code, filename = '') {
  try {
    const workspace = await loadWorkspace();
    return workspace.format(String(code));
  } catch (error) {
    const wrapped = new Error(`Pythonコードを整形できません: ${error?.message || error}`);
    wrapped.cause = error;
    wrapped.pythonError = parseFormatterError(error, code, filename);
    throw wrapped;
  }
}
