// 專案紀錄的前端。驗證、排序、報表計算直接 import 後端同一支 rules.js，
// 不要在這裡另外寫一份——兩邊規則不一致時，畫面跟匯出的 Excel 會對不起來。
import {
  RECENT_STAGE_LIMIT, buildReport, dateToPhotoFolder, knownStages, reportPeriod, searchStages, similarStages, sortRecords,
  stageStats, todayString, weekdayLabel,
} from "/lib/rules.js";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

let data = { today: todayString(), projects: [], records: [], dataDir: "", exportFile: "" };
const state = {
  view: "entry",
  editingId: null,
  busy: false,
  loaded: false,
};
let draft = null;
let photoKey = 0;

// ---------- API ----------
async function api(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.errors || [`伺服器回應 ${res.status}`]).join("、"));
  return json;
}

async function loadData() {
  try {
    data = await api("GET", "/api/data");
    $("#load-error").hidden = true;
  } catch (err) {
    $("#load-error-msg").textContent = `讀不到資料：${err.message}。確認 start.bat 的黑色視窗還開著，再重新整理這一頁。`;
    $("#load-error").hidden = false;
  }
  if (!state.loaded) {
    state.loaded = true;
    draft = freshDraft();
  }
  renderAll();
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, size) => `<svg class="icon"${size ? ` style="width:${size}px;height:${size}px"` : ""}><use href="#${id}"/></svg>`;
const dlabel = (d) => { const [, m, dd] = d.split("-"); return `${+m}/${+dd}（${weekdayLabel(d)}）`; };
const trange = (r) => (r.start || r.end ? `${r.start || "?"}–${r.end || "?"}` : "未填時段");
const photoUrl = (date, file) => `/photos/${dateToPhotoFolder(date)}/${encodeURIComponent(file)}`;
const stagedUrl = (file) => `/photos/_暫存/${encodeURIComponent(file)}`;
// data.projects 由後端 knownProjects() 算好，最近用過的排第一個
const currentProject = () => data.projects[0] || "";
const findRecord = (id) => data.records.find((r) => r.id === id);

function imgTag(src, alt) {
  return `<img src="${esc(src)}" alt="${esc(alt || "工作照片")}" loading="lazy" data-photo>`;
}
// 照片檔案不見了（例如手動刪掉、舊 Excel 的照片沒放進資料夾）：顯示檔名，不要一個破圖示
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute("data-photo")) return;
  const name = decodeURIComponent(img.src.split("/").pop() || "");
  img.replaceWith(Object.assign(document.createElement("div"), { className: "missing", textContent: `找不到照片\n${name}` }));
}, true);

function defaultShift(date) {
  const sameDay = sortRecords(data.records).filter((r) => r.date === date);
  if (sameDay.length) return sameDay[sameDay.length - 1].shift;
  const h = new Date().getHours();
  return h >= 6 && h < 14 ? "早" : h >= 14 && h < 22 ? "中" : "晚";
}

/** 新的空白表單：日期今天、班別依時間、開始時間接當天最後一筆、專案／工作進度沿用上一筆 */
function freshDraft(keep = {}) {
  const date = keep.date || data.today;
  const sameDay = sortRecords(data.records).filter((r) => r.date === date && r.end);
  const project = keep.project ?? currentProject();
  return {
    date,
    shift: keep.shift || defaultShift(date),
    start: sameDay.length ? sameDay.map((r) => r.end).sort().pop() : "",
    end: "",
    project,
    stage: keep.stage ?? knownStages(data.records, project)[0] ?? "",
    content: "",
    photos: [],
  };
}

function isDirty() {
  if (!draft) return false;
  if (state.editingId !== null) return true;
  return Boolean(draft.content.trim()) || draft.photos.length > 0;
}

