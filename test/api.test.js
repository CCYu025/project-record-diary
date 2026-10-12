import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { todayString } from "../backend/lib/rules.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "prd-api-"));
process.env.DATA_DIR = dataDir;
process.env.NO_OPEN_BROWSER = "1";

const { default: app, EXPORT_FILENAME } = await import("../backend/server.js");

let server;
let base;
const photos = (rel) => {
  const dir = path.join(dataDir, "照片", rel);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function uploadPhoto(name, type = "image/jpeg") {
  const fd = new FormData();
  fd.append("photo", new Blob([`fake ${name}`], { type }), name);
  const res = await fetch(base + "/api/photos", { method: "POST", body: fd });
  return { status: res.status, body: await res.json() };
}

const record = { date: "2026-10-12", shift: "早", start: "09:30", end: "12:00", project: "CCD設備安裝", stage: "送料設備定位", content: "高度、水平、管線" };

test("全新資料夾：GET /api/data 回傳空資料和今天日期", async () => {
  const { status, body } = await call("GET", "/api/data");
  assert.equal(status, 200);
  assert.deepEqual(body.records, []);
  assert.equal(body.today, todayString());
  assert.equal(body.exportFile, EXPORT_FILENAME);
});

test("首頁和前端共用的 rules.js 拿得到；其他後端程式不對外", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  assert.match(await html.text(), /專案紀錄/);
  const rules = await fetch(base + "/lib/rules.js");
  assert.match(rules.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(base + "/lib/photos.js")).status, 404);
});

test("照片：上傳進暫存區 → 儲存紀錄時搬進日期資料夾 → 照片網址拿得到", async () => {
  const a = await uploadPhoto("S__1.jpg");
  const b = await uploadPhoto("水平儀.jpg");
  assert.equal(a.status, 201);
  assert.equal(b.body.file, "水平儀.jpg", "中文檔名不能變亂碼");
  assert.deepEqual(photos("_暫存"), ["S__1.jpg", "水平儀.jpg"]);

  const created = await call("POST", "/api/records", {
    ...record,
    photos: [{ file: "S__1.jpg", caption: "推到定位", staged: true }, { file: "水平儀.jpg", caption: "", staged: true }],
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.item.photos, [{ file: "S__1.jpg", caption: "推到定位" }, { file: "水平儀.jpg", caption: "" }]);
  assert.deepEqual(photos("_暫存"), []);
  assert.deepEqual(photos("20261012"), ["S__1.jpg", "水平儀.jpg"]);

  const img = await fetch(base + "/photos/20261012/" + encodeURIComponent("水平儀.jpg"));
  assert.equal(img.status, 200);
  assert.equal((await fetch(base + "/photos/20261012/none.jpg")).status, 404);
});

test("上傳：不是圖片擋下來；暫存照片可以刪；不合法檔名 400", async () => {
  assert.equal((await uploadPhoto("a.txt", "text/plain")).status, 400);
  const up = await uploadPhoto("tmp.jpg");
  assert.equal((await call("DELETE", `/api/photos/staged/${up.body.file}`)).body.deleted, true);
  assert.equal((await call("DELETE", "/api/photos/staged/..%5Cdata.json")).status, 400);
});

test("修改：改說明、拿掉照片會刪檔案、改日期照片跟著搬", async () => {
  await uploadPhoto("keep.jpg");
  await uploadPhoto("drop.jpg");
  const { body } = await call("POST", "/api/records", {
    ...record, start: "13:00", end: "17:00", stage: "配線",
    photos: [{ file: "keep.jpg", caption: "", staged: true }, { file: "drop.jpg", caption: "", staged: true }],
  });
  const id = body.item.id;

  const captioned = await call("PUT", `/api/records/${id}`, { photos: [{ file: "keep.jpg", caption: "端子台" }, { file: "drop.jpg", caption: "" }] });
  assert.equal(captioned.status, 200);
  assert.equal(captioned.body.item.photos[0].caption, "端子台");
  assert.equal(captioned.body.item.content, record.content, "只送部分欄位時其他欄位要保留");
  assert.ok(captioned.body.item.updatedAt);

  await call("PUT", `/api/records/${id}`, { photos: [{ file: "keep.jpg", caption: "端子台" }] });
  assert.ok(!photos("20261012").includes("drop.jpg"), "拿掉的照片要從資料夾刪掉");

  const moved = await call("PUT", `/api/records/${id}`, { date: "2026-10-13" });
  assert.equal(moved.status, 200);
  assert.deepEqual(photos("20261013"), ["keep.jpg"]);
  assert.ok(!photos("20261012").includes("keep.jpg"));

  const bad = await call("PUT", `/api/records/${id}`, { start: "18:00" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors, ["結束時間不能早於開始時間"]);
  assert.equal((await call("PUT", "/api/records/999", { content: "x" })).status, 404);
});

test("存檔時照片已經不在暫存區、或引用不存在的照片 → 400，不存進去", async () => {
  const before = (await call("GET", "/api/data")).body.records.length;
  const gone = await call("POST", "/api/records", { ...record, photos: [{ file: "ghost.jpg", caption: "", staged: true }] });
  assert.equal(gone.status, 400);
  assert.match(gone.body.errors[0], /暫存區/);
  const missing = await call("POST", "/api/records", { ...record, photos: [{ file: "ghost.jpg", caption: "" }] });
  assert.equal(missing.status, 400);
  assert.equal((await call("GET", "/api/data")).body.records.length, before);
});

test("刪除紀錄：照片檔案一起刪", async () => {
  await uploadPhoto("bye.jpg");
  const { body } = await call("POST", "/api/records", { ...record, date: "2026-10-20", photos: [{ file: "bye.jpg", caption: "", staged: true }] });
  assert.deepEqual(photos("20261020"), ["bye.jpg"]);
  assert.equal((await call("DELETE", `/api/records/${body.item.id}`)).status, 200);
  assert.deepEqual(photos("20261020"), []);
  assert.equal((await call("DELETE", `/api/records/${body.item.id}`)).status, 404);
});

test("必填驗證、壞掉的 JSON 回 400 JSON", async () => {
  const bad = await call("POST", "/api/records", { date: "2026-10-12" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.includes("工作內容為必填"));
  const broken = await call("POST", "/api/records", "{not json");
  assert.deepEqual(broken.body.errors, ["請求內容不是合法的 JSON"]);
});

test("連點送出：同時多個新增請求，id 不重複、一筆都不會掉", async () => {
  const before = (await call("GET", "/api/data")).body.records.length;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/records", { ...record, content: `第 ${i} 筆` })));
  assert.ok(results.every((r) => r.status === 201));
  const { body } = await call("GET", "/api/data");
  assert.equal(body.records.length, before + 10);
  assert.equal(new Set(body.records.map((r) => r.id)).size, body.records.length);
  assert.ok(body.projects.includes("CCD設備安裝"));
});

test("匯出 Excel 會在資料夾裡產生檔案，檔名不是搬遷來源", async () => {
  const { status, body } = await call("POST", "/api/export-xlsx");
  assert.equal(status, 200);
  assert.equal(path.basename(body.path), EXPORT_FILENAME);
  assert.notEqual(EXPORT_FILENAME, "工作紀錄.xlsx");
  assert.ok(existsSync(path.join(dataDir, EXPORT_FILENAME)));
});
