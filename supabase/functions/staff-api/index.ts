import { cors, distanceMeters, eligibilityErrors, getContext, json, queueNotification, rankCandidatesByWorkload, serviceClient, verifyLineIdToken } from "../_shared/common.ts";

const DAY = 86_400_000;
const dateText = (d: Date) => d.toISOString().slice(0, 10);
const MANUAL_WORK_ITEMS: Record<string, string> = {
  grandma: "外婆", haunted_shop: "詭店", haunted_prison: "詭獄", shit_power: "屎力全開",
  haunted_toilet: "詭廁", escapee: "越獄者", orphan: "孤兒怨", mr_mystery_counter: "謎先生櫃台",
  burgundy_counter: "桌遊大忠店櫃台", weekly_cleaning: "每週大清潔", practice: "練習場",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const profile = await verifyLineIdToken(req);
    const input = await req.json().catch(() => ({}));
    const action = String(input.action ?? "bootstrap");
    const sb = serviceClient();

    if (action === "bind") {
      const code = String(input.code ?? "").trim().toUpperCase();
      const { data: bind } = await sb.from("line_bind_codes").select("*").eq("code", code).maybeSingle();
      if (!bind || bind.used_at || new Date(bind.expires_at) < new Date()) return json({ error: "驗證碼無效或已過期" }, 400);
      const { data: existing } = await sb.from("line_accounts").select("emp_id").eq("line_user_id", profile.userId).maybeSingle();
      if (existing && existing.emp_id !== bind.emp_id) return json({ error: "此 LINE 已綁定其他員工" }, 409);
      const { error } = await sb.from("line_accounts").upsert({ emp_id: bind.emp_id, line_user_id: profile.userId,
        display_name: profile.displayName, role: bind.role, active: true, updated_at: new Date().toISOString() });
      if (error) throw error;
      await sb.from("line_bind_codes").update({ used_at: new Date().toISOString() }).eq("code", code);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: bind.emp_id, action: "bind_line", target_type: "employee", target_id: bind.emp_id });
      return json({ ok: true });
    }

    const { data: account } = await sb.from("line_accounts").select("*").eq("line_user_id", profile.userId).eq("active", true).maybeSingle();
    if (!account) return json({ error: "NOT_BOUND", displayName: profile.displayName }, 403);
    const { cfg, shifts } = await getContext(sb);
    const employee = (cfg.employees ?? []).find((e: any) => e.id === account.emp_id);
    if (!employee?.active) return json({ error: "員工帳號已停用" }, 403);

    if (action === "bootstrap") {
      const now = new Date(), from = dateText(new Date(now.getTime() - 7 * DAY)), to = dateText(new Date(now.getTime() + 60 * DAY));
      const [{ data: worksites }, { data: punches }, { data: requests }, { data: responses }, { data: attendanceDays }, { data: attendanceRequests }] = await Promise.all([
        sb.from("worksites").select("id,name,radius_m,enabled").eq("enabled", true),
        sb.from("punches").select("id,ts,type,worksite_id,verification,review_state,voided_at,void_reason,shift_ids,raw").eq("emp_id", employee.id).gte("ts", from).order("ts", { ascending: false }).limit(60),
        sb.from("shift_requests").select("*").or(`requester_emp_id.eq.${employee.id},target_emp_id.eq.${employee.id},target_emp_id.is.null`).order("created_at", { ascending: false }).limit(100),
        sb.from("shift_request_responses").select("*").eq("emp_id", employee.id),
        sb.from("attendance_daily").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
        sb.from("attendance_requests").select("*").eq("emp_id", employee.id).order("created_at", { ascending: false }).limit(30),
      ]);
      const publicEmployees = (cfg.employees ?? []).filter((e: any) => e.active).map((e: any) => ({ id: e.id, name: e.name }));
      const publicShifts = shifts.filter((s: any) => s.date >= from && s.date <= to).map((s: any) => ({
        id: s.id, date: s.date, storeId: s.storeId, kind: s.kind, themeId: s.themeId, start: s.start, end: s.end,
        status: s.status ?? "active", assignments: s.assignments ?? [],
      }));
      const publicPunches = (punches ?? []).map((p: any) => ({
        id: p.id, ts: p.ts, type: p.type, worksite_id: p.worksite_id, verification: p.verification,
        review_state: p.review_state, voided_at: p.voided_at, void_reason: p.void_reason, shift_ids: p.shift_ids ?? [],
        work_item: p.raw?.work_item ?? null,
      }));
      return json({ me: { id: employee.id, name: employee.name, role: account.role }, stores: cfg.stores, themes: cfg.themes,
        employees: publicEmployees, shifts: publicShifts, worksites, punches: publicPunches, requests, responses,
        attendanceDays, attendanceRequests, liffId: Deno.env.get("LINE_LIFF_ID") ?? "" });
    }

    if (action === "punch") {
      const type = String(input.type), lat = Number(input.latitude), lng = Number(input.longitude), accuracy = Number(input.accuracy ?? 9999);
      if (!["in", "out"].includes(type) || !Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "打卡資料不完整" }, 400);
      if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 250) return json({ error: "定位精確度不足，請開啟精確定位並到室外或窗邊重試" }, 403);
      const { data: sites } = await sb.from("worksites").select("*").eq("enabled", true).not("latitude", "is", null);
      const ranked = (sites ?? []).map((s: any) => ({ ...s, distance: distanceMeters(lat, lng, Number(s.latitude), Number(s.longitude)) }))
        .sort((a: any, b: any) => a.distance - b.distance);
      const site = ranked[0];
      if (!site || site.distance > site.radius_m + Math.min(accuracy, 50)) return json({ error: "目前不在允許的打卡地點範圍內" }, 403);
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      let selectedShifts: any[] = [];
      let workItem: any = null;
      let verification = "line_location";
      if (type === "in") {
        const requestedIds = Array.isArray(input.shiftIds) ? [...new Set(input.shiftIds.map(String))] : [];
        selectedShifts = shifts.filter((s: any) => requestedIds.includes(String(s.id)));
        const invalidSelection = selectedShifts.some((s: any) => s.date !== today || s.storeId !== site.id || s.status === "cancelled" ||
          !(s.assignments ?? []).some((a: any) => a.empId === employee.id));
        if (invalidSelection || selectedShifts.length !== requestedIds.length) return json({ error: "選取的場次不屬於你今天在這間店的班表，請重新整理後再試。" }, 409);
        if (selectedShifts.length) {
          workItem = { source: "scheduled", labels: selectedShifts.map((s: any) => {
            const theme = (cfg.themes ?? []).find((t: any) => t.id === s.themeId)?.name;
            const label = s.kind === "theme" ? theme : s.kind === "counter" ? (s.storeId === "ms" ? "謎先生櫃台" : "桌遊大忠店櫃台") :
              s.kind === "cleaning" ? "每週大清潔" : s.kind === "practice" ? "練習場" : s.kind === "floor" ? "場控／現場支援" : "其他工作";
            const role = (s.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
            return `${s.start}–${s.end} ${label}${role ? `（${role}）` : ""}`;
          }) };
        } else {
          const code = String(input.workItemCode ?? "");
          if (!MANUAL_WORK_ITEMS[code]) return json({ error: "請先選擇今天要執行的主題、櫃台或練習場。" }, 400);
          workItem = { source: "temporary_support", code, labels: [MANUAL_WORK_ITEMS[code]] };
          verification = "line_location_unassigned";
        }
      } else {
        const { data: latest } = await sb.from("punches").select("type,worksite_id,shift_ids,raw").eq("emp_id", employee.id)
          .is("voided_at", null).order("ts", { ascending: false }).limit(1).maybeSingle();
        if (!latest || latest.type !== "in") return json({ error: "目前沒有尚未下班的上班卡。" }, 409);
        selectedShifts = shifts.filter((s: any) => (latest.shift_ids ?? []).includes(s.id));
        workItem = latest.raw?.work_item ?? null;
        if (latest.raw?.verification === "line_location_unassigned") verification = "line_location_unassigned";
        else if (latest.worksite_id !== site.id) verification = "line_location_cross_site";
      }
      const { data, error } = await sb.rpc("record_line_punch", { p_emp: employee.id, p_type: type, p_worksite: site.id,
        p_lat: lat, p_lng: lng, p_accuracy: accuracy, p_verification: verification, p_shift_ids: selectedShifts.map((s: any) => s.id),
        p_raw: { distance_m: Math.round(site.distance), line_user_id: profile.userId, user_agent: req.headers.get("user-agent") ?? "", work_item: workItem, verification } });
      if (error) return json({ error: error.message }, error.message.includes("目前已") ? 409 : 500);
      return json({ ...data, site: site.name, distance: Math.round(site.distance), workItem,
        warning: verification === "line_location" ? null : "本次打卡屬於臨時支援或跨店下班，已記錄並交由管理員確認。" });
    }

    if (action === "create-request") {
      const type = String(input.requestType), shiftId = String(input.shiftId), offeredId = input.offeredShiftId ? String(input.offeredShiftId) : null;
      if (!["give", "swap"].includes(type)) return json({ error: "申請類型錯誤" }, 400);
      const shift = shifts.find((s: any) => s.id === shiftId);
      if (!shift || !(shift.assignments ?? []).some((a: any) => a.empId === employee.id)) return json({ error: "你不在此班次中" }, 403);
      const shiftStart = new Date(`${shift.date}T${shift.start}:00+08:00`).getTime();
      if (shift.status === "cancelled" || shiftStart <= Date.now()) return json({ error: "此班次已取消或已開始" }, 409);
      const { data: duplicate } = await sb.from("shift_requests").select("id").eq("requester_emp_id", employee.id).eq("shift_id", shiftId)
        .in("status", ["open", "pending_manager"]).limit(1).maybeSingle();
      if (duplicate) return json({ error: "此班次已有進行中的申請" }, 409);
      const offeredShift = type === "swap" ? shifts.find((s: any) => s.id === offeredId) : null;
      if (type === "swap") {
        if (!offeredShift || !(offeredShift.assignments ?? []).some((a: any) => a.empId && a.empId !== employee.id)) return json({ error: "交換班次無效" }, 400);
      }
      const requestedDeadline = input.deadline ? new Date(input.deadline).getTime() : Date.now() + 24 * 3_600_000;
      const deadline = new Date(Math.max(Date.now() + 5 * 60_000, Math.min(requestedDeadline, shiftStart - 60 * 60_000))).toISOString();
      const { data: request, error } = await sb.from("shift_requests").insert({ request_type: type, shift_id: shiftId,
        requester_emp_id: employee.id, offered_shift_id: offeredId, target_emp_id: input.targetEmpId || null, deadline,
        details: { note: String(input.note ?? "") } }).select().single();
      if (error) throw error;
      const targetRole = (shift.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
      const offeredEmployeeIds = new Set((offeredShift?.assignments ?? []).map((a: any) => a.empId).filter(Boolean));
      const eligibleCandidates = (cfg.employees ?? []).filter((e: any) => e.id !== employee.id && (!input.targetEmpId || e.id === input.targetEmpId))
        .filter((e: any) => type !== "swap" || offeredEmployeeIds.has(e.id))
        .filter((e: any) => eligibilityErrors(e, shift, targetRole, shifts, cfg, [offeredId].filter(Boolean) as string[]).length === 0);
      const candidates = rankCandidatesByWorkload(eligibleCandidates, shifts, shift.date, 2);
      if (!candidates.length) {
        await sb.from("shift_requests").delete().eq("id", request.id);
        return json({ error: "目前找不到符合技能與時間的接班者" }, 409);
      }
      for (const candidate of candidates) await queueNotification(sb, candidate.id, "shift_request", {
        title: type === "swap" ? "換班邀請" : "讓班邀請", requestId: request.id, shift: { date: shift.date, start: shift.start, end: shift.end },
        text: `${employee.name}提出${type === "swap" ? "換班" : "讓班"}申請`, actions: true,
      }, false, `shift-request:${request.id}:${candidate.id}`);
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "shift_change_requested", {
        title: type === "swap" ? "員工提出換班" : "員工提出讓班",
        text: `${employee.name}提出 ${shift.date} ${shift.start}–${shift.end} ${type === "swap" ? "換班" : "讓班"}申請，系統已通知合適人選。`,
      }, false, `shift-change-manager:${request.id}:${manager.emp_id}`);
      return json({ ok: true, requestId: request.id, candidates: candidates.length });
    }

    if (action === "respond-request") {
      const requestId = String(input.requestId), response = String(input.response);
      if (!["accept", "decline"].includes(response)) return json({ error: "回覆錯誤" }, 400);
      if (response === "decline") {
        await sb.from("shift_request_responses").upsert({ request_id: requestId, emp_id: employee.id, response: "decline" });
        return json({ ok: true, message: "已回覆無法接班" });
      }
      const { data: request } = await sb.from("shift_requests").select("*").eq("id", requestId).single();
      const shift = shifts.find((s: any) => s.id === request.shift_id);
      const role = (shift?.assignments ?? []).find((a: any) => a.empId === request.requester_emp_id)?.role ??
        (shift?.assignments ?? []).find((a: any) => !a.empId)?.role ?? "";
      const errors = eligibilityErrors(employee, shift, role, shifts, cfg, request.offered_shift_id ? [request.offered_shift_id] : []);
      if (request.request_type === "swap") {
        const requester = cfg.employees.find((e: any) => e.id === request.requester_emp_id);
        const offered = shifts.find((s: any) => s.id === request.offered_shift_id);
        const offeredRole = (offered?.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
        errors.push(...eligibilityErrors(requester, offered, offeredRole, shifts, cfg, [request.shift_id]));
      }
      if (errors.length) return json({ error: errors.join("、") }, 409);
      const { data, error } = await sb.rpc("accept_shift_request", { p_request: requestId, p_line_user_id: profile.userId });
      if (error) throw error;
      if (!data?.ok) return json({ error: data?.msg ?? "接班失敗" }, 409);
      if (!data.pending_manager && request.requester_emp_id) await queueNotification(sb, request.requester_emp_id, "shift_result", {
        title: "班表異動完成", text: data.msg, requestId,
      }, true, `shift-result:${requestId}:${request.requester_emp_id}`);
      return json({ ok: true, message: data.msg });
    }

    if (action === "attendance-request") {
      const reason = String(input.reason ?? "").trim();
      if (!reason) return json({ error: "請填寫補卡原因" }, 400);
      const requestType = String(input.requestType ?? "");
      if (!["missing_in", "missing_out", "correction"].includes(requestType)) return json({ error: "請選擇補上班卡、補下班卡或更正整日時間" }, 400);
      const punchDate = String(input.punchDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(punchDate)) return json({ error: "補卡日期格式錯誤" }, 400);
      const requested = input.requested ?? {};
      const workItemCode = String(requested.workItemCode ?? "");
      if (!MANUAL_WORK_ITEMS[workItemCode]) return json({ error: "請選擇補卡的主題或工作項目" }, 400);
      requested.workItem = { code: workItemCode, labels: [MANUAL_WORK_ITEMS[workItemCode]], source: "attendance_request" };
      delete requested.workItemCode;
      const timeOk = (v: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ""));
      if (["missing_in", "missing_out"].includes(requestType) && !timeOk(requested.time)) return json({ error: "請填寫正確的補卡時間" }, 400);
      if (requestType === "correction" && (!timeOk(requested.inTime) || !timeOk(requested.outTime) || requested.inTime >= requested.outTime))
        return json({ error: "請填寫正確且先後順序一致的上下班時間" }, 400);
      const { data: duplicate } = await sb.from("attendance_requests").select("id").eq("emp_id", employee.id).eq("punch_date", punchDate).eq("status", "pending").maybeSingle();
      if (duplicate) return json({ error: "這一天已有待審核的補卡申請" }, 409);
      const { error } = await sb.from("attendance_requests").insert({ emp_id: employee.id, punch_date: punchDate,
        request_type: requestType, requested, reason });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, message.includes("LINE_") ? 401 : 500);
  }
});
