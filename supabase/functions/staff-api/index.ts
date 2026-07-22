import { cors, distanceMeters, eligibilityErrors, employedOn, getContext, json, queueNotification, rankCandidatesByWorkload, serviceClient, toMinutes, verifyLineIdToken } from "../_shared/common.ts";

const DAY = 86_400_000;
const dateText = (d: Date) => d.toISOString().slice(0, 10);
const SB_LOGIN_URL = "https://user-api.simplybook.asia/login";
const SB_ADMIN_URL = "https://user-api.simplybook.asia/admin/";
async function simplyBookRpc(url: string, headers: Record<string, string>, method: string, params: unknown[]) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: crypto.randomUUID() }) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error ?? payload)}`);
  return payload.result;
}
const MANUAL_WORK_ITEMS: Record<string, string> = {
  grandma: "外婆", haunted_shop: "詭店", haunted_prison: "詭獄", shit_power: "屎力全開",
  haunted_toilet: "詭廁", escapee: "越獄者", orphan: "孤兒怨", mr_mystery_counter: "謎先生櫃台",
  burgundy_counter: "桌遊大忠店櫃台", weekly_cleaning: "每週大清潔", practice: "訓練場", floor_support: "場控／現場支援",
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
      const [{ data: worksites }, { data: punches }, { data: sessionCheckins }, { data: shiftConfirmations }, { data: attendanceDays }, { data: attendanceRequests }, { data: overtimeReviews }] = await Promise.all([
        sb.from("worksites").select("id,name,radius_m,enabled").eq("enabled", true),
        sb.from("punches").select("id,ts,type,worksite_id,verification,review_state,voided_at,void_reason,shift_ids,raw").eq("emp_id", employee.id).gte("ts", from).order("ts", { ascending: false }).limit(60),
        sb.from("session_checkins").select("id,shift_id,checked_in_at,worksite_id,verification,source,note").eq("emp_id", employee.id).gte("checked_in_at", from).order("checked_in_at", { ascending: false }).limit(100),
        sb.from("shift_confirmations").select("shift_id,status,confirmed_at").eq("emp_id", employee.id),
        sb.from("attendance_daily").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
        sb.from("attendance_requests").select("*").eq("emp_id", employee.id).order("created_at", { ascending: false }).limit(30),
        sb.from("overtime_reviews").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
      ]);
      const publicEmployees = (cfg.employees ?? []).filter((e: any) => e.active).map((e: any) => ({ id: e.id, name: e.name }));
      const publicShifts = shifts.filter((s: any) => s.date >= from && s.date <= to).map((s: any) => {
        const cancelled = String(s.status ?? "").startsWith("cancelled");
        const emptyRoles = (s.assignments ?? []).filter((a: any) => !a.empId).map((a: any) => String(a.role ?? ""));
        const eligible = emptyRoles.length ? (cfg.employees ?? []).filter((candidate: any) => candidate.active &&
          emptyRoles.some((role: string) => eligibilityErrors(candidate, s, role, shifts, cfg).length === 0)) : [];
        const ranked = rankCandidatesByWorkload(eligible, shifts, s.date, 99);
        const onSite = ranked.filter((candidate: any) => shifts.some((other: any) => other.id !== s.id && other.date === s.date &&
          other.storeId === s.storeId && !String(other.status ?? "").startsWith("cancelled") && (other.assignments ?? []).some((a: any) => a.empId === candidate.id)));
        const onSiteIds = new Set(onSite.map((candidate: any) => candidate.id));
        const assignedToMe = (s.assignments ?? []).some((a: any) => a.empId === employee.id);
        const counterOnDuty = s.kind === "theme" && shifts.some((other: any) => other.date === s.date && other.storeId === s.storeId &&
          other.kind === "counter" && !String(other.status ?? "").startsWith("cancelled") && toMinutes(other.start) <= toMinutes(s.start) &&
          toMinutes(other.end) >= toMinutes(s.end) && (other.assignments ?? []).some((a: any) => a.empId === employee.id));
        const canSeeCustomer = account.role === "manager" || assignedToMe || counterOnDuty;
        const replacementCandidates: Record<string, Array<{ id: string; name: string }>> = {};
        if ((employee.type === "full" || account.role === "manager") && !cancelled) {
          for (const assignment of (s.assignments ?? []).filter((a: any) => a.empId)) {
            replacementCandidates[String(assignment.empId)] = (cfg.employees ?? []).filter((candidate: any) =>
              candidate.id !== assignment.empId && employedOn(candidate, s.date) &&
              !(s.assignments ?? []).some((a: any) => a.empId === candidate.id) &&
              eligibilityErrors(candidate, s, assignment.role, shifts, cfg, [s.id]).length === 0
            ).map((candidate: any) => ({ id: candidate.id, name: candidate.name }));
          }
        }
        const writebackTheme = (cfg.themes ?? []).find((theme: any) => theme.id === s.themeId);
        const writebackRole = writebackTheme && (Number(writebackTheme.payNPC) || 0) > 0 ? "NPC" : "場控";
        const writebackCandidates = account.role === "manager" && String(s.id).startsWith("sb_") && (s.assignments ?? []).some((a: any) => !a.empId && a.role === writebackRole)
          ? (cfg.employees ?? []).filter((candidate: any) => candidate.active && eligibilityErrors(candidate, s, writebackRole, shifts, cfg, [s.id]).length === 0).map((candidate: any) => ({ id: candidate.id, name: candidate.name })) : [];
        return {
          id: s.id, date: s.date, storeId: s.storeId, kind: s.kind, themeId: s.themeId, start: s.start, end: s.end,
          status: s.status ?? "active", assignments: s.assignments ?? [],
          linkedThemeAssignments: s.linkedThemeAssignments ?? [],
          depositPaid: ["paid", "completed"].includes(String(s.payment?.depositStatus ?? "").toLowerCase()),
          customer: canSeeCustomer && s.customer ? { name: s.customer.name ?? "", phone: s.customer.phone ?? "", email: s.customer.email ?? "", comment: s.customer.comment ?? "" } : null,
          payment: canSeeCustomer && s.payment ? { depositAmount: s.payment.depositAmount ?? null, depositStatus: s.payment.depositStatus ?? "", system: s.payment.system ?? "", currency: s.payment.depositCurrency ?? s.payment.currency ?? "" } : null,
          replacementCandidates,
          writebackRole: writebackCandidates.length ? writebackRole : null,
          writebackCandidates,
          candidateGroups: emptyRoles.length ? {
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
        attendanceDays, attendanceRequests, overtimeReviews, sessionCheckins, shiftConfirmations, liffId: Deno.env.get("LINE_LIFF_ID") ?? "" });
    }

    if (action === "monthly-summary") {
      const month = String(input.month ?? "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "月份格式錯誤" }, 400);
      const [year, monthNo] = month.split("-").map(Number);
      const nextMonth = dateText(new Date(Date.UTC(year, monthNo, 1))).slice(0, 7);
      const [{ data: checkins, error: checkinError }, { data: attendance, error: attendanceError }, { data: punches, error: punchError }, { data: overtime, error: overtimeError }] = await Promise.all([
        sb.from("session_checkins").select("shift_id,checked_in_at").eq("emp_id", employee.id)
          .gte("checked_in_at", `${month}-01T00:00:00`).lt("checked_in_at", `${nextMonth}-01T00:00:00`),
        sb.from("attendance_daily").select("work_date,actual_minutes,payable_minutes,status").eq("emp_id", employee.id)
          .gte("work_date", `${month}-01`).lt("work_date", `${nextMonth}-01`),
        sb.from("punches").select("ts,type,worksite_id").eq("emp_id", employee.id).is("voided_at", null)
          .gte("ts", `${month}-01T00:00:00`).lt("ts", `${nextMonth}-01T00:00:00`).order("ts", { ascending: true }),
        sb.from("overtime_reviews").select("work_date,actual_minutes,candidate_minutes,approved_minutes,status,note").eq("emp_id", employee.id)
          .gte("work_date", `${month}-01`).lt("work_date", `${nextMonth}-01`).order("work_date", { ascending: true }),
      ]);
      if (checkinError) throw checkinError;
      if (attendanceError) throw attendanceError;
      if (punchError) throw punchError;
      if (overtimeError) throw overtimeError;
      const completed = new Set((checkins ?? []).map((row: any) => String(row.shift_id)));
      const seen = new Set<string>(), detailSeen = new Set<string>(), scheduled = { gm: 0, npc: 0 }, done = { gm: 0, npc: 0 }, workItems: any[] = [];
      const add = (shift: any, role: string) => {
        const normalized = String(role).toUpperCase() === "NPC" ? "npc" : role === "場控" ? "gm" : "";
        if (!normalized || String(shift.status ?? "").startsWith("cancelled") || String(shift.date ?? "").slice(0, 7) !== month) return;
        const key = `${shift.id}|${normalized}`;
        if (seen.has(key)) return;
        seen.add(key); scheduled[normalized as "gm" | "npc"]++;
        if (completed.has(String(shift.id))) done[normalized as "gm" | "npc"]++;
      };
      const addDetail = (shift: any, role: string, linked = false) => {
        if (String(shift.status ?? "").startsWith("cancelled") || String(shift.date ?? "").slice(0, 7) !== month) return;
        const key = `${shift.id}|${role}`; if (detailSeen.has(key)) return; detailSeen.add(key);
        const requiresReport = shift.kind === "practice" || (shift.kind === "theme" && ["NPC", "場控"].includes(String(role).toUpperCase() === "NPC" ? "NPC" : role));
        workItems.push({ id: shift.id, date: shift.date, start: shift.start, end: shift.end, storeId: shift.storeId, kind: shift.kind,
          themeId: shift.themeId ?? null, role, linked, requiresReport, completed: completed.has(String(shift.id)) });
      };
      for (const shift of shifts) for (const assignment of shift.assignments ?? []) if (assignment.empId === employee.id) { add(shift, assignment.role); addDetail(shift, assignment.role); }
      for (const source of shifts) for (const link of source.linkedThemeAssignments ?? []) {
        if (link.empId !== employee.id) continue;
        const target = shifts.find((shift: any) => String(shift.id) === String(link.shiftId));
        if (target) { add(target, "場控"); addDetail(target, "場控", true); }
      }
      const rows = attendance ?? [];
      const approvedMinutes = rows.filter((row: any) => row.status === "approved").reduce((sum: number, row: any) => sum + Math.max(0, Number(row.payable_minutes) || 0), 0);
      const pendingMinutes = rows.filter((row: any) => row.status === "pending" || row.status === "anomaly").reduce((sum: number, row: any) => sum + Math.max(0, Number(row.actual_minutes) || 0), 0);
      const actualMinutes = rows.reduce((sum: number, row: any) => sum + Math.max(0, Number(row.actual_minutes) || 0), 0);
      const punchDays = new Map<string, any[]>();
      for (const row of punches ?? []) { const date = String(row.ts).slice(0, 10); if (!punchDays.has(date)) punchDays.set(date, []); punchDays.get(date)!.push(row); }
      const segments = new Map<string, any[]>();
      for (const [date, dayPunches] of punchDays) {
        const list: any[] = []; let open: any = null;
        for (const punch of dayPunches) { if (punch.type === "in") { if (open) list.push({ in: String(open.ts).slice(11, 16), out: null, worksiteId: open.worksite_id }); open = punch; } else if (open) { list.push({ in: String(open.ts).slice(11, 16), out: String(punch.ts).slice(11, 16), worksiteId: open.worksite_id }); open = null; } else list.push({ in: null, out: String(punch.ts).slice(11, 16), worksiteId: punch.worksite_id }); }
        if (open) list.push({ in: String(open.ts).slice(11, 16), out: null, worksiteId: open.worksite_id }); segments.set(date, list);
      }
      const attendanceByDate = new Map(rows.map((row: any) => [String(row.work_date), row]));
      const dates = new Set<string>([...workItems.map(item => item.date), ...segments.keys(), ...attendanceByDate.keys()]);
      const days = [...dates].sort().map(date => {
        const attendanceRow: any = attendanceByDate.get(date), daySegments = segments.get(date) ?? [];
        let remaining = 540, overtimeThreshold: number | null = null;
        for (const segment of daySegments) {
          if (!segment.in || !segment.out) continue;
          const duration = Math.max(0, toMinutes(segment.out) - toMinutes(segment.in));
          if (duration > remaining) { overtimeThreshold = toMinutes(segment.in) + remaining; break; }
          remaining -= duration;
        }
        return { date, segments: daySegments,
          attendance: attendanceRow ? { actualMinutes: attendanceRow.actual_minutes, payableMinutes: attendanceRow.payable_minutes, status: attendanceRow.status } : null,
          workItems: workItems.filter(item => item.date === date).sort((a, b) => String(a.start).localeCompare(String(b.start))).map(item => ({ ...item,
            overtime: overtimeThreshold !== null && (String(item.role).toUpperCase() === "NPC" || item.role === "場控") && toMinutes(String(item.end)) > overtimeThreshold })) };
      });
      const overtimeRows = overtime ?? [];
      return json({ month, scheduled, done, approvedMinutes, pendingMinutes, actualMinutes, days,
        overtime: { approvedMinutes: overtimeRows.filter((row: any) => row.status === "approved").reduce((sum: number, row: any) => sum + Math.max(0, Number(row.approved_minutes) || 0), 0),
          pendingMinutes: overtimeRows.filter((row: any) => ["pending", "anomaly"].includes(row.status)).reduce((sum: number, row: any) => sum + Math.max(0, Number(row.candidate_minutes) || 0), 0), rows: overtimeRows } });
    }

    if (action === "empty-slots") {
      const date = String(input.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "日期格式錯誤" }, 400);
      const actual = shifts.filter((shift: any) => shift.date === date && shift.kind === "theme" && !String(shift.status ?? "").startsWith("cancelled"));
      const slots: any[] = [];
      for (const theme of (cfg.themes ?? []).filter((row: any) => row.active !== false && Array.isArray(row.slots))) {
        for (const start of theme.slots ?? []) {
          if (actual.some((shift: any) => shift.themeId === theme.id && shift.start === start)) continue;
          const startMinutes = toMinutes(String(start)), endMinutes = startMinutes + Math.max(0, Number(theme.dur) || 0);
          const end = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
          const assignments: any[] = [];
          for (let i = 0; i < Number(theme.needGM || 0); i++) assignments.push({ role: "場控", empId: "" });
          for (let i = 0; i < Number(theme.needNPC || 0); i++) assignments.push({ role: "NPC", empId: "" });
          if (!assignments.length) assignments.push({ role: "工作人員", empId: "" });
          const target = { id: `virtual_slot_${date}_${theme.id}_${String(start).replace(":", "")}`, date, storeId: theme.storeId, kind: "theme", themeId: theme.id, start, end, status: "active", assignments, depositPaid: false, virtualEmpty: true };
          const roles = [...new Set(assignments.map(row => String(row.role)))];
          const eligible = (cfg.employees ?? []).filter((candidate: any) => candidate.active && roles.some(role => eligibilityErrors(candidate, target, role, shifts, cfg).length === 0));
          const ranked = rankCandidatesByWorkload(eligible, shifts, date, 99);
          const onSite = ranked.filter((candidate: any) => shifts.some((other: any) => other.date === date && other.storeId === theme.storeId && !String(other.status ?? "").startsWith("cancelled") && (other.assignments ?? []).some((assignment: any) => assignment.empId === candidate.id)));
          const onSiteIds = new Set(onSite.map((candidate: any) => candidate.id));
          slots.push({ ...target, candidateGroups: { onSite: onSite.map((candidate: any) => candidate.name), available: ranked.filter((candidate: any) => !onSiteIds.has(candidate.id)).map((candidate: any) => candidate.name) } });
        }
      }
      return json({ date, slots });
    }

    if (action === "manager-dashboard") {
      if (account.role !== "manager") return json({ error: "只有管理員可以查看全體員工資料" }, 403);
      const month = String(input.month ?? "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "月份格式錯誤" }, 400);
      const [year, monthNo] = month.split("-").map(Number);
      const nextMonth = dateText(new Date(Date.UTC(year, monthNo, 1))).slice(0, 7);
      const [{ data: daily, error: dailyError }, { data: attendanceRequests, error: attendanceRequestError }, { data: shiftRequests, error: shiftRequestError }] = await Promise.all([
        sb.from("attendance_daily").select("emp_id,work_date,scheduled_minutes,actual_minutes,payable_minutes,status,note,anomalies").gte("work_date", `${month}-01`).lt("work_date", `${nextMonth}-01`).order("work_date", { ascending: true }),
        sb.from("attendance_requests").select("id,emp_id,punch_date,request_type,requested,reason,status,created_at").eq("status", "pending").order("created_at", { ascending: true }),
        sb.from("shift_requests").select("id,request_type,shift_id,requester_emp_id,status,details,created_at").eq("status", "pending_manager").order("created_at", { ascending: true }),
      ]);
      if (dailyError) throw dailyError;
      if (attendanceRequestError) throw attendanceRequestError;
      if (shiftRequestError) throw shiftRequestError;
      const employees = (cfg.employees ?? []).filter((e: any) => e.active).map((candidate: any) => {
        const attendance = (daily ?? []).filter((row: any) => row.emp_id === candidate.id), workItems: any[] = [];
        for (const shift of shifts) {
          if (String(shift.date ?? "").slice(0, 7) !== month || String(shift.status ?? "").startsWith("cancelled")) continue;
          for (const assignment of shift.assignments ?? []) if (assignment.empId === candidate.id) workItems.push({ id: shift.id, date: shift.date, start: shift.start, end: shift.end, storeId: shift.storeId, kind: shift.kind, themeId: shift.themeId ?? null, role: assignment.role, linked: false });
          for (const link of shift.linkedThemeAssignments ?? []) if (link.empId === candidate.id) {
            const target = shifts.find((row: any) => String(row.id) === String(link.shiftId));
            if (target && !String(target.status ?? "").startsWith("cancelled")) workItems.push({ id: target.id, date: target.date, start: target.start, end: target.end, storeId: target.storeId, kind: target.kind, themeId: target.themeId ?? null, role: "場控", linked: true });
          }
        }
        const unique: any[] = [...new Map(workItems.map(item => [`${item.id}|${item.role}`, item])).values()];
        const dates = new Set<string>([...attendance.map((row: any) => String(row.work_date)), ...unique.map(item => item.date)]);
        return { id: candidate.id, name: candidate.name, type: candidate.type,
          approvedMinutes: attendance.filter((row: any) => row.status === "approved").reduce((sum: number, row: any) => sum + Math.max(0, Number(row.payable_minutes) || 0), 0),
          pendingMinutes: attendance.filter((row: any) => ["pending", "anomaly"].includes(row.status)).reduce((sum: number, row: any) => sum + Math.max(0, Number(row.actual_minutes) || 0), 0),
          pendingDays: attendance.filter((row: any) => ["pending", "anomaly"].includes(row.status)).length,
          days: [...dates].sort().map(date => ({ date, attendance: attendance.find((row: any) => String(row.work_date) === date) ?? null, workItems: unique.filter(item => item.date === date).sort((a, b) => String(a.start).localeCompare(String(b.start))) })),
        };
      });
      const changes = (shiftRequests ?? []).map((request: any) => {
        const shift = shifts.find((row: any) => String(row.id) === String(request.shift_id));
        const replacedEmpId = String(request.details?.replacedEmpId ?? request.requester_emp_id ?? "");
        const role = String(request.details?.replacedRole ?? (shift?.assignments ?? []).find((a: any) => a.empId === replacedEmpId)?.role ?? "");
        const candidates = shift ? (cfg.employees ?? []).filter((person: any) => person.active && person.id !== replacedEmpId && !(shift.assignments ?? []).some((a: any) => a.empId === person.id) && eligibilityErrors(person, shift, role, shifts, cfg, [shift.id]).length === 0).map((person: any) => ({ id: person.id, name: person.name })) : [];
        return { ...request, shift: shift ? { id: shift.id, date: shift.date, start: shift.start, end: shift.end, storeId: shift.storeId, kind: shift.kind, themeId: shift.themeId } : null, candidates };
      });
      return json({ month, employees, attendanceRequests: attendanceRequests ?? [], shiftRequests: changes });
    }

    if (action === "manager-review-day") {
      if (account.role !== "manager") return json({ error: "只有管理員可以審核工時" }, 403);
      const empId = String(input.empId ?? ""), workDate = String(input.workDate ?? ""), status = String(input.status ?? "");
      const payable = Math.max(0, Math.min(1440, Number(input.payableMinutes) || 0));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !["approved", "rejected", "pending"].includes(status)) return json({ error: "審核資料格式錯誤" }, 400);
      const { data, error } = await sb.rpc("review_attendance_day", { p_emp: empId, p_date: workDate, p_status: status, p_payable: payable, p_note: String(input.note ?? "LINE 管理員審核") });
      if (error) throw error;
      if (!data?.ok) return json({ error: data?.msg ?? "審核失敗" }, 409);
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "review_attendance_day", target_type: "attendance_daily", target_id: `${empId}:${workDate}`, details: { status, payableMinutes: payable } });
      return json({ ok: true });
    }

    if (action === "manager-approve-month") {
      if (account.role !== "manager") return json({ error: "只有管理員可以審核工時" }, 403);
      const empId = String(input.empId ?? ""), month = String(input.month ?? "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "月份格式錯誤" }, 400);
      const [year, monthNo] = month.split("-").map(Number), nextMonth = dateText(new Date(Date.UTC(year, monthNo, 1))).slice(0, 7);
      const { data: rows, error: rowsError } = await sb.from("attendance_daily").select("work_date,actual_minutes,status").eq("emp_id", empId).gte("work_date", `${month}-01`).lt("work_date", `${nextMonth}-01`).in("status", ["pending", "anomaly"]);
      if (rowsError) throw rowsError;
      for (const row of rows ?? []) {
        const { data, error } = await sb.rpc("review_attendance_day", { p_emp: empId, p_date: row.work_date, p_status: "approved", p_payable: Math.max(0, Number(row.actual_minutes) || 0), p_note: "LINE 管理員本月全部核准" });
        if (error) throw error;
        if (!data?.ok) return json({ error: `${row.work_date}：${data?.msg ?? "審核失敗"}` }, 409);
      }
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "approve_employee_month", target_type: "attendance_daily", target_id: `${empId}:${month}`, details: { count: (rows ?? []).length } });
      return json({ ok: true, count: (rows ?? []).length });
    }

    if (action === "manager-review-attendance-request") {
      if (account.role !== "manager") return json({ error: "只有管理員可以審核補卡" }, 403);
      const requestId = String(input.requestId ?? ""), status = String(input.status ?? "");
      if (!["approved", "rejected"].includes(status)) return json({ error: "審核狀態錯誤" }, 400);
      const { data, error } = await sb.rpc("review_attendance_request", { p_request: requestId, p_status: status });
      if (error) throw error;
      if (!data?.ok) return json({ error: data?.msg ?? "審核失敗" }, 409);
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "review_attendance_request", target_type: "attendance_request", target_id: requestId, details: { status } });
      return json({ ok: true });
    }

    if (action === "manager-review-shift-request") {
      if (account.role !== "manager") return json({ error: "只有管理員可以審核換班" }, 403);
      const requestId = String(input.requestId ?? ""), decision = String(input.decision ?? ""), replacementEmpId = String(input.replacementEmpId ?? "");
      if (!["approved", "rejected"].includes(decision)) return json({ error: "審核狀態錯誤" }, 400);
      const { data: request, error: requestError } = await sb.from("shift_requests").select("*").eq("id", requestId).eq("status", "pending_manager").maybeSingle();
      if (requestError) throw requestError;
      if (!request) return json({ error: "申請不存在或已處理" }, 409);
      const shift = shifts.find((row: any) => String(row.id) === String(request.shift_id));
      if (!shift) return json({ error: "找不到原班次" }, 404);
      const now = new Date().toISOString(), originalEmpId = String(request.details?.replacedEmpId ?? request.requester_emp_id ?? "");
      if (decision === "rejected") {
        const reason = String(input.note ?? "管理員未核准").trim() || "管理員未核准";
        const { error } = await sb.from("shift_requests").update({ status: "cancelled", details: { ...(request.details ?? {}), managerReply: reason }, updated_at: now }).eq("id", requestId);
        if (error) throw error;
        if (request.requester_emp_id) await queueNotification(sb, request.requester_emp_id, "shift_change_result", { title: "換班申請未核准", text: `${shift.date} ${shift.start}–${shift.end}：${reason}` }, true, `shift-change-rejected:${requestId}`);
      } else {
        const replacement = (cfg.employees ?? []).find((row: any) => row.id === replacementEmpId && row.active);
        const slot = (shift.assignments ?? []).find((row: any) => row.empId === originalEmpId), role = String(request.details?.replacedRole ?? slot?.role ?? "");
        if (!replacement || !slot) return json({ error: "找不到原排班或替補人員" }, 409);
        const errors = eligibilityErrors(replacement, shift, role, shifts, cfg, [shift.id]);
        if (errors.length) return json({ error: errors.join("、") }, 409);
        slot.empId = replacement.id; shift.manualEdit = true;
        const source = String(shift.id).startsWith("sb_") ? "simplybook" : "manual";
        const [{ error: shiftError }, { error: updateError }] = await Promise.all([sb.from("shifts").upsert({ id: shift.id, date: shift.date, source, data: shift }), sb.from("shift_requests").update({ status: "completed", selected_emp_id: replacement.id, completed_at: now, updated_at: now }).eq("id", requestId)]);
        if (shiftError) throw shiftError;
        if (updateError) throw updateError;
        const label = `${shift.date} ${shift.start}–${shift.end}`;
        if (request.requester_emp_id) await queueNotification(sb, request.requester_emp_id, "shift_change_result", { title: "換班已核准", text: `${label} 已由 ${replacement.name} 接替。` }, true, `shift-change-approved:${requestId}:requester`);
        await queueNotification(sb, replacement.id, "shift_assigned", { title: "管理員指派新班次", text: `你已接替 ${label}，請至 LINE 班表確認。` }, true, `shift-change-approved:${requestId}:replacement`);
      }
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "review_shift_request", target_type: "shift_request", target_id: requestId, details: { decision, replacementEmpId: replacementEmpId || null } });
      return json({ ok: true });
    }

    if (action === "manager-assign-writeback") {
      if (account.role !== "manager") return json({ error: "只有管理員可以回填 SimplyBook" }, 403);
      const shiftId = String(input.shiftId ?? ""), empId = String(input.empId ?? "");
      if (!shiftId.startsWith("sb_")) return json({ error: "只有已存在的 SimplyBook 預約可以回填人員" }, 400);
      const shift = shifts.find((row: any) => String(row.id) === shiftId && !String(row.status ?? "").startsWith("cancelled"));
      const selectedEmployee = (cfg.employees ?? []).find((row: any) => row.id === empId && row.active);
      const theme = (cfg.themes ?? []).find((row: any) => row.id === shift?.themeId);
      const role = theme && (Number(theme.payNPC) || 0) > 0 ? "NPC" : "場控";
      const slot = (shift?.assignments ?? []).find((row: any) => !row.empId && row.role === role);
      if (!shift || !selectedEmployee || !slot) return json({ error: `場次不存在、已排人，或缺少可回填的${role}欄位` }, 409);
      const errors = eligibilityErrors(selectedEmployee, shift, role, shifts, cfg, [shift.id]);
      if (errors.length) return json({ error: errors.join("、") }, 409);
      const company = Deno.env.get("SB_COMPANY"), userLogin = Deno.env.get("SB_USER_LOGIN"), userKey = Deno.env.get("SB_USER_PASSWORD");
      if (!company || !userLogin || !userKey) return json({ error: "SimplyBook Secrets 尚未設定完整" }, 500);
      const token = await simplyBookRpc(SB_LOGIN_URL, {}, "getUserToken", [company, userLogin, userKey]);
      const headers = { "X-Company-Login": company, "X-User-Token": String(token) };
      const unitsRaw = await simplyBookRpc(SB_ADMIN_URL, headers, "getUnitList", []);
      const units: any[] = Array.isArray(unitsRaw) ? unitsRaw : Object.values(unitsRaw ?? {});
      const employeeNames = [selectedEmployee.name, ...(selectedEmployee.aliases ?? [])];
      const unit = units.find((row: any) => employeeNames.includes(String(row.name ?? "").trim()));
      if (!unit) return json({ error: `SimplyBook 找不到服務供應者「${selectedEmployee.name}」` }, 409);
      const bookingCode = shiftId.slice(3);
      const bookingsRaw = await simplyBookRpc(SB_ADMIN_URL, headers, "getBookings", [{ date_from: shift.date, date_to: shift.date, booking_type: "non_cancelled" }]);
      const bookings: any[] = Array.isArray(bookingsRaw) ? bookingsRaw : Object.values(bookingsRaw ?? {});
      const booking = bookings.find((row: any) => String(row.code ?? "") === bookingCode || String(row.id ?? "") === bookingCode);
      if (!booking) return json({ error: `SimplyBook 查無預約 ${bookingCode}` }, 404);
      await simplyBookRpc(SB_ADMIN_URL, headers, "editBook", [Number(booking.id), { unit_id: Number(unit.id) }]);
      slot.empId = selectedEmployee.id; shift.manualEdit = true; shift.simplybookWritebackAt = new Date().toISOString();
      const { error: saveError } = await sb.from("shifts").upsert({ id: shift.id, date: shift.date, source: "simplybook", data: shift });
      if (saveError) throw saveError;
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "simplybook_assign_writeback", target_type: "shift", target_id: shift.id, details: { empId: selectedEmployee.id, role, bookingId: booking.id, unitId: unit.id } });
      return json({ ok: true, message: `${selectedEmployee.name} 已排入${role}，並回填 SimplyBook` });
    }

    if (action === "confirm-shift") {
      const shiftId = String(input.shiftId ?? "");
      const shift = shifts.find((s: any) => String(s.id) === shiftId && !String(s.status ?? "").startsWith("cancelled"));
      if (!shift || !(shift.assignments ?? []).some((a: any) => a.empId === employee.id)) return json({ error: "這個班次未指派給你，或已經取消。" }, 403);
      const { error } = await sb.from("shift_confirmations").upsert({ shift_id: shiftId, emp_id: employee.id, status: "confirmed", source: "line", confirmed_at: new Date().toISOString() });
      if (error) throw error;
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "confirm_shift", target_type: "shift", target_id: shiftId,
        details: { date: shift.date, start: shift.start, end: shift.end, kind: shift.kind } });
      return json({ ok: true, message: "已確認收到這個班次" });
    }

    if (action === "schedule-practice") {
      if (account.role !== "manager" && !(employee.type === "full" && employee.canSchedulePractice)) return json({ error: "你沒有安排新人訓練場的權限" }, 403);
      const date = String(input.date ?? ""), start = String(input.start ?? ""), end = String(input.end ?? ""), storeId = String(input.storeId ?? "");
      const traineeId = String(input.traineeId ?? ""), companionId = String(input.companionId ?? ""), note = String(input.note ?? "").trim();
      const timeOk = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeOk(start) || !timeOk(end) || toMinutes(end) <= toMinutes(start)) return json({ error: "請填寫正確的訓練日期與起訖時間" }, 400);
      if (!(cfg.stores ?? []).some((s: any) => s.id === storeId)) return json({ error: "訓練場地錯誤" }, 400);
      const trainee = (cfg.employees ?? []).find((e: any) => e.id === traineeId && e.active), companion = (cfg.employees ?? []).find((e: any) => e.id === companionId && e.active);
      if (!trainee || !companion) return json({ error: "請選擇在職的受訓員工與陪練人員" }, 400);
      if (trainee.id === companion.id) return json({ error: "受訓員工與陪練人員不可為同一人" }, 400);
      const startsAt = new Date(`${date}T${start}:00+08:00`).getTime();
      if (startsAt <= Date.now()) return json({ error: "訓練場開始時間必須晚於現在" }, 409);
      const id = `practice_${crypto.randomUUID()}`, target = { id, date, storeId, kind: "practice", themeId: null, start, end, status: "active", assignments: [] };
      const traineeErrors = eligibilityErrors(trainee, target, "訓練場", shifts, cfg), companionErrors = eligibilityErrors(companion, target, "陪練", shifts, cfg);
      if (traineeErrors.length || companionErrors.length) return json({ error: [traineeErrors.length ? `${trainee.name}：${traineeErrors.join("、")}` : "", companionErrors.length ? `${companion.name}：${companionErrors.join("、")}` : ""].filter(Boolean).join("；") }, 409);
      const shift = { ...target, note, assignments: [{ role: "訓練場", empId: trainee.id }, { role: "陪練", empId: companion.id }],
        createdBy: employee.id, createdVia: "line_practice_scheduler" };
      const { error } = await sb.from("shifts").insert({ id, date, source: "manual", data: shift });
      if (error) throw error;
      const label = `${date} ${start}–${end} ${(cfg.stores ?? []).find((s: any) => s.id === storeId)?.name ?? ""}`;
      await queueNotification(sb, trainee.id, "practice_assigned", { title: "新人訓練場安排", text: `${label}，陪練：${companion.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:trainee`);
      await queueNotification(sb, companion.id, "practice_companion", { title: "陪練工作安排", text: `${label}，受訓員工：${trainee.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:companion`);
      const informed = new Set([trainee.id, companion.id, employee.id]);
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) if (!informed.has(manager.emp_id)) await queueNotification(sb, manager.emp_id, "practice_scheduled_manager", {
        title: "訓練場已安排", text: `${employee.name}安排 ${label}：${trainee.name} 受訓，由 ${companion.name} 陪練。`,
      }, false, `practice:${id}:manager:${manager.emp_id}`);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "schedule_practice", target_type: "shift", target_id: id,
        details: { traineeId: trainee.id, companionId: companion.id, date, start, end, storeId } });
      return json({ ok: true, message: "訓練場已建立，受訓員工、陪練人員與管理員都會收到資訊" });
    }

    if (action === "session-report") {
      const shiftId = String(input.shiftId ?? ""), lat = Number(input.latitude), lng = Number(input.longitude), accuracy = Number(input.accuracy ?? 9999);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 250) return json({ error: "定位精確度不足" }, 403);
      const shift = shifts.find((s: any) => String(s.id) === shiftId && ["theme", "practice"].includes(String(s.kind)) && !String(s.status ?? "").startsWith("cancelled"));
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const directRole = (shift?.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
      const linkedRole = shift && shifts.some((source: any) => (source.linkedThemeAssignments ?? []).some((link: any) => link.empId === employee.id && String(link.shiftId) === String(shift.id))) ? "場控" : "";
      const role = directRole || linkedRole;
      if (!shift || shift.date !== today || !role) return json({ error: "只能確認今天指派給你的 NPC、場控或訓練場" }, 403);
      const { data: latestPunch } = await sb.from("punches").select("type,ts").eq("emp_id", employee.id).is("voided_at", null)
        .order("ts", { ascending: false }).limit(1).maybeSingle();
      if (!latestPunch || latestPunch.type !== "in" || String(latestPunch.ts ?? "").slice(0, 10) !== today) return json({ error: "請先完成今天的上班定位打卡，再確認本場工作" }, 409);
      const { data: sites } = await sb.from("worksites").select("*").eq("enabled", true).not("latitude", "is", null);
      const ranked = (sites ?? []).map((s: any) => ({ ...s, distance: distanceMeters(lat, lng, Number(s.latitude), Number(s.longitude)) })).sort((a: any, b: any) => a.distance - b.distance);
      const site = ranked[0];
      if (!site || site.id !== shift.storeId || site.distance > site.radius_m + Math.min(accuracy, 50)) return json({ error: "目前不在這個場次的店家打卡範圍內" }, 403);
      const checkedInAt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replace(" ", "T");
      const { error } = await sb.from("session_checkins").insert({ emp_id: employee.id, shift_id: shift.id, checked_in_at: checkedInAt,
        worksite_id: site.id, latitude: lat, longitude: lng, accuracy_m: accuracy, verification: "line_location", source: "line", note: `${role}${shift.kind === "practice" ? "確認" : "場次完成"}` });
      if (error) return json({ error: error.code === "23505" ? "這個場次已經回報過" : error.message }, error.code === "23505" ? 409 : 500);
      return json({ ok: true, ts: checkedInAt, site: site.name, role });
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
        selectedShifts = requestedIds.length ? shifts.filter((s: any) => requestedIds.includes(String(s.id))) : shifts.filter((s: any) =>
          s.date === today && s.storeId === site.id && !String(s.status ?? "").startsWith("cancelled") &&
          (s.assignments ?? []).some((a: any) => a.empId === employee.id));
        const invalidSelection = selectedShifts.some((s: any) => s.date !== today || s.storeId !== site.id || String(s.status ?? "").startsWith("cancelled") ||
          !(s.assignments ?? []).some((a: any) => a.empId === employee.id));
        if (invalidSelection || (requestedIds.length && selectedShifts.length !== requestedIds.length)) return json({ error: "排定工作不屬於你今天在這間店的班表，請重新整理後再試。" }, 409);
        if (selectedShifts.length) {
          workItem = { source: "scheduled", attendance_mode: "clock_range", labels: selectedShifts.map((s: any) => {
            const theme = (cfg.themes ?? []).find((t: any) => t.id === s.themeId)?.name;
            const label = s.kind === "theme" ? theme : s.kind === "counter" ? (s.storeId === "ms" ? "謎先生櫃台" : "桌遊大忠店櫃台") :
              s.kind === "cleaning" ? "每週大清潔" : s.kind === "practice" ? "訓練場" : s.kind === "floor" ? "場控／現場支援" : "其他工作";
            const role = (s.assignments ?? []).find((a: any) => a.empId === employee.id)?.role ?? "";
            return `${s.start}–${s.end} ${label}${role ? `（${role}）` : ""}`;
          }) };
        } else if (String(input.workItemCode ?? "")) {
          const code = String(input.workItemCode ?? "");
          if (!MANUAL_WORK_ITEMS[code]) return json({ error: "請先選擇今天要執行的主題、櫃台或訓練場。" }, 400);
          workItem = { source: "temporary_support", code, labels: [MANUAL_WORK_ITEMS[code]] };
          verification = "line_location_unassigned";
        } else {
          workItem = { source: "unassigned_clock", attendance_mode: "clock_range", labels: ["臨時支援（工作項目待管理員確認）"] };
          verification = "line_location_unassigned";
        }
      } else {
        const { data: latest } = await sb.from("punches").select("type,ts,worksite_id,shift_ids,raw").eq("emp_id", employee.id)
          .is("voided_at", null).order("ts", { ascending: false }).limit(1).maybeSingle();
        if (!latest || latest.type !== "in" || String(latest.ts ?? "").slice(0, 10) !== today) {
          return json({ error: "今天沒有尚未下班的上班卡；過去缺卡請使用補卡申請。" }, 409);
        }
        selectedShifts = shifts.filter((s: any) => (latest.shift_ids ?? []).includes(s.id));
        workItem = latest.raw?.work_item ?? null;
        if (latest.raw?.verification === "line_location_unassigned") verification = "line_location_unassigned";
        else if (latest.worksite_id !== site.id) verification = "line_location_cross_site";
      }
      const { data, error } = await sb.rpc("record_line_punch", { p_emp: employee.id, p_type: type, p_worksite: site.id,
        p_lat: lat, p_lng: lng, p_accuracy: accuracy, p_verification: verification, p_shift_ids: selectedShifts.map((s: any) => s.id),
        p_raw: { distance_m: Math.round(site.distance), line_user_id: profile.userId, user_agent: req.headers.get("user-agent") ?? "", work_item: workItem, verification } });
      if (error) return json({ error: error.message }, error.message.includes("目前已") ? 409 : 500);
      let overtime: any = null;
      if (type === "out") {
        const { data: attendance } = await sb.from("attendance_daily").select("scheduled_minutes,actual_minutes,anomalies").eq("emp_id", employee.id).eq("work_date", today).maybeSingle();
        const actualMinutes = Math.max(0, Number(attendance?.actual_minutes) || 0), candidateMinutes = Math.max(0, actualMinutes - 540);
        if (candidateMinutes > 0) {
          const { data: existing } = await sb.from("overtime_reviews").select("actual_minutes,status,approved_minutes").eq("emp_id", employee.id).eq("work_date", today).maybeSingle();
          if (!existing || existing.status !== "approved" || Number(existing.actual_minutes) !== actualMinutes) {
            const status = Array.isArray(attendance?.anomalies) && attendance.anomalies.length ? "anomaly" : "pending";
            const { error: overtimeError } = await sb.from("overtime_reviews").upsert({ emp_id: employee.id, work_date: today, scheduled_minutes: Math.max(0, Number(attendance?.scheduled_minutes) || 0), actual_minutes: actualMinutes, candidate_minutes: candidateMinutes, approved_minutes: null, status, note: "LINE 下班打卡自動產生" }, { onConflict: "emp_id,work_date" });
            if (overtimeError) throw overtimeError;
            overtime = { candidateMinutes, status };
          } else overtime = { candidateMinutes, status: existing.status, approvedMinutes: existing.approved_minutes };
        }
      }
      return json({ ...data, site: site.name, distance: Math.round(site.distance), workItem,
        overtime,
        warning: verification === "line_location" ? null : "本次打卡屬於臨時支援或跨店下班，已記錄並交由管理員確認。" });
    }

    if (action === "create-request") {
      if (employee.type !== "full" && account.role !== "manager") return json({ error: "換班申請只開放正職員工與管理員使用" }, 403);
      const shiftId = String(input.shiftId), replacedEmpId = String(input.replacedEmpId ?? employee.id), preferredEmpId = String(input.preferredEmpId ?? ""), preferredName = String(input.preferredName ?? "").trim(), reasonCode = String(input.reasonCode ?? ""), note = String(input.note ?? "").trim();
      const reasons: Record<string, string> = { extra: "臨時加場，人力調換", emergency: "緊急事故發生，人力調換", health: "員工個人身體有狀況，人力調換", other: "其他" };
      if (!reasons[reasonCode]) return json({ error: "請選擇換班原因" }, 400);
      if (!preferredEmpId && !preferredName) return json({ error: "請選擇接替人員，或填寫其他接替者姓名" }, 400);
      if (preferredName.length > 30) return json({ error: "其他接替者姓名請勿超過 30 個字" }, 400);
      const shift = shifts.find((s: any) => s.id === shiftId);
      const originalAssignment = (shift?.assignments ?? []).find((a: any) => a.empId === replacedEmpId);
      if (!shift || !originalAssignment) return json({ error: "所選班別或原排班人員不存在" }, 400);
      const shiftEnd = new Date(`${shift.date}T${shift.end}:00+08:00`).getTime();
      if (String(shift.status ?? "").startsWith("cancelled") || shiftEnd <= Date.now()) return json({ error: "此班次已取消或已結束" }, 409);
      if (preferredEmpId) {
        const preferred = (cfg.employees ?? []).find((e: any) => e.id === preferredEmpId);
        if (!preferred || !employedOn(preferred, shift.date)) return json({ error: "希望接替的人員目前不在職或不存在" }, 400);
        if ((shift.assignments ?? []).some((a: any) => a.empId === preferredEmpId)) return json({ error: "希望接替的人員已在這個班次中" }, 409);
        const errors = eligibilityErrors(preferred, shift, originalAssignment.role, shifts, cfg, [shift.id]);
        if (errors.length) return json({ error: `此人目前不適合接替：${errors.join("、")}` }, 409);
      }
      const { data: duplicate } = await sb.from("shift_requests").select("id").eq("shift_id", shiftId)
        .contains("details", { replacedEmpId })
        .in("status", ["open", "pending_manager"]).limit(1).maybeSingle();
      if (duplicate) return json({ error: "此班次已有進行中的申請" }, 409);
      const deadline = new Date(Math.max(Date.now() + 5 * 60_000, shiftEnd)).toISOString();
      const { data: request, error } = await sb.from("shift_requests").insert({ request_type: "give", shift_id: shiftId,
        requester_emp_id: employee.id, deadline, status: "pending_manager", details: { note, reasonCode, reasonLabel: reasons[reasonCode],
          replacedEmpId, replacedRole: originalAssignment.role, preferredEmpId: preferredEmpId || null, preferredName: preferredName || null, approval_flow: "manager_only" } }).select().single();
      if (error) throw error;
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "shift_change_requested", {
        title: "正職員工提出換班",
        text: `${employee.name}提出 ${shift.date} ${shift.start}–${shift.end} ${originalAssignment.role}（原排 ${((cfg.employees ?? []).find((e: any) => e.id === replacedEmpId)?.name ?? replacedEmpId)}）換班，希望由 ${preferredEmpId ? ((cfg.employees ?? []).find((e: any) => e.id === preferredEmpId)?.name ?? preferredEmpId) : preferredName} 接替：${reasons[reasonCode]}。請至管理後台確認。`,
      }, false, `shift-change-manager:${request.id}:${manager.emp_id}`);
      return json({ ok: true, requestId: request.id, message: "已送交管理員確認，不會自動通知其他員工" });
    }

    if (action === "guest-booking-report") {
      let shiftId = String(input.shiftId ?? ""); const customerType = String(input.customerType ?? "");
      const surname = String(input.surname ?? "").trim(), phone = String(input.phone ?? "").replace(/\s+/g, "");
      const partySize = Number(input.partySize), note = String(input.note ?? "").trim();
      let shift = shifts.find((s: any) => String(s.id) === shiftId && !String(s.status ?? "").startsWith("cancelled"));
      if (!shift && input.slot) {
        const slot = input.slot, date = String(slot.date ?? ""), themeId = String(slot.themeId ?? ""), storeId = String(slot.storeId ?? ""), start = String(slot.start ?? "");
        const targetTheme = (cfg.themes ?? []).find((t: any) => t.id === themeId && t.active !== false && t.storeId === storeId && (t.slots ?? []).includes(start));
        const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
        if (!targetTheme || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return json({ error: "這不是目前可開放的標準空場" }, 409);
        const matching = shifts.find((s: any) => s.date === date && s.kind === "theme" && s.themeId === themeId && s.start === start && !String(s.status ?? "").startsWith("cancelled"));
        if (matching) {
          shift = matching; shiftId = String(matching.id);
        } else {
          const endMinutes = toMinutes(start) + Number(targetTheme.dur ?? 0), end = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
          const assignments: any[] = [];
          for (let i = 0; i < Number(targetTheme.needGM ?? 0); i++) assignments.push({ role: "場控", empId: "" });
          for (let i = 0; i < Number(targetTheme.needNPC ?? 0); i++) assignments.push({ role: "NPC", empId: "" });
          if (!assignments.length) assignments.push({ role: "工作人員", empId: "" });
          shiftId = `line_slot_${date.replaceAll("-", "")}_${themeId.replace(/[^a-zA-Z0-9_-]/g, "")}_${start.replace(":", "")}`;
          shift = { id: shiftId, date, storeId, kind: "theme", themeId, start, end, status: "active", assignments, createdBy: employee.id, createdVia: "line_empty_slot_report" };
          const { error: shiftError } = await sb.from("shifts").upsert({ id: shiftId, date, source: "manual", data: shift });
          if (shiftError) throw shiftError;
        }
      }
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
