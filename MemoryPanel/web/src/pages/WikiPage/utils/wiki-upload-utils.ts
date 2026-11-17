/**
 * 读取文件为 base64（不含 data URL 前缀）。
 *
 * **所有格式统一走 base64**：HTTP+JSON 只能传字符串，而 UTF-8 解码对二进制
 * 是有损不可逆的（非法字节被替换为 U+FFFD），故不再按扩展名分流编码。
 * base64 是任意字节的可逆编码，服务端解码后按原始字节落盘。
 * 分块拼接以避免大文件在 `String.fromCharCode(...arr)` 上爆栈。
 */
export async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * 读取上传文件内容。**所有格式统一走 base64**（不再按扩展名分流编码）。
 *
 * 服务端按 `encoding` 解码后以原始字节落盘，文本文件经 base64 往返同样无损。
 */
export async function readUploadFile(
  file: File,
): Promise<{ filename: string; content: string; encoding: 'base64' }> {
  return { filename: file.name, content: await readAsBase64(file), encoding: 'base64' };
}

/** Keep each request within the Panel raw/write limits; the Wiki ingester still sees all saved files together. */
export function batchUploadFiles(files: readonly File[]): File[][] {
  // Keep these in sync with MAX_FILES_PER_REQUEST / MAX_TOTAL_SIZE in wiki-routes.ts.
  const maxFiles = 10;
  const maxBytes = 20 * 1024 * 1024;
  const batches: File[][] = [];
  let batch: File[] = [];
  let bytes = 0;
  for (const file of files) {
    if (file.size > maxBytes) throw new Error(`File exceeds the per-request upload limit: ${file.name}`);
    if (batch.length >= maxFiles || bytes + file.size > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function findExistingRawFilenames(
  filenames: readonly string[],
  existingFilenames: readonly string[],
): string[] {
  const existing = new Set(existingFilenames);
  return [...new Set(filenames.filter((filename) => existing.has(filename)))];
}

export function formatOverwriteFilenames(filenames: readonly string[]): string {
  return filenames.map((filename) => `「${filename}」`).join('、 ');
}
