// Google 日曆(iCal)自動匯入可上班/休假(Edge Function)
// 每天由 pg_cron 觸發:讀 config.icalUrl 的 .ics → 解析每筆全天事件 → 比對員工姓名 → 解析可上班時段/休假(事假/病假/特休)→ 寫入 config.employees[].availX。
// 只讀取 Google 日曆,絕不修改你的日曆;只寫入本系統自己的資料。
// 觸發:pg_cron 帶 x-supabase-cron:1;或登入管理員手動呼叫。
//   POST /functions/v1/ical-import  body: { from?, to? }
import { createClient } from "npm:@supabase/supabase-js@2";

function unfold(text: string): string[] {
  const lines = text.split(/\r?\n/); const out: string[] = [];
  for (const ln of lines) { if ((ln.startsWith(" ") || ln.startsWith("\t")) && out.length) out[out.length - 1] += ln.slice(1); else out.push(ln); }
  return out;
}
function parseIcs(text: string) {
  const events: { date: string; summary: string }[] = []; let cur: any = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur && cur.date && cur.summary) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0], val = line.slice(i + 1);
    if (key === "DTSTART") { const m = val.match(/(\d{4})(\d{2})(\d{2})/); if (m) cur.date = `${m[1]}-${m[2]}-${m[3]}`; }
    else if (key === "SUMMARY") cur.summary = val.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
  }
  return events;
}
// 與 admin.html 的 parseGCalAvail 邏輯一致(自由格式→可上班時段/休假)。
function parseGCalAvail(raw: string): any {
  const s = String(raw).replace(/[🍐👌🏻😻👍✅️\s]/g, "");
  const norm = (h: any, m = 0) => { h = +h; m = +m; if (h >= 1 && h <= 8) h += 12; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"); };
  const norm4 = (t: any) => { t = String(t).padStart(4, "0"); return t.slice(0, 2) + ":" + t.slice(2); };
  if (/其餘皆可/.test(s)) return { on: true, start: "09:00", end: "22:30" };
  const rng = s.match(/(\d{1,2})\s*[-~～至]\s*(\d{1,2})\s*可以/);
  if (rng) return { on: true, start: norm(rng[1]), end: norm(rng[2]) };
  let dir: string | null = null;
  if (/前/.test(s)) dir = "before"; else if (/後/.test(s)) dir = "after"; else if (/離/.test(s)) dir = "before";
  if (dir) { let t: string | null = null, m;
    if ((m = s.match(/(\d{1,2})[:：](\d{2})/))) t = m[1].padStart(2, "0") + ":" + m[2];
    else if ((m = s.match(/(\d{3,4})/))) t = norm4(m[1]);
    else if ((m = s.match(/(\d{1,2})點/))) t = norm(m[1]);
    if (t) return dir === "before" ? { on: true, start: "09:00", end: t } : { on: true, start: t, end: "22:30" };
  }
  if (/特休/.test(s)) return { on: false, start: "09:00", end: "22:30", leaveType: "特休" };
  if (/事假/.test(s)) return { on: false, start: "09:00", end: "22:30", leaveType: "事假" };
  if (/病假/.test(s)) return { on: false, start: "09:00", end: "22:30", leaveType: "病假" };
  if (/(❌|❎|不行|休)/.test(s)) return { on: false, start: "09:00", end: "22:30" };
  if (/(allday|全天|整天|全台可以|可以|全部)/i.test(s)) return { on: true, start: "09:00", end: "22:30" };
  return null;
}
function matchEmp(text: string, employees: any[]) {
  const t = String(text).replace(/\s/g, "");
  for (const e of employees) if (t.startsWith(e.name) || t.includes(e.name) || (e.aliases ?? []).some((a: string) => t.includes(a))) return e;
  return null;
}
function dstr(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, x-supabase-cron", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const isCron = req.headers.get("x-supabase-cron") === "1";
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: authData } = bearer ? await supa.auth.getUser(bearer) : { data: { user: null } };
    if (!isCron && !authData.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });

    const { data: cfgRow, error: cfgErr } = await supa.from("config").select("data").eq("id", 1).single();
    if (cfgErr) throw cfgErr;
    const cfg = cfgRow.data;
    const url: string = cfg.icalUrl ?? "";
    if (!/^https:\/\/calendar\.google\.com\//.test(url) && !/\.ics(\?|$)/i.test(url)) {
      return Response.json({ error: "尚未設定有效的 iCal 網址(config.icalUrl)" }, { status: 400, headers: cors });
    }
    const now = new Date();
    const body = await req.json().catch(() => ({}));
    const from = body.from ?? dstr(new Date(now.getTime() - 7 * 86400000));
    const to = body.to ?? dstr(new Date(now.getTime() + 90 * 86400000));

    const r = await fetch(url);
    if (!r.ok) return Response.json({ error: "抓取 Google 日曆失敗 HTTP " + r.status }, { status: 502, headers: cors });
    const events = parseIcs(await r.text()).filter((e) => e.date >= from && e.date <= to);

    let applied = 0; const unmatched = new Set<string>(); let unparsed = 0;
    for (const ev of events) {
      const emp = matchEmp(ev.summary, cfg.employees ?? []);
      if (!emp) { unmatched.add(ev.summary); continue; }
      const av = parseGCalAvail(ev.summary);
      if (!av) { unparsed++; continue; }
      emp.availX = emp.availX ?? {};
      emp.availX[ev.date] = av;
      applied++;
    }
    const { error: upErr } = await supa.from("config").update({ data: cfg, updated_at: new Date().toISOString() }).eq("id", 1);
    if (upErr) throw upErr;
    return Response.json({ ok: true, range: { from, to }, events: events.length, applied, unparsed, unmatched: unmatched.size }, { headers: cors });
  } catch (e) {
    return Response.json({ error: "匯入錯誤: " + (e as Error).message }, { status: 500, headers: cors });
  }
});
