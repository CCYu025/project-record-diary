// 照片檔案的生命週期。紀錄的 photos[] 只存檔名（{ file, caption }），實際檔案在
// <DATA_DIR>/照片/<YYYYMMDD>/<檔名>，資料夾由紀錄的日期決定。
//
// 跟產線日誌最大的不同：上傳先放進暫存區 照片/_暫存/，**儲存紀錄時**才搬進日期資料夾。
//   - 選了照片就立刻上傳（產線日誌修過兩次 bug 才定案的做法：送出時才上傳，重複送出會傳兩次）
//   - 但放棄填寫、關掉分頁留下的檔案只會在暫存區，不會混進日期資料夾
//   - 孤兒清理（sweepStaging）**只掃暫存區**。日期資料夾裡是使用者的真實照片，
//     有些是 App 出現之前就放進去的、還沒搬遷進 data.json，絕對不能因為「沒被參照」就刪掉
//   - 先上傳、後改日期也沒問題：存檔時才依當下的日期決定放哪個資料夾

import path from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dateToPhotoFolder } from "./rules.js";

export const STAGING_FOLDER = "_暫存";

// 暫存區裡放超過這麼久、又沒被存進任何紀錄的檔案，才算孤兒。
// 不能看到就刪：使用者可能剛選完照片、正在寫說明，表單還沒按儲存。
export const STAGING_SAFE_AGE_MS = 60 * 60 * 1000;

export function stagingDir(photosDir) {
  return path.join(photosDir, STAGING_FOLDER);
}

export function dateDir(photosDir, date) {
  return path.join(photosDir, dateToPhotoFolder(date));
}

/**
 * 上傳檔名整理：拿掉路徑、把 Windows 不允許的字元換掉，保留中文。
 * 自己切最後一段，不用 path.basename——Windows 版會把「a:b.jpg」的 a: 當成磁碟機代號吃掉。
 */
export function safeFilename(originalName) {
  const base = String(originalName || "").split(/[\\/]/).pop().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "");
  return base || `photo-${Date.now()}.jpg`;
}

/** dir 裡已經有同名檔案時，改成 名稱-1.jpg、名稱-2.jpg…… */
export function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 1; existsSync(path.join(dir, candidate)); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

export function isPhotoReferenced(records, date, file) {
  return records.some((r) => r.date === date && (r.photos || []).some((p) => p.file === file));
}

export class PhotoError extends Error {}

/**
 * 存檔前把照片放到該在的地方，回傳整理好的 photos（不含 staged 旗標）。
 *   - staged:true → 從暫存區搬進日期資料夾（同名就改名）
 *   - 原本就在這筆紀錄裡、但日期改了 → 從舊日期資料夾搬過去；別的紀錄也在用同一個檔案時用複製
 *   - 其他：必須已經在日期資料夾裡（例如搬遷進來的舊照片），找不到就擋下來
 *
 * @param {object} opts
 * @param {Array}  opts.otherRecords  除了這筆以外的所有紀錄（判斷檔案有沒有被共用）
 * @param {string} [opts.oldDate]     修改時原本的日期
 * @param {Array}  [opts.oldPhotos]   修改時原本的 photos
 */
export async function placePhotos(photosDir, photos, date, { otherRecords = [], oldDate = null, oldPhotos = [] } = {}) {
  const targetDir = dateDir(photosDir, date);
  const oldFiles = new Set(oldPhotos.map((p) => p.file));
  const out = [];
  for (const p of photos) {
    if (p.staged) {
      const from = path.join(stagingDir(photosDir), p.file);
      if (!existsSync(from)) throw new PhotoError(`照片「${p.file}」已經不在暫存區，請移除後重新上傳`);
      await mkdir(targetDir, { recursive: true });
      const name = uniqueName(targetDir, p.file);
      await rename(from, path.join(targetDir, name));
      out.push({ file: name, caption: p.caption });
      continue;
    }
    if (oldFiles.has(p.file) && oldDate && oldDate !== date) {
      const from = path.join(dateDir(photosDir, oldDate), p.file);
      if (existsSync(from)) {
        await mkdir(targetDir, { recursive: true });
        const name = uniqueName(targetDir, p.file);
        const shared = isPhotoReferenced(otherRecords, oldDate, p.file);
        await (shared ? copyFile : rename)(from, path.join(targetDir, name));
        out.push({ file: name, caption: p.caption });
      } else {
        // 檔案本來就不見了（例如手動刪掉）：保留參照，畫面會顯示「找不到照片」，不在這裡擋存檔
        out.push({ file: p.file, caption: p.caption });
      }
      continue;
    }
    if (!oldFiles.has(p.file) && !existsSync(path.join(targetDir, p.file))) {
      throw new PhotoError(`找不到照片「${p.file}」`);
    }
    out.push({ file: p.file, caption: p.caption });
  }
  return out;
}

/**
 * records 裡已經沒有任何紀錄參照這個 (date, file) 時，刪掉硬碟上的檔案。
 * 只在使用者自己把照片從紀錄移除、或刪除整筆紀錄時呼叫。
 * @returns {Promise<boolean>} 是否真的刪除了檔案
 */
export async function deleteUnreferencedPhoto(photosDir, records, date, file) {
  if (isPhotoReferenced(records, date, file)) return false;
  const target = path.join(dateDir(photosDir, date), file);
  if (!existsSync(target)) return false;
  await rm(target, { force: true });
  return true;
}

/** 刪掉暫存區裡的一個檔案（使用者在表單上移除還沒儲存的照片時）。 */
export async function deleteStagedPhoto(photosDir, file) {
  const target = path.join(stagingDir(photosDir), file);
  if (!existsSync(target)) return false;
  await rm(target, { force: true });
  return true;
}

/**
 * 暫存區的孤兒清理：放超過 STAGING_SAFE_AGE_MS 的檔案一律刪掉（存進紀錄的早就被搬走了）。
 * 前端放棄填寫時會主動刪，但關分頁、當機這些情況前端沒機會執行，這裡是最後一道防線。
 * **只掃暫存區**，日期資料夾一律不碰。
 */
export async function sweepStaging(photosDir, now = Date.now()) {
  const dir = stagingDir(photosDir);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    const st = await stat(file);
    if (!st.isFile() || now - st.mtimeMs < STAGING_SAFE_AGE_MS) continue;
    await rm(file, { force: true });
    removed++;
  }
  return removed;
}
