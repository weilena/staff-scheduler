const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: cors });
}

async function validSignature(raw: string, signature: string) {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (expected.length !== signature.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function reply(replyToken: string, messages: any[]) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")}` },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!response.ok) throw new Error(`LINE reply failed: ${await response.text()}`);
}

function employeePortalMessages() {
  const portal = Deno.env.get("LINE_LIFF_URL") ?? "";
  if (!portal) return [{ type: "text", text: "員工入口尚未完成設定，請通知管理員。" }];
  const link = (tab: string) => `${portal}${portal.includes("?") ? "&" : "?"}tab=${tab}`;
  return [{
    type: "template",
    altText: "員工班表與打卡選單",
    template: {
      type: "buttons",
      title: "mythworker 員工專區",
      text: "請選擇要使用的功能",
      actions: [
        { type: "uri", label: "查看班表", uri: link("schedule") },
        { type: "uri", label: "手機定位打卡", uri: link("punch") },
        { type: "uri", label: "正職換班申請", uri: link("requests") },
      ],
    },
  }];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const raw = await req.text();
  if (!await validSignature(raw, req.headers.get("x-line-signature") ?? "")) return json({ error: "INVALID_SIGNATURE" }, 401);
  const body = JSON.parse(raw || "{}");
  const events = body.events ?? [];
  // LINE's Verify request contains no events. Return immediately so cold-starting
  // the database client cannot make the verification request time out.
  if (!events.length) return json({ ok: true });
  const { eligibilityErrors, getContext, queueNotification, serviceClient } = await import("../_shared/common.ts");
  const sb = serviceClient();
  for (const event of events) {
    const eventId = String(event.webhookEventId ?? "");
    if (eventId) {
      const { error } = await sb.from("line_events").insert({ event_id: eventId, event_type: event.type });
      if (error?.code === "23505") continue;
      if (error) throw error;
    }
    if (event.type === "follow" && event.replyToken) {
      await reply(event.replyToken, employeePortalMessages());
      continue;
    }
    if (event.type === "message" && event.message?.type === "text" && event.replyToken) {
      await reply(event.replyToken, employeePortalMessages());
      continue;
    }
    if (event.type !== "postback" || !event.replyToken || !event.source?.userId) continue;
    const params = new URLSearchParams(String(event.postback?.data ?? ""));
    if (params.get("action") !== "request_response") continue;
    const requestId = params.get("request") ?? "", response = params.get("response") ?? "";
    const { data: account } = await sb.from("line_accounts").select("*").eq("line_user_id", event.source.userId).eq("active", true).maybeSingle();
    if (!account) { await reply(event.replyToken, [{ type: "text", text: "LINE 尚未綁定員工身分，請先開啟員工入口完成綁定。" }]); continue; }
    if (response === "decline") {
      await sb.from("shift_request_responses").upsert({ request_id: requestId, emp_id: account.emp_id, response: "decline" });
      await reply(event.replyToken, [{ type: "text", text: "已登記：這次無法接班。" }]);
      continue;
    }
    const [{ data: request }, context] = await Promise.all([
      sb.from("shift_requests").select("*").eq("id", requestId).single(), getContext(sb),
    ]);
    const emp = context.cfg.employees.find((e: any) => e.id === account.emp_id);
    const shift = context.shifts.find((s: any) => s.id === request?.shift_id);
    const role = (shift?.assignments ?? []).find((a: any) => a.empId === request?.requester_emp_id)?.role ??
      (shift?.assignments ?? []).find((a: any) => !a.empId)?.role ?? "";
    const errors = eligibilityErrors(emp, shift, role, context.shifts, context.cfg, request?.offered_shift_id ? [request.offered_shift_id] : []);
    if (request?.request_type === "swap") {
      const requester = context.cfg.employees.find((e: any) => e.id === request.requester_emp_id);
      const offered = context.shifts.find((s: any) => s.id === request.offered_shift_id);
      const offeredRole = (offered?.assignments ?? []).find((a: any) => a.empId === account.emp_id)?.role ?? "";
      errors.push(...eligibilityErrors(requester, offered, offeredRole, context.shifts, context.cfg, [request.shift_id]));
    }
    if (errors.length) { await reply(event.replyToken, [{ type: "text", text: `目前無法接班：${errors.join("、")}` }]); continue; }
    const { data, error } = await sb.rpc("accept_shift_request", { p_request: requestId, p_line_user_id: event.source.userId });
    if (error) throw error;
    if (data?.ok && !data.pending_manager && request?.requester_emp_id) await queueNotification(sb, request.requester_emp_id, "shift_result",
      { title: "班表異動完成", text: data.msg, requestId }, true, `shift-result:${requestId}:${request.requester_emp_id}`);
    await reply(event.replyToken, [{ type: "text", text: data?.msg ?? "處理失敗，請重新查詢班表。" }]);
  }
  return json({ ok: true });
});
