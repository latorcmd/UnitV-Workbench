import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await copyFile(
  resolve(process.cwd(), 'worker/github-worker.js'),
  resolve(process.cwd(), 'dist/_worker.js')
);
