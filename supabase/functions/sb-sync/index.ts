import { createClient } from "npm:@supabase/supabase-js@2";
import { eligibilityErrors, queueNotification, rankCandidatesByWorkload } from "../_shared/common.ts";

const LOGIN_URL = "https://user-api.simplybook.asia/login";
const ADMIN_URL = "https://user-api.simplybook.asia/admin/";
const DAY = 86_400_000;
const DEFAULT_EMPLOYEE_COLORS: Record<string, string> = {
  "庭瑋": "#2782e8",
  "翊嘉": "#28c75f",
};

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
function selectedThemeName(cfg: any, themeId: string) {
  return cfg.themes?.find((theme: any) => theme.id === themeId)?.name ?? "場次";
}
function providerColor(provider: any) {
  const value = String(pick(provider, ["color", "hex_color", "hexColor", "colour", "unit_color", "color_code"])).trim();
  const normalized = value && !value.startsWith("#") ? `#${value}` : value;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : "";
}
function matchedEmployee(employees: any[], providerName: string) {
  const normalized = providerName.trim();
  return employees.find((item: any) => item.name === normalized ||
    (item.aliases ?? []).includes(normalized) || (normalized === "穆穆" && item.name === "宏穆"));
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

// CORS:讓管理後台(GitHub Pages)能用「立即同步」按鈕直接呼叫;排程與伺服器呼叫不受影響
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-sync-secret, x-supabase-cron, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const handler = async (req: Request) => {
  let supabase: ReturnType<typeof createClient> | null = null;
  let runId: number | null = null;
  try {
    const url = new URL(req.url);
    const source = url.searchParams.get("source") ?? "manual";
    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const suppliedKey = req.headers.get("x-sync-secret") ?? url.searchParams.get("key");
    const isDatabaseCron = source === "database-cron" && req.headers.get("x-supabase-cron") === "1";
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: authData } = bearer ? await supabase.auth.getUser(bearer) : { data: { user: null } };
    const isSignedInAdmin = !!authData.user;
    if (!isDatabaseCron && !isSignedInAdmin && (!suppliedKey || suppliedKey !== Deno.env.get("SYNC_SECRET"))) {
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

    if (apply) {
      const { data, error } = await supabase.rpc("try_start_integration_sync", {
        p_integration: "simplybook",
        p_trigger_source: source,
        p_range_from: from,
        p_range_to: to,
        p_min_interval_seconds: source === "manual" ? 0 : 45,
      });
      // During rollout the migration may not exist yet. Manual calls continue,
      // while scheduled calls fail clearly instead of silently doing nothing.
      if (error && source !== "manual") throw error;
      runId = data == null ? null : Number(data);
      if (!error && runId == null) {
        return Response.json({ ok: true, skipped: true, reason: "another synchronization just ran" });
      }
    }

    const company = Deno.env.get("SB_COMPANY");
    const userLogin = Deno.env.get("SB_USER_LOGIN");
    const userKey = Deno.env.get("SB_USER_PASSWORD"); // SimplyBook API User Key，不是主帳號密碼
    if (!company || !userLogin || !userKey) throw new Error("SimplyBook Secrets 尚未設定完整");

    const token = await rpc(LOGIN_URL, {}, "getUserToken", [company, userLogin, userKey]);
    const headers = { "X-Company-Login": company, "X-User-Token": String(token) };
    const filters = { date_from: from, date_to: to, order: "date_start_asc" };
    const [activeRaw, cancelledRaw, providersRaw] = await Promise.all([
      rpc(ADMIN_URL, headers, "getBookings", [{ ...filters, booking_type: "non_cancelled" }]),
      rpc(ADMIN_URL, headers, "getBookings", [{ ...filters, booking_type: "cancelled" }]),
      rpc(ADMIN_URL, headers, "getUnitList", [false, true]),
    ]);
    const active = list(activeRaw);
    const cancelled = list(cancelledRaw);
    const providers = list(providersRaw);

    const [{ data: cfgRow, error: cfgError }, { data: existing, error: shiftsError }] = await Promise.all([
      supabase.from("config").select("data").eq("id", 1).single(),
      supabase.from("shifts").select("id,data").gte("date", from).lte("date", to),
    ]);
    if (cfgError) throw cfgError;
    if (shiftsError) throw shiftsError;
    const cfg = cfgRow.data;
    let employeeColorsUpdated = 0;
    for (const employee of cfg.employees ?? []) {
      const provider = providers.find((item: any) => matchedEmployee([employee], String(pick(item, ["name", "unit_name", "title"])))) ;
      const color = providerColor(provider) || employee.simplybookColor || DEFAULT_EMPLOYEE_COLORS[employee.name] || "";
      if (color && employee.simplybookColor !== color) {
        employee.simplybookColor = color;
        employeeColorsUpdated++;
      }
    }
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
      const employee = matchedEmployee(cfg.employees ?? [], providerName);
      const role = (selectedTheme.payNPC ?? 0) > 0 ? "NPC" : "場控";
      // 客人與付款資訊僅存私人雲端；員工 API 只提供給該場人員、同店值班櫃台與管理員。
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
        ...(previous?.rebookFrom ? { rebookFrom: previous.rebookFrom } : {}),
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
      // 颱風待改期期間暫留聯絡資料；一般取消、已改期與已退費只保留場次及稽核資料。
      const keepTyphoonContact = previous.status === "cancelled_typhoon" && previous.rebook?.state === "pending";
      const { customer: _customer, payment: _payment, ...nonPersonal } = previous;
      const shift = keepTyphoonContact
        ? { ...previous, status: "cancelled_typhoon", cancelledAt: previous.cancelledAt ?? new Date().toISOString(), sourceUpdatedAt: new Date().toISOString() }
        : { ...nonPersonal, customer: null, payment: null, status: previous.status === "cancelled_typhoon" ? "cancelled_typhoon" : "cancelled", cancelledAt: previous.cancelledAt ?? new Date().toISOString(), sourceUpdatedAt: new Date().toISOString() };
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

      // 只對真正受影響的人推播；idempotency key 避免重複同步造成重複訊息。
      for (const row of upserts) {
        const before: any = existingMap.get(row.id);
        const after = row.data;
        const beforeAssigned = new Set((before?.assignments ?? []).map((a: any) => a.empId).filter(Boolean));
        const afterAssigned = new Set((after.assignments ?? []).map((a: any) => a.empId).filter(Boolean));
        const changed = before && (before.date !== after.date || before.start !== after.start || before.end !== after.end || before.storeId !== after.storeId);
        if (changed) {
          for (const empId of new Set([...beforeAssigned, ...afterAssigned])) await queueNotification(supabase, String(empId), "shift_changed", {
            title: "班次時間異動", text: `${after.date} ${after.start}–${after.end}，請開啟員工入口確認。`, shiftId: after.id,
          }, true, `sb-change:${after.id}:${after.sourceUpdatedAt}:${empId}`);
        }
        const emptySlots = (after.assignments ?? []).map((assignment: any, slotIndex: number) => ({ assignment, slotIndex }))
          .filter((slot: any) => !slot.assignment.empId);
        if (emptySlots.length) {
          const { data: existingRequests } = await supabase.from("shift_requests").select("id,details").eq("shift_id", after.id)
            .in("status", ["open", "pending_manager"]);
          for (const { assignment, slotIndex } of emptySlots) {
            if ((existingRequests ?? []).some((request: any) => Number(request.details?.slotIndex) === slotIndex)) continue;
            const shiftTime = new Date(`${after.date}T${after.start}:00+08:00`).getTime();
            const deadline = new Date(Math.max(Date.now() + 60 * 60_000, shiftTime - 2 * 60 * 60_000)).toISOString();
            const { data: request, error: requestError } = await supabase.from("shift_requests").insert({
              request_type: "extra", shift_id: after.id, deadline, details: { source: "simplybook", role: assignment.role, slotIndex },
            }).select().single();
            if (requestError) throw requestError;
            const eligible = (cfg.employees ?? []).filter((e: any) => eligibilityErrors(e, after, assignment.role, merged, cfg).length === 0);
            const candidates = rankCandidatesByWorkload(eligible, merged, after.date, 2);
            for (const employee of candidates) await queueNotification(supabase, employee.id, "extra_shift", {
              title: "臨時加場徵人", text: `${after.date} ${after.start}–${after.end} ${selectedThemeName(cfg, after.themeId)}（${assignment.role}），是否可以接班？`,
              requestId: request.id, actions: true, shiftId: after.id,
            }, false, `extra:${request.id}:${employee.id}`);
          }
        }
      }
      for (const row of cancelledUpdates) {
        const before: any = existingMap.get(row.id);
        for (const assignment of before?.assignments ?? []) if (assignment.empId) await queueNotification(supabase, assignment.empId, "shift_cancelled", {
          title: "班次取消", text: `${before.date} ${before.start}–${before.end} 的班次已取消。`, shiftId: before.id,
        }, true, `sb-cancel:${before.id}:${row.data.cancelledAt}:${assignment.empId}`);
      }
    }
    if (apply && employeeColorsUpdated) {
      const { error } = await supabase.from("config").update({ data: cfg, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw error;
    }

    const result = {
      mode: apply ? "applied" : "preview",
      range: { from, to },
      fetched: { active: active.length, cancelled: cancelled.length, providers: providers.length },
      changes: { upsert: upserts.length, markCancelled: cancelledUpdates.length, employeeColors: employeeColorsUpdated, ignored: ignored.length },
      conflicts: [...warnings.entries()].map(([shiftId, messages]) => ({ shiftId, messages })),
      ignored: ignored.slice(0, 50),
      hint: apply ? undefined : "確認預覽後，以相同日期加上 apply=1 套用",
    };
    if (runId != null) {
      await supabase.from("integration_sync_runs").update({
        status: "success",
        fetched_count: active.length + cancelled.length,
        changed_count: upserts.length + cancelledUpdates.length,
        ignored_count: ignored.length,
        details: { providers: providers.length, employeeColorsUpdated, conflicts: warnings.size },
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }
    return Response.json(result);
  } catch (error) {
    console.error(error);
    if (supabase && runId != null) {
      await supabase.from("integration_sync_runs").update({
        status: "error",
        error_message: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        finished_at: new Date().toISOString(),
      }).eq("id", runId);
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  const res = await handler(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});
