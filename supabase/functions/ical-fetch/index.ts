// Google 日曆(iCal)代抓 + 解析(Edge Function)
// 瀏覽器直接抓 Google 的 .ics 會被 CORS 擋,所以由此函式在伺服器端抓取、解析後回傳。
// 只讀取,不會更動你的 Google 日曆。
//   POST /functions/v1/ical-fetch   body: { url?: string, from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
// url 省略時讀 config.data.icalUrl。回傳該區間的全天事件 [{date, summary}]。
//
// 部署:supabase functions deploy ical-fetch(保留 JWT 驗證,限登入管理者)

import { createClient } from "npm:@supabase/supabase-js@2";

function unfold(text: string): string[] {
  // iCal 折行:下一行以空白或 tab 開頭表示接續
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const ln of lines) {
    if ((ln.startsWith(" ") || ln.startsWith("\t")) && out.length) out[out.length - 1] += ln.slice(1);
    else out.push(ln);
  }
  return out;
}

function parseIcs(text: string) {
  const events: { date: string; end: string; summary: string; allDay: boolean }[] = [];
  let cur: any = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur && cur.date) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const rawKey = line.slice(0, i);
    const val = line.slice(i + 1);
    const key = rawKey.split(";")[0];
    if (key === "DTSTART") {
      const m = val.match(/(\d{4})(\d{2})(\d{2})/);
      if (m) { cur.date = `${m[1]}-${m[2]}-${m[3]}`; cur.allDay = !val.includes("T"); }
    } else if (key === "DTEND") {
      const m = val.match(/(\d{4})(\d{2})(\d{2})/);
      if (m) cur.end = `${m[1]}-${m[2]}-${m[3]}`;
    } else if (key === "SUMMARY") {
      cur.summary = val.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
    }
  }
  return events;
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    let url: string = body.url ?? "";
    if (!url) {
      const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await supa.from("config").select("data").eq("id", 1).single();
      url = data?.data?.icalUrl ?? "";
    }
    if (!/^https:\/\/calendar\.google\.com\//.test(url) && !/\.ics(\?|$)/i.test(url)) {
      return Response.json({ error: "請提供有效的 Google 日曆 iCal 網址(私人 .ics 網址)" }, { status: 400, headers: cors });
    }
    const r = await fetch(url);
    if (!r.ok) return Response.json({ error: "抓取失敗 HTTP " + r.status }, { status: 502, headers: cors });
    const text = await r.text();
    let events = parseIcs(text);
    const from = body.from, to = body.to;
    if (from && to) events = events.filter((e) => e.date >= from && e.date <= to);
    events.sort((a, b) => (a.date + a.summary).localeCompare(b.date + b.summary));
    return Response.json({ count: events.length, events }, { headers: cors });
  } catch (e) {
    return Response.json({ error: "解析錯誤: " + (e as Error).message }, { status: 500, headers: cors });
  }
});
