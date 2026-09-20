import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir(resolve(process.cwd(), 'dist/server'), { recursive: true });
await mkdir(resolve(process.cwd(), 'dist/.openai'), { recursive: true });
await copyFile(
  resolve(process.cwd(), 'worker/github-worker.js'),
  resolve(process.cwd(), 'dist/server/index.js')
);
await copyFile(
  resolve(process.cwd(), '.openai/hosting.json'),
  resolve(process.cwd(), 'dist/.openai/hosting.json')
);
