import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStoreQueue, loadStore, saveStore } from "../backend/lib/store.js";

test("沒有 data.json 時回傳空資料；存檔後讀得回來、不留暫存檔", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prd-store-"));
  const empty = await loadStore(dir);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.meta.app, "專案紀錄");

  await saveStore(dir, { ...empty, records: [{ id: 1, date: "2026-10-12" }] });
  assert.deepEqual(readdirSync(dir), ["data.json"]);
  const raw = JSON.parse(readFileSync(path.join(dir, "data.json"), "utf8"));
  assert.equal(raw._meta.schemaVersion, "1.0");
  assert.ok(raw._meta.savedAt);
  assert.equal((await loadStore(dir)).records.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("寫入排隊：同時 20 個新增，一筆都不會掉；回傳 false 不存檔", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prd-store-"));
  const withStore = createStoreQueue(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => withStore((s) => { s.records.push({ id: i }); })));
  assert.equal((await loadStore(dir)).records.length, 20);

  await withStore((s) => { s.records = []; return false; });
  assert.equal((await loadStore(dir)).records.length, 20);

  await assert.rejects(withStore(() => { throw new Error("壞掉"); }));
  await withStore((s) => { s.records.push({ id: 99 }); });
  assert.equal((await loadStore(dir)).records.length, 21, "前一個失敗不會卡住隊伍");
  rmSync(dir, { recursive: true, force: true });
});
