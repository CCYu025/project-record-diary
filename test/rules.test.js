import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReport, dateToPhotoFolder, isSafePhotoName, knownProjects, knownStages, normalizeRecord, parseTimeRange,
  reportKind, reportPeriod, sortRecords, sortRecordsChronological, timeRangeText, todayString,
} from "../backend/lib/rules.js";

const base = { date: "2026-10-12", shift: "早", start: "09:30", end: "12:00", project: "CCD設備安裝", stage: "送料設備定位", content: "高度、水平、管線" };

test("normalizeRecord：合法資料整理好、照片只留檔名和說明", () => {
  const { value, errors } = normalizeRecord({
    ...base,
    content: "  高度、水平、管線 ",
    photos: [{ file: "S__1.jpg", caption: " 推到定位 " }, "S__2.jpg", { file: "S__1.jpg", caption: "重複" }, { file: "S__3.jpg", caption: "", staged: true }],
  });
  assert.deepEqual(errors, []);
  assert.equal(value.content, "高度、水平、管線");
  assert.deepEqual(value.photos, [
    { file: "S__1.jpg", caption: "推到定位" },
    { file: "S__2.jpg", caption: "" },
    { file: "S__3.jpg", caption: "", staged: true },
  ]);
  assert.equal("equipment" in value, false, "設備欄位已經拿掉");
});

test("normalizeRecord：必填、班別、時段、照片檔名", () => {
  const { errors } = normalizeRecord({ date: "2026-02-30", shift: "夜", start: "13:00", end: "12:00", photos: [{ file: "..\\x.jpg" }] });
  assert.ok(errors.includes("日期格式須為 YYYY-MM-DD"));
  assert.ok(errors.some((e) => e.startsWith("班別必須是")));
  assert.ok(errors.includes("專案名稱為必填"));
  assert.ok(errors.includes("工作進度為必填"));
  assert.ok(errors.includes("工作內容為必填"));
  assert.ok(errors.includes("結束時間不能早於開始時間"));
  assert.ok(errors.some((e) => e.startsWith("照片檔名不合法")));

  assert.deepEqual(normalizeRecord({ ...base, start: "", end: "" }).value.start, null, "時段選填");
  assert.deepEqual(normalizeRecord({ ...base, photos: "a.jpg" }).errors, ["照片格式不對"]);
});

test("isSafePhotoName：擋路徑、隱藏檔；中文檔名可以", () => {
  assert.ok(isSafePhotoName("S__35356682_0.jpg"));
  assert.ok(isSafePhotoName("水平儀.jpg"));
  for (const bad of ["", "a/b.jpg", "a\\b.jpg", "..", ".hidden", "C:x.jpg", 3]) assert.equal(isSafePhotoName(bad), false, String(bad));
});

test("parseTimeRange：原本 Excel 的 0930-1200 格式", () => {
  assert.deepEqual(parseTimeRange("0930-1200"), { start: "09:30", end: "12:00" });
  assert.deepEqual(parseTimeRange("9:30~12:00"), { start: "09:30", end: "12:00" });
  assert.deepEqual(parseTimeRange(""), { start: null, end: null });
  assert.equal(parseTimeRange("整天"), null);
  assert.equal(parseTimeRange("2500-2600"), null);
  assert.equal(timeRangeText({ start: "09:30", end: "12:00" }), "09:30-12:00");
  assert.equal(timeRangeText({ start: null, end: null }), "");
});

test("dateToPhotoFolder、todayString 用本地日期", () => {
  assert.equal(dateToPhotoFolder("2026-10-12"), "20261012");
  assert.equal(todayString(new Date(2026, 9, 12, 7, 30)), "2026-10-12");
});

const records = [
  { id: 1, ...base },
  { id: 2, ...base, start: "13:00", end: "17:00", stage: "配線" },
  { id: 3, ...base, date: "2026-10-13", start: null, end: null, stage: "CCD安裝" },
  { id: 4, ...base, date: "2026-10-13", start: "08:00", end: "09:00", stage: "送料設備定位", photos: [{ file: "a.jpg", caption: "" }, { file: "b.jpg", caption: "" }] },
  { id: 5, ...base, date: "2026-10-01", project: "別的專案", stage: "拆機" },
];

test("排序：新到舊（同一天依時間、沒時段排最後）；舊到新", () => {
  assert.deepEqual(sortRecords(records).map((r) => r.id), [4, 3, 1, 2, 5]);
  assert.deepEqual(sortRecordsChronological(records).map((r) => r.id), [5, 1, 2, 4, 3]);
});

test("knownProjects / knownStages：開放清單，最近用過的排前面、這個專案的排前面", () => {
  assert.deepEqual(knownProjects({ projects: ["預設"], records }), ["CCD設備安裝", "別的專案", "預設"]);
  // 10/13 08:00 送料設備定位 > 10/13 沒時段 CCD安裝 > 10/12 13:00 配線 > 10/12 09:30 送料設備定位
  assert.deepEqual(knownStages(records, "CCD設備安裝"), ["送料設備定位", "CCD安裝", "配線", "拆機"]);
  const sameDay = [{ id: 1, ...base }, { id: 2, ...base, start: "13:00", end: "17:00", stage: "配線" }];
  assert.deepEqual(knownStages(sameDay, "CCD設備安裝"), ["配線", "送料設備定位"], "同一天下午的比早上的新");
  assert.deepEqual(knownStages(records, "別的專案")[0], "拆機");
});

test("reportPeriod：本週週一到週日、上週、本月、整個專案", () => {
  assert.deepEqual(reportPeriod("week", "2026-10-14"), { start: "2026-10-12", end: "2026-10-18" });
  assert.deepEqual(reportPeriod("lastweek", "2026-10-12"), { start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(reportPeriod("month", "2026-02-10"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(reportPeriod("all", "2026-10-20", records), { start: "2026-10-01", end: "2026-10-13" });
  assert.deepEqual(reportPeriod("all", "2026-10-20", []), { start: "2026-10-20", end: "2026-10-20" });
  assert.equal(reportKind("2026-10-12", "2026-10-18"), "週報");
  assert.equal(reportKind("2026-10-12", "2026-10-12"), "日報");
});

test("buildReport 依日期：舊到新、只算期間內和選的專案", () => {
  const rep = buildReport(records, { start: "2026-10-12", end: "2026-10-18", project: "CCD設備安裝" });
  assert.deepEqual(rep.groups.map((g) => g.key), ["2026-10-12", "2026-10-13"]);
  assert.deepEqual(rep.groups[1].records.map((r) => r.id), [4, 3]);
  assert.deepEqual(rep.summary, { workDays: 2, records: 4, stages: 3, photos: 2 });
  assert.equal(rep.singleProject, "CCD設備安裝");
  assert.equal(rep.kind, "週報");

  const all = buildReport(records, { start: "2026-10-01", end: "2026-10-31" });
  assert.equal(all.singleProject, null, "多個專案時每筆要印專案名稱");
});

test("buildReport 依工作進度：同一階段跨天的紀錄集中，順序是第一次出現的時間", () => {
  const rep = buildReport(records, { start: "2026-10-12", end: "2026-10-18", groupBy: "stage" });
  assert.deepEqual(rep.groups.map((g) => g.key), ["送料設備定位", "配線", "CCD安裝"]);
  const first = rep.groups[0];
  assert.deepEqual(first.records.map((r) => r.id), [1, 4]);
  assert.equal(first.days, 2);
  assert.equal(first.photos, 2);
});