// ---------- 導覽 ----------
function go(view) {
  state.view = view;
  $$(".nav button").forEach((b) => (b.dataset.view === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  for (const v of ["entry", "list", "report"]) $(`#view-${v}`).hidden = v !== view;
  renderView();
  window.scrollTo(0, 0);
}
$$(".nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));

function renderAll() {
  $("#nav-count").textContent = data.records.length || "";
  $("#brand-project").textContent = currentProject();
  $("#data-path").textContent = data.dataDir ? `資料：${data.dataDir}` : "";
  renderView();
}
function renderView() {
  if (!draft) return;
  if (state.view === "entry") renderForm();
  if (state.view === "list") renderList();
  if (state.view === "report") renderReport();
}

// ---------- 新增／修改 ----------
function renderForm() {
  const editing = state.editingId !== null;
  $("#f-date").value = draft.date;
  $("#f-start").value = draft.start || "";
  $("#f-end").value = draft.end || "";
  if ($("#f-content").value !== draft.content) $("#f-content").value = draft.content;
  $$("#f-shift button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === draft.shift)));
  renderChips("project", data.projects, "輸入新專案…");
  renderStageChips();
  renderPhotos();
  $("#entry-title").textContent = editing ? "修改紀錄" : "新增紀錄";
  $("#nav-entry-label").textContent = editing ? "修改紀錄" : "新增紀錄";
  $("#entry-sub").textContent = editing
    ? "改完按儲存；刪除要按兩次確認，照片檔案會一起刪掉"
    : "日期、班別、時段已依目前時間和上一筆帶入";
  $("#save-label").textContent = editing ? "儲存變更" : "儲存紀錄";
  $("#cancel-btn").hidden = !editing;
  $("#del-btn").hidden = !editing;
  $("#clear-btn").hidden = editing || !isDirty();
  renderTimeline();
}

// 專案：標籤列（專案不會多到排不下）
function renderChips(key, list, placeholder) {
  const box = $(`#f-${key}`);
  const values = draft[key] && !list.includes(draft[key]) ? [draft[key], ...list] : list;
  box.innerHTML = values.map((v) => `<button type="button" class="chip" aria-pressed="${v === draft[key]}" data-v="${esc(v)}">${esc(v)}</button>`).join("")
    + `<input class="chip-input" id="f-${key}-new" placeholder="${placeholder}" aria-label="${placeholder}" maxlength="40">`;
  $$(".chip", box).forEach((c) => c.addEventListener("click", () => pickChip(key, c.dataset.v)));
  const inp = $(".chip-input", box);
  const commit = () => { const v = inp.value.trim(); if (v) pickChip(key, v); };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  inp.addEventListener("blur", commit);
}
function pickChip(key, value) {
  draft[key] = value;
  // 換專案時，工作進度如果是別的專案的，改成這個專案最近用的
  if (key === "project" && !knownStages(data.records.filter((r) => r.project === value), value).includes(draft.stage)) {
    draft.stage = knownStages(data.records.filter((r) => r.project === value), value)[0] || draft.stage;
  }
  setErr(key, false);
  renderForm();
}

// 工作進度：標籤列只放這個專案最近用過的幾個，其他的用搜尋框找，找不到就直接新增。
// 工作進度幾乎每筆都不一樣，全部列成標籤會越來越長（使用者 2026-10-13 選的方案）。
const stageInput = () => $("#f-stage-search");
const STAGE_ERR_DEFAULT = "選一個工作進度，或搜尋後按 Enter";
const combo = { open: false, active: 0, items: [] };

function renderStageChips() {
  const recent = stageStats(data.records, draft.project).slice(0, RECENT_STAGE_LIMIT).map((s) => s.name);
  // 目前選的一定要看得到（從搜尋選了比較舊的、或剛打的新名稱）
  const values = draft.stage && !recent.includes(draft.stage) ? [draft.stage, ...recent] : recent;
  const box = $("#f-stage");
  box.innerHTML = values.map((v) => `<button type="button" class="chip" aria-pressed="${v === draft.stage}" data-v="${esc(v)}">${esc(v)}</button>`).join("");
  $$(".chip", box).forEach((c) => c.addEventListener("click", () => pickStage(c.dataset.v)));
}
function pickStage(name) {
  const v = String(name || "").trim();
  if (!v) return;
  draft.stage = v;
  stageInput().value = "";
  closeCombo();
  setStageErr("");
  renderForm();
}
function setStageErr(msg) {
  $("#stage-err").textContent = msg || STAGE_ERR_DEFAULT;
  setErr("stage", Boolean(msg));
}
function markedName(name, marks) {
  const set = new Set(marks);
  return [...name].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}
const mdShort = (d) => { const [, m, dd] = d.split("-"); return `${+m}/${+dd}`; };

function openCombo() {
  combo.open = true;
  renderCombo();
}
function closeCombo() {
  combo.open = false;
  const input = stageInput();
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  $("#stage-list").hidden = true;
}
function renderCombo() {
  const input = stageInput();
  const q = input.value.trim();
  const stats = stageStats(data.records, draft.project);
  const hits = searchStages(stats, q).slice(0, 8);
  const exact = stats.some((s) => s.name === q);
  const similar = q && !exact ? similarStages(stats.map((s) => s.name), q).filter((n) => !hits.some((h) => h.name === n)) : [];
  combo.items = [...hits.map((h) => ({ name: h.name })), ...(q && !exact ? [{ name: q, isNew: true }] : [])];
  combo.active = Math.min(combo.active, Math.max(combo.items.length - 1, 0));

  const meta = (h) => (h.count ? `${h.count} 筆 · ${mdShort(h.lastDate)}` : "其他專案用過");
  let html = q || !stats.length ? "" : `<div class="combo-sec">最近用過（共 ${stats.length} 個）</div>`;
  html += hits.map((h, i) => `<div class="combo-opt" role="option" id="stage-opt-${i}" aria-selected="${i === combo.active}" data-i="${i}">
      <span>${markedName(h.name, h.marks)}</span><span class="meta">${meta(h)}</span></div>`).join("");
  if (similar.length) html += `<div class="combo-hint">已經有相似的：${similar.map(esc).join("、")}。確定要新增嗎？</div>`;
  if (q && !exact) {
    const i = hits.length;
    html += `<div class="combo-opt new" role="option" id="stage-opt-${i}" aria-selected="${i === combo.active}" data-i="${i}"><span>＋ 新增「${esc(q)}」</span></div>`;
  }
  if (!hits.length && !q) html += `<div class="combo-empty">還沒有工作進度，直接輸入第一個。</div>`;

  const list = $("#stage-list");
  list.innerHTML = html;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-activedescendant", `stage-opt-${combo.active}`);
  $$(".combo-opt", list).forEach((el) => {
    // mousedown 而不是 click：click 之前輸入框會先 blur，清單已經被關掉了
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pickStage(combo.items[Number(el.dataset.i)].name); });
  });
  $(".combo-opt[aria-selected=true]", list)?.scrollIntoView({ block: "nearest" });
}

stageInput().addEventListener("focus", () => { combo.active = 0; openCombo(); });
stageInput().addEventListener("input", () => { combo.active = 0; setStageErr(""); openCombo(); });
stageInput().addEventListener("blur", () => closeCombo()); // 打到一半的文字留著，按儲存時會提醒，不會默默丟掉
stageInput().addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) return; // Ctrl+Enter 是儲存，交給全域的處理（搜尋框有字時 save() 會提醒）
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!combo.open) return openCombo();
    const n = combo.items.length;
    if (n) combo.active = (combo.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    renderCombo();
  } else if (e.key === "Enter") {
    e.preventDefault(); // 輸入框在 <form> 裡，不擋的話 Enter 會直接送出整張表單
    const item = combo.open ? combo.items[combo.active] : null;
    if (item) pickStage(item.name);
  } else if (e.key === "Escape" && combo.open) {
    e.preventDefault();
    closeCombo();
  }
});

