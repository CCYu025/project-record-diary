import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PhotoError, STAGING_SAFE_AGE_MS, deleteStagedPhoto, deleteUnreferencedPhoto, placePhotos, safeFilename, stagingDir,
  sweepStaging, uniqueName,
} from "../backend/lib/photos.js";

function setup() {
  const photosDir = path.join(mkdtempSync(path.join(os.tmpdir(), "prd-photos-")), "照片");
  mkdirSync(stagingDir(photosDir), { recursive: true });
  const put = (rel, content = "x") => {
    const file = path.join(photosDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const ls = (rel) => (existsSync(path.join(photosDir, rel)) ? readdirSync(path.join(photosDir, rel)).sort() : []);
  return { photosDir, put, ls, done: () => rmSync(path.dirname(photosDir), { recursive: true, force: true }) };
}

test("safeFilename / uniqueName", () => {
  assert.equal(safeFilename("C:\\fake\\S__1.jpg".split("\\").pop()), "S__1.jpg");
  assert.equal(safeFilename('a:b*c?.jpg'), "a_b_c_.jpg");
  assert.equal(safeFilename("水平儀.jpg"), "水平儀.jpg");
  assert.match(safeFilename(".."), /^photo-\d+\.jpg$/);
  const { photosDir, put, done } = setup();
  put("20261012/a.jpg");
  put("20261012/a-1.jpg");
  assert.equal(uniqueName(path.join(photosDir, "20261012"), "a.jpg"), "a-2.jpg");
  done();
});

test("placePhotos：暫存區的照片存檔時搬進日期資料夾，同名自動改名", async () => {
  const { photosDir, put, ls, done } = setup();
  put("_暫存/S__1.jpg", "new");
  put("20261012/S__1.jpg", "old");
  const out = await placePhotos(photosDir, [{ file: "S__1.jpg", caption: "說明", staged: true }], "2026-10-12");
  assert.deepEqual(out, [{ file: "S__1-1.jpg", caption: "說明" }]);
  assert.deepEqual(ls("_暫存"), []);
  assert.deepEqual(ls("20261012"), ["S__1-1.jpg", "S__1.jpg"]);
  done();
});

test("placePhotos：暫存檔不見了、或引用不存在的照片 → 擋下來", async () => {
  const { photosDir, done } = setup();
  await assert.rejects(placePhotos(photosDir, [{ file: "gone.jpg", caption: "", staged: true }], "2026-10-12"), PhotoError);
  await assert.rejects(placePhotos(photosDir, [{ file: "nope.jpg", caption: "" }], "2026-10-12"), /找不到照片/);
  done();
});

test("placePhotos：已經在日期資料夾的照片（例如搬遷進來的）直接保留", async () => {
  const { photosDir, put, done } = setup();
  put("20261012/S__2.jpg");
  const out = await placePhotos(photosDir, [{ file: "S__2.jpg", caption: "" }], "2026-10-12");
  assert.deepEqual(out, [{ file: "S__2.jpg", caption: "" }]);
  done();
});

test("placePhotos：改日期時把照片搬到新資料夾；別的紀錄也在用就複製", async () => {
  const { photosDir, put, ls, done } = setup();
  put("20261012/mine.jpg");
  put("20261012/shared.jpg");
  const other = { date: "2026-10-12", photos: [{ file: "shared.jpg", caption: "" }] };
  const oldPhotos = [{ file: "mine.jpg", caption: "" }, { file: "shared.jpg", caption: "" }];
  const out = await placePhotos(photosDir, oldPhotos, "2026-10-13", { otherRecords: [other], oldDate: "2026-10-12", oldPhotos });
  assert.deepEqual(out.map((p) => p.file), ["mine.jpg", "shared.jpg"]);
  assert.deepEqual(ls("20261013"), ["mine.jpg", "shared.jpg"]);
  assert.deepEqual(ls("20261012"), ["shared.jpg"], "共用的留在原處，自己的搬走");
  done();
});

test("deleteUnreferencedPhoto：還有紀錄在用就不刪", async () => {
  const { photosDir, put, ls, done } = setup();
  put("20261012/a.jpg");
  const records = [{ date: "2026-10-12", photos: [{ file: "a.jpg", caption: "" }] }];
  assert.equal(await deleteUnreferencedPhoto(photosDir, records, "2026-10-12", "a.jpg"), false);
  assert.equal(await deleteUnreferencedPhoto(photosDir, [], "2026-10-12", "a.jpg"), true);
  assert.deepEqual(ls("20261012"), []);
  assert.equal(await deleteUnreferencedPhoto(photosDir, [], "2026-10-12", "a.jpg"), false);
  done();
});

test("sweepStaging：只清暫存區裡放超過 1 小時的檔案，日期資料夾一律不碰", async () => {
  const { photosDir, put, ls, done } = setup();
  const old = put("_暫存/old.jpg");
  put("_暫存/fresh.jpg");
  const realOld = put("20261012/沒被參照的舊照片.jpg");
  const past = (Date.now() - STAGING_SAFE_AGE_MS - 60_000) / 1000;
  utimesSync(old, past, past);
  utimesSync(realOld, past, past);

  assert.equal(await sweepStaging(photosDir), 1);
  assert.deepEqual(ls("_暫存"), ["fresh.jpg"]);
  assert.deepEqual(ls("20261012"), ["沒被參照的舊照片.jpg"]);
  assert.equal(await deleteStagedPhoto(photosDir, "fresh.jpg"), true);
  assert.equal(await deleteStagedPhoto(photosDir, "fresh.jpg"), false);
  done();
});
