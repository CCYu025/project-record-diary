import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { exec } from "node:child_process";

import { createStoreQueue, loadStore } from "./lib/store.js";
import { isSafePhotoName, knownProjects, nextId, normalizeRecord, sortRecords, todayString } from "./lib/rules.js";
import {
  PhotoError, deleteStagedPhoto, deleteUnreferencedPhoto, placePhotos, safeFilename, stagingDir, sweepStaging, uniqueName,
} from "./lib/photos.js";
import { writeSnapshotXlsx } from "./lib/xlsx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR 沒設定時用內建範例資料開機，clone 下來不用準備任何東西就能看畫面。
// 自己電腦上的正式資料夾路徑放在 .env，不進版控。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data", "example");
const PORT = Number(process.env.PORT) || 3002;
const PHOTOS_DIR = path.join(DATA_DIR, "照片");
// 故意跟搬遷來源「工作紀錄.xlsx」不同名，絕對不能覆蓋使用者原本的 Excel
export const EXPORT_FILENAME = "專案紀錄_匯出.xlsx";

const withStore = createStoreQueue(DATA_DIR);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));
// 前端直接 import 這支規則檔，前後端用同一套驗證／排序／報表（見 CLAUDE.md）
app.get("/lib/rules.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "rules.js"));
});
// express.static 每次請求才解析路徑，照片資料夾之後才建立也不用重啟
app.use("/photos", express.static(PHOTOS_DIR, { fallthrough: false }));

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const now = () => new Date().toISOString();
// Express 4 不會自己接 async handler 丟出的錯誤，包一層交給最後的錯誤處理
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get("/api/data", wrap(async (req, res) => {
  const store = await loadStore(DATA_DIR);
  res.json({
    today: todayString(),
    projects: knownProjects(store),
    records: sortRecords(store.records),
    dataDir: DATA_DIR,
    exportFile: EXPORT_FILENAME,
  });
}));

app.post("/api/records", wrap(async (req, res) => {
  const { value, errors } = normalizeRecord(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const item = await withStore(async (store) => {
    const photos = await placePhotos(PHOTOS_DIR, value.photos, value.date, { otherRecords: store.records });
    const created = { id: nextId(store.records), ...value, photos, updatedAt: null };
    store.records.push(created);
    return created;
  });
  res.status(201).json({ item });
}));

app.put("/api/records/:id", wrap(async (req, res) => {
  const id = parseId(req);
  let errors = [];
  const result = await withStore(async (store) => {
    const existing = store.records.find((r) => r.id === id);
    if (!existing) return false;
    const normalized = normalizeRecord({ ...existing, ...(req.body || {}) });
    if (normalized.errors.length) {
      errors = normalized.errors;
      return false;
    }
    const others = store.records.filter((r) => r !== existing);
    const oldDate = existing.date;
    const oldPhotos = existing.photos || [];
    const photos = await placePhotos(PHOTOS_DIR, normalized.value.photos, normalized.value.date, {
      otherRecords: others, oldDate, oldPhotos,
    });
    Object.assign(existing, normalized.value, { photos, updatedAt: now() });
    // 這次拿掉的照片（日期改了的話，留下來的已經搬走了，舊資料夾裡只剩被拿掉的）
    const kept = new Set(photos.map((p) => p.file));
    const removed = oldPhotos.filter((p) => oldDate !== existing.date || !kept.has(p.file)).map((p) => p.file);
    return { item: existing, oldDate, removed, records: store.records };
  });
  if (errors.length) return res.status(400).json({ errors });
  if (!result) return res.status(404).json({ errors: ["找不到這一筆"] });
  // 存檔成功之後才刪檔案；別的紀錄還在用同一個檔案時不刪
  for (const file of result.removed) await deleteUnreferencedPhoto(PHOTOS_DIR, result.records, result.oldDate, file);
  res.json({ item: result.item });
}));

app.delete("/api/records/:id", wrap(async (req, res) => {
  const id = parseId(req);
  const result = await withStore((store) => {
    const idx = store.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const [removed] = store.records.splice(idx, 1);
    return { removed, records: store.records };
  });
  if (!result) return res.status(404).json({ errors: ["找不到這一筆"] });
  for (const p of result.removed.photos || []) {
    await deleteUnreferencedPhoto(PHOTOS_DIR, result.records, result.removed.date, p.file);
  }
  res.json({ deleted: true });
}));

// ---------- 照片：選了就立刻上傳到暫存區，儲存紀錄時才搬進日期資料夾（見 lib/photos.js） ----------

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = stagingDir(PHOTOS_DIR);
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, uniqueName(stagingDir(PHOTOS_DIR), safeFilename(decodeName(file.originalname))));
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\//.test(file.mimetype));
  },
});

// 瀏覽器送 multipart 檔名是 UTF-8，但 busboy 預設當 latin1 解，中文檔名會變亂碼
function decodeName(name) {
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}

app.post("/api/photos", (req, res, next) => {
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ errors: [err.code === "LIMIT_FILE_SIZE" ? "照片超過 25MB" : err.message] });
    if (!req.file) return res.status(400).json({ errors: ["只能上傳圖片檔"] });
    res.status(201).json({ file: req.file.filename });
  });
});

// 表單上移除還沒儲存的照片：只刪暫存區，日期資料夾裡的照片要透過修改紀錄才會刪
app.delete("/api/photos/staged/:file", wrap(async (req, res) => {
  if (!isSafePhotoName(req.params.file)) return res.status(400).json({ errors: ["檔名不合法"] });
  res.json({ deleted: await deleteStagedPhoto(PHOTOS_DIR, req.params.file) });
}));

app.post("/api/export-xlsx", wrap(async (req, res) => {
  const store = await loadStore(DATA_DIR);
  const outPath = path.join(DATA_DIR, EXPORT_FILENAME);
  try {
    await writeSnapshotXlsx(store, outPath);
    res.json({ path: outPath });
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      return res.status(409).json({ errors: [`${EXPORT_FILENAME} 正在被 Excel 開著，關掉之後再匯出一次`] });
    }
    throw err;
  }
}));

// 壞掉的 JSON、照片問題、或任何沒接到的錯誤：回傳 JSON 讓前端顯示，不要吐 HTML 錯誤頁
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ errors: ["請求內容不是合法的 JSON"] });
  if (err instanceof PhotoError) return res.status(400).json({ errors: [err.message] });
  if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ errors: ["找不到檔案"] });
  console.error(err);
  res.status(500).json({ errors: [err.message || "伺服器錯誤"] });
});

async function runStagingSweep() {
  try {
    const removed = await sweepStaging(PHOTOS_DIR);
    if (removed > 0) console.log(`暫存照片清理：刪除 ${removed} 個沒有存進紀錄的檔案`);
  } catch (err) {
    console.error("暫存照片清理失敗：", err.message);
  }
}

// 只有直接執行這支檔案時才啟動；被測試 import 時不要自動開伺服器／瀏覽器
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`專案紀錄已啟動： http://localhost:${PORT}`);
    console.log(`資料夾： ${DATA_DIR}`);
    if (process.platform === "win32" && !process.env.NO_OPEN_BROWSER) {
      exec(`start "" "http://localhost:${PORT}"`);
    }
  });
  // 單機工具常常一開好幾天不重啟：啟動跑一次，之後每小時一次
  runStagingSweep();
  setInterval(runStagingSweep, 60 * 60 * 1000);
}

export default app;
export { DATA_DIR };
