// 專案紀錄的欄位規則（純函式）。
// 前後端共用：server.js 用它驗證寫入，frontend/app.js 透過 /lib/rules.js 直接 import 它排序、產生報表。
// 所以這支檔案**不能 import 任何 node: 模組**，要能直接在瀏覽器跑。

export const SHIFTS = ["早", "中", "晚"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 本地時區的今天，格式 YYYY-MM-DD。刻意不用 toISOString()——那是 UTC，
// 台灣早上 8 點前會變成「昨天」。
export function todayString(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === "string" && TIME_RE.test(s);
}

// b - a 的天數（兩個都是 YYYY-MM-DD）
export function daysBetween(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 照片資料夾名稱：2026-10-12 → 20261012（照片放在 <DATA_DIR>/照片/20261012/） */
export function dateToPhotoFolder(date) {
  return String(date).replaceAll("-", "");
}

/**
 * 照片檔名只能是單純的檔名：不能有路徑分隔符號、不能是 . 或 .. 開頭。
 * 紀錄裡只存檔名，實際位置由日期決定——舊 Excel 存絕對路徑，資料夾一改名就全部失效，
 * 這個 App 就是為了避開這個坑才這樣設計（見 schema.md）。
 */
export function isSafePhotoName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 200 &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !name.startsWith(".");
}

const blankToNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

/**
 * 驗證並整理一筆紀錄。input 是「完整的」紀錄（更新時由呼叫端先把舊資料和新欄位合併）。
 * photos 每一張是 { file, caption }；剛上傳、還在暫存區的照片多帶 staged:true，
 * 由 server.js 在存檔時搬進日期資料夾後拿掉這個旗標（data.json 裡不會出現 staged）。
 * @returns {{ value: object|null, errors: string[] }}
 */
export function normalizeRecord(input) {
  const errors = [];
  const value = {
    date: blankToNull(input.date),
    shift: text(input.shift),
    start: blankToNull(input.start),
    end: blankToNull(input.end),
    project: text(input.project),
    stage: text(input.stage),
    content: text(input.content),
    photos: [],
  };

  if (!isValidDate(value.date)) errors.push("日期格式須為 YYYY-MM-DD");
  if (!SHIFTS.includes(value.shift)) errors.push(`班別必須是：${SHIFTS.join("／")}`);
  if (!value.project) errors.push("專案名稱為必填");
  if (!value.stage) errors.push("工作進度為必填");
  if (!value.content) errors.push("工作內容為必填");
  if (value.start !== null && !isValidTime(value.start)) errors.push("開始時間格式須為 HH:MM");
  if (value.end !== null && !isValidTime(value.end)) errors.push("結束時間格式須為 HH:MM");
  if (value.start && value.end && isValidTime(value.start) && isValidTime(value.end) && value.end < value.start) {
    errors.push("結束時間不能早於開始時間");
  }

  if (input.photos !== undefined && !Array.isArray(input.photos)) {
    errors.push("照片格式不對");
  } else {
    const seen = new Set();
    for (const p of input.photos || []) {
      const file = typeof p === "string" ? p : p?.file;
      if (!isSafePhotoName(file)) {
        errors.push(`照片檔名不合法：${file}`);
        continue;
      }
      if (seen.has(file)) continue; // 同一張不要重複參照
      seen.add(file);
      const photo = { file, caption: text(p?.caption) };
      if (p?.staged === true) photo.staged = true;
      value.photos.push(photo);
    }
  }

  return errors.length ? { value: null, errors } : { value, errors };
}

/** 紀錄排序：日期新到舊；同一天依開始時間早到晚（沒填時段的排最後），再依建立順序。 */
export function sortRecords(list) {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const sa = a.start || "99:99", sb = b.start || "99:99";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });
}

/** 舊到新（報表、匯出用）：日期早到晚，同一天依開始時間。 */
export function sortRecordsChronological(list) {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const sa = a.start || "99:99", sb = b.start || "99:99";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });
}

// 「最近用過」的順序：日期新到舊，同一天裡晚的排前面（跟畫面上同一天早到晚的排法相反）
function byRecency(list) {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const sa = a.start || "", sb = b.start || "";
    if (sa !== sb) return sa < sb ? 1 : -1;
    return (b.id || 0) - (a.id || 0);
  });
}

