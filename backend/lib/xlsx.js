// Excel 的讀（一次性搬遷用）與寫（匯出快照用）。App 平常從不讀 Excel。
//
// 注意：exceljs 把 Excel 的日期格子讀成「UTC 錨定」的 Date，一定要用 getUTC*() 取年月日。
// 用本地 getDate() 在 UTC+8 的機器上看起來沒事，但在 UTC-X 的時區會變成前一天；
// 反過來寫入時也要用 Date.UTC() 建日期，不然 Excel 裡會差一天。test/xlsx.test.js 有鎖這個行為。

import ExcelJS from "exceljs";
import path from "node:path";
import { rename, rm } from "node:fs/promises";
import { SHIFTS, normalizeRecord, parseTimeRange, sortRecordsChronological, timeRangeText } from "./rules.js";

export const SHEET_NAME = "工作日誌表";
export const EXPORT_HEADERS = ["日期", "班別", "時間", "專案名稱", "工作進度", "工作內容", "照片"];

// ---------- 讀 ----------

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateToString(v);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return String(v.text).trim();
  }
  return String(v).trim();
}

function dateToString(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 日期格子可能是真的 Date、可能是數字 20261012（原本的 Excel 就是這樣填的），也可能是手打的 "2026/10/12"
function cellDate(v) {
  if (v instanceof Date) return dateToString(v);
  if (v && typeof v === "object" && v.result instanceof Date) return dateToString(v.result);
  const s = cellText(v);
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return s || null;
}

/**
 * 照片欄：一格裡放好幾個「絕對路徑」，用「、」分隔，有的加了雙引號。
 * 只留檔名——路徑是當時那台電腦、當時的資料夾名稱，資料夾改名後就全部失效了
 * （原本的 Excel 就是這樣壞掉的）。用 path.win32 是因為路徑一定是 Windows 格式，
 * 跟搬遷腳本在哪個 OS 上跑無關（產線日誌在 Linux CI 上踩過這個坑）。
 */
export function parsePhotoCell(raw) {
  return cellText(raw)
    .split(/[、,，;；\r\n]+/)
    .map((s) => s.trim().replace(/^["'「]+|["'」]+$/g, "").trim())
    .filter(Boolean)
    .map((s) => path.win32.basename(s));
}

function headerIndex(ws, aliases) {
  const map = {};
  ws.getRow(1).eachCell((cell, col) => {
    map[cellText(cell.value)] = col;
  });
  const out = {};
  for (const [key, names] of Object.entries(aliases)) out[key] = names.map((n) => map[n]).find(Boolean) ?? null;
  return out;
}

const ALIASES = {
  date: ["日期"],
  shift: ["班別"],
  time: ["時間", "時段"],
  project: ["專案名稱", "專案"],
  equipment: ["設備"],
  stage: ["工作進度"],
  content: ["工作內容"],
  photos: ["照片"],
};

/**
 * 讀舊的「工作紀錄.xlsx」（工作表「工作日誌表」；找不到就用第一張）。
 * 「設備」欄**不搬**（使用者 2026-10-12 決定拿掉這個欄位、舊資料直接捨棄）。
 * 回傳整理好的紀錄和 warnings；有問題的列不會中斷整個搬遷，只會跳過並記在 warnings。
 */
export async function readLegacyWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const warnings = [];
  const records = [];

  const ws = wb.getWorksheet(SHEET_NAME) || wb.worksheets[0];
  if (!ws) return { records, warnings: ["Excel 裡沒有任何工作表"] };
  const col = headerIndex(ws, ALIASES);
  let droppedEquipment = 0;

  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (k) => (col[k] ? row.getCell(col[k]).value : null);
    if (!cellText(get("content")) && !cellText(get("stage"))) return;

    let shift = cellText(get("shift")).replace(/班$/, "");
    if (!SHIFTS.includes(shift)) {
      warnings.push(`第 ${n} 列：班別「${shift}」不在清單內，改成「早」`);
      shift = "早";
    }
    const rawTime = cellText(get("time"));
    const range = parseTimeRange(rawTime);
    let content = cellText(get("content"));
    if (range === null) {
      warnings.push(`第 ${n} 列：時間「${rawTime}」看不懂，原文放進工作內容`);
      content = [content, `（原時段：${rawTime}）`].filter(Boolean).join(" ");
    }
    if (cellText(get("equipment"))) droppedEquipment++;

    const { value, errors } = normalizeRecord({
      date: cellDate(get("date")),
      shift,
      start: range?.start ?? null,
      end: range?.end ?? null,
      project: cellText(get("project")) || "其他",
      stage: cellText(get("stage")) || "未分類",
      content: content || cellText(get("stage")),
      photos: parsePhotoCell(get("photos")).map((file) => ({ file, caption: "" })),
    });
    if (errors.length) warnings.push(`第 ${n} 列略過：${errors.join("、")}`);
    else records.push({ id: records.length + 1, ...value, updatedAt: null });
  });

  if (droppedEquipment) warnings.push(`「設備」欄位不搬遷（${droppedEquipment} 筆有填，依決定捨棄）`);
  return { records, warnings };
}

// ---------- 寫 ----------

function toExcelDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * 匯出成跟原本 Excel 一樣的欄位（拿掉「設備」，共 7 欄），給還沒用這個 App 的人看、或傳給主管。
 * 照片欄只放檔名（「、」分隔），不放說明（使用者 2026-10-12 決定）。
 * 先寫暫存檔再 rename：Excel 開著這個檔案時會寫失敗，但不會把舊檔案寫壞一半。
 * 失敗時丟出的錯誤帶 code（EBUSY／EPERM），server.js 會轉成「請先關掉 Excel」。
 */
export async function writeSnapshotXlsx({ records }, outFilePath) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [12, 6, 13, 16, 18, 40, 40].map((width) => ({ width }));
  ws.addRow(EXPORT_HEADERS).font = { bold: true };
  // 舊到新，跟原本 Excel 往下新增的閱讀順序一致
  for (const r of sortRecordsChronological(records)) {
    ws.addRow([
      toExcelDate(r.date),
      r.shift,
      timeRangeText(r),
      r.project,
      r.stage,
      r.content,
      (r.photos || []).map((p) => p.file).join("、"),
    ]);
  }
  ws.getColumn(1).numFmt = "yyyy-mm-dd";
  ws.getColumn(6).alignment = { wrapText: true, vertical: "top" };

  const tmp = `${outFilePath}.tmp-${process.pid}-${Date.now()}.xlsx`;
  try {
    await wb.xlsx.writeFile(tmp);
    await rename(tmp, outFilePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
