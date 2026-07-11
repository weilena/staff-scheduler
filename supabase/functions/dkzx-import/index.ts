// 打卡之星 → 雲端 匯入(Edge Function)
// 店內電腦的抓取程式每天凌晨把報表頁資料 POST 到這裡:
//   POST /functions/v1/dkzx-import?key=SYNC_SECRET   body = 抓取程式的 dump JSON
// 1) 原始資料整包存進 dkzx_raw(永久留底,解析規則日後可調整重跑)
// 2) 嘗試解析出「姓名 + 上/下班時間(+班別)」寫入 punches(source='dkzx')
// 重新解析既有原始資料(不用動店內電腦):
//   POST /functions/v1/dkzx-import?key=SYNC_SECRET&reparse=1&date=YYYY-MM-DD
//
// 部署:supabase functions deploy dkzx-import --no-verify-jwt
// 資料表:先在 SQL Editor 執行 supabase/schema-dkzx.sql

import { createClient } from "npm:@supabase/supabase-js@2";

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function norm(t: string) {
  const [h, m] = t.split(":");
  return h.padStart(2, "0") + ":" + m;
}

// 從表格中解析打卡列:一列裡「有員工名字 + 一個以上 HH:MM」就視為一筆
function parseTables(tables: string[][][], employees: any[], fallbackDate: string) {
  const out: any[] = [];
  const unmatched = new Set<string>();
  for (const table of tables ?? []) {
    for (const row of table) {
      const cells = row.map((c) => String(c ?? "").trim());
      const times = cells.filter((c) => TIME_RE.test(c)).map(norm);
      if (!times.length) continue;
      // 列內找日期(YYYY-MM-DD 或 YYYY/MM/DD 或 MM/DD)
      let date = fallbackDate;
      for (const c of cells) {
        const m1 = c.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (m1) { date = `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`; break; }
      }
      // 列內找員工
      const emp = employees.find((e: any) =>
        cells.some((c) => c === e.name || c.includes(e.name) || (e.aliases ?? []).some((a: string) => c === a || c.includes(a)))
      );
      if (!emp) {
        // 記下疑似名字的儲存格(2~4 個中文字)供後台補建員工
        const nameLike = cells.find((c) => /^[一-鿿]{2,4}$/.test(c));
        if (nameLike) unmatched.add(nameLike);
        continue;
      }
      // 班別:列內出現「早/午/晚/加班」等字樣的短儲存格
      const shiftType = cells.find((c) => /班/.test(c) && c.length <= 6 && !TIME_RE.test(c)) ?? "";
      out.push({ empId: emp.id, name: emp.name, date, in: times[0] ?? null, out: times.length > 1 ? times[times.length - 1] : null, shiftType });
    }
  }
  return { records: out, unmatched: [...unmatched] };
}

// 從 XHR JSON 深層找「含名字與時間」的物件陣列(打卡 App 常見回傳格式)
function parseXhr(xhr: any[], employees: any[], fallbackDate: string) {
  const out: any[] = [];
  const seen = new Set<string>();
  const visit = (v: any, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => visit(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const values = Object.values(v).map((x) => String(x ?? ""));
    const emp = employees.find((e: any) => values.some((s) => s === e.name || (e.aliases ?? []).includes(s)));
    const times = values.map((s) => {
      const m = s.match(/([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?/);
      return m ? norm(m[0]) : null;
    }).filter(Boolean) as string[];
    if (emp && times.length) {
      let date = fallbackDate;
      for (const s of values) {
        const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (m) { date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; break; }
      }
      const key = emp.id + "|" + date + "|" + times.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        const st = values.find((s) => /班/.test(s) && s.length <= 6) ?? "";
        out.push({ empId: emp.id, name: emp.name, date, in: times[0], out: times.length > 1 ? times[times.length - 1] : null, shiftType: st });
      }
    }
    Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  (xhr ?? []).forEach((r) => visit(r.json, 0));
  return out;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("key") !== Deno.env.get("SYNC_SECRET")) {
      return new Response("unauthorized", { status: 401 });
    }
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let dump: any;
    let dumpDate: string;
    if (url.searchParams.get("reparse") === "1") {
      dumpDate = url.searchParams.get("date") ?? "";
      const { data } = await supa.from("dkzx_raw").select("payload").eq("id", dumpDate).single();
      if (!data) return Response.json({ error: "查無 " + dumpDate + " 的原始資料" }, { status: 404 });
      dump = data.payload;
    } else {
      dump = await req.json();
      dumpDate = String(dump.date ?? new Date().toISOString().slice(0, 10));
      await supa.from("dkzx_raw").upsert({ id: dumpDate, payload: dump });
    }

    const { data: cfgRow } = await supa.from("config").select("data").eq("id", 1).single();
    const employees = cfgRow?.data?.employees ?? [];

    const t = parseTables(dump.tables ?? [], employees, dumpDate);
    const x = parseXhr(dump.xhr ?? [], employees, dumpDate);
    // 表格與 XHR 兩路解析取聯集(同人同日同時間只留一筆)
    const all = [...t.records, ...x];
    const rows: any[] = [];
    for (const r of all) {
      if (r.in) rows.push({ id: `dkzx_${r.empId}_${r.date}_in`, emp_id: r.empId, ts: `${r.date}T${r.in}:00`, type: "in", source: "dkzx" });
      if (r.out) rows.push({ id: `dkzx_${r.empId}_${r.date}_out`, emp_id: r.empId, ts: `${r.date}T${r.out}:00`, type: "out", source: "dkzx" });
    }
    const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
    if (uniq.length) {
      const { error } = await supa.from("punches").upsert(uniq);
      if (error) return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({
      date: dumpDate, stored_raw: url.searchParams.get("reparse") !== "1",
      parsed_people: all.length, punches_upserted: uniq.length,
      unmatched_names: t.unmatched,   // 系統裡沒有的名字 → 後台「員工」頁補建後可 reparse
      hint: uniq.length === 0 ? "解析不到資料:請把 dumps 檔給 Claude 調整解析規則,原始資料已留底可重跑" : "ok",
    });
  } catch (e) {
    return new Response("匯入錯誤: " + (e as Error).message, { status: 500 });
  }
});