function renderPhotos() {
  const grid = $("#f-photos");
  $("#p-count").textContent = draft.photos.length ? `（${draft.photos.length} 張）` : "";
  grid.innerHTML = draft.photos.map((p, i) => `
    <div class="pcard${p.error ? " failed" : ""}" draggable="true" data-i="${i}">
      <div class="pimg">${p.preview ? imgTag(p.preview, p.caption) : ""}
        <span class="grip" title="拖曳調整順序" aria-hidden="true">${icon("i-grip", 16)}</span>
        <span class="tools"><button type="button" data-rm="${i}" aria-label="移除第 ${i + 1} 張照片">${icon("i-x", 16)}</button></span>
        <span class="idx mono">${i + 1}</span>
        ${p.uploading ? `<span class="state">上傳中…</span>` : p.error ? `<span class="state bad">${esc(p.error)}</span>` : ""}
      </div>
      <textarea class="input" id="cap-${p.key}" rows="2" maxlength="200" placeholder="照片說明，例如：水平儀確認台面" aria-label="第 ${i + 1} 張照片說明">${esc(p.caption)}</textarea>
    </div>`).join("");

  $$("textarea", grid).forEach((t, i) => t.addEventListener("input", () => { draft.photos[i].caption = t.value; renderTimeline(); }));
  $$("[data-rm]", grid).forEach((b) => b.addEventListener("click", () => removePhoto(Number(b.dataset.rm))));

  let from = null;
  $$(".pcard", grid).forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      if (e.target.closest("textarea")) return;
      from = Number(card.dataset.i);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "photo");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (e) => { if (from !== null) { e.preventDefault(); card.classList.add("over"); } });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("over");
      const to = Number(card.dataset.i);
      if (from !== null && from !== to) {
        const [moved] = draft.photos.splice(from, 1);
        draft.photos.splice(to, 0, moved);
        renderPhotos();
        renderTimeline();
      }
      from = null;
    });
  });
}

