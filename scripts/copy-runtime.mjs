import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const pyodideDir = resolve(root, 'public/pyodide');
await mkdir(pyodideDir, { recursive: true });

for (const file of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await cp(resolve(root, 'node_modules/pyodide', file), resolve(pyodideDir, file));
}
