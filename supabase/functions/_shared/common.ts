import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: cors });
}

export function serviceClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function verifyLineIdToken(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const clientId = Deno.env.get("LINE_LOGIN_CHANNEL_ID");
  if (!token || !clientId) throw new Error("LINE_LOGIN_REQUIRED");
  const body = new URLSearchParams({ id_token: token, client_id: clientId });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const profile = await response.json();
  if (!response.ok || profile.aud !== clientId || !profile.sub) throw new Error("INVALID_LINE_TOKEN");
  return { userId: String(profile.sub), displayName: String(profile.name ?? "") };
}

export function toMinutes(value: string) {
  const [h, m] = String(value ?? "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
}

export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function employedOn(emp: any, date: string) {
  return !!emp?.active && (!emp.startDate || date >= emp.startDate) && (!emp.endDate || date <= emp.endDate);
}

function availability(emp: any, date: string) {
  if (emp?.availX?.[date]) return emp.availX[date];
  // Full-time staff report leave rather than ordinary availability. A date
  // without a date-specific leave entry is therefore available by default.
  if (emp?.type === "full") return { on: true, start: "09:00", end: "22:30", assumedFullTime: true };
  const day = new Date(`${date}T00:00:00+08:00`).getDay();
  return emp?.avail?.[day] ?? emp?.avail?.[String(day)];
}

export function eligibilityErrors(emp: any, target: any, role: string, shifts: any[], cfg: any, ignoreIds: string[] = []) {
  const errors: string[] = [];
  if (!emp) return ["查無員工資料"];
  if (!target) return ["班次不存在"];
  if (!employedOn(emp, target.date)) errors.push("非在職狀態");
  const avail = availability(emp, target.date);
  const prep = Number(cfg.settings?.prepMin ?? 10), travel = Number(cfg.settings?.travelMin ?? 12);
  const start = toMinutes(target.start) - prep, end = toMinutes(target.end);
  if (!avail?.on) errors.push("當日未設定可上班");
  else if (toMinutes(avail.start) > start || toMinutes(avail.end) < end) errors.push("超出可上班時間");
  if (role === "櫃台" && !(emp.counters ?? []).includes(target.storeId)) errors.push("未具此店櫃台資格");
  if (target.kind === "theme" && ["場控", "NPC"].includes(role) && !(emp.skills?.[target.themeId] ?? []).includes(role)) errors.push(`未具${role}技能`);
  for (const shift of shifts) {
    if (ignoreIds.includes(shift.id) || shift.id === target.id || shift.date !== target.date || shift.status === "cancelled") continue;
    if (!(shift.assignments ?? []).some((a: any) => a.empId === emp.id)) continue;
    const gap = shift.storeId === target.storeId ? 0 : travel;
    if (start < toMinutes(shift.end) + gap && end + gap > toMinutes(shift.start) - prep) {
      errors.push(shift.storeId === target.storeId ? "與既有班次撞班" : "跨店移動時間不足");
    }
  }
  if (role === "NPC") {
    const rest = Number(cfg.settings?.npcRestMin ?? 30), max = Number(cfg.settings?.npcMaxChain ?? 2);
    const npc = shifts.filter((s: any) => !ignoreIds.includes(s.id) && s.date === target.date && s.status !== "cancelled" &&
      (s.assignments ?? []).some((a: any) => a.empId === emp.id && a.role === "NPC"))
      .map((s: any) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }));
    npc.push({ start: toMinutes(target.start), end: toMinutes(target.end) });
    npc.sort((a: any, b: any) => a.start - b.start);
    let chain = 1, largest = 1;
    for (let i = 1; i < npc.length; i++) { chain = npc[i].start - npc[i - 1].end < rest ? chain + 1 : 1; largest = Math.max(largest, chain); }
    if (max > 0 && largest > max) errors.push("NPC連場超過上限");
  }
  return [...new Set(errors)];
}

export function rankCandidatesByWorkload(candidates: any[], shifts: any[], targetDate: string, limit = 2) {
  const month = String(targetDate ?? "").slice(0, 7);
  const workload = new Map<string, number>();
  for (const shift of shifts ?? []) {
    if (shift?.status === "cancelled" || String(shift?.date ?? "").slice(0, 7) !== month) continue;
    for (const assignment of shift.assignments ?? []) {
      if (!assignment?.empId) continue;
      workload.set(String(assignment.empId), (workload.get(String(assignment.empId)) ?? 0) + 1);
    }
  }
  return [...candidates]
    .sort((a: any, b: any) => {
      const countDiff = (workload.get(String(a.id)) ?? 0) - (workload.get(String(b.id)) ?? 0);
      if (countDiff) return countDiff;
      return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), "zh-Hant");
    })
    .slice(0, Math.max(0, limit));
}

export async function getContext(sb: any) {
  const [{ data: config, error: configError }, { data: rows, error: shiftError }] = await Promise.all([
    sb.from("config").select("data").eq("id", 1).single(),
    sb.from("shifts").select("id,date,data"),
  ]);
  if (configError) throw configError;
  if (shiftError) throw shiftError;
  return { cfg: config.data, shifts: (rows ?? []).map((r: any) => r.data) };
}

export async function queueNotification(sb: any, employeeId: string, category: string, payload: any, critical = false, key?: string) {
  const { error } = await sb.from("notification_outbox").upsert({
    recipient_emp_id: employeeId, category, payload, critical,
    idempotency_key: key ?? `${category}:${employeeId}:${crypto.randomUUID()}`,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}