// 選了照片就立刻上傳到暫存區（不是按儲存才傳：重複按儲存會把同一批照片傳兩次，產線日誌修過這個 bug）
async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/"));
  if (!images.length) return toast("只能加入圖片檔", null, null, true);
  const firstNew = draft.photos.length;
  const owner = draft;
  for (const f of images) {
    const entry = { key: ++photoKey, file: null, caption: "", staged: true, uploading: true, error: "", abandoned: false, preview: URL.createObjectURL(f) };
    owner.photos.push(entry);
    upload(entry, f);
  }
  renderForm();
  $(`#cap-${owner.photos[firstNew].key}`)?.focus();
}

async function upload(entry, file) {
  const fd = new FormData();
  fd.append("photo", file, file.name);
  try {
    const { file: saved } = await api("POST", "/api/photos", fd);
    entry.file = saved;
    // 上傳途中使用者已經把這張移除（或放棄整張表單）：上傳完自己補刪，不留在暫存區
    if (entry.abandoned) return discardStaged(entry);
  } catch (err) {
    entry.error = `上傳失敗：${err.message}`;
  } finally {
    entry.uploading = false;
    if (state.view === "entry" && draft.photos.includes(entry)) { renderPhotos(); updateSaveStatus(); }
  }
}

function discardStaged(entry) {
  if (entry.uploading) { entry.abandoned = true; return; }
  if (entry.staged && entry.file) api("DELETE", `/api/photos/staged/${encodeURIComponent(entry.file)}`).catch(() => {});
}

function removePhoto(i) {
  const [removed] = draft.photos.splice(i, 1);
  const owner = draft;
  renderForm();
  // 5 秒內可以復原；時間到才真的刪暫存檔（已存進紀錄的照片要按儲存才會刪）
  let undone = false;
  toast("已移除 1 張照片", "復原", () => {
    undone = true;
    owner.photos.splice(Math.min(i, owner.photos.length), 0, removed);
    if (owner === draft) renderForm();
  });
  setTimeout(() => { if (!undone) discardStaged(removed); }, 5200);
}

