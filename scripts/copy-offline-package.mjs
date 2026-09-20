import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await copyFile(
  resolve(process.cwd(), 'outputs/unitv-browser-lab-offline.zip'),
  resolve(process.cwd(), 'dist/client/unitv-browser-lab-offline.zip')
);
