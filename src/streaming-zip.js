import { Unzip, UnzipInflate } from 'fflate';

/**
 * Streams a ZIP response into individual files. Only one decompressed file is
 * accumulated at a time, so the compressed repository is never buffered as a
 * second full in-memory copy.
 */
export async function streamZipResponse(response, { onFile, onProgress = () => {} } = {}) {
  if (!response?.ok) throw new Error(`ZIPを取得できませんでした（HTTP ${response?.status || 0}）。`);
  if (typeof onFile !== 'function') throw new TypeError('onFile is required');

  const totalDownloadBytes = Number(response.headers?.get?.('Content-Length')) || null;
  let downloadedBytes = 0;
  let extractedBytes = 0;
  let extractedFiles = 0;
  let extractionError = null;
  let lastExtractionProgressAt = 0;

  const unzip = new Unzip(file => {
    if (file.name.endsWith('/')) return;
    const chunks = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (extractionError) return;
      if (error) { extractionError = error; return; }
      if (chunk?.byteLength) { chunks.push(chunk); size += chunk.byteLength; }
      if (!final) return;
      try {
        onFile({ name:file.name, chunks, size, originalSize:file.originalSize });
        extractedBytes += size;
        extractedFiles += 1;
        const now = Date.now();
        if (extractedFiles === 1 || extractedFiles % 100 === 0 || now - lastExtractionProgressAt >= 150) {
          lastExtractionProgressAt = now;
          onProgress({ phase:'extract', downloadedBytes, totalDownloadBytes, extractedBytes, extractedFiles });
        }
      } catch (error) { extractionError = error; }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const pushChunk = (chunk, final) => {
    try { unzip.push(chunk, final); }
    catch (error) { extractionError = error; }
    if (extractionError) throw extractionError;
  };

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    downloadedBytes = bytes.byteLength;
    onProgress({ phase:'download', downloadedBytes, totalDownloadBytes:totalDownloadBytes || downloadedBytes, extractedBytes, extractedFiles });
    pushChunk(bytes, true);
    return { downloadedBytes, totalDownloadBytes:totalDownloadBytes || downloadedBytes, extractedBytes, extractedFiles };
  }

  const reader = response.body.getReader();
  let lastProgressAt = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { pushChunk(new Uint8Array(0), true); break; }
      downloadedBytes += value.byteLength;
      pushChunk(value, false);
      const now = Date.now();
      if (now - lastProgressAt >= 150) {
        lastProgressAt = now;
        onProgress({ phase:'download', downloadedBytes, totalDownloadBytes, extractedBytes, extractedFiles });
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  onProgress({ phase:'download', downloadedBytes, totalDownloadBytes:totalDownloadBytes || downloadedBytes, extractedBytes, extractedFiles });
  return { downloadedBytes, totalDownloadBytes:totalDownloadBytes || downloadedBytes, extractedBytes, extractedFiles };
}
