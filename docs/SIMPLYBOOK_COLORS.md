# SimplyBook 員工顏色同步

- `sb-sync` 每次同步時會呼叫 SimplyBook Admin API 的 `getUnitList(false, true)` 取得供應者與色號。
- 色號統一寫入員工資料的 `simplybookColor` 欄位。
- SimplyBook 的「穆穆」對應本系統的「宏穆」。
- 庭瑋與翊嘉若沒有 SimplyBook 供應者色號，會使用可在管理後台修改的預設色。
- 已安排人員的班次使用該員工色；尚未安排人員的班次維持原本店別／狀態色；取消班次維持灰色。
- 管理後台的「員工」頁可檢視與手動修改顏色。下一次 SimplyBook 同步若該供應者有色號，會再以 SimplyBook 為準。

可上班時間頁同時保留私人 iCal 匯入工具，並嵌入既有 Google 排班日曆作為管理員唯讀核對畫面。
