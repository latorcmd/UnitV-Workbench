import { rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const outputDirectory = resolve(projectRoot, 'dist');
const relativeTarget = relative(projectRoot, outputDirectory);

if (relativeTarget !== 'dist') {
  throw new Error(`Unexpected build output path: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
