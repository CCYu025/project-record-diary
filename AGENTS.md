# 專案紀錄

## 專案概述

記錄專案施工／設備安裝每天做了什麼的小工具，每張照片可以附一句說明。**單人使用、單機本地執行**，
取代原本手填的「工作紀錄.xlsx」（工作日誌表），但保留匯出成同樣格式 Excel 的能力。
資料格式見 [`backend/data/schema.md`](backend/data/schema.md)，改任何欄位前先讀那份。

架構刻意跟姊妹專案 [production-line-diary](https://github.com/CCYu025/production-line-diary)（產線日誌）、
[personal-work-diary](https://github.com/CCYu025/personal-work-diary)（個人工作日誌）一致，三個專案用同一套維護方式。
照片的處理沿用產線日誌的經驗，但改成「暫存區」做法（見核心不變量）。

## 快速啟動

```bash
npm install
cp .env.example .env   # 改成實際的 DATA_DIR / LEGACY_XLSX_PATH
npm run migrate        # 只有第一次搬遷舊 Excel 時需要
npm start              # 或雙擊 start.bat，開在 http://localhost:3002
```

## 架構

| 層 | 技術 |
|---|---|
| 前端 | 純 HTML/CSS/JS，無框架：`frontend/index.html`（畫面）＋ `frontend/app.js`（邏輯） |
| 後端 | Node.js（ESM）+ Express + multer，只聽 `127.0.0.1:3002` |
| 資料 | `DATA_DIR/data.json`，**不在這個 repo 裡** |
| 照片 | 檔案系統 `DATA_DIR/照片/<YYYYMMDD>/`，不是塞進資料庫的 blob |
| 測試 | Node 內建 `node:test` |
| CI | GitHub Actions：`ci.yml`（Ubuntu + Windows） |

## 關鍵檔案

| 檔案 | 職責 |
|---|---|
| `backend/lib/rules.js` | 欄位驗證（`normalizeRecord`）、排序、專案／工作進度清單與搜尋（`stageStats`／`searchStages`／`similarStages`）、報表計算（`buildReport`）。**前後端共用**（前端 import `/lib/rules.js`） |
| `backend/lib/photos.js` | 照片生命週期：暫存區 → 日期資料夾（`placePhotos`）、改日期搬檔、刪除沒人用的檔案、暫存區清理（`sweepStaging`） |
| `backend/lib/store.js` | `data.json` 讀寫；`createStoreQueue()` 把「讀→改→寫」排隊 |
| `backend/lib/xlsx.js` | 讀舊 Excel（搬遷）、寫匯出快照 |
| `backend/server.js` | REST API：`GET /api/data`、`/api/records` 的 POST/PUT/DELETE、`POST /api/photos`（上傳到暫存區）、`DELETE /api/photos/staged/:file`、`POST /api/export-xlsx`；`/photos` 提供照片檔 |
| `frontend/app.js` | 三個畫面（新增紀錄／紀錄／報表）、工作進度搜尋框、照片上傳與說明、燈箱 |
| `scripts/migrate.js` | 一次性搬遷；已有 `data.json` 時要 `--force` 才覆蓋，而且會先備份 |

## 核心不變量

這些是跟使用者討論後確認的決策，**改之前先重新評估，不要憑直覺改回「看起來更完整」的做法**：

- **這個 App 刻意很小**。欄位就是原本 Excel 的那幾欄：日期／班別／時段／專案名稱／工作進度／工作內容／照片，
  外加每張照片一句說明（選填）。2026-10-12 規劃時評估過三個方案：A 精簡流水帳、B 專案×設備進度看板
  （每台設備每個階段的狀態矩陣）、C 安裝教學手冊（檢查點、標準值、注意事項）。使用者先選 B、看過 mockup
  後**改選 A**。所以**不要加回**：設備欄位、階段狀態、進度矩陣、檢查點表格、注意事項欄。
  使用者自己的另一個專案從 16 欄砍到 7 欄，就是因為填起來太累。要加欄位先問使用者。
- **「設備」欄位已經拿掉**，舊 Excel 的設備值（例：`3、4`）搬遷時**直接捨棄**，不併進工作內容
  （使用者 2026-10-12 決定）。
- **照片說明是選填**。沒寫說明的照片在列表顯示淡色的「沒有說明」、報表不印說明列，不能改成必填。
- **員工教育資料靠報表的「依工作進度」排法**，不另外加欄位：同一個階段分散在不同天的紀錄集中在一起，
  照片配說明。階段順序是「第一次出現的時間」。
- **照片只存檔名**，位置由日期決定（`照片/<YYYYMMDD>/<檔名>`）。原本 Excel 存絕對路徑，資料夾改名後
  全部失效——不要改回存路徑。
- **照片選了就立刻上傳，先進 `照片/_暫存/`，按儲存才搬進日期資料夾**（`placePhotos`）。
  - 立刻上傳是產線日誌修過兩次 bug 才定案的：送出時才上傳，重複送出會把同一批照片傳兩次。
  - 暫存區是這個專案的改良：放棄填寫的照片不會混進日期資料夾；先上傳、後改日期也沒問題
    （產線日誌因此要擋「已上傳照片時不能改日期」）。
  - **孤兒清理（`sweepStaging`）只掃 `_暫存/`，絕對不能擴大到日期資料夾**。日期資料夾裡有 App 出現之前
    放進去的真實照片，還沒搬遷進 `data.json` 前全部都是「沒被參照」——掃日期資料夾會直接刪掉使用者的照片。
    1 小時的安全時間也不能拿掉（使用者可能剛選完照片、正在寫說明）。
  - 前端移除還沒儲存的照片時，5 秒內可以復原，時間到才刪暫存檔；上傳途中被移除的標 `abandoned`，
    上傳完成後自己補刪。這些都是「盡力而為」，最後一道防線是 `sweepStaging`。
- **日期資料夾的檔案只在兩種情況刪除**：修改紀錄時移除照片並儲存、刪除整筆紀錄；都要先確認沒有其他紀錄
  參照同一個 `(date, file)`（`deleteUnreferencedPhoto`）。刪除在**存檔成功之後**才做。
- **改日期時照片跟著搬**；別的紀錄也在用同一個檔案時用複製，不是搬走。
- **同名照片自動改名**（`名稱-1.jpg`），不覆蓋。LINE 存下來的照片檔名很容易重複。
- **刪除紀錄沒有回收桶**，按兩次確認（不用 `confirm()`），照片一起刪；資料夾在 OneDrive，有版本紀錄可以救。
  跟個人工作日誌同一套，不跟產線日誌的軟刪除。
- **`data.json` 是唯一事實來源**，Excel 只是匯出快照，**不要做雙向同步**（Excel 開著時會鎖檔）。
  匯出檔名 `專案紀錄_匯出.xlsx`，**故意跟搬遷來源 `工作紀錄.xlsx` 不同名**，絕對不能覆蓋使用者原本的 Excel。
  匯出 7 欄（拿掉設備），照片欄只放檔名、**不放說明**（使用者 2026-10-12 決定）。
- **匯出時 Excel 開著**會得到 `EBUSY`/`EPERM`，API 回 409 並提示「關掉之後再匯出」。
- **`shift` 是固定的 3 個值**（早／中／晚）；**`project`、`stage` 是開放清單**，最近用過的排前面
  （`knownProjects`／`knownStages`，同一天裡晚的比早的新），不要改成寫死的 enum。
- **工作進度的輸入是「最近 5 個標籤＋搜尋框」，不是把全部名稱列成標籤**（使用者 2026-10-13 選的方案 1）。
  工作進度實際上幾乎每筆都不一樣，全列成標籤會越來越長；專案不會多到排不下，所以專案還是標籤列。
  - 標籤列固定 `RECENT_STAGE_LIMIT`（5）個，只算**這個專案**最近用過的；目前選的一定要看得到（排最前面，所以最多 6 個）。
  - 搜尋框（`stageStats`／`searchStages`／`matchStage`，在 `rules.js`，有單元測試）：連續包含的優先，
    依序出現也找得到（「送調」→「送料機調整」）；清單每列顯示用過幾筆和最後使用日期；找不到就在最下面「＋ 新增」。
  - **輸入新名稱時，有相似的既有名稱會先提醒**（`similarStages`，共用連續兩個字）。這是防止名稱分岔的主要手段
    （例：送料設備定位／送料機運轉／送料機調整其實是同一台機器），報表「依工作進度」靠名稱一致才能把同一階段集中。
  - 搜尋框裡有打字但還沒選時按儲存，`save()` 會擋下來提醒、**不會默默丟掉也不會猜著新增**。Ctrl+Enter 要放行給全域儲存，
    搜尋框裡的 Enter 一定要 `preventDefault()`（在 `<form>` 裡，不擋會直接送出整張表單）。
  - 清單用 `mousedown` 選取，不是 `click`（click 之前輸入框先 blur，清單已經被關掉）。
  - **刻意沒做「整理工作進度」（批次改名／合併）的畫面**——使用者評估後決定不要（2026-10-13）。要改名請在「紀錄」
    逐筆修改。名稱分岔靠上面的相似提醒預防，不要順手加回來。
- **時段不拿來加總工時**。報表用「有紀錄的天數」。
- **新增表單的預設值**：日期今天、班別沿用當天上一筆（當天沒有就依時間）、開始時間接當天最後一筆的結束時間、
  專案和工作進度沿用上一筆。儲存後表單保留日期／班別／專案／工作進度，只清空內容和照片——
  一天通常連續記好幾筆。
- **表單內容在切換畫面時保留**（draft 存在記憶體），所以「修改」別筆時，如果表單有沒儲存的內容要先問。
  有沒儲存的新增內容時關分頁會跳瀏覽器的離開提醒。
- **報表跟姊妹專案一致**：選期間 → 產生 → `window.print()` 另存 PDF（不裝 puppeteer／jsPDF，中文字型問題）；
  「開新視窗」用 `window.open` ＋ `document.write` 複製已算好的 HTML，**一定要帶 `<base href>`**，
  不然照片的 `/photos/...` 在新分頁解析不到；被彈出視窗封鎖時要 toast 提示。紙本配色（`--paper*`，
  深色模式下也是白紙）、Noto Serif TC、雙線報頭。報表計算全在 `buildReport()`，`app.js` 只排版。
- **報表欄位有值才顯示**：整段期間只有一個專案 → 每筆不印專案名稱、改在報頭註明；照片沒說明 → 不印說明列。
- **`rules.js` 不能 import 任何模組**，瀏覽器直接載入它。`test/frontend.test.js` 有鎖。
  前端需要的規則一律從這裡 import，**不要在 `app.js` 另寫一份**。server 只開放 `/lib/rules.js` 這一支。
- **「今天」用本地時間**（`todayString()`），不要用 `toISOString().slice(0,10)`——那是 UTC，台灣早上 8 點前會變成昨天。
- **exceljs 的日期是 UTC 錨定的**：讀用 `getUTC*()`，寫用 `Date.UTC()`。`test/xlsx.test.js` 開頭把 `TZ`
  設成 `America/Los_Angeles` 才測得出來，**不要拿掉那行**。原本 Excel 的日期是數字 `20261012`，也要認得。
- **舊 Excel 照片路徑用 `path.win32.basename` 取檔名**，路徑一定是 Windows 格式，跟在哪個 OS 上跑無關
  （產線日誌在 Linux CI 上踩過）。上傳檔名整理（`safeFilename`）自己切最後一段，不用 `path.basename`——
  Windows 版會把 `a:b.jpg` 的 `a:` 當磁碟機代號吃掉。
- **multer 收到的中文檔名要從 latin1 轉回 UTF-8**（`decodeName`），不然中文檔名會變亂碼。`test/api.test.js` 有測。
- **寫入要排隊**（`createStoreQueue`）。前端也有 `state.busy` 擋連按，兩層都要留。
- **`[hidden]{ display:none !important; }` 不能拿掉**，畫面切換全靠它。
- **只聽 `127.0.0.1`、沒有帳號、先不支援手機**（使用者 2026-10-12 確認）。照片是手機拍、LINE 傳到電腦再拖進來。
  除非使用者明確要求，不要加雲端部署、登入、多人協作、手機版。
- **repo 公開時**：`backend/data/example/` 只能放虛構資料，測試資料也一樣。真實的 `data.json`、`.env`、照片絕不進版控。

## 測試

```bash
npm run check   # node --check
npm test        # node --test
```

手動驗證（改了畫面或 API 之後）：用一份**複製出來的**資料夾跑（`DATA_DIR` 指到暫存資料夾，裡面放
`工作紀錄.xlsx` 和 `照片/` 的複本，先 `npm run migrate`），不要拿真實資料點來點去。確認：
工作進度：標籤列只有 5 個、搜尋「送調」找得到「送料機調整」、↑↓ Enter 選取、輸入新名稱出現相似提醒、搜尋框有字時 Ctrl+Enter 會提醒而不是儲存；
新增一筆並拖兩張照片（其中一張跟既有照片同名）、寫說明、儲存後檔案在 `照片/<日期>/` 且同名的被改名、
`_暫存/` 是空的；紀錄搜尋照片說明；燈箱改說明、左右切換；修改紀錄移除一張照片、儲存後檔案真的被刪掉；
修改日期後照片搬到新資料夾；刪除整筆；報表切本週／上週／本月／整個專案、依日期／依工作進度；
列印預覽只剩報表本身；開新視窗照片有出來；匯出 Excel；瀏覽器 console 沒有錯誤。

## Git 工作流程

跟姊妹專案一樣：`main` 開 branch protection，只能透過 PR 合併、CI 綠燈才能合併。

```bash
git checkout -b <類型>/<簡短描述>   # 例如 fix/photo-rename
git push -u origin <分支名>
gh pr create --title "..." --body "..."
gh pr checks --watch
gh pr merge --squash --delete-branch
```

### 合併前的文件檢查

使用者說「合併」時，執行 `gh pr merge` 之前先對照完整 diff（`git diff main...HEAD`），逐項判斷
`CLAUDE.md`（關鍵檔案、核心不變量、手動驗證）、`AGENTS.md`（跟 `CLAUDE.md` 同步）、`README.md`、
`backend/data/schema.md`（動到欄位才需要）要不要更新，回報「已更新」與「不需更新（理由）」兩份清單。
需要補的內容 commit 到同一個 PR；發現還要改程式碼時先停下來問使用者。

## Claude Code 執行原則

使用者確認方向後直接做，不用每一步都問。只在這些情況先停下來確認：

- 會覆蓋或刪除 `DATA_DIR` 裡的真實資料（`data.json`、照片、使用者的 Excel）
- `git push` 到遠端、建立或修改 GitHub repo 設定、打 release tag
- 修改範圍明顯超出討論內容，或要改上面任何一條核心不變量
