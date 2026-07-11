# SimplyBook 同步設定

## 安全原則

- GitHub 只保存程式碼，不保存 API User Key、帳號密碼、顧客或員工資料。
- SimplyBook API User Key 請存入 Supabase Edge Function Secrets。
- 使用專用 User API Key，不使用主要管理員密碼。
- 預覽模式不寫入資料；確認結果後才使用 `apply=1`。

## Supabase Secrets

在 Supabase Dashboard 的 Edge Functions Secrets 建立：

| 名稱 | 內容 |
| --- | --- |
| `SB_COMPANY` | SimplyBook 公司登入代號，例如網址中的公司代號 |
| `SB_USER_LOGIN` | 產生 User API Key 的 SimplyBook 系統使用者登入名稱 |
| `SB_USER_PASSWORD` | 新建立的 SimplyBook User API Key（不是主帳號密碼） |
| `SYNC_SECRET` | 自行產生的長隨機字串，用來保護同步網址 |

`SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase Edge Functions 自動提供。

## 2026 年 7 月測試

先部署 `sb-sync`，再用瀏覽器開啟以下網址。請以實際 Project Ref 與 `SYNC_SECRET` 取代括號內容。

預覽（不寫入）：

```text
https://[PROJECT_REF].supabase.co/functions/v1/sb-sync?key=[SYNC_SECRET]&from=2026-07-01&to=2026-07-31
```

預覽結果確認後才套用：

```text
https://[PROJECT_REF].supabase.co/functions/v1/sb-sync?key=[SYNC_SECRET]&from=2026-07-01&to=2026-07-31&apply=1
```

回應會列出讀取的有效／取消場次、準備新增或更新的筆數、忽略原因，以及撞班或跨店移動不足警告。回應不包含顧客姓名、電話或 Email。

## 同步規則

- SimplyBook 是場次、時間與服務提供者的主要資料來源。
- 新增或修改場次會更新排班資料。
- 已在排班系統人工調整的人員安排會保留，場次時間與狀態仍跟隨 SimplyBook。
- 取消場次標示為 `cancelled` 並保留歷史，不直接刪除。
- 同一人時間重疊或跨店移動時間不足時，結果會回報警告。
- 單次同步最長 93 天，避免誤抓過大範圍。

## 後續即時連動

目前以定時同步作為可靠基線。SimplyBook 的 create/change/cancel 回撥網址在新的 Supabase Webhook 完成並驗證前，不要替換既有 Vercel 網址。完成後可讓 Webhook 觸發小範圍同步，並保留每 15 分鐘全量校正，避免漏單。