$("#f-file").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); drop.classList.add("over"); } });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
// 照片直接拖到表單任何地方也收
$("#form").addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
$("#form").addEventListener("drop", (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

$("#f-date").addEventListener("change", (e) => { draft.date = e.target.value; setErr("date", false); renderTimeline(); });
$("#f-start").addEventListener("change", (e) => { draft.start = e.target.value; checkTime(); renderTimeline(); });
$("#f-end").addEventListener("change", (e) => { draft.end = e.target.value; checkTime(); renderTimeline(); });
$("#f-content").addEventListener("input", (e) => {
  draft.content = e.target.value;
  setErr("content", false);
  $("#clear-btn").hidden = state.editingId !== null || !isDirty();
  renderTimeline();
});
$$("#f-shift button").forEach((b) => b.addEventListener("click", () => { draft.shift = b.dataset.v; renderForm(); }));

function setErr(key, on) {
  const f = $(`#fd-${key}`);
  if (!f) return;
  f.classList.toggle("invalid", on);
  $(".err", f).hidden = !on;
}
function checkTime() {
  const bad = Boolean(draft.start && draft.end && draft.end < draft.start);
  setErr("time", bad);
  return !bad;
}
function updateSaveStatus(msg, bad = false) {
  const el = $("#save-status");
  const uploading = draft.photos.filter((p) => p.uploading).length;
  el.textContent = msg || (uploading ? `照片上傳中（${uploading} 張）…` : "");
  el.classList.toggle("bad", bad);
}

async function save() {
  if (state.busy) return;
  // 搜尋框裡打了字但還沒選：不要默默丟掉，也不要猜是不是要新增
  const pending = stageInput().value.trim();
  if (pending) {
    setStageErr(`「${pending}」還沒選：按 Enter 選取或新增，或把搜尋框清空`);
    stageInput().focus();
    return;
  }
  const missing = [];
  if (!draft.date) missing.push("date");
  if (!draft.project) missing.push("project");
  if (!draft.stage) missing.push("stage");
  if (!draft.content.trim()) missing.push("content");
  for (const k of ["date", "project", "stage", "content"]) setErr(k, missing.includes(k));
  $("#stage-err").textContent = STAGE_ERR_DEFAULT;
  if (!checkTime()) missing.push("time");
  if (missing.length) {
    const first = missing[0];
    ({ date: $("#f-date"), project: $("#f-project-new"), stage: stageInput(), content: $("#f-content"), time: $("#f-end") })[first]?.focus();
    return;
  }
  if (draft.photos.some((p) => p.uploading)) return updateSaveStatus("照片還在上傳，等一下再儲存", true);
  if (draft.photos.some((p) => p.error)) return updateSaveStatus("有照片上傳失敗，移除那張再儲存", true);

  const body = {
    date: draft.date, shift: draft.shift, start: draft.start || null, end: draft.end || null,
    project: draft.project, stage: draft.stage, content: draft.content,
    photos: draft.photos.map((p) => ({ file: p.file, caption: p.caption, ...(p.staged ? { staged: true } : {}) })),
  };
  state.busy = true;
  $("#save-btn").disabled = true;
  updateSaveStatus("儲存中…");
  try {
    const editing = state.editingId !== null;
    const { item } = editing
      ? await api("PUT", `/api/records/${state.editingId}`, body)
      : await api("POST", "/api/records", body);
    state.editingId = null;
    await loadData();
    draft = freshDraft({ date: item.date, shift: item.shift, project: item.project, stage: item.stage });
    renderForm();
    updateSaveStatus();
    if (editing) {
      toast("已儲存變更", "查看紀錄", () => go("list"));
    } else {
      toast(`已儲存 · ${dlabel(item.date)} ${trange(item)}`, "查看紀錄", () => go("list"));
      $("#f-content").focus();
    }
  } catch (err) {
    updateSaveStatus(`沒有存成功：${err.message}`, true);
  } finally {
    state.busy = false;
    $("#save-btn").disabled = false;
  }
}
$("#form").addEventListener("submit", (e) => { e.preventDefault(); save(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && state.view === "entry" && $("#lb").hidden) {
    e.preventDefault();
    save();
  }
});

function abandonDraft() {
  for (const p of draft.photos) discardStaged(p);
}
function startNew(keep) {
  abandonDraft();
  state.editingId = null;
  draft = freshDraft(keep);
  stageInput().value = "";
  setErrAll(false);
  updateSaveStatus();
  renderForm();
}
function setErrAll(on) { for (const k of ["date", "time", "project", "stage", "content"]) setErr(k, on); }

$("#cancel-btn").addEventListener("click", () => { startNew(); go("list"); });
$("#clear-btn").addEventListener("click", () => {
  const keep = { date: draft.date, shift: draft.shift, project: draft.project, stage: draft.stage };
  startNew(keep);
  toast("已清空表單");
});

let delTimer = null;
$("#del-btn").addEventListener("click", async () => {
  const b = $("#del-btn");
  if (!b.classList.contains("armed")) {
    b.classList.add("armed");
    b.textContent = "再按一次確認刪除";
    clearTimeout(delTimer);
    delTimer = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  try {
    await api("DELETE", `/api/records/${state.editingId}`);
    state.editingId = null;
    await loadData();
    startNew();
    go("list");
    toast("已刪除這筆紀錄");
  } catch (err) {
    updateSaveStatus(`刪除失敗：${err.message}`, true);
  }
});
function disarmDelete() {
  clearTimeout(delTimer);
  const b = $("#del-btn");
  b.classList.remove("armed");
  b.textContent = "刪除這筆";
}

function edit(id, force = false) {
  const r = findRecord(id);
  if (!r) return;
  if (!force && isDirty() && state.editingId !== id) {
    toast("表單裡還有沒儲存的內容", "放棄並修改這筆", () => edit(id, true));
    return;
  }
  abandonDraft();
  state.editingId = id;
  disarmDelete();
  draft = {
    date: r.date, shift: r.shift, start: r.start || "", end: r.end || "",
    project: r.project, stage: r.stage, content: r.content,
    photos: (r.photos || []).map((p) => ({ key: ++photoKey, file: p.file, caption: p.caption, staged: false, preview: photoUrl(r.date, p.file) })),
  };
  stageInput().value = "";
  setErrAll(false);
  updateSaveStatus();
  go("entry");
}

function renderTimeline() {
  const day = sortRecords(data.records).filter((r) => r.date === draft.date && r.id !== state.editingId);
  const items = [...day, { ...draft, isDraft: true }].sort((a, b) => (a.start || "99:99").localeCompare(b.start || "99:99"));
  $("#tl-sub").textContent = draft.date ? `${dlabel(draft.date)} · 已存 ${day.length} 筆` : "";
  $("#timeline").innerHTML = items.map((r) => {
    const thumbs = (r.photos || []).slice(0, 6).map((p) => {
      const src = r.isDraft ? p.preview : photoUrl(r.date, p.file);
      return `<span>${src ? `<img src="${esc(src)}" alt="" loading="lazy" data-photo>` : ""}</span>`;
    }).join("");
    return `<li class="${r.isDraft ? "draft" : ""}">
      <div class="t mono">${trange(r)} · ${esc(r.shift)}班${r.isDraft ? (state.editingId !== null ? " · 修改中" : " · 正在填寫") : ""}</div>
      <div class="s">${esc(r.stage || "（還沒選工作進度）")}</div>
      ${r.content ? `<div class="c">${esc(r.content)}</div>` : ""}
      ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
    </li>`;
  }).join("");
}

window.addEventListener("beforeunload", (e) => {
  if (isDirty() && state.editingId === null) e.preventDefault();
});

// ---------- 紀錄 ----------
function fillSelect(sel, allLabel, values) {
  const el = $(sel);
  const prev = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
  el.value = values.includes(prev) ? prev : "";
}
function highlight(text, q) {
  const t = esc(text);
  if (!q) return t;
  const pattern = esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(pattern, "gi"), (m) => `<mark>${m}</mark>`);
}

function renderList() {
  fillSelect("#fl-project", "全部專案", data.projects);
  fillSelect("#fl-stage", "全部工作進度", knownStages(data.records, $("#fl-project").value));
  const q = $("#q").value.trim();
  const fp = $("#fl-project").value;
  const fs = $("#fl-stage").value;
  const all = data.records;
  const photoCount = all.reduce((n, r) => n + (r.photos || []).length, 0);
  $("#list-sub").textContent = all.length
    ? `共 ${all.length} 筆 · ${new Set(all.map((r) => r.date)).size} 個工作天 · ${photoCount} 張照片`
    : "";

  if (!all.length) {
    $("#list").innerHTML = `<div class="card empty"><b>還沒有任何紀錄</b>到「新增紀錄」記下第一筆，照片可以直接拖進去。</div>`;
    return;
  }
  const lower = q.toLowerCase();
  const rows = sortRecords(all).filter((r) => (!fp || r.project === fp) && (!fs || r.stage === fs) &&
    (!q || [r.content, r.stage, ...(r.photos || []).map((p) => p.caption)].some((t) => String(t).toLowerCase().includes(lower))));
  if (!rows.length) {
    $("#list").innerHTML = `<div class="card empty"><b>找不到符合的紀錄</b>換個關鍵字，或把專案、工作進度改回「全部」。</div>`;
    return;
  }
  const dates = [...new Set(rows.map((r) => r.date))];
  $("#list").innerHTML = dates.map((d) => {
    const rs = rows.filter((r) => r.date === d);
    return `<section class="day"><div class="day-h"><b>${dlabel(d)}</b><span>${rs.length} 筆</span></div>
      ${rs.map((r) => `<article class="card rec">
        <div class="rec-h"><span class="mono">${trange(r)}</span><span class="tag">${esc(r.shift)}班</span>
          <span class="tag stage">${highlight(r.stage, q)}</span><span class="proj">${esc(r.project)}</span>
          <button class="btn ghost act" data-edit="${r.id}">${icon("i-edit")}修改</button></div>
        <p class="rec-c">${highlight(r.content, q)}</p>
        ${(r.photos || []).length ? `<div class="rgrid">${r.photos.map((p, i) => `
          <button class="rph" data-r="${r.id}" data-i="${i}" aria-label="放大第 ${i + 1} 張照片${p.caption ? "：" + esc(p.caption) : ""}">
            <div class="pimg">${imgTag(photoUrl(r.date, p.file), p.caption)}</div>
            <span class="cap${p.caption ? "" : " none"}">${p.caption ? highlight(p.caption, q) : "沒有說明"}</span></button>`).join("")}</div>` : ""}
      </article>`).join("")}</section>`;
  }).join("");
  $$("[data-edit]", $("#list")).forEach((b) => b.addEventListener("click", () => edit(Number(b.dataset.edit))));
  $$(".rph", $("#list")).forEach((b) => b.addEventListener("click", () => openLightbox(Number(b.dataset.r), Number(b.dataset.i))));
}
$("#q").addEventListener("input", renderList);
$("#fl-project").addEventListener("change", renderList);
$("#fl-stage").addEventListener("change", renderList);

// ---------- 燈箱：放大看照片、直接改說明 ----------
let lb = null;
function openLightbox(rid, i) {
  lb = { rid, i, returnTo: document.activeElement, original: null };
  $("#lb").hidden = false;
  drawLightbox();
  $("#lb-cap").focus();
}
function drawLightbox() {
  const r = findRecord(lb.rid);
  const p = r.photos[lb.i];
  const n = r.photos.length;
  lb.original = p.caption;
  $("#lb-img").innerHTML = imgTag(photoUrl(r.date, p.file), p.caption) + (n > 1
    ? `<button class="nav-b prev" aria-label="上一張">${icon("i-left")}</button><button class="nav-b next" aria-label="下一張">${icon("i-right")}</button>`
    : "");
  $("#lb-n").textContent = `${lb.i + 1} / ${n}`;
  $("#lb-cap").value = p.caption;
  $("#lb-where").textContent = `${dlabel(r.date)} ${trange(r)} · ${r.stage} · ${p.file} · 說明改完按 Enter 或離開欄位就會儲存`;
  $("#lb-img .prev")?.addEventListener("click", () => stepLightbox(-1));
  $("#lb-img .next")?.addEventListener("click", () => stepLightbox(1));
}
async function saveCaption() {
  if (!lb) return;
  const r = findRecord(lb.rid);
  const value = $("#lb-cap").value.trim();
  if (value === (lb.original || "")) return;
  const photos = r.photos.map((p, idx) => ({ file: p.file, caption: idx === lb.i ? value : p.caption }));
  try {
    await api("PUT", `/api/records/${r.id}`, { photos });
    r.photos[lb.i].caption = value;
    lb.original = value;
    toast("照片說明已儲存");
  } catch (err) {
    toast(`說明沒有存成功：${err.message}`, null, null, true);
  }
}
async function stepLightbox(d) {
  await saveCaption();
  const n = findRecord(lb.rid).photos.length;
  lb.i = (lb.i + d + n) % n;
  drawLightbox();
}
async function closeLightbox() {
  await saveCaption();
  const back = lb?.returnTo;
  $("#lb").hidden = true;
  lb = null;
  await loadData();
  back?.focus?.();
}
$("#lb-cap").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCaption(); } });
$("#lb-cap").addEventListener("blur", saveCaption);
$("#lb-close").addEventListener("click", closeLightbox);
$("#lb").addEventListener("click", (e) => { if (e.target.id === "lb") closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (!lb) return;
  if (e.key === "Escape") closeLightbox();
  if (e.target.id !== "lb-cap" && e.key === "ArrowLeft") stepLightbox(-1);
  if (e.target.id !== "lb-cap" && e.key === "ArrowRight") stepLightbox(1);
});

