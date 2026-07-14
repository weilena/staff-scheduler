import { cors, distanceMeters, eligibilityErrors, getContext, json, queueNotification, rankCandidatesByWorkload, serviceClient, toMinutes, verifyLineIdToken } from "../_shared/common.ts";

const DAY = 86_400_000;
const dateText = (d: Date) => d.toISOString().slice(0, 10);
const MANUAL_WORK_ITEMS: Record<string, string> = {
  grandma: "外婆", haunted_shop: "詭店", haunted_prison: "詭獄", shit_power: "屎力全開",
  haunted_toilet: "詭廁", escapee: "越獄者", orphan: "孤兒怨", mr_mystery_counter: "謎先生櫃台",
  burgundy_counter: "桌遊大忠店櫃台", weekly_cleaning: "每週大清潔", practice: "練習場", floor_support: "場控／現場支援",
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
      const now = new Date(), from = dateText(new Date(now.getTime() - 60 * DAY)), to = dateText(new Date(now.getTime() + 60 * DAY));
      const [{ data: worksites }, { data: punches }, { data: sessionCheckins }, { data: shiftConfirmations }, { data: attendanceDays }, { data: attendanceRequests }] = await Promise.all([
        sb.from("worksites").select("id,name,radius_m,enabled").eq("enabled", true),
        sb.from("punches").select("id,ts,type,worksite_id,verification,review_state,voided_at,void_reason,shift_ids,raw").eq("emp_id", employee.id).gte("ts", from).order("ts", { ascending: false }).limit(60),
        sb.from("session_checkins").select("id,shift_id,checked_in_at,worksite_id,verification,source,note").eq("emp_id", employee.id).gte("checked_in_at", from).order("checked_in_at", { ascending: false }).limit(100),
        sb.from("shift_confirmations").select("shift_id,status,confirmed_at").eq("emp_id", employee.id),
        sb.from("attendance_daily").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
        sb.from("attendance_requests").select("*").eq("emp_id", employee.id).order("created_at", { ascending: false }).limit(30),
      ]);
      const publicEmployees = (cfg.employees ?? []).filter((e: any) => e.active).map((e: any) => ({ id: e.id, name: e.name }));
      const publicShifts = shifts.filter((s: any) => s.date >= from && s.date <= to).map((s: any) => {
        const emptyRoles = (s.assignments ?? []).filter((a: any) => !a.empId).map((a: any) => String(a.role ?? ""));
        const eligible = emptyRoles.length ? (cfg.employees ?? []).filter((candidate: any) => candidate.active &&
          emptyRoles.some((role: string) => eligibilityErrors(candidate, s, role, shifts, cfg).length === 0)) : [];
        const ranked = rankCandidatesByWorkload(eligible, shifts, s.date, 99);
        const onSite = ranked.filter((candidate: any) => shifts.some((other: any) => other.id !== s.id && other.date === s.date &&
          other.storeId === s.storeId && other.status !== "cancelled" && (other.assignments ?? []).some((a: any) => a.empId === candidate.id)));
        const onSiteIds = new Set(onSite.map((candidate: any) => candidate.id));
        return {
          id: s.id, date: s.date, storeId: s.storeId, kind: s.kind, themeId: s.themeId, start: s.start, end: s.end,
          status: s.status ?? "active", assignments: s.assignments ?? [], candidateGroups: emptyRoles.length ? {
            onSite: onSite.map((candidate: any) => candidate.name),
            available: ranked.filter((candidate: any) => !onSiteIds.has(candidate.id)).map((candidate: any) => candidate.name),
          } : null,
        };
      });
      const publicPunches = (punches ?? []).map((p: any) => ({
        id: p.id, ts: p.ts, type: p.type, worksite_id: p.worksite_id, verification: p.verification,
        review_state: p.review_state, voided_at: p.voided_at, void_reason: p.void_reason, shift_ids: p.shift_ids ?? [],
        work_item: p.raw?.work_item ?? null,
      }));
      return json({ me: { id: employee.id, name: employee.name, role: account.role, type: employee.type,
          canSchedulePractice: account.role === "manager" || (employee.type === "full" && !!employee.canSchedulePractice) }, stores: cfg.stores, themes: cfg.themes,
        employees: publicEmployees, shifts: publicShifts, worksites, punches: publicPunches,
        attendanceDays, attendanceRequests, sessionCheckins, shiftConfirmations, liffId: Deno.env.get("LINE_LIFF_ID") ?? "" });
    }

    if (action === "confirm-shift") {
      const shiftId = String(input.shiftId ?? "");
      const shift = shifts.find((s: any) => String(s.id) === shiftId && s.status !== "cancelled");
      if (!shift || !(shift.assignments ?? []).some((a: any) => a.empId === employee.id)) return json({ error: "這個班次未指派給你，或已經取消。" }, 403);
      const { error } = await sb.from("shift_confirmations").upsert({ shift_id: shiftId, emp_id: employee.id, status: "confirmed", source: "line", confirmed_at: new Date().toISOString() });
      if (error) throw error;
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "confirm_shift", target_type: "shift", target_id: shiftId,
        details: { date: shift.date, start: shift.start, end: shift.end, kind: shift.kind } });
      return json({ ok: true, message: "已確認收到這個班次" });
    }

    if (action === "schedule-practice") {
      if (account.role !== "manager" && !(employee.type === "full" && employee.canSchedulePractice)) return json({ error: "你沒有安排新人練習場的權限" }, 403);
      const date = String(input.date ?? ""), start = String(input.start ?? ""), end = String(input.end ?? ""), storeId = String(input.storeId ?? "");
      const traineeId = String(input.traineeId ?? ""), companionId = String(input.companionId ?? ""), note = String(input.note ?? "").trim();
      const timeOk = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeOk(start) || !timeOk(end) || toMinutes(end) <= toMinutes(start)) return json({ error: "請填寫正確的練習日期與起訖時間" }, 400);
      if (!(cfg.stores ?? []).some((s: any) => s.id === storeId)) return json({ error: "練習場地錯誤" }, 400);
      const trainee = (cfg.employees ?? []).find((e: any) => e.id === traineeId && e.active), companion = (cfg.employees ?? []).find((e: any) => e.id === companionId && e.active);
      if (!trainee || !companion) return json({ error: "請選擇在職的練習員工與陪練人員" }, 400);
      if (trainee.id === companion.id) return json({ error: "練習員工與陪練人員不可為同一人" }, 400);
      const startsAt = new Date(`${date}T${start}:00+08:00`).getTime();
      if (startsAt <= Date.now()) return json({ error: "練習場開始時間必須晚於現在" }, 409);
      const id = `practice_${crypto.randomUUID()}`, target = { id, date, storeId, kind: "practice", themeId: null, start, end, status: "active", assignments: [] };
      const traineeErrors = eligibilityErrors(trainee, target, "練習場", shifts, cfg), companionErrors = eligibilityErrors(companion, target, "陪練", shifts, cfg);
      if (traineeErrors.length || companionErrors.length) return json({ error: [traineeErrors.length ? `${trainee.name}：${traineeErrors.join("、")}` : "", companionErrors.length ? `${companion.name}：${companionErrors.join("、")}` : ""].filter(Boolean).join("；") }, 409);
      const shift = { ...target, note, assignments: [{ role: "練習場", empId: trainee.id }, { role: "陪練", empId: companion.id }],
        createdBy: employee.id, createdVia: "line_practice_scheduler" };
      const { error } = await sb.from("shifts").insert({ id, date, source: "manual", data: shift });
      if (error) throw error;
      const label = `${date} ${start}–${end} ${(cfg.stores ?? []).find((s: any) => s.id === storeId)?.name ?? ""}`;
      await queueNotification(sb, trainee.id, "practice_assigned", { title: "新人練習場安排", text: `${label}，陪練：${companion.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:trainee`);
      await queueNotification(sb, companion.id, "practice_companion", { title: "陪練工作安排", text: `${label}，練習員工：${trainee.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:companion`);
      const informed = new Set([trainee.id, companion.id, employee.id]);
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) if (!informed.has(manager.emp_id)) await queueNotification(sb, manager.emp_id, "practice_scheduled_manager", {
        title: "練習場已安排", text: `${employee.name}安排 ${label}：${trainee.name} 練習，由 ${companion.name} 陪練。`,
      }, false, `practice:${id}:manager:${manager.emp_id}`);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "schedule_practice", target_type: "shift", target_id: id,
        details: { traineeId: trainee.id, companionId: companion.id, date, start, end, storeId } });
      return json({ ok: true, message: "練習場已建立，練習員工、陪練人員與管理員都會收到資訊" });
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
          const roles = selectedShifts.map((s: any) => (s.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "");
          const npcOnly = roles.length > 0 && roles.every((role: string) => role.toUpperCase() === "NPC");
          const mixedNpc = roles.some((role: string) => role.toUpperCase() === "NPC") && !npcOnly;
          if (mixedNpc) return json({ error: "NPC 場次與需要上下班打卡的工作請分開操作。" }, 400);
          workItem = { source: "scheduled", attendance_mode: npcOnly ? "session_checkin" : "clock_range", labels: selectedShifts.map((s: any) => {
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
      if (type === "in" && workItem?.attendance_mode === "session_checkin") {
        const checkedInAt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replace(" ", "T");
        const rows = selectedShifts.map((s: any) => ({ emp_id: employee.id, shift_id: s.id, checked_in_at: checkedInAt,
          worksite_id: site.id, latitude: lat, longitude: lng, accuracy_m: accuracy, verification, source: "line" }));
        const { error: checkinError } = await sb.from("session_checkins").insert(rows);
        if (checkinError) return json({ error: checkinError.code === "23505" ? "這個 NPC 場次已經完成報到" : checkinError.message }, checkinError.code === "23505" ? 409 : 500);
        return json({ ok: true, mode: "session_checkin", ts: checkedInAt, site: site.name, distance: Math.round(site.distance), workItem });
      }
      const { data, error } = await sb.rpc("record_line_punch", { p_emp: employee.id, p_type: type, p_worksite: site.id,
        p_lat: lat, p_lng: lng, p_accuracy: accuracy, p_verification: verification, p_shift_ids: selectedShifts.map((s: any) => s.id),
        p_raw: { distance_m: Math.round(site.distance), line_user_id: profile.userId, user_agent: req.headers.get("user-agent") ?? "", work_item: workItem, verification } });
      if (error) return json({ error: error.message }, error.message.includes("目前已") ? 409 : 500);
      return json({ ...data, site: site.name, distance: Math.round(site.distance), workItem,
        warning: verification === "line_location" ? null : "本次打卡屬於臨時支援或跨店下班，已記錄並交由管理員確認。" });
    }

    if (action === "create-request") {
      if (employee.type !== "full" && account.role !== "manager") return json({ error: "換班申請只開放正職員工與管理員使用" }, 403);
      const shiftId = String(input.shiftId), replacedEmpId = String(input.replacedEmpId ?? employee.id), reasonCode = String(input.reasonCode ?? ""), note = String(input.note ?? "").trim();
      const reasons: Record<string, string> = { extra: "臨時加場，人力調換", emergency: "緊急事故發生，人力調換", health: "員工個人身體有狀況，人力調換", other: "其他" };
      if (!reasons[reasonCode]) return json({ error: "請選擇換班原因" }, 400);
      const shift = shifts.find((s: any) => s.id === shiftId);
      const originalAssignment = (shift?.assignments ?? []).find((a: any) => a.empId === replacedEmpId);
      if (!shift || !originalAssignment) return json({ error: "所選班別或原排班人員不存在" }, 400);
      const shiftEnd = new Date(`${shift.date}T${shift.end}:00+08:00`).getTime();
      if (shift.status === "cancelled" || shiftEnd <= Date.now()) return json({ error: "此班次已取消或已結束" }, 409);
      const { data: duplicate } = await sb.from("shift_requests").select("id").eq("shift_id", shiftId)
        .contains("details", { replacedEmpId })
        .in("status", ["open", "pending_manager"]).limit(1).maybeSingle();
      if (duplicate) return json({ error: "此班次已有進行中的申請" }, 409);
      const deadline = new Date(Math.max(Date.now() + 5 * 60_000, shiftEnd)).toISOString();
      const { data: request, error } = await sb.from("shift_requests").insert({ request_type: "give", shift_id: shiftId,
        requester_emp_id: employee.id, deadline, status: "pending_manager", details: { note, reasonCode, reasonLabel: reasons[reasonCode],
          replacedEmpId, replacedRole: originalAssignment.role, approval_flow: "manager_only" } }).select().single();
      if (error) throw error;
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "shift_change_requested", {
        title: "正職員工提出換班",
        text: `${employee.name}提出 ${shift.date} ${shift.start}–${shift.end} ${originalAssignment.role}（原排 ${((cfg.employees ?? []).find((e: any) => e.id === replacedEmpId)?.name ?? replacedEmpId)}）換班：${reasons[reasonCode]}。請至管理後台確認。`,
      }, false, `shift-change-manager:${request.id}:${manager.emp_id}`);
      return json({ ok: true, requestId: request.id, message: "已送交管理員確認，不會自動通知其他員工" });
    }

    if (action === "guest-booking-report") {
      const shiftId = String(input.shiftId ?? ""), customerType = String(input.customerType ?? "");
      const surname = String(input.surname ?? "").trim(), phone = String(input.phone ?? "").replace(/\s+/g, "");
      const partySize = Number(input.partySize), note = String(input.note ?? "").trim();
      const shift = shifts.find((s: any) => String(s.id) === shiftId && s.status !== "cancelled");
      if (!shift || !(shift.assignments ?? []).some((a: any) => !a.empId)) return json({ error: "這個場次已排人、已取消或不存在" }, 409);
      if (!["walk_in", "reservation"].includes(customerType)) return json({ error: "請選擇現場客人或預約客人" }, 400);
      if (!surname || surname.length > 30) return json({ error: "請填寫客人姓氏" }, 400);
      if (!/^[0-9+()\-]{8,20}$/.test(phone)) return json({ error: "請填寫可聯絡的電話號碼" }, 400);
      if (!Number.isInteger(partySize) || partySize < 1 || partySize > 99) return json({ error: "請填寫正確人數" }, 400);
      const { data: report, error } = await sb.from("guest_booking_reports").insert({ emp_id: employee.id, shift_id: shiftId,
        customer_type: customerType, surname, phone, party_size: partySize, note }).select("id").single();
      if (error) throw error;
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "guest_booking_report", {
        title: customerType === "walk_in" ? "現場客人待處理" : "預約客人待處理",
        text: `${employee.name}回報：${shift.date} ${shift.start} ${surname}先生／小姐，${partySize}人。聯絡電話請至管理後台查看，並處理 SimplyBook 與訂金。`,
      }, false, `guest-report:${report.id}:${manager.emp_id}`);
      return json({ ok: true, message: "已回報管理員；這不是正式預約，請等待管理員完成 SimplyBook 與訂金確認" });
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
      if (!["missing_in", "missing_out", "correction", "npc_checkin"].includes(requestType)) return json({ error: "請選擇補上班卡、補下班卡、NPC 補報到或更正整日時間" }, 400);
      const punchDate = String(input.punchDate ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(punchDate)) return json({ error: "補卡日期格式錯誤" }, 400);
      const requested = input.requested ?? {};
      const workItemCode = String(requested.workItemCode ?? "");
      if (!MANUAL_WORK_ITEMS[workItemCode]) return json({ error: "請選擇補卡的主題或工作項目" }, 400);
      requested.workItem = { code: workItemCode, labels: [MANUAL_WORK_ITEMS[workItemCode]], source: "attendance_request" };
      delete requested.workItemCode;
      const timeOk = (v: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ""));
      if (["missing_in", "missing_out", "npc_checkin"].includes(requestType) && !timeOk(requested.time)) return json({ error: "請填寫正確的補卡時間" }, 400);
      if (requestType === "correction" && (!timeOk(requested.inTime) || !timeOk(requested.outTime) || requested.inTime >= requested.outTime))
        return json({ error: "請填寫正確且先後順序一致的上下班時間" }, 400);
      if (requestType === "npc_checkin") {
        const shift = shifts.find((s: any) => String(s.id) === String(requested.shiftId ?? ""));
        const role = (shift?.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
        if (!shift || shift.date !== punchDate || String(role).toUpperCase() !== "NPC") return json({ error: "NPC 補報到必須連結到本人過去的 NPC 場次" }, 400);
      }
      const { data: pendingSameDay } = await sb.from("attendance_requests").select("request_type,requested").eq("emp_id", employee.id).eq("punch_date", punchDate).eq("status", "pending");
      const duplicate = (pendingSameDay ?? []).some((r: any) => requestType === "npc_checkin"
        ? r.request_type === requestType && String(r.requested?.shiftId ?? "") === String(requested.shiftId ?? "")
        : r.request_type === requestType && JSON.stringify(r.requested ?? {}) === JSON.stringify(requested));
      if (duplicate) return json({ error: "這個場次已有相同的待審補卡申請" }, 409);
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
