# 專案紀錄

記錄專案施工／設備安裝「每天做了什麼」的小工具，每張照片可以附一句說明。
單人使用、單機本地執行，不需要雲端、不需要帳號。

**接手這個專案（人或 AI）先讀 [`CLAUDE.md`](CLAUDE.md)**（[`AGENTS.md`](AGENTS.md) 內容相同）。
資料格式見 [`backend/data/schema.md`](backend/data/schema.md)，那份是資料契約：
就算 App 停用或重寫，只要那份文件、`data.json` 和 `照片/` 還在，資料就讀得懂。

## 這是什麼

原本用一份 Excel（日期／班別／時間／專案名稱／設備／工作進度／工作內容／照片）記錄，照片欄存的是絕對路徑，
資料夾一改名就全部打不開。這個 App 把同樣的欄位（拿掉設備）做成三個畫面：

| 畫面 | 做什麼 |
|---|---|
| **新增紀錄** | 日期、班別、時段自動帶入；專案和工作進度用點的（最近用過的排前面，也能打新的）；照片拖進來立刻上傳，每張下面寫一句說明，可以拖曳排序；右邊是這一天已經記過的時間軸。Ctrl+Enter 儲存 |
| **紀錄** | 依日期分組，搜尋會連照片說明一起找；點照片放大，左右切換，說明可以直接改；點「修改」帶回表單，刪除要按兩次 |
| **報表** | 本週／上週／本月／整個專案／自訂期間；**依日期**（給主管看進度）或**依工作進度**（同一階段集中、照片配說明，可當員工教育訓練資料）；列印另存 PDF，或開新視窗截圖 |

另外可以「匯出 Excel」，7 欄（原本的欄位拿掉設備），照片欄放檔名。

## 快速開始

需要 Node.js 22.9 以上。

```bash
npm install
cp .env.example .env   # 改成你自己的 DATA_DIR / LEGACY_XLSX_PATH
npm run migrate        # 只有第一次從舊 Excel 搬資料時需要
npm start              # 或雙擊 start.bat
```

啟動後自動開瀏覽器到 `http://localhost:3002`。沒有 `.env` 時會用
`backend/data/example/` 的虛構範例資料開機，可以先看看畫面。

## 專案結構

```
backend/
  server.js         Express：靜態檔案 + REST API + 照片上傳，只聽 127.0.0.1
  lib/
    rules.js         欄位規則（純函式）：驗證、排序、清單、報表計算。前後端共用
    photos.js        照片：暫存區 → 日期資料夾、改日期搬檔、刪除、暫存區清理
    store.js         data.json 讀寫（原子寫入、寫入排隊）
    xlsx.js          讀舊 Excel（搬遷用）、寫匯出快照
  data/
    schema.md        資料契約
    example/         虛構的範例資料
frontend/
  index.html         畫面與樣式
  app.js             前端邏輯，import /lib/rules.js
scripts/
  migrate.js         一次性搬遷：工作紀錄.xlsx → data.json
test/                node:test
```

## 測試

```bash
npm run check   # node --check 語法檢查
npm test        # node --test
```

測試涵蓋欄位規則、報表分組、照片的暫存／搬移／刪除／清理（清理絕不碰日期資料夾）、
data.json 讀寫與寫入排隊、Excel 搬遷與匯出（刻意在非 UTC 時區跑）、完整的 API 流程（含上傳中文檔名），
以及前端跟 `rules.js`／`index.html` 對不對得上。

## 資料在哪裡

真實資料**不在**這個 repo 裡：`data.json`、照片、匯出的 Excel 都在 `.env` 的 `DATA_DIR`
（自己電腦上的 OneDrive 資料夾），只有程式碼進版控。
