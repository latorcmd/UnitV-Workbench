const STORAGE_RESERVE_MINIMUM = 8 * 1024 * 1024;
const STORAGE_RESERVE_MAXIMUM = 64 * 1024 * 1024;

export function formatByteSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  const digits = unit === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

export function evaluateStorageCapacity(requiredBytes, estimate) {
  const required = Math.max(0, Number(requiredBytes) || 0);
  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage);
  if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota <= 0) {
    return { supported:false, enough:true, required, available:null, reserve:0 };
  }
  const reserve = Math.min(STORAGE_RESERVE_MAXIMUM, Math.max(STORAGE_RESERVE_MINIMUM, quota * 0.02));
  const available = Math.max(0, quota - usage - reserve);
  return { supported:true, enough:required <= available, required, available, reserve };
}

export async function ensureStorageCapacity(requiredBytes, storage = globalThis.navigator?.storage) {
  if (!storage?.estimate) return evaluateStorageCapacity(requiredBytes, null);
  let estimate;
  try { estimate = await storage.estimate(); }
  catch { return evaluateStorageCapacity(requiredBytes, null); }
  const result = evaluateStorageCapacity(requiredBytes, estimate);
  if (!result.enough) {
    throw new Error(`ブラウザの保存容量が不足しています。必要: ${formatByteSize(result.required)}、利用可能: ${formatByteSize(result.available)}。不要なプロジェクトを削除するか、空き容量の多い端末を使用してください。`);
  }
  return result;
}
