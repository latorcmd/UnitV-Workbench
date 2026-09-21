import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';

/** Create a ZIP without constructing a second uncompressed copy of the folder. */
export async function createEntriesZip(entries, rootPath = '') {
  const chunks = [];
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const archive = new Zip((error, chunk, final) => {
    if (error) { rejectDone(error); return; }
    if (chunk?.length) chunks.push(chunk);
    if (final) resolveDone(new Blob(chunks, { type:'application/zip' }));
  });
  const prefix = rootPath ? `${rootPath}/` : '';
  try {
    for (const entry of entries) {
      const name = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
      if (!name) continue;
      if (entry.kind === 'folder') {
        const stream = new ZipPassThrough(`${name}/`); archive.add(stream); stream.push(new Uint8Array(), true); continue;
      }
      const stream = entry.kind === 'text' ? new ZipDeflate(name, { level:6 }) : new ZipPassThrough(name);
      archive.add(stream);
      const bytes = entry.kind === 'text' ? strToU8(entry.text || '') : new Uint8Array(await entry.blob.arrayBuffer());
      stream.push(bytes, true);
    }
    archive.end();
  } catch (error) {
    archive.terminate(); rejectDone(error);
  }
  return done;
}
