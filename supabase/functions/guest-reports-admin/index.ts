import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, queueNotification, serviceClient } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const authorization = req.headers.get("authorization") ?? "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user || user.aud !== "authenticated" || !user.email_confirmed_at) return json({ error: "ADMIN_LOGIN_REQUIRED" }, 401);

    const input = await req.json().catch(() => ({})), action = String(input.action ?? "list"), sb = serviceClient();
    if (action === "list") {
      const { data, error } = await sb.from("guest_booking_reports").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ reports: data ?? [] });
    }
    if (action === "review") {
      const id = String(input.id ?? ""), status = String(input.status ?? ""), reply = String(input.reply ?? "").trim();
      if (!["confirmed", "rejected"].includes(status) || !reply) return json({ error: "請填寫有效的處理結果" }, 400);
      const { data: report, error: findError } = await sb.from("guest_booking_reports").select("*").eq("id", id).eq("status", "pending").maybeSingle();
      if (findError) throw findError;
      if (!report) return json({ error: "回報已處理或不存在" }, 409);
      const now = new Date().toISOString();
      const { error } = await sb.from("guest_booking_reports").update({ status, manager_reply: reply, reviewed_by: user.id,
        reviewed_at: now, updated_at: now }).eq("id", id).eq("status", "pending");
      if (error) throw error;
      await queueNotification(sb, report.emp_id, "guest_booking_result", {
        title: status === "confirmed" ? "客人預約已處理" : "客人回報無法受理", text: reply,
      }, true, `guest-result:${id}:${status}`);
      await sb.from("audit_log").insert({ actor_type: "supabase_admin", actor_id: user.id, action: "review_guest_booking_report",
        target_type: "guest_booking_report", target_id: id, details: { status } });
      return json({ ok: true });
    }
    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
