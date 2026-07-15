# 排班打卡系統 雲端版

單機版(桌面 排班打卡系統.html)的雲端升級:資料存 Supabase、多裝置即時共用、SimplyBook 預約自動同步成班次、店員以 LINE 員工入口定位打卡(已全面取代打卡之星)。

## 檔案結構

```
web/admin.html      管理後台(功能與單機版相同+登入)
web/punch.html      店員手機打卡頁(選名字+PIN)
web/staff.html      LINE/LIFF 員工入口(定位打卡、班表、讓班/換班)
web/config.js       雲端連線設定(要填兩個值)
supabase/schema.sql 資料庫結構(貼進 SQL Editor 執行)
supabase/line_schema.sql LINE 身分、定位、換班、審核與通知擴充
supabase/functions/sb-sync/index.ts  SimplyBook 自動同步程式
```

## 安裝步驟(約 30 分鐘)

### 第 1 步:建 Supabase 專案(免費)
1. 到 https://supabase.com 註冊 → New project
2. 區域選 **Northeast Asia (Tokyo)**,設一組資料庫密碼(記下來)
3. 建好後:**SQL Editor** → 貼上 `supabase/schema.sql` 全部內容 → Run

### 第 2 步:建管理者帳號
1. Dashboard → **Authentication → Users → Add user**
2. 輸入老闆的 Email + 密碼(這就是 admin.html 的登入帳號)
3. ⚠️ 若不想開放自行註冊:Authentication → Sign In / Up → 關閉「Allow new users to sign up」

### 第 3 步:填連線設定
1. Dashboard → **Settings → API**,複製 `Project URL` 和 `anon public` key
2. 貼進 `web/config.js` 對應欄位

### 第 4 步:部署網頁(GitHub Pages 或 Netlify 擇一)
- **GitHub Pages(本 repo 已啟用)**:把 config.js 填好後 commit+push,網址是
  `https://weilena.github.io/<repo-name>/web/admin.html`(後台)與 `.../web/punch.html`(打卡)
- 或把 `web/` 資料夾拖到 https://app.netlify.com/drop

### 第 5 步:搬資料上雲
1. 開桌面單機版 → 資料備份 → **匯出備份(JSON)**
2. 開雲端 admin.html → 登入 → 資料備份 → **匯入備份** → 選剛才的 JSON
3. 員工、主題、技能、班次、打卡全部整包上雲

### 第 6 步:啟用 QR 打卡
1. admin.html → 員工 → 每人編輯 → 設定 **打卡 PIN**(4–6 位數字)
2. 把 `https://你的網址/punch.html` 做成 QR code(任何線上 QR 產生器),印出貼兩間店櫃台
3. 店員手機掃碼 → 選名字 → 輸 PIN → 上班/下班(手機會記住,之後兩鍵完成)

### 第 7 步:SimplyBook 自動同步(純讀取,不會改動 SimplyBook 任何資料)
1. SimplyBook 後台 → **Custom Features → API** → 保持啟用
2. 認證用的是「**使用者帳號 + 密碼(或該使用者的 API User Key)**」——
   API User Key 在 SimplyBook 的使用者(員工/管理者)設定裡,格式是 `api_user_key_` 開頭;
   用 API User Key 比直接放密碼安全(可隨時重生,且不影響登入密碼)
3. 安裝 Supabase CLI(https://supabase.com/docs/guides/cli),然後在本資料夾執行
   (⚠️ 金鑰請自己貼,不要交給別人或貼在對話/文件裡):
   ```
   supabase login
   supabase link --project-ref 你的專案REF
   supabase secrets set SB_COMPANY=bglescape "SB_USER_LOGIN=管理者帳號" "SB_USER_PASSWORD=密碼或api_user_key" "SYNC_SECRET=自訂一串亂碼"
   supabase functions deploy sb-sync --no-verify-jwt
   ```
3. 管理員後台可按「立即同步」測試；成功後會顯示最後同步時間與讀取／更新筆數。
4. `20260714153000_simplybook_sync_health.sql` 會建立每 1 分鐘校正排程與防重複鎖。
5. SimplyBook API 的 create/change/cancel 回撥網址設為
   `https://xrkdwdcsyzivkjankfsg.supabase.co/functions/v1/sb-webhook`，預約異動會立即觸發同步。

## 同步規則說明
- 同步範圍:前 7 天 ~ 後 60 天的預約;已取消的預約會標示取消並保留歷史
- 主題對照:用預約服務名稱開頭比對系統主題名(詭廁/詭獄/詭店…)
- 人員對照:用 SimplyBook 服務供應者名字比對員工姓名;別名(如「穆穆」=宏穆)可在員工資料的 aliases 欄位設定
- 後台**手動改過**的 SimplyBook 班次(換人),之後同步不會覆蓋
- NPC 職主題(詭廁/詭獄/加場/詭店)自動掛 NPC 角色,其餘掛場控 → 薪資按主題頁費率論場計酬

## LINE 員工入口

LINE 版本提供本人 LINE 綁定、店內定位打卡、個人／全員班表、讓班／換班、加場回覆、補卡申請、加班審核與每月訊息額度控制。

完整設定與兩週並行測試流程請看 [`docs/LINE_SETUP.md`](docs/LINE_SETUP.md)。建立 LINE Channel 前，`web/staff.html` 會顯示「尚未連接 LINE 測試帳號」，不影響原管理後台。

## 費用
- Supabase 免費方案:500MB 資料庫+每月 50 萬次 Edge Function 呼叫,以這個規模綽綽有餘
- Netlify 免費方案:足夠
- 都免費,超過額度才需付費

## 試玩模式
還沒接雲端前,網址加 `?demo=1` 開 admin.html 可以直接試用介面(資料只存在當次瀏覽器,不會保存)。
