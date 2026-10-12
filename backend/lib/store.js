// data.json 的讀寫。原則見 backend/data/schema.md：
//   - data.json 是唯一事實來源，Excel 只是匯出快照
//   - 寫入用「先寫暫存檔、再 rename」，避免程式中途當機把檔案寫壞一半
//   - 找不到檔案時回傳空資料，讓全新安裝也能正常開機

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = "1.0";
export const APP_NAME = "專案紀錄";

export function dataFilePath(dataDir) {
  return path.join(dataDir, "data.json");
}

export function emptyStore() {
  return {
    meta: { schemaVersion: SCHEMA_VERSION, app: APP_NAME },
    projects: [],
    records: [],
  };
}

export async function loadStore(dataDir) {
  const file = dataFilePath(dataDir);
  if (!existsSync(file)) return emptyStore();
  const parsed = JSON.parse(await readFile(file, "utf8"));
  return {
    meta: { schemaVersion: SCHEMA_VERSION, app: APP_NAME, ...parsed._meta },
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    records: Array.isArray(parsed.records) ? parsed.records : [],
  };
}

export async function saveStore(dataDir, store) {
  await mkdir(dataDir, { recursive: true });
  const file = dataFilePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    _meta: { ...store.meta, schemaVersion: SCHEMA_VERSION, app: APP_NAME, savedAt: new Date().toISOString() },
    projects: store.projects || [],
    records: store.records || [],
  };
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, file);
  return payload;
}

/**
 * 把「讀 → 改 → 寫」排成一條隊伍，一次只跑一個。
 * 單人使用也會發生：快速連點兩次「儲存」，兩個請求同時讀到舊資料，後寫的蓋掉先寫的，
 * 其中一筆就不見了。fn 回傳 false 代表「不用存檔」（例如找不到要改的那筆）。
 */
export function createStoreQueue(dataDir) {
  let tail = Promise.resolve();
  return function withStore(fn) {
    const run = tail.then(async () => {
      const store = await loadStore(dataDir);
      const result = await fn(store);
      if (result !== false) await saveStore(dataDir, store);
      return result;
    });
    tail = run.catch(() => {});
    return run;
  };
}
