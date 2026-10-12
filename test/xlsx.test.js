// 刻意設成 UTC 以外的時區：exceljs 的日期是 UTC 錨定的，程式如果誤用本地 getDate()，
// 在 UTC 的 CI runner 上測不出來，在 UTC-7 就會整個差一天。這行不要拿掉。
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { EXPORT_HEADERS, parsePhotoCell, readLegacyWorkbook, writeSnapshotXlsx } from "../backend/lib/xlsx.js";
import { migrate } from "../scripts/migrate.js";
import { loadStore } from "../backend/lib/store.js";

const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day));

// 仿照原本「工作紀錄.xlsx」的結構（內容是虛構的）：日期是數字、照片欄是一串絕對路徑
async function makeLegacyWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("工作日誌表");
  ws.addRow(["日期", "班別", "時間", "專案名稱", "設備", "工作進度", "工作內容", "照片"]);
  ws.addRow([20260105, "早", "0930-1200", "示範專案", "3、4", "設備定位", "高度、水平、管線",
    'C:\\Users\\someone\\OneDrive\\桌面\\舊資料夾\\照片\\20260105\\P1.jpg、"C:\\Users\\someone\\OneDrive\\桌面\\舊資料夾\\照片\\20260105\\P2.jpg"']);
  ws.addRow([d(2026, 1, 6), "中班", "13:00-17:00", "示範專案", null, "配線", "主電源配線", null]);
  ws.addRow(["2026/1/7", "夜", "整天", "示範專案", null, "配線", "訊號線", null]);
  ws.addRow([null, null, null, null, null, null, null, null]); // 空列要略過
  ws.addRow(["不是日期", "早", "", "示範專案", null, "配線", "壞掉的列", null]);
  await wb.xlsx.writeFile(file);
}

test("parsePhotoCell：絕對路徑只留檔名，引號、分隔符號都處理掉", () => {
  assert.deepEqual(
    parsePhotoCell('C:\\a\\照片\\20261012\\S__1.jpg、"C:\\a\\照片\\20261012\\S__2.jpg"、 "S__3.jpg"'),
    ["S__1.jpg", "S__2.jpg", "S__3.jpg"],
  );
  assert.deepEqual(parsePhotoCell(null), []);
});

test("readLegacyWorkbook：日期不受時區影響、時段拆開、設備不搬、照片只留檔名", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prd-xlsx-"));
  const file = path.join(dir, "legacy.xlsx");
  await makeLegacyWorkbook(file);

  const { records, warnings } = await readLegacyWorkbook(file);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    id: 1, date: "2026-01-05", shift: "早", start: "09:30", end: "12:00", project: "示範專案", stage: "設備定位",
    content: "高度、水平、管線", photos: [{ file: "P1.jpg", caption: "" }, { file: "P2.jpg", caption: "" }], updatedAt: null,
  });
  assert.equal(records[1].date, "2026-01-06", "真正的日期格子用 UTC 讀");
  assert.equal(records[1].shift, "中", "「中班」也認得");
  assert.equal(records[2].date, "2026-01-07", "手打的 2026/1/7 也認得");
  assert.equal(records[2].shift, "早");
  assert.equal(records[2].content, "訊號線 （原時段：整天）");

  assert.ok(warnings.some((w) => w.includes("夜")));
  assert.ok(warnings.some((w) => w.includes("整天")));
  assert.ok(warnings.some((w) => w.includes("略過")));
  assert.ok(warnings.some((w) => w.includes("設備") && w.includes("1 筆")));
  rmSync(dir, { recursive: true, force: true });
});

test("writeSnapshotXlsx：7 欄、日期正確、舊到新、照片只放檔名、不留暫存檔", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prd-xlsx-"));
  const out = path.join(dir, "out.xlsx");
  const rec = (id, date, start, content, photos = []) => ({
    id, date, shift: "早", start, end: start ? "12:00" : null, project: "P", stage: "S", content, photos,
  });
  await writeSnapshotXlsx({
    records: [
      rec(1, "2026-10-13", "09:00", "隔天"),
      rec(2, "2026-10-12", "10:00", "第二筆", [{ file: "a.jpg", caption: "說明不匯出" }, { file: "b.jpg", caption: "" }]),
      rec(3, "2026-10-12", "08:00", "第一筆"),
      rec(4, "2026-10-12", null, "沒時段"),
    ],
  }, out);
  assert.deepEqual(readdirSync(dir), ["out.xlsx"]);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet("工作日誌表");
  assert.deepEqual(ws.getRow(1).values.slice(1), EXPORT_HEADERS);
  assert.deepEqual([2, 3, 4, 5].map((r) => ws.getRow(r).getCell(6).value), ["第一筆", "第二筆", "沒時段", "隔天"]);
  const date = ws.getRow(2).getCell(1).value;
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString().slice(0, 10), "2026-10-12");
  assert.equal(ws.getRow(3).getCell(3).value, "10:00-12:00");
  assert.equal(ws.getRow(3).getCell(7).value, "a.jpg、b.jpg");
  rmSync(dir, { recursive: true, force: true });
});

test("migrate：第一次成功、照片不在資料夾裡會提醒；已有 data.json 要 --force，並先備份", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prd-migrate-"));
  const file = path.join(dir, "legacy.xlsx");
  await makeLegacyWorkbook(file);
  mkdirSync(path.join(dir, "照片", "20260105"), { recursive: true });
  writeFileSync(path.join(dir, "照片", "20260105", "P1.jpg"), "x");
  const quiet = () => {};

  const { warnings } = await migrate({ xlsxPath: file, dataDir: dir, log: quiet });
  assert.ok(warnings.some((w) => w.includes("P2.jpg")), "P2 不在資料夾裡要提醒");
  assert.ok(!warnings.some((w) => w.includes("P1.jpg")));
  const store = await loadStore(dir);
  assert.equal(store.records.length, 3);
  assert.equal(store.meta.migratedFrom, "legacy.xlsx");

  await assert.rejects(migrate({ xlsxPath: file, dataDir: dir, log: quiet }), /--force/);
  await migrate({ xlsxPath: file, dataDir: dir, force: true, log: quiet });
  assert.ok(readdirSync(dir).some((f) => /^data\.backup-.*\.json$/.test(f)));
  assert.ok(existsSync(path.join(dir, "data.json")));

  await assert.rejects(migrate({ xlsxPath: path.join(dir, "nope.xlsx"), dataDir: dir, log: quiet }), /找不到 Excel/);
  rmSync(dir, { recursive: true, force: true });
});
