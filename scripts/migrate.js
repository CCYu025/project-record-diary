// 一次性搬遷：舊的「工作紀錄.xlsx」（工作日誌表）→ DATA_DIR/data.json
//
//   npm run migrate            data.json 已經存在就停下來，不覆蓋
//   npm run migrate -- --force 覆蓋既有的 data.json（會先備份成 data.backup-<時間>.json）
//
// 需要 .env 裡的 DATA_DIR 和 LEGACY_XLSX_PATH。
// 照片只搬「檔名」，不動檔案本身：照片本來就放在 DATA_DIR/照片/<YYYYMMDD>/，
// 找不到的會列在注意事項裡（紀錄照樣搬，畫面上會顯示找不到照片）。

import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLegacyWorkbook } from "../backend/lib/xlsx.js";
import { dataFilePath, emptyStore, saveStore } from "../backend/lib/store.js";
import { dateDir } from "../backend/lib/photos.js";

export async function migrate({ xlsxPath, dataDir, force = false, log = console.log }) {
  if (!xlsxPath || !existsSync(xlsxPath)) throw new Error(`找不到 Excel：${xlsxPath}（檢查 .env 的 LEGACY_XLSX_PATH）`);
  if (!dataDir) throw new Error("沒有設定 DATA_DIR（檢查 .env）");

  const target = dataFilePath(dataDir);
  if (existsSync(target)) {
    if (!force) throw new Error(`${target} 已經存在。確定要用 Excel 重新覆蓋的話，加上 --force`);
    const backup = path.join(dataDir, `data.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await copyFile(target, backup);
    log(`已備份原本的 data.json → ${backup}`);
  }

  const { records, warnings } = await readLegacyWorkbook(xlsxPath);
  const photosDir = path.join(dataDir, "照片");
  let photoCount = 0;
  for (const r of records) {
    for (const p of r.photos) {
      photoCount++;
      if (!existsSync(path.join(dateDir(photosDir, r.date), p.file))) {
        warnings.push(`${r.date} 的照片「${p.file}」不在 照片/${path.basename(dateDir(photosDir, r.date))}/ 裡`);
      }
    }
  }

  const store = { ...emptyStore(), records };
  store.meta.migratedFrom = path.basename(xlsxPath);
  await saveStore(dataDir, store);

  log(`搬遷完成 → ${target}`);
  log(`  紀錄 ${records.length} 筆、照片 ${photoCount} 張`);
  for (const w of warnings) log(`  注意：${w}`);
  return { records, warnings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate({
    xlsxPath: process.env.LEGACY_XLSX_PATH,
    dataDir: process.env.DATA_DIR,
    force: process.argv.includes("--force"),
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