function uniqueInOrder(values) {
  const out = [];
  for (const v of values) {
    const s = text(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 專案清單是開放式的：最近用過的排前面，再接 data.json 的 projects（預設清單）。
 * 不要寫死成 enum——新專案隨時會冒出來。
 */
export function knownProjects({ projects = [], records = [] }) {
  return uniqueInOrder([...byRecency(records).map((r) => r.project), ...projects]);
}

/**
 * 工作進度也是開放清單：這個專案最近用過的排前面，其他專案用過的接在後面
 * （新專案還沒有紀錄時，也能直接點別的專案用過的階段名稱）。
 */
export function knownStages(records = [], project = "") {
  const sorted = byRecency(records);
  return uniqueInOrder([
    ...sorted.filter((r) => r.project === project).map((r) => r.stage),
    ...sorted.map((r) => r.stage),
  ]);
}

/**
 * 舊 Excel「時間」欄的時段字串 → { start, end }。
 * 接受 "0930-1200"、"09:30-12:00"、"9:30~12:00"；看不懂就回傳 null，由呼叫端決定怎麼保留原文。
 */
export function parseTimeRange(raw) {
  const s = text(raw).replace(/\s/g, "");
  if (!s) return { start: null, end: null };
  const m = s.match(/^(\d{1,2}):?(\d{2})[-~－～](\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const start = `${m[1].padStart(2, "0")}:${m[2]}`;
  const end = `${m[3].padStart(2, "0")}:${m[4]}`;
  if (!isValidTime(start) || !isValidTime(end)) return null;
  return { start, end };
}

export function timeRangeText(r) {
  return r.start || r.end ? `${r.start || ""}-${r.end || ""}` : "";
}

export function nextId(list) {
  return list.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
}

// ---------- 報表 ----------
// 日期一律用 UTC 運算：輸入輸出都是 YYYY-MM-DD 字串，跟機器時區無關。

function shiftDate(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayLabel(s) {
  return "日一二三四五六"[weekdayOf(s)];
}

export const REPORT_PRESETS = ["week", "lastweek", "month", "all"];

/**
 * 快速期間：本週（週一到週日）／上週／本月／整個專案（第一筆到最後一筆紀錄）。
 * 「整個專案」需要 records，沒有紀錄時回傳今天。
 */
export function reportPeriod(preset, today, records = []) {
  const monday = shiftDate(today, -((weekdayOf(today) + 6) % 7));
  switch (preset) {
    case "week":
      return { start: monday, end: shiftDate(monday, 6) };
    case "lastweek":
      return { start: shiftDate(monday, -7), end: shiftDate(monday, -1) };
    case "month": {
      const [y, m] = today.split("-").map(Number);
      return { start: `${today.slice(0, 7)}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
    }
    case "all": {
      const dates = records.map((r) => r.date).filter(Boolean).sort();
      return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : { start: today, end: today };
    }
    default:
      return null;
  }
}

/** 依期間決定報表名稱：日報／週報（週一到週日）／月報（整個月）／其他一律「報告」 */
export function reportKind(start, end) {
  if (start === end) return "日報";
  if (weekdayOf(start) === 1 && daysBetween(start, end) === 6) return "週報";
  if (start.endsWith("-01") && start.slice(0, 7) === end.slice(0, 7) && shiftDate(end, 1).endsWith("-01")) return "月報";
  return "報告";
}

export const REPORT_GROUPS = ["date", "stage"];

/**
 * 報表：只用現有欄位計算，不需要另外填任何東西。
 *
 * - groupBy "date"：依日期分組（舊到新），給主管看這段期間做了什麼
 * - groupBy "stage"：依工作進度分組，順序是「這個階段第一次出現的時間」，
 *   同一個階段分散在不同天的紀錄集中在一起——照片配說明，可以當員工教育訓練的參考資料
 * - project 是空字串代表全部專案
 * - 投入用「有紀錄的天數」，不加總時段（同一天的紀錄可能重疊）
 */
export function buildReport(records = [], { start, end, project = "", groupBy = "date" } = {}) {
  const inRange = records.filter((r) => r.date >= start && r.date <= end && (!project || r.project === project));
  const list = sortRecordsChronological(inRange);

  const groups = [];
  const keyOf = groupBy === "stage" ? (r) => r.stage : (r) => r.date;
  for (const r of list) {
    const key = keyOf(r);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, records: [] };
      groups.push(g);
    }
    g.records.push(r);
  }
  for (const g of groups) {
    g.photos = g.records.reduce((n, r) => n + (r.photos || []).length, 0);
    g.days = new Set(g.records.map((r) => r.date)).size;
  }

  const projects = uniqueInOrder(list.map((r) => r.project));
  return {
    start,
    end,
    project,
    groupBy,
    kind: reportKind(start, end),
    summary: {
      workDays: new Set(list.map((r) => r.date)).size,
      records: list.length,
      stages: new Set(list.map((r) => r.stage)).size,
      photos: list.reduce((n, r) => n + (r.photos || []).length, 0),
    },
    groups,
    projects,
    // 整段期間只有一個專案時，每筆紀錄就不用再印專案名稱，改在報頭註明（有值才顯示）
    singleProject: projects.length === 1 ? projects[0] : null,
  };
}
