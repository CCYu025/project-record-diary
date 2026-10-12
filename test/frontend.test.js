// 前端沒有瀏覽器可以跑，但至少鎖住幾件「改了會整個畫面壞掉、又不容易從程式碼看出來」的事。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as rules from "../backend/lib/rules.js";

const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/app.js", import.meta.url), "utf8");

test("app.js 從 rules.js import 的名稱都真的存在", () => {
  const m = app.match(/import\s*\{([^}]+)\}\s*from\s*"\/lib\/rules\.js"/);
  assert.ok(m, "app.js 應該從 /lib/rules.js import 規則");
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) assert.ok(name in rules, `rules.js 沒有 export ${name}`);
});

test("rules.js 不能 import 任何模組（瀏覽器會直接載入它）", () => {
  const src = readFileSync(new URL("../backend/lib/rules.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m);
});

test("[hidden] 規則還在（畫面切換全靠它）", () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test("app.js 用到的元素 id 在 index.html 裡都找得到", () => {
  const ids = new Set([...app.matchAll(/\$\("#([\w-]+)/g)].map((m) => m[1]));
  // 動態產生的元素（新專案輸入框、照片說明）id 寫在 app.js 的樣板字串裡
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !app.includes(`id="${id}`) && !app.includes(`id="f-\${key}`));
  assert.deepEqual(missing, []);
});

test("開新視窗的報表一定要帶 <base href>（不然照片路徑解析不到）", () => {
  assert.match(app, /<base href="\$\{location\.origin\}\/">/);
});
