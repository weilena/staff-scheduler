import { json, queueNotification, serviceClient } from "../_shared/common.ts";

async function push(to: string, payload: any) {
  const actions = payload.actions && payload.requestId ? [{
    type: "template", altText: payload.title ?? "排班通知", template: {
      type: "buttons", title: String(payload.title ?? "排班通知").slice(0, 40), text: String(payload.text ?? "請回覆").slice(0, 160),
      actions: [
        { type: "postback", label: "我要接班", data: `action=request_response&request=${payload.requestId}&response=accept`, displayText: "我要接班" },
        { type: "postback", label: "這次無法", data: `action=request_response&request=${payload.requestId}&response=decline`, displayText: "這次無法接班" },
      ],
    },
  }] : [{ type: "text", text: `${payload.title ? `${payload.title}\n` : ""}${payload.text ?? "排班資料有更新，請開啟員工入口查看。"}` }];
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")}` },
    body: JSON.stringify({ to, messages: actions }),
  });
  if (!response.ok) throw new Error(await response.text());
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const key = req.headers.get("x-dispatch-secret") ?? new URL(req.url).searchParams.get("key");
  if (!key || key !== Deno.env.get("DISPATCH_SECRET")) return json({ error: "UNAUTHORIZED" }, 401);
  const sb = serviceClient(), now = new Date(), month = now.toISOString().slice(0, 7);

  await sb.from("shift_requests").update({ status: "expired", updated_at: now.toISOString() })
    .in("request_type", ["give", "swap"]).eq("status", "open").lte("deadline", now.toISOString());

  // 截止時只建立一則管理員摘要，利用 idempotency key 防止重複。
  const { data: due } = await sb.from("shift_requests").select("id,shift_id,status").eq("request_type", "extra").in("status", ["open", "pending_manager"]).lte("deadline", now.toISOString());
  const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
  for (const request of due ?? []) {
    const { data: responses } = await sb.from("shift_request_responses").select("emp_id,response").eq("request_id", request.id);
    const accepted = (responses ?? []).filter((r: any) => r.response === "accept").length;
    for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "manager_summary", {
      title: accepted ? "加場候選名單已截止" : "加場目前無人可接", text: `班次 ${request.shift_id}，願意接班 ${accepted} 人。請開啟管理後台處理。`, requestId: request.id,
    }, true, `manager-summary:${request.id}:${manager.emp_id}`);
    await sb.from("shift_requests").update({ status: accepted ? "pending_manager" : "expired", updated_at: now.toISOString() }).eq("id", request.id);
  }

  const { data: usageRow } = await sb.from("message_usage").select("chargeable_count").eq("month", month).maybeSingle();
  let usage = Number(usageRow?.chargeable_count ?? 0), sent = 0, skipped = 0, failed = 0;
  const { data: jobs } = await sb.from("notification_outbox").select("*").eq("status", "pending").order("critical", { ascending: false }).order("created_at").limit(100);
  for (const job of jobs ?? []) {
    try {
      if (job.chargeable && usage >= 200) {
        await sb.from("notification_outbox").update({ status: "skipped", error: "已達每月200則上限" }).eq("id", job.id); skipped++; continue;
      }
      if (job.chargeable && usage >= 160 && !job.critical) {
        await sb.from("notification_outbox").update({ status: "skipped", error: "已達每月160則保留門檻" }).eq("id", job.id); skipped++; continue;
      }
      let lineUser = job.recipient_line_user_id;
      if (!lineUser && job.recipient_emp_id) {
        const { data: account } = await sb.from("line_accounts").select("line_user_id").eq("emp_id", job.recipient_emp_id).eq("active", true).maybeSingle();
        lineUser = account?.line_user_id;
      }
      if (!lineUser) { await sb.from("notification_outbox").update({ status: "skipped", error: "員工尚未綁定LINE" }).eq("id", job.id); skipped++; continue; }
      await push(lineUser, job.payload);
      await sb.from("notification_outbox").update({ status: "sent", sent_at: new Date().toISOString(), recipient_line_user_id: lineUser }).eq("id", job.id);
      if (job.chargeable) usage++; sent++;
    } catch (error) {
      await sb.from("notification_outbox").update({ status: "failed", error: error instanceof Error ? error.message : String(error) }).eq("id", job.id); failed++;
    }
  }
  await sb.from("message_usage").upsert({ month, chargeable_count: usage, updated_at: new Date().toISOString() });
  return json({ ok: true, sent, skipped, failed, usage });
});
