import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const root = process.cwd();
const clientDirectory = resolve(root, 'dist/client');
const packageName = 'unitv-workbench-offline.zip';
const files = {};

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else {
      const name = relative(clientDirectory, absolute).replaceAll('\\', '/');
      if (name !== packageName) files[name] = new Uint8Array(await readFile(absolute));
    }
  }
}

await collect(clientDirectory);
files['README.md'] = new Uint8Array(await readFile(resolve(root, 'README.md')));
files['LICENSE'] = new Uint8Array(await readFile(resolve(root, 'LICENSE')));
files['THIRD_PARTY_NOTICES.md'] = new Uint8Array(await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md')));
files['start-local.bat'] = strToU8(`@echo off\r
cd /d "%~dp0"\r
where py >nul 2>nul\r
if %errorlevel%==0 (\r
  start "" "http://localhost:8000/"\r
  py -m http.server 8000\r
  exit /b\r
)\r
where python >nul 2>nul\r
if %errorlevel%==0 (\r
  start "" "http://localhost:8000/"\r
  python -m http.server 8000\r
  exit /b\r
)\r
echo Python 3 could not be found.\r
echo Please install Python 3, then run this file again.\r
pause\r
`);

const archive = zipSync(files, { level:6 });
await mkdir(resolve(root, 'outputs'), { recursive:true });
await writeFile(resolve(root, 'outputs', packageName), archive);
await writeFile(resolve(clientDirectory, packageName), archive);
