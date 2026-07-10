// SimplyBook → Supabase 自動同步(Edge Function)
// 只讀取(getBookings),絕不寫入/修改 SimplyBook 的任何資料。
//
// 認證方式(SimplyBook 官方 JSON-RPC 管理 API):
//   getUserToken(公司代號, 使用者帳號, 使用者密碼或 API User Key)
//   之後以 X-Company-Login + X-User-Token 呼叫 /admin/ 服務
//
// 需要的 Secrets(由老闆自己執行 supabase secrets set,金鑰不寫在程式裡):
//   SB_COMPANY       = SimplyBook 公司代號(例:bglescape)
//   SB_USER_LOGIN    = SimplyBook 管理者的登入帳號
//   SB_USER_PASSWORD = 該管理者的密碼,或其 API User Key(api_user_key_ 開頭)
//   SYNC_SECRET      = 自訂亂碼,呼叫本函式時 ?key= 帶上,防止外人觸發
//
// 部署:supabase functions deploy sb-sync --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";

// 注意:你們的租戶在 .asia 網域(SimplyBook API 設定頁可確認端點)
const LOGIN_URL = "https://user-api.simplybook.asia/login";
const ADMIN_URL = "https://user-api.simplybook.asia/admin/";

function pad(n: number) { return String(n).padStart(2, "0"); }
function dstr(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

async function rpc(url: string, headers: Record<string, string>, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + " 失敗: " + JSON.stringify(j.error));
  return j.result;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("key") !== Deno.env.get("SYNC_SECRET")) {
      return new Response("unauthorized", { status: 401 });
    }

    const company = Deno.env.get("SB_COMPANY")!;
    const userLogin = Deno.env.get("SB_USER_LOGIN")!;
    const userPassword = Deno.env.get("SB_USER_PASSWORD")!;
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. 取得管理 API token(官方 getUserToken;密碼欄可用 API User Key)
    const token = await rpc(LOGIN_URL, {}, "getUserToken", [company, userLogin, userPassword]);
    const H = { "X-Company-Login": company, "X-User-Token": String(token) };

    // 2. 抓「前 7 天 ~ 後 60 天」的預約(有效 + 已取消各抓一次)——純讀取
    const now = new Date();
    const from = dstr(new Date(now.getTime() - 7 * 864e5));
    const to = dstr(new Date(now.getTime() + 60 * 864e5));
    const active: any[] = await rpc(ADMIN_URL, H, "getBookings",
      [{ date_from: from, date_to: to, booking_type: "non_cancelled", order: "date_start_asc" }]) ?? [];
    const cancelled: any[] = await rpc(ADMIN_URL, H, "getBookings",
      [{ date_from: from, date_to: to, booking_type: "cancelled" }]) ?? [];

    // 3. 讀系統設定(主題對照、員工名單)
    const { data: cfgRow } = await supa.from("config").select("data").eq("id", 1).single();
    const cfg = cfgRow!.data;

    // 4. 讀既有的 SimplyBook 班次(保留後台手動改過的人員安排)
    const { data: existing } = await supa.from("shifts").select("id,data")
      .eq("source", "simplybook").gte("date", from).lte("date", to);
    const exMap = new Map((existing ?? []).map((r: any) => [r.id, r.data]));

    const pick = (b: any, keys: string[]) => {
      for (const k of keys) if (b[k] != null && b[k] !== "") return b[k];
      return "";
    };

    const upserts: any[] = [];
    let skippedService = 0;

    for (const b of active) {
      const code = String(pick(b, ["code", "id"]));
      const id = "sb_" + code;
      const startRaw = String(pick(b, ["start_date", "start_date_time"]));
      const endRaw = String(pick(b, ["end_date", "end_date_time"]));
      const svcName = String(pick(b, ["event_name", "event", "service_name"]));
      const provName = String(pick(b, ["unit_name", "unit", "provider_name"]));
      const clientName = String(pick(b, ["client_name", "client"]));
      if (!startRaw || !svcName) { skippedService++; continue; }

      const t = cfg.themes.find((t: any) => svcName.startsWith(t.name));
      if (!t) { skippedService++; continue; }

      const emp = cfg.employees.find((e: any) =>
        e.name === provName || (e.aliases ?? []).includes(provName)
      );

      const date = startRaw.slice(0, 10);
      const start = startRaw.slice(11, 16);
      const end = endRaw ? endRaw.slice(11, 16) : start;
      const role = (t.payNPC ?? 0) > 0 ? "NPC" : "場控";

      const prev = exMap.get(id);
      const shift = {
        id, date, storeId: t.storeId, kind: "theme", themeId: t.id, start, end,
        note: `預約:${clientName}(${code})`,
        assignments: prev?.manualEdit
          ? prev.assignments // 後台手動改過的人員安排,同步時不覆蓋
          : [{ role, empId: emp ? emp.id : "" }],
        ...(prev?.manualEdit ? { manualEdit: true } : {}),
      };
      upserts.push({ id, date, source: "simplybook", data: shift });
    }

    // 5. 已取消的預約 → 移除對應班次
    const deletes = cancelled
      .map((b: any) => "sb_" + String(pick(b, ["code", "id"])))
      .filter((id: string) => exMap.has(id));

    if (upserts.length) {
      const { error } = await supa.from("shifts").upsert(upserts);
      if (error) return new Response("寫入失敗: " + error.message, { status: 500 });
    }
    if (deletes.length) await supa.from("shifts").delete().in("id", deletes);

    return Response.json({
      fetched: active.length, upserted: upserts.length,
      deleted: deletes.length, skipped: skippedService,
      range: [from, to],
    });
  } catch (e) {
    return new Response("同步錯誤: " + (e as Error).message, { status: 500 });
  }
});
