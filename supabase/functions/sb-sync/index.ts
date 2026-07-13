import { createClient } from "npm:@supabase/supabase-js@2";

const LOGIN_URL = "https://user-api.simplybook.asia/login";
const ADMIN_URL = "https://user-api.simplybook.asia/admin/";
const DAY = 86_400_000;

function pad(n: number) { return String(n).padStart(2, "0"); }
function dstr(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function validDate(v: string | null) { return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function minutes(v: string) {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}
function list(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}
function pick(row: any, keys: string[]) {
  for (const key of keys) if (row?.[key] != null && row[key] !== "") return row[key];
  return "";
}

async function rpc(url: string, headers: Record<string, string>, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: crypto.randomUUID() }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method}: ${JSON.stringify(body.error ?? body)}`);
  return body.result;
}

function conflictWarnings(shifts: any[], employees: any[], prepMin: number, travelMin: number) {
  const warnings = new Map<string, string[]>();
  for (const shift of shifts) {
    if (shift.status === "cancelled") continue;
    for (const assignment of shift.assignments ?? []) {
      if (!assignment.empId) continue;
      const employee = employees.find((item: any) => item.id === assignment.empId);
      if (!employee) continue;
      let message = "";
      if (!employee.active) message = `${employee.id}:員工已停用`;
      else if (employee.startDate && shift.date < employee.startDate) message = `${employee.id}:尚未到職`;
      else if (employee.endDate && shift.date > employee.endDate) message = `${employee.id}:已超過離職日`;
      if (message) warnings.set(shift.id, [...(warnings.get(shift.id) ?? []), message]);
    }
  }
  for (let i = 0; i < shifts.length; i++) {
    const a = shifts[i];
    if (a.status === "cancelled") continue;
    for (let j = i + 1; j < shifts.length; j++) {
      const b = shifts[j];
      if (b.status === "cancelled" || a.date !== b.date) continue;
      const shared = (a.assignments ?? []).map((x: any) => x.empId).filter(Boolean)
        .filter((id: string) => (b.assignments ?? []).some((x: any) => x.empId === id));
      if (!shared.length) continue;
      const travel = a.storeId === b.storeId ? 0 : travelMin;
      const overlaps = minutes(a.start) - prepMin < minutes(b.end) + travel &&
        minutes(a.end) + travel > minutes(b.start) - prepMin;
      if (!overlaps) continue;
      for (const id of shared) {
        const msg = `${id}:${a.storeId === b.storeId ? "人員撞班" : `跨店移動不足 ${travelMin} 分鐘`}`;
        warnings.set(a.id, [...(warnings.get(a.id) ?? []), msg]);
        warnings.set(b.id, [...(warnings.get(b.id) ?? []), msg]);
      }
    }
  }
  return warnings;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("key") !== Deno.env.get("SYNC_SECRET")) {
      return new Response("unauthorized", { status: 401 });
    }

    const now = new Date();
    const defaultFrom = dstr(new Date(now.getTime() - 7 * DAY));
    const defaultTo = dstr(new Date(now.getTime() + 60 * DAY));
    const from = url.searchParams.get("from") ?? defaultFrom;
    const to = url.searchParams.get("to") ?? defaultTo;
    const apply = url.searchParams.get("apply") === "1";
    if (!validDate(from) || !validDate(to) || from > to) {
      return Response.json({ error: "日期格式需為 YYYY-MM-DD，且結束日不可早於開始日" }, { status: 400 });
    }
    if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY > 93) {
      return Response.json({ error: "單次同步最多 93 天" }, { status: 400 });
    }

    const company = Deno.env.get("SB_COMPANY");
    const userLogin = Deno.env.get("SB_USER_LOGIN");
    const userKey = Deno.env.get("SB_USER_PASSWORD"); // SimplyBook API User Key，不是主帳號密碼
    if (!company || !userLogin || !userKey) throw new Error("SimplyBook Secrets 尚未設定完整");

    const token = await rpc(LOGIN_URL, {}, "getUserToken", [company, userLogin, userKey]);
    const headers = { "X-Company-Login": company, "X-User-Token": String(token) };
    const filters = { date_from: from, date_to: to, order: "date_start_asc" };
    const [activeRaw, cancelledRaw] = await Promise.all([
      rpc(ADMIN_URL, headers, "getBookings", [{ ...filters, booking_type: "non_cancelled" }]),
      rpc(ADMIN_URL, headers, "getBookings", [{ ...filters, booking_type: "cancelled" }]),
    ]);
    const active = list(activeRaw);
    const cancelled = list(cancelledRaw);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const [{ data: cfgRow, error: cfgError }, { data: existing, error: shiftsError }] = await Promise.all([
      supabase.from("config").select("data").eq("id", 1).single(),
      supabase.from("shifts").select("id,data").gte("date", from).lte("date", to),
    ]);
    if (cfgError) throw cfgError;
    if (shiftsError) throw shiftsError;
    const cfg = cfgRow.data;
    const existingRows = existing ?? [];
    const existingMap = new Map(existingRows.map((row: any) => [row.id, row.data]));

    const upserts: any[] = [];
    const ignored: any[] = [];
    for (const booking of active) {
      const code = String(pick(booking, ["code", "id"]));
      const id = `sb_${code}`;
      const startRaw = String(pick(booking, ["start_date", "start_date_time"]));
      const endRaw = String(pick(booking, ["end_date", "end_date_time"]));
      const serviceName = String(pick(booking, ["event_name", "event", "service_name"]));
      const providerName = String(pick(booking, ["unit_name", "unit", "provider_name"]));
      const previous: any = existingMap.get(id);
      const selectedTheme = cfg.themes.find((theme: any) => serviceName.startsWith(theme.name));
      if (!code || !startRaw || !selectedTheme) {
        ignored.push({ bookingId: code || "unknown", reason: !selectedTheme ? `找不到主題對應:${serviceName}` : "缺少日期或 ID" });
        continue;
      }
      const employee = cfg.employees.find((item: any) => item.name === providerName || (item.aliases ?? []).includes(providerName));
      const role = (selectedTheme.payNPC ?? 0) > 0 ? "NPC" : "場控";
      // 客人與付款資訊(僅存私人雲端,受 RLS 保護,登入管理者才看得到)
      const customer = {
        name: String(pick(booking, ["client", "text", "client_name"])),
        phone: String(pick(booking, ["client_phone"])),
        email: String(pick(booking, ["client_email"])),
        comment: String(pick(booking, ["comment"])),
      };
      const depAmt = pick(booking, ["deposit_invoice_amount"]);
      const payment = {
        depositAmount: depAmt ? Math.round(Number(depAmt)) : null,
        depositStatus: String(pick(booking, ["deposit_payment_status"])),
        system: String(pick(booking, ["deposit_payment_system", "payment_system"])),
        currency: String(pick(booking, ["deposit_invoice_currency"])),
        invoiceNo: String(pick(booking, ["deposit_invoice_number"])),
      };
      const shift = {
        id,
        date: startRaw.slice(0, 10),
        storeId: selectedTheme.storeId,
        kind: "theme",
        themeId: selectedTheme.id,
        start: startRaw.slice(11, 16),
        end: endRaw ? endRaw.slice(11, 16) : startRaw.slice(11, 16),
        note: `SimplyBook 預約 ${code}`,
        customer,
        payment,
        status: previous?.status === "cancelled" ? "active" : (previous?.status ?? "active"),
        sourceUpdatedAt: new Date().toISOString(),
        assignments: previous?.manualEdit ? previous.assignments : [{ role, empId: employee?.id ?? "" }],
        ...(previous?.manualEdit ? { manualEdit: true } : {}),
        ...(previous?.rebook ? { rebook: previous.rebook } : {}),
      };
      upserts.push({ id, date: shift.date, source: "simplybook", data: shift });
    }
    // 去重:同一預約 code 只保留最後一筆,避免批次 upsert 撞 id(ON CONFLICT 重複)
    {
      const uniq = new Map<string, any>();
      for (const r of upserts) uniq.set(r.id, r);
      upserts.length = 0;
      upserts.push(...uniq.values());
    }

    const cancelledUpdates: any[] = [];
    for (const booking of cancelled) {
      const code = String(pick(booking, ["code", "id"]));
      const id = `sb_${code}`;
      const previous: any = existingMap.get(id);
      if (!previous) continue;
      const shift = { ...previous, status: "cancelled", cancelledAt: new Date().toISOString(), sourceUpdatedAt: new Date().toISOString() };
      cancelledUpdates.push({ id, date: shift.date, source: "simplybook", data: shift });
    }

    const merged = [
      ...existingRows.map((row: any) => row.data).filter((shift: any) =>
        !upserts.some((row) => row.id === shift.id) && !cancelledUpdates.some((row) => row.id === shift.id)
      ),
      ...upserts.map((row) => row.data),
      ...cancelledUpdates.map((row) => row.data),
    ];
    const warnings = conflictWarnings(merged, cfg.employees ?? [], cfg.settings?.prepMin ?? 10, cfg.settings?.travelMin ?? 12);
    for (const row of [...upserts, ...cancelledUpdates]) row.data.syncWarnings = warnings.get(row.id) ?? [];

    if (apply && (upserts.length || cancelledUpdates.length)) {
      const { error } = await supabase.from("shifts").upsert([...upserts, ...cancelledUpdates]);
      if (error) throw error;
    }

    return Response.json({
      mode: apply ? "applied" : "preview",
      range: { from, to },
      fetched: { active: active.length, cancelled: cancelled.length },
      changes: { upsert: upserts.length, markCancelled: cancelledUpdates.length, ignored: ignored.length },
      conflicts: [...warnings.entries()].map(([shiftId, messages]) => ({ shiftId, messages })),
      ignored: ignored.slice(0, 50),
      hint: apply ? undefined : "確認預覽後，以相同日期加上 apply=1 套用",
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
