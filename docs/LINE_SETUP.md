# LINE 員工打卡與排班：部署設定

程式已完成 LINE 登入、薪資級定位打卡、查班、讓班／換班、加場回覆、補卡／每日計薪／加班審核、前一日班表提醒與通知額度控制。正式連線前需要建立一個測試 LINE 官方帳號；不要把任何密碼或 Token 貼進 GitHub、聊天或 `web/config.js`。

為節省 LINE 計費訊息，加場及公開讓班只會依資格與當月班數排序，通知最多 2 位合適員工；指定換班只通知指定同事。員工按鈕回覆仍使用免費 Reply。

## 1. 更新 Supabase 資料庫

在 Supabase Dashboard → **SQL Editor** 開啟並執行 `supabase/line_schema.sql`。成功時顯示 `Success. No rows returned` 是正常的。

## 2. 建立測試 LINE Channel

1. 建立或選擇 LINE Provider。
2. 建立測試用 LINE 官方帳號及 Messaging API channel。
3. 建立 LINE Login channel，加入 LIFF App。
4. LIFF Endpoint URL 設為 `https://weilena.github.io/staff-scheduler/web/staff.html`。
5. LIFF Scope 勾選 `profile` 與 `openid`。
6. 將公開的 LIFF ID 填入 `web/config.js` 的 `LINE_LIFF_ID`。

參考：[建立 Messaging API bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[LIFF App 設定](https://developers.line.biz/en/docs/liff/registering-liff-apps/)。

## 3. 設定 Supabase Secrets

Edge Functions → Secrets 新增以下名稱；值只能存於 Supabase：

| Secret | 內容 |
|---|---|
| `LINE_CHANNEL_SECRET` | Messaging API 的 Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API 的 Channel access token |
| `LINE_LOGIN_CHANNEL_ID` | LINE Login channel ID |
| `LINE_LIFF_ID` | LIFF ID |
| `LINE_LIFF_URL` | 上方的 `staff.html` 網址 |
| `DISPATCH_SECRET` | 自行產生至少32字元亂碼 |

原有 SimplyBook Secrets 繼續保留：`SB_COMPANY`、`SB_USER_LOGIN`、`SB_USER_PASSWORD`、`SYNC_SECRET`。

## 4. 部署四個 Edge Functions

```powershell
supabase functions deploy sb-sync --no-verify-jwt
supabase functions deploy staff-api --no-verify-jwt
supabase functions deploy line-webhook --no-verify-jwt
supabase functions deploy line-dispatch --no-verify-jwt
```

四個函式都不能開啟 Supabase 的 **Verify JWT with legacy secret**：`staff-api` 驗證 LINE ID Token、`line-webhook` 驗證 LINE 簽章，另外兩個驗證各自的 Secret。這也是先前 `sb-sync` 出現 Gateway `401 Invalid credentials` 的修正方式。

## 5. 設定 LINE Webhook

Messaging API → Webhook URL：

```text
https://xrkdwdcsyzivkjankfsg.supabase.co/functions/v1/line-webhook
```

按 **Verify**，成功後開啟 **Use webhook**。

## 6. 建立 Rich Menu

測試版先建立五個 URI 按鈕，使用 `https://liff.line.me/[LIFF_ID]` 並加上頁籤參數；員工頁本身也有底部導覽：

- 打卡：`?tab=punch`
- 我的班表：`?tab=home`
- 全員班表：`?tab=schedule`
- 加場／換班：`?tab=requests`
- 我的申請：`?tab=mine`

## 7. 啟用通知派送

使用 Supabase Dashboard 的 Cron／Integrations，每分鐘或每五分鐘 POST 呼叫 `line-dispatch`，加入 Header：

```text
x-dispatch-secret: [DISPATCH_SECRET 的值]
```

不要把 Secret 寫入 GitHub。派送程式會先發緊急通知、本月達160則後略過非緊急 Push，並保留40則給取消／改期。

## 8. 管理員測試順序

1. 管理後台 → **LINE員工系統** → 設定兩間店緯度、經度及半徑。
2. 為一位測試員工產生24小時一次性驗證碼。
3. 測試員工加入官方帳號，開啟員工入口並輸入驗證碼。
4. 在店內測試上下班；店外及關閉定位應被拒絕。
5. 建立讓班、指定換班與公開換班，確認只有符合資格者能接受。
6. 測試 SimplyBook 新增無人場次、改期及取消。
7. 與打卡之星並行兩週，每天核對工時與異常。

## 9. 打卡與薪資制度

- 上下班卡使用 Supabase 伺服器的台灣時間，不採用手機自行回傳的時間。
- 每次打卡驗證 LINE 本人、精確定位、店家範圍與當日已排班次；臨時支援仍可落卡，但會標記異常供管理員確認。
- 同一員工的打卡以資料庫鎖定處理，連點或兩支手機同時送出不會建立重複狀態。
- 原始卡禁止刪除或改寫；管理員只能「作廢」並填原因，稽核紀錄會保存原始內容。
- 員工補卡要選日期、補上班／下班或整日更正、正確時間與原因；核准後建立 `admin_correction` 紀錄，不覆蓋原始卡。
- `attendance_daily` 保存排班分鐘、原始打卡分鐘、異常及管理員核准的「時薪計薪分鐘」。薪資頁只使用已核准分鐘乘以時薪。
- 加班仍由 `overtime_reviews` 另外核准，缺卡或異常長工時不會自動列入加班費。
- 離職員工只能停用，歷史班表、打卡、審核與薪資紀錄不得刪除。

## 10. 前一日提醒

`line-dispatch` 每次執行都會檢查台灣時間；到管理後台設定的提醒時段後，將同一員工隔日所有班次合併成一則 LINE 通知。通知包含「查看我的班表」與「需要換班／讓班」按鈕，並使用日期＋員工的唯一鍵避免重複。

提醒屬於主動 Push，會計入 LINE 額度；系統沿用每月160則非緊急停止、保留40則緊急通知的規則。

## 安全注意事項

- GitHub Pages 只存程式碼，不存員工資料或 Secrets。
- 員工 API 每次驗證 LINE ID Token，不接受前端自行宣稱的員工編號。
- 原始打卡不可覆寫或刪除；補卡、每日計薪分鐘及加班均以審核資料保留軌跡。
- 員工離職時，在管理後台停用員工並解除 LINE 綁定。
