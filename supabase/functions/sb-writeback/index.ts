// 回寫 SimplyBook:把系統裡指定場次的「負責人」回寫到 SimplyBook 預約(試驗功能)
// - 只能由「已登入的管理者」從後台按鈕觸發(部署時保留 JWT 驗證,勿加 --no-verify-jwt)
// - 一次只改一筆、按了才改;失敗時 SimplyBook 不會有任何變動
// - 注意:SimplyBook 端可能因異動寄通知信給客人(依其通知設定)
//
// 部署:supabase functions deploy sb-writeback

import { createClient } from "npm:@supabase/supabase-js@2";

const LOGIN_URL = "https://user-api.simplybook.asia/login";
const ADMIN_URL = "https://user-api.simplybook.asia/admin/";

async function rpc(url: string, headers: Record<string, string>, method: string, params: unknown[]) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: crypto.randomUUID() }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(method + ": " + JSON.stringify(j.error ?? j));
  return j.result;
}

Deno.serve(async (req) => {
  try {
    // 1. 必須是登入中的管理者(不接受匿名 key)
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return Response.json({ error: "需要管理者登入" }, { status: 401 });

    const { shiftId } = await req.json();
    if (!shiftId || !String(shiftId).startsWith("sb_")) {
      return Response.json({ error: "只有 SimplyBook 來源的場次(sb_ 開頭)可以回寫" }, { status: 400 });
    }
    const code = String(shiftId).slice(3);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: row } = await supa.from("shifts").select("data").eq("id", shiftId).single();
    if (!row) return Response.json({ error: "查無此場次" }, { status: 404 });
    const shift = row.data;

    const { data: cfgRow } = await supa.from("config").select("data").eq("id", 1).single();
    const cfg = cfgRow!.data;
    // SimplyBook 的服務供應者角色:payNPC>0 的主題(詭廁/詭獄/加場/詭店)= NPC;其餘 = 場控。
    // 詭獄同時有場控+NPC 欄位時,回寫「只取 NPC」那格,絕不誤送場控(老闆規則)。
    const themeRow = cfg.themes?.find((t: any) => t.id === shift.themeId);
    const primaryRole = themeRow && (Number(themeRow.payNPC) || 0) > 0 ? "NPC" : "場控";
    const primary = shift.assignments?.find((a: any) => a.empId && a.role === primaryRole);
    if (!primary) {
      return Response.json({
        error: `此場次尚未指定「${primaryRole}」人員`,
        hint: `SimplyBook 這個主題的服務供應者對應的是${primaryRole};請先在場次的${primaryRole}欄位選人再回寫。`,
      }, { status: 400 });
    }
    const empId = primary.empId;
    const employee = cfg.employees.find((e: any) => e.id === empId);
    if (!employee) return Response.json({ error: "查無此員工" }, { status: 400 });

    // 2. SimplyBook 管理 API
    const company = Deno.env.get("SB_COMPANY")!;
    const token = await rpc(LOGIN_URL, {}, "getUserToken",
      [company, Deno.env.get("SB_USER_LOGIN")!, Deno.env.get("SB_USER_PASSWORD")!]);
    const H = { "X-Company-Login": company, "X-User-Token": String(token) };

    // 3. 員工姓名 → SimplyBook 服務供應者(unit)id
    const unitsRaw = await rpc(ADMIN_URL, H, "getUnitList", []);
    const units = Array.isArray(unitsRaw) ? unitsRaw : Object.values(unitsRaw ?? {});
    const names = [employee.name, ...(employee.aliases ?? [])];
    const unit = units.find((u: any) => names.includes(String(u.name ?? "").trim()));
    if (!unit) {
      return Response.json({
        error: `SimplyBook 找不到叫「${employee.name}」的服務供應者`,
        simplybook_units: units.map((u: any) => u.name),
        hint: "若名稱不同,請在系統員工資料的 aliases 加上 SimplyBook 用的名字",
      }, { status: 400 });
    }

    // 4. 以 code 找出 SimplyBook 的預約 id
    const bookings = await rpc(ADMIN_URL, H, "getBookings",
      [{ date_from: shift.date, date_to: shift.date, booking_type: "non_cancelled" }]);
    const blist = Array.isArray(bookings) ? bookings : Object.values(bookings ?? {});
    const bk = blist.find((b: any) => String(b.code ?? "") === code || String(b.id ?? "") === code);
    if (!bk) return Response.json({ error: `SimplyBook 查無預約(code=${code})` }, { status: 404 });
    if (String(bk.unit_id ?? bk.unit?.id ?? "") === String(unit.id)) {
      return Response.json({ ok: true, message: "SimplyBook 上已經是這位負責人,無需變更" });
    }

    // 5. 回寫負責人(editBook)
    const result = await rpc(ADMIN_URL, H, "editBook", [Number(bk.id), { unit_id: Number(unit.id) }]);

    return Response.json({
      ok: true, booking_code: code,
      changed_to: { unit_id: unit.id, name: unit.name },
      simplybook_result: result,
      note: "SimplyBook 端可能會依其通知設定寄信給客人",
    });
  } catch (e) {
    return Response.json({ error: "回寫失敗: " + (e as Error).message }, { status: 500 });
  }
});