// ---------- 報表 ----------
const rp = { range: "week", group: "date", from: "", to: "", project: null };

function renderReport() {
  if (rp.project === null) rp.project = currentProject();
  fillSelect("#rp-project", "全部專案", data.projects);
  $("#rp-project").value = data.projects.includes(rp.project) ? rp.project : "";
  $$("#rp-range button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === rp.range)));
  $$("#rp-group button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === rp.group)));
  $("#rp-custom").hidden = rp.range !== "custom";

  const scoped = data.records.filter((r) => !rp.project || r.project === rp.project);
  const period = rp.range === "custom"
    ? { start: rp.from || data.today, end: rp.to || data.today }
    : reportPeriod(rp.range, data.today, scoped);
  if (period.end < period.start) [period.start, period.end] = [period.end, period.start];
  rp.from = period.start;
  rp.to = period.end;
  $("#rp-from").value = period.start;
  $("#rp-to").value = period.end;

  const report = buildReport(data.records, { start: period.start, end: period.end, project: rp.project, groupBy: rp.group });
  $("#paper").innerHTML = reportHtml(report);
}

function reportHtml(rep) {
  const slash = (d) => d.replaceAll("-", "/");
  const projectLabel = rep.project || rep.singleProject || "全部專案";
  const showProject = !rep.singleProject;
  const title = rep.groupBy === "stage" ? "作業紀錄" : `專案工作${rep.kind}`;
  const fig = (r, p) => `<figure><div class="pimg">${imgTag(photoUrl(r.date, p.file), p.caption)}</div>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`;
  const item = (r, head) => `<div class="it">
      <div class="it-h"><b>${head}</b><span class="mono">${trange(r)}</span><span>${esc(r.shift)}班</span>${showProject ? `<span>${esc(r.project)}</span>` : ""}</div>
      <p class="it-c">${esc(r.content)}</p>
      ${(r.photos || []).length ? `<div class="pp">${r.photos.map((p) => fig(r, p)).join("")}</div>` : ""}
    </div>`;

  let body;
  if (!rep.groups.length) {
    body = `<p class="none">這段期間沒有紀錄。換個期間，或把專案改成「全部專案」。</p>`;
  } else if (rep.groupBy === "stage") {
    body = rep.groups.map((g, i) => `<h3>${i + 1}．${esc(g.key)}<small>${g.records.length} 筆 · ${g.days} 天 · ${g.photos} 張照片</small></h3>`
      + g.records.map((r) => item(r, dlabel(r.date))).join("")).join("");
  } else {
    body = rep.groups.map((g) => `<h3>${dlabel(g.key)}<small>${g.records.length} 筆</small></h3>`
      + g.records.map((r) => item(r, esc(r.stage))).join("")).join("");
  }
  return `
    <header class="mast"><h2>${title}</h2>
      <div class="meta">${esc(projectLabel)}<br><span class="mono">${slash(rep.start)}${rep.start === rep.end ? "" : " – " + slash(rep.end)}</span></div></header>
    <div class="sum"><div><b>${rep.summary.workDays}</b>工作天數</div><div><b>${rep.summary.records}</b>紀錄</div><div><b>${rep.summary.stages}</b>工作進度</div><div><b>${rep.summary.photos}</b>照片</div></div>
    ${body}
    <div class="foot"><span>${rep.groupBy === "stage" ? "依工作進度整理，同一階段的紀錄集中在一起，可作為教育訓練參考" : "依日期排列"}</span><span>產出：${slash(data.today)}</span></div>`;
}

$$("#rp-range button").forEach((b) => b.addEventListener("click", () => { rp.range = b.dataset.v; renderReport(); }));
$$("#rp-group button").forEach((b) => b.addEventListener("click", () => { rp.group = b.dataset.v; renderReport(); }));
$("#rp-project").addEventListener("change", (e) => { rp.project = e.target.value; renderReport(); });
$("#rp-from").addEventListener("change", (e) => { rp.from = e.target.value; renderReport(); });
$("#rp-to").addEventListener("change", (e) => { rp.to = e.target.value; renderReport(); });
$("#rp-print").addEventListener("click", () => window.print());

// 開新視窗方便整頁截圖：把算好的報表 HTML 複製到沒有側邊選單的分頁。
// 一定要帶 <base href>，不然照片的 /photos/... 路徑在新分頁解析不到（姊妹專案同一套做法）。
$("#rp-window").addEventListener("click", () => {
  const win = window.open("", "_blank");
  if (!win) return toast("瀏覽器擋住了新視窗，請允許這個網站開彈出視窗後再試一次", null, null, true);
  const styles = $$('link[rel="stylesheet"], link[rel="preconnect"], style').map((n) => n.outerHTML).join("");
  win.document.write(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><base href="${location.origin}/">` +
    `<title>${esc($("#paper .mast h2")?.textContent || "報表")}</title>${styles}</head>` +
    `<body style="background:#e9e7df;padding:32px 16px;margin:0"><article class="paper" style="width:100%;max-width:860px;margin:0 auto">${$("#paper").innerHTML}</article></body></html>`,
  );
  win.document.close();
});

// ---------- 匯出 ----------
$("#export-btn").addEventListener("click", async () => {
  try {
    const { path } = await api("POST", "/api/export-xlsx");
    toast(`已匯出：${path}`);
  } catch (err) {
    toast(err.message, null, null, true);
  }
});

// ---------- toast ----------
let toastTimer = null;
function toast(msg, actionLabel, action, bad = false) {
  const el = $("#toast");
  $("#toast-msg").textContent = msg;
  el.classList.toggle("bad", bad);
  const btn = $("#toast-act");
  btn.hidden = !actionLabel;
  btn.onclick = actionLabel ? () => { el.hidden = true; action(); } : null;
  if (actionLabel) btn.textContent = actionLabel;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 5000 : bad ? 6000 : 3500);
}

loadData();
