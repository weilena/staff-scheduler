// 給 Codex：2026-07-28 我(老闆端 Claude)動了這個檔，請 pull 最新別蓋掉。
// 為 LINE@ 管理員排班新增(沒改你既有的 action)：
//  1. bootstrap 的 publicShifts 每筆多回 roleCandidates(每個尚未排人的角色，附「有資格＋當天有空＋不衝堂」的候選人{id,name}，依場數排序，供一鍵排)。
//  2. 新增 action "manager-assign"(限 account.role==='manager')：把 empId 寫進指定 shift 的該 role 空位(或清空)，eligibilityErrors 防呆，並設 data.manualEdit=true 避免每分鐘 SimplyBook 同步覆蓋。寫回 shifts 表。
// 前端搭配在 web/staff.html 的「排班」分頁(scheduleAdminNav)。有衝突或要調整再找我，謝謝！
import { cors, distanceMeters, eligibilityErrors, employedOn, getContext, json, queueNotification, rankCandidatesByWorkload, serviceClient, toMinutes, verifyLineIdToken } from "../_shared/common.ts";

const DAY = 86_400_000;
const dateText = (d: Date) => d.toISOString().slice(0, 10);
const isDepositPaid = (payment: any) => {
  const status = String(payment?.depositStatus ?? "").trim().toLowerCase();
  return ["paid", "completed", "success", "succeeded", "confirmed", "1", "true"].includes(status);
};
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

type AttendanceEstimate = { estimatedMinutes: number; estimatedSegments: Array<{ in: string; out: string }>; estimateAnomalies: string[] };
function estimateAttendanceAfterRequest(existing: any[], requestType: string, requested: any): AttendanceEstimate | null {
  if (requestType === "npc_checkin") return null;
  const events = (existing ?? []).map((p: any) => ({ type: String(p.type), time: String(p.ts ?? "").slice(11, 16), virtual: false }));
  if (requestType === "correction") events.push(
    { type: "in", time: String(requested.inTime ?? ""), virtual: true },
    { type: "out", time: String(requested.outTime ?? ""), virtual: true },
  );
  else events.push({ type: requestType === "missing_in" ? "in" : "out", time: String(requested.time ?? ""), virtual: true });
  events.sort((a: any, b: any) => a.time.localeCompare(b.time) || Number(b.virtual) - Number(a.virtual) || (a.type === "in" ? -1 : 1));
  let open: string | null = null, estimatedMinutes = 0;
  const estimatedSegments: Array<{ in: string; out: string }> = [], estimateAnomalies: string[] = [];
  for (const event of events) {
    if (event.type === "in") {
      if (open !== null) estimateAnomalies.push("重複上班卡");
      open = event.time;
    } else if (open === null) estimateAnomalies.push("缺上班卡");
    else {
      const minutes = Math.max(0, toMinutes(event.time) - toMinutes(open));
      estimatedMinutes += minutes;
      estimatedSegments.push({ in: open, out: event.time });
      open = null;
    }
  }
  if (open !== null) estimateAnomalies.push("缺下班卡");
  return { estimatedMinutes, estimatedSegments, estimateAnomalies: [...new Set(estimateAnomalies)] };
}

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
      const availabilityConfirmationQuery = account.role === "manager"
        ? sb.from("availability_month_confirmations").select("emp_id,month,confirmed_at").gte("month", from.slice(0, 7)).order("month", { ascending: true })
        : sb.from("availability_month_confirmations").select("emp_id,month,confirmed_at").eq("emp_id", employee.id).gte("month", from.slice(0, 7)).order("month", { ascending: true });
      const [{ data: worksites }, { data: punches }, { data: sessionCheckins }, { data: shiftConfirmations }, { data: attendanceDays }, { data: attendanceRequests }, { data: overtimeReviews }, { data: availabilityRequests }, { data: availabilityConfirmations }] = await Promise.all([
        sb.from("worksites").select("id,name,radius_m,enabled").eq("enabled", true),
        sb.from("punches").select("id,ts,type,worksite_id,verification,review_state,voided_at,void_reason,shift_ids,raw").eq("emp_id", employee.id).gte("ts", from).order("ts", { ascending: false }).limit(60),
        sb.from("session_checkins").select("id,shift_id,checked_in_at,worksite_id,verification,source,note").eq("emp_id", employee.id).gte("checked_in_at", from).order("checked_in_at", { ascending: false }).limit(100),
        sb.from("shift_confirmations").select("shift_id,status,confirmed_at").eq("emp_id", employee.id),
        sb.from("attendance_daily").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
        sb.from("attendance_requests").select("*").eq("emp_id", employee.id).order("created_at", { ascending: false }).limit(30),
        sb.from("overtime_reviews").select("*").eq("emp_id", employee.id).gte("work_date", from).order("work_date", { ascending: false }).limit(70),
        sb.from("availability_requests").select("*").eq("emp_id", employee.id).gte("work_date", from).order("created_at", { ascending: false }).limit(120),
        availabilityConfirmationQuery,
      ]);
      const publicEmployees = (cfg.employees ?? []).filter((e: any) => e.active).map((e: any) => account.role === "manager"
        ? { id: e.id, name: e.name, color: e.simplybookColor ?? "", type: e.type, skills: e.skills ?? {}, avail: e.avail ?? null, availX: e.availX ?? {} }
        : { id: e.id, name: e.name });
      // bootstrap 只回前後 60 天，但 getContext 會載入完整歷史班次。候選人與撞班判斷
      // 若每次都掃描全部歷史資料，班次超過 1000 筆後會讓 LINE 啟動逾時。
      // 撞班只需要同一天；月工作量排序只需要同月份，因此先建立索引縮小運算範圍。
      const shiftsByDate = new Map<string, any[]>(), shiftsByMonth = new Map<string, any[]>();
      for (const shift of shifts) {
        const date = String(shift.date ?? ""), month = date.slice(0, 7);
        if (!shiftsByDate.has(date)) shiftsByDate.set(date, []);
        shiftsByDate.get(date)!.push(shift);
        if (!shiftsByMonth.has(month)) shiftsByMonth.set(month, []);
        shiftsByMonth.get(month)!.push(shift);
      }
      const publicShifts = shifts.filter((s: any) => s.date >= from && s.date <= to).map((s: any) => {
        const dayShifts = shiftsByDate.get(String(s.date ?? "")) ?? [];
        const monthShifts = shiftsByMonth.get(String(s.date ?? "").slice(0, 7)) ?? [];
        const cancelled = String(s.status ?? "").startsWith("cancelled");
        const emptyRoles = (s.assignments ?? []).filter((a: any) => !a.empId).map((a: any) => String(a.role ?? ""));
        const eligible = emptyRoles.length ? (cfg.employees ?? []).filter((candidate: any) => candidate.active &&
          emptyRoles.some((role: string) => eligibilityErrors(candidate, s, role, dayShifts, cfg).length === 0)) : [];
        const ranked = rankCandidatesByWorkload(eligible, monthShifts, s.date, 99);
        const onSite = ranked.filter((candidate: any) => dayShifts.some((other: any) => other.id !== s.id && other.date === s.date &&
          other.storeId === s.storeId && !String(other.status ?? "").startsWith("cancelled") && (other.assignments ?? []).some((a: any) => a.empId === candidate.id)));
        const onSiteIds = new Set(onSite.map((candidate: any) => candidate.id));
        const replacementCandidates: Record<string, Array<{ id: string; name: string }>> = {};
        if ((employee.type === "full" || account.role === "manager") && !cancelled) {
          for (const assignment of (s.assignments ?? []).filter((a: any) => a.empId)) {
            replacementCandidates[String(assignment.empId)] = (cfg.employees ?? []).filter((candidate: any) =>
              candidate.id !== assignment.empId && employedOn(candidate, s.date) &&
              !(s.assignments ?? []).some((a: any) => a.empId === candidate.id) &&
              eligibilityErrors(candidate, s, assignment.role, dayShifts, cfg, [s.id]).length === 0
            ).map((candidate: any) => ({ id: candidate.id, name: candidate.name }));
          }
        }
        const writebackTheme = (cfg.themes ?? []).find((theme: any) => theme.id === s.themeId);
        const writebackRole = writebackTheme && (Number(writebackTheme.payNPC) || 0) > 0 ? "NPC" : "場控";
        const writebackCandidates = account.role === "manager" && String(s.id).startsWith("sb_") && (s.assignments ?? []).some((a: any) => !a.empId && a.role === writebackRole)
          ? (cfg.employees ?? []).filter((candidate: any) => candidate.active && eligibilityErrors(candidate, s, writebackRole, dayShifts, cfg, [s.id]).length === 0).map((candidate: any) => ({ id: candidate.id, name: candidate.name })) : [];
        // 管理員 LINE 排班用:每個尚未排人的角色，列出「有資格＋當天有空＋不衝堂」的候選人(依場數少到多排序，供一鍵排)
        const roleCandidates: Record<string, Array<{ id: string; name: string; warnings: string[] }>> = {};
        // 詭獄／詭獄加場除了 SimplyBook 帶的 NPC，還可排場控(即使 assignments 尚無此欄位)。
        const extraRoles = writebackTheme && String(writebackTheme.name ?? "").startsWith("詭獄") && !(s.assignments ?? []).some((a: any) => a.role === "場控") ? ["場控"] : [];
        const roleSet = new Set<string>([...emptyRoles, ...extraRoles]);
        // 只對「尚有空位的場次」算候選(避免對全部場次×全部角色計算讓 bootstrap 過重逾時);已排要換人先按 ✕ 清空即出現候選。
        if (account.role === "manager" && (s.kind === "theme" || (s.kind === "counter" && s.storeId === "dz")) && !cancelled && roleSet.size) {
          const pool = (cfg.employees ?? []).filter((candidate: any) => candidate.active && employedOn(candidate, s.date) &&
            !(s.assignments ?? []).some((a: any) => a.empId === candidate.id));
          const ranked = rankCandidatesByWorkload(pool, monthShifts, s.date, 99);
          for (const role of roleSet) {
            // 未具技能/衝堂/跨店/休假等以 warnings 提示，不硬擋;合格者(無 warnings)優先。
            roleCandidates[role] = ranked.map((candidate: any) => ({ id: candidate.id, name: candidate.name, warnings: eligibilityErrors(candidate, s, role, dayShifts, cfg, [s.id]) }))
              .sort((a: any, b: any) => (a.warnings.length ? 1 : 0) - (b.warnings.length ? 1 : 0));
          }
        }
        return {
          id: s.id, date: s.date, storeId: s.storeId, kind: s.kind, themeId: s.themeId, start: s.start, end: s.end,
          trainingThemeId: s.trainingThemeId ?? null,
          paid: s.kind === "meeting" ? s.paid === true : null,
          payStatus: s.kind === "meeting" ? String(s.payStatus ?? (s.paid === true ? "paid" : "unpaid")) : null,
          audience: s.kind === "meeting" ? String(s.audience ?? "") : null,
          hostId: s.kind === "meeting" ? String(s.hostId ?? "") : null,
          hostName: s.kind === "meeting" ? String(s.hostName ?? "") : null,
          note: s.kind === "meeting" ? String(s.note ?? "") : null,
          createdBy: s.kind === "meeting" ? String(s.createdBy ?? "") : null,
          status: s.status ?? "active", assignments: s.assignments ?? [],
          linkedThemeAssignments: s.linkedThemeAssignments ?? [],
          fulltimeControllerAssignment: s.fulltimeControllerAssignment ? {
            assignedBy: String(s.fulltimeControllerAssignment.assignedBy ?? ""),
            assignedEmpId: String(s.fulltimeControllerAssignment.assignedEmpId ?? ""),
            assignedAt: String(s.fulltimeControllerAssignment.assignedAt ?? ""),
          } : null,
          depositPaid: isDepositPaid(s.payment),
          // 所有已綁定且仍在職的兼職、正職、管理員都可查看簡要客人資訊。
          // LINE 前端只顯示姓名與訂金；電話需點開才呈現。Email、備註不送到員工端。
          customer: s.customer ? { name: s.customer.name ?? "", phone: s.customer.phone ?? "" } : null,
          payment: s.payment ? { depositAmount: s.payment.depositAmount ?? null, depositStatus: s.payment.depositStatus ?? "", system: s.payment.system ?? "", currency: s.payment.depositCurrency ?? s.payment.currency ?? "" } : null,
          replacementCandidates,
          writebackRole: writebackCandidates.length ? writebackRole : null,
          writebackCandidates,
          candidateGroups: emptyRoles.length ? {
            onSite: onSite.map((candidate: any) => candidate.name),
            available: ranked.filter((candidate: any) => !onSiteIds.has(candidate.id)).map((candidate: any) => candidate.name),
          } : null,
          roleCandidates,
        };
      });
      let meetingResponses: any[] = [];
      const meetingIds = publicShifts.filter((shift: any) => shift.kind === "meeting" && !String(shift.status ?? "").startsWith("cancelled")).map((shift: any) => String(shift.id));
      const meetingAudience: Record<string, Array<{ id: string; name: string }>> = {};
      for (const meeting of publicShifts.filter((shift: any) => shift.kind === "meeting" && !String(shift.status ?? "").startsWith("cancelled") &&
        (account.role === "manager" || String(shift.hostId ?? "") === employee.id))) {
        meetingAudience[String(meeting.id)] = (cfg.employees ?? []).filter((item: any) => item.active && ["full", "part"].includes(String(item.type)) && employedOn(item, meeting.date))
          .map((item: any) => ({ id: String(item.id), name: String(item.name ?? "") }));
      }
      if (account.role === "manager" && meetingIds.length) {
        const { data, error } = await sb.from("shift_confirmations").select("shift_id,emp_id,status,confirmed_at").in("shift_id", meetingIds);
        if (error) throw error;
        meetingResponses = data ?? [];
      } else {
        // 一般員工只能看到自己的回覆；若本人是該場主持人，才額外取得該場全體出缺席。
        const hostedMeetingIds = publicShifts.filter((shift: any) => shift.kind === "meeting" && String(shift.hostId ?? "") === employee.id &&
          !String(shift.status ?? "").startsWith("cancelled")).map((shift: any) => String(shift.id));
        const ownResponses = (shiftConfirmations ?? []).filter((row: any) => meetingIds.includes(String(row.shift_id)) && ["attending", "declined"].includes(String(row.status)))
          .map((row: any) => ({ ...row, emp_id: employee.id }));
        if (hostedMeetingIds.length) {
          const { data, error } = await sb.from("shift_confirmations").select("shift_id,emp_id,status,confirmed_at").in("shift_id", hostedMeetingIds);
          if (error) throw error;
          meetingResponses = [...new Map([...ownResponses, ...(data ?? [])].map((row: any) => [`${row.shift_id}|${row.emp_id}`, row])).values()];
        } else meetingResponses = ownResponses;
      }
      const publicPunches = (punches ?? []).map((p: any) => ({
        id: p.id, ts: p.ts, type: p.type, worksite_id: p.worksite_id, verification: p.verification,
        review_state: p.review_state, voided_at: p.voided_at, void_reason: p.void_reason, shift_ids: p.shift_ids ?? [],
        work_item: p.raw?.work_item ?? null,
      }));
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const leaveYear = today.slice(0, 4), annualQuota = Math.max(0, Number(employee.annualLeaveQuota) || 0);
      const annualLeaveDates = Object.entries(employee.availX ?? {}).filter(([date, availability]: [string, any]) =>
        date.slice(0, 4) === leaveYear && availability?.on === false && availability?.leaveType === "特休"
      ).map(([date, availability]: [string, any]) => ({ date, days: Math.max(0, Number(availability?.leaveDays) || 1) })).sort((a, b) => a.date.localeCompare(b.date));
      const usedLeave = annualLeaveDates.filter(item => item.date <= today), plannedLeave = annualLeaveDates.filter(item => item.date > today);
      const usedDays = usedLeave.reduce((sum, item) => sum + item.days, 0), plannedDays = plannedLeave.reduce((sum, item) => sum + item.days, 0);
      const annualLeave = employee.type === "full" ? { year: leaveYear, quotaDays: annualQuota, usedDays, plannedDays,
        unusedDays: Math.max(0, annualQuota - usedDays), availableToPlanDays: Math.max(0, annualQuota - usedDays - plannedDays),
        usedDates: usedLeave, plannedDates: plannedLeave, restNote: String(employee.restNote ?? "") } : null;
      return json({ me: { id: employee.id, name: employee.name, role: account.role, type: employee.type,
          canSchedulePractice: account.role === "manager" || (employee.type === "full" && !!employee.canSchedulePractice) }, stores: cfg.stores, themes: cfg.themes,
        employees: publicEmployees, shifts: publicShifts, worksites, punches: publicPunches,
        attendanceDays, attendanceRequests, overtimeReviews, sessionCheckins, shiftConfirmations, meetingResponses, meetingAudience,
        availabilityRequests, availabilityConfirmations, availability: employee.availX ?? {}, myAvail: employee.avail ?? {},
        annualLeave, weeklyOffDay: cfg.settings?.weeklyOffDay ?? 4, holidays: cfg.settings?.holidays ?? {}, liffId: Deno.env.get("LINE_LIFF_ID") ?? "" });
    }

    if (action === "manager-assign") {
      if (account.role !== "manager") return json({ error: "只有管理員可以排班" }, 403);
      const shiftId = String(input.shiftId ?? ""), role = String(input.role ?? ""), empId = input.empId ? String(input.empId) : "";
      const shift = shifts.find((s: any) => s.id === shiftId);
      if (!shift) return json({ error: "找不到這個班次，請重新整理後再試" }, 404);
      if (String(shift.status ?? "").startsWith("cancelled")) return json({ error: "已取消的班次不能排班" }, 409);
      const assignments = (shift.assignments ?? []).map((a: any) => ({ ...a }));
      if (empId) {
        const cand = (cfg.employees ?? []).find((e: any) => e.id === empId && e.active);
        if (!cand) return json({ error: "找不到這位員工" }, 400);
        if (assignments.some((a: any) => a.empId === empId)) return json({ error: `${cand.name} 已排在這個場次` }, 409);
        // 管理員可臨時調度:未具技能/衝堂/跨店/休假等不硬擋(前端已提示)。找同角色的欄位填入或換人，沒有就新增。
        const slot = assignments.find((a: any) => a.role === role);
        if (slot) slot.empId = empId; else assignments.push({ role, empId });
      } else {
        const slot = assignments.find((a: any) => a.role === role && a.empId);
        if (slot) slot.empId = "";
      }
      // manualEdit 保護此指派，避免每分鐘的 SimplyBook 同步覆蓋掉。
      const updated = { ...shift, assignments, manualEdit: true, sourceUpdatedAt: new Date().toISOString() };
      const source = String(shift.id).startsWith("sb_") ? "simplybook" : "manual";
      const { error } = await sb.from("shifts").upsert({ id: shift.id, date: shift.date, source, data: updated });
      if (error) return json({ error: error.message }, 500);
      // 每一次排班/換人/清除都留稽核紀錄，不省略。
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id,
        action: empId ? "schedule_assign" : "schedule_clear", target_type: "shift", target_id: shift.id,
        details: { role, empId, date: shift.date, start: shift.start, end: shift.end, themeId: shift.themeId, by: employee.name } });
      return json({ ok: true, assignments });
    }

    if (action === "fulltime-controller-self-assign" || action === "fulltime-controller-assign") {
      if (employee.type !== "full") return json({ error: "只有正職可以使用場控選填" }, 403);
      const shiftId = String(input.shiftId ?? ""), assign = input.assign !== false;
      const shift = shifts.find((item: any) => String(item.id) === shiftId);
      if (!shift || shift.kind !== "theme" || String(shift.status ?? "").startsWith("cancelled")) return json({ error: "找不到可選填的主題場次" }, 404);
      const theme = (cfg.themes ?? []).find((item: any) => item.id === shift.themeId), themeName = String(theme?.name ?? "").trim();
      if (!["詭獄", "詭獄加場"].includes(themeName)) return json({ error: "正職只能選填詭獄或詭獄加場的場控" }, 403);
      const assignments = (shift.assignments ?? []).map((item: any) => ({ ...item }));
      const controller = assignments.find((item: any) => item.role === "場控");
      const requestedEmpId = String(input.empId ?? controller?.empId ?? employee.id);
      const targetEmployee = (cfg.employees ?? []).find((item: any) => item.id === requestedEmpId && item.active);
      if (!targetEmployee) return json({ error: "找不到這位在職員工" }, 400);
      const worksThatDay = shifts.some((item: any) => item.id !== shift.id && item.date === shift.date &&
        !String(item.status ?? "").startsWith("cancelled") && (item.assignments ?? []).some((assignment: any) => assignment.empId === requestedEmpId));
      if (requestedEmpId !== employee.id && !worksThatDay) return json({ error: `${targetEmployee.name} 當天沒有其他已排班工作，正職不能替他選填` }, 403);
      if (assign) {
        if (controller?.empId && controller.empId !== requestedEmpId) return json({ error: `這一場已由 ${((cfg.employees ?? []).find((item: any) => item.id === controller.empId)?.name ?? "其他人")} 擔任場控` }, 409);
        if (controller) controller.empId = requestedEmpId; else assignments.push({ role: "場控", empId: requestedEmpId });
      } else {
        const record = shift.fulltimeControllerAssignment;
        const mayClear = record?.assignedBy === employee.id || (!record && controller?.empId === employee.id);
        if (!controller || controller.empId !== requestedEmpId || !mayClear) return json({ error: "只能取消由你本人完成的場控選填" }, 409);
        controller.empId = "";
      }
      const updated = { ...shift, assignments, manualEdit: true, sourceUpdatedAt: new Date().toISOString(),
        fulltimeControllerAssignment: assign ? { assignedBy: employee.id, assignedEmpId: requestedEmpId, assignedAt: new Date().toISOString() } : null };
      const source = String(shift.id).startsWith("sb_") ? "simplybook" : "manual";
      const { error } = await sb.from("shifts").upsert({ id: shift.id, date: shift.date, source, data: updated });
      if (error) throw error;
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      const actionText = assign ? "選填" : "取消", targetText = requestedEmpId === employee.id ? employee.name : `${targetEmployee.name}`;
      for (const manager of managers ?? []) await queueNotification(sb, manager.emp_id, "fulltime_controller_assign", {
        title: assign ? "正職已選填場控" : "正職已取消場控選填", text: `${employee.name}已替 ${targetText}${actionText} ${shift.date} ${shift.start}–${shift.end} ${themeName}－場控。`,
      }, false, `fulltime-controller:${shift.id}:${requestedEmpId}:${assign ? "assign" : "clear"}:${Date.now()}`);
      if (requestedEmpId !== employee.id) await queueNotification(sb, requestedEmpId, "fulltime_controller_assignment", {
        title: assign ? "場控工作已選填" : "場控選填已取消", text: `${employee.name}已替你${actionText} ${shift.date} ${shift.start}–${shift.end} ${themeName}－場控。`,
      }, false, `fulltime-controller-target:${shift.id}:${requestedEmpId}:${assign ? "assign" : "clear"}:${Date.now()}`);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: assign ? "fulltime_controller_assign" : "fulltime_controller_clear",
        target_type: "shift", target_id: shift.id, details: { targetEmpId: requestedEmpId, targetName: targetEmployee.name, date: shift.date, start: shift.start, end: shift.end, themeId: shift.themeId, themeName } });
      return json({ ok: true, message: assign ? `已替 ${targetText} 選填 ${themeName}－場控，並通知管理員` : `已取消 ${targetText} 的 ${themeName}－場控選填，並通知管理員` });
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
          themeId: shift.themeId ?? null, trainingThemeId: shift.trainingThemeId ?? null, paid: shift.kind === "meeting" ? !!shift.paid : null,
          hostId: shift.hostId ?? null, hostName: shift.hostName ?? null, role, linked, requiresReport, completed: completed.has(String(shift.id)) });
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
          for (const assignment of shift.assignments ?? []) if (assignment.empId === candidate.id) workItems.push({ id: shift.id, date: shift.date, start: shift.start, end: shift.end, storeId: shift.storeId, kind: shift.kind, themeId: shift.themeId ?? null, trainingThemeId: shift.trainingThemeId ?? null, paid: shift.kind === "meeting" ? !!shift.paid : null, hostId: shift.hostId ?? null, hostName: shift.hostName ?? null, role: assignment.role, linked: false });
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

    if (action === "meeting-response") {
      const shiftId = String(input.shiftId ?? ""), response = String(input.response ?? "");
      if (!["attending", "declined"].includes(response)) return json({ error: "請選擇會參加或不參加" }, 400);
      const meeting = shifts.find((item: any) => String(item.id) === shiftId && item.kind === "meeting" && item.audience === "all" && !String(item.status ?? "").startsWith("cancelled"));
      if (!meeting) return json({ error: "找不到這場會議，可能已經取消" }, 404);
      if (new Date(`${meeting.date}T${meeting.end}:00+08:00`).getTime() <= Date.now()) return json({ error: "已結束的會議不能再更改回覆" }, 409);
      if (!["full", "part"].includes(String(employee.type)) || !employedOn(employee, meeting.date)) return json({ error: "你不在這場會議的通知名單中" }, 403);
      const { error } = await sb.from("shift_confirmations").upsert({ shift_id: meeting.id, emp_id: employee.id, status: response, source: "line", confirmed_at: new Date().toISOString() });
      if (error) throw error;
      if (meeting.payStatus === "paid") {
        const assignments = (meeting.assignments ?? []).filter((item: any) => item.empId !== employee.id);
        if (response === "attending") assignments.push({ role: employee.id === meeting.hostId ? "會議主持（計薪）" : "參加會議（計薪）", empId: employee.id });
        const updated = { ...meeting, assignments, sourceUpdatedAt: new Date().toISOString() };
        const { error: shiftError } = await sb.from("shifts").upsert({ id: meeting.id, date: meeting.date, source: "manual", data: updated });
        if (shiftError) throw shiftError;
      }
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "meeting_response", target_type: "shift", target_id: meeting.id,
        details: { response, date: meeting.date, start: meeting.start, end: meeting.end, hostId: meeting.hostId, paid: !!meeting.paid } });
      return json({ ok: true, message: response === "attending" ? "已回覆：會參加" : "已回覆：不參加" });
    }

    if (action === "schedule-meeting") {
      if (account.role !== "manager" && employee.type !== "full") return json({ error: "只有管理員或正職可以建立開會提醒" }, 403);
      const date = String(input.date ?? ""), start = String(input.start ?? ""), end = String(input.end ?? ""), storeId = String(input.storeId ?? "");
      const managerCreated = account.role === "manager", hostId = managerCreated ? String(input.hostId ?? "") : employee.id;
      const payStatus = managerCreated ? (input.paid === true ? "paid" : "unpaid") : "pending", paid = payStatus === "paid", note = String(input.note ?? "").trim().slice(0, 300);
      const timeOk = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeOk(start) || !timeOk(end) || toMinutes(end) <= toMinutes(start)) return json({ error: "請填寫正確的會議日期與起訖時間" }, 400);
      if (new Date(`${date}T${start}:00+08:00`).getTime() <= Date.now()) return json({ error: "會議開始時間必須晚於現在" }, 409);
      const store = (cfg.stores ?? []).find((item: any) => item.id === storeId);
      if (!store) return json({ error: "請選擇會議地點" }, 400);
      const host = (cfg.employees ?? []).find((item: any) => item.id === hostId && item.active && employedOn(item, date));
      if (!host || !["full", "part"].includes(String(host.type))) return json({ error: "請選擇會議當日在職的主持人" }, 400);
      const attendees = (cfg.employees ?? []).filter((item: any) => item.active && ["full", "part"].includes(String(item.type)) && employedOn(item, date));
      const id = `meeting_${crypto.randomUUID()}`;
      const assignments = paid ? attendees.map((item: any) => ({ role: item.id === host.id ? "會議主持（計薪）" : "參加會議（計薪）", empId: item.id })) : [];
      const meeting = { id, date, storeId, kind: "meeting", themeId: null, start, end, status: "active", paid, payStatus, audience: "all", hostId: host.id, hostName: host.name,
        note, assignments, createdBy: employee.id, createdVia: managerCreated ? "line_manager_meeting" : "line_fulltime_meeting" };
      const { error } = await sb.from("shifts").insert({ id, date, source: "manual", data: meeting });
      if (error) throw error;
      const payText = payStatus === "pending" ? "本次會議由正職建立，是否計薪等待管理員決定。" : paid ? "本次會議計薪，請依規定上下班定位打卡；工時仍須管理員核准。" : "本次會議不計薪，只需查看提醒，不需打卡。";
      const label = `${date} ${start}–${end} ${store.name}・主持人：${host.name}`;
      for (const attendee of attendees) await queueNotification(sb, attendee.id, "meeting_reminder", {
        title: `${payStatus === "pending" ? "計薪待確認" : paid ? "計薪" : "不計薪"}會議提醒`, text: `${label}。${note ? `內容：${note}。` : ""}${payText}`,
      }, true, `meeting:${id}:${attendee.id}`);
      await sb.from("audit_log").insert({ actor_type: managerCreated ? "line_manager" : "line_employee", actor_id: employee.id, action: "schedule_meeting", target_type: "shift", target_id: id,
        details: { date, start, end, storeId, hostId: host.id, hostName: host.name, paid, payStatus, note, attendeeCount: attendees.length } });
      return json({ ok: true, message: `會議已建立，將提醒 ${attendees.length} 位在職正職與兼職${payStatus === "pending" ? "；是否計薪等待管理員決定" : ""}` });
    }

    if (action === "manager-set-meeting-pay") {
      if (account.role !== "manager") return json({ error: "只有管理員可以決定會議是否計薪" }, 403);
      const shiftId = String(input.shiftId ?? ""), payStatus = String(input.payStatus ?? "");
      if (!["paid", "unpaid"].includes(payStatus)) return json({ error: "請選擇計薪或不計薪" }, 400);
      const meeting = shifts.find((item: any) => item.id === shiftId && item.kind === "meeting" && !String(item.status ?? "").startsWith("cancelled"));
      if (!meeting) return json({ error: "找不到這場會議" }, 404);
      if (new Date(`${meeting.date}T${meeting.start}:00+08:00`).getTime() <= Date.now()) return json({ error: "會議開始後不能再更改計薪方式" }, 409);
      const attendees = (cfg.employees ?? []).filter((item: any) => item.active && ["full", "part"].includes(String(item.type)) && employedOn(item, meeting.date));
      const { data: responses } = await sb.from("shift_confirmations").select("emp_id,status").eq("shift_id", meeting.id);
      const declined = new Set((responses ?? []).filter((item: any) => item.status === "declined").map((item: any) => item.emp_id));
      const paid = payStatus === "paid", assignments = paid ? attendees.filter((item: any) => !declined.has(item.id)).map((item: any) => ({ role: item.id === meeting.hostId ? "會議主持（計薪）" : "參加會議（計薪）", empId: item.id })) : [];
      const updated = { ...meeting, paid, payStatus, assignments, payDecidedAt: new Date().toISOString(), payDecidedBy: employee.id };
      const { error } = await sb.from("shifts").upsert({ id: meeting.id, date: meeting.date, source: "manual", data: updated });
      if (error) throw error;
      for (const attendee of attendees) await queueNotification(sb, attendee.id, "meeting_pay_decision", {
        title: `會議已確認${paid ? "計薪" : "不計薪"}`, text: `${meeting.date} ${meeting.start}–${meeting.end}・主持人：${meeting.hostName}。${paid ? "請上下班定位打卡，核准後計入工時。" : "只需出席，不需為本會議打卡。"}`,
      }, true, `meeting-pay:${meeting.id}:${payStatus}:${attendee.id}`);
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "manager_set_meeting_pay", target_type: "shift", target_id: meeting.id,
        details: { payStatus, paid, attendeeCount: attendees.length } });
      return json({ ok: true, message: `已設定為${paid ? "計薪" : "不計薪"}會議，並通知全體` });
    }

    if (action === "cancel-meeting") {
      if (account.role !== "manager" && employee.type !== "full") return json({ error: "只有管理員或建立會議的正職可以取消會議" }, 403);
      const shiftId = String(input.shiftId ?? ""), meeting = shifts.find((item: any) => item.id === shiftId && item.kind === "meeting" && !String(item.status ?? "").startsWith("cancelled"));
      if (!meeting) return json({ error: "找不到可取消的會議" }, 404);
      if (account.role !== "manager" && meeting.createdBy !== employee.id) return json({ error: "正職只能取消自己建立的會議" }, 403);
      const cancelled = { ...meeting, status: "cancelled_manual", cancelledAt: new Date().toISOString(), cancelledBy: employee.id };
      const { error } = await sb.from("shifts").upsert({ id: meeting.id, date: meeting.date, source: "manual", data: cancelled });
      if (error) throw error;
      const attendees = (cfg.employees ?? []).filter((item: any) => item.active && ["full", "part"].includes(String(item.type)) && employedOn(item, meeting.date));
      for (const attendee of attendees) await queueNotification(sb, attendee.id, "meeting_cancelled", {
        title: "會議取消", text: `${meeting.date} ${meeting.start}–${meeting.end} ${(cfg.stores ?? []).find((item: any) => item.id === meeting.storeId)?.name ?? ""} 的會議已取消。`,
      }, true, `meeting-cancelled:${meeting.id}:${attendee.id}`);
      await sb.from("audit_log").insert({ actor_type: "line_manager", actor_id: employee.id, action: "cancel_meeting", target_type: "shift", target_id: meeting.id,
        details: { date: meeting.date, start: meeting.start, end: meeting.end, paid: !!meeting.paid, hostId: meeting.hostId } });
      return json({ ok: true, message: "會議已取消，並通知正職與兼職" });
    }

    if (action === "schedule-practice") {
      if (account.role !== "manager" && !(employee.type === "full" && employee.canSchedulePractice)) return json({ error: "你沒有安排新人訓練場的權限" }, 403);
      const date = String(input.date ?? ""), start = String(input.start ?? ""), end = String(input.end ?? ""), storeId = String(input.storeId ?? "");
      const traineeId = String(input.traineeId ?? ""), companionId = String(input.companionId ?? ""), trainingThemeId = String(input.trainingThemeId ?? ""), note = String(input.note ?? "").trim();
      const timeOk = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeOk(start) || !timeOk(end) || toMinutes(end) <= toMinutes(start)) return json({ error: "請填寫正確的訓練日期與起訖時間" }, 400);
      if (!(cfg.stores ?? []).some((s: any) => s.id === storeId)) return json({ error: "訓練場地錯誤" }, 400);
      const trainingTheme = (cfg.themes ?? []).find((t: any) => t.id === trainingThemeId && t.active !== false);
      if (!trainingTheme || trainingTheme.storeId !== storeId) return json({ error: "請選擇這個場地的訓練主題" }, 400);
      const trainee = (cfg.employees ?? []).find((e: any) => e.id === traineeId && e.active), companion = (cfg.employees ?? []).find((e: any) => e.id === companionId && e.active);
      if (!trainee || !companion) return json({ error: "請選擇在職的受訓員工與陪練人員" }, 400);
      if (trainee.id === companion.id) return json({ error: "受訓員工與陪練人員不可為同一人" }, 400);
      const startsAt = new Date(`${date}T${start}:00+08:00`).getTime();
      if (startsAt <= Date.now()) return json({ error: "訓練場開始時間必須晚於現在" }, 409);
      const id = `practice_${crypto.randomUUID()}`, target = { id, date, storeId, kind: "practice", themeId: null, trainingThemeId: trainingTheme.id, start, end, status: "active", assignments: [] };
      const traineeErrors = eligibilityErrors(trainee, target, "訓練場", shifts, cfg), companionErrors = eligibilityErrors(companion, target, "陪練", shifts, cfg);
      if (traineeErrors.length || companionErrors.length) return json({ error: [traineeErrors.length ? `${trainee.name}：${traineeErrors.join("、")}` : "", companionErrors.length ? `${companion.name}：${companionErrors.join("、")}` : ""].filter(Boolean).join("；") }, 409);
      const shift = { ...target, note, assignments: [{ role: "訓練場", empId: trainee.id }, { role: "陪練", empId: companion.id }],
        createdBy: employee.id, createdVia: "line_practice_scheduler" };
      const { error } = await sb.from("shifts").insert({ id, date, source: "manual", data: shift });
      if (error) throw error;
      const label = `${date} ${start}–${end} ${(cfg.stores ?? []).find((s: any) => s.id === storeId)?.name ?? ""}・訓練主題：${trainingTheme.name}`;
      await queueNotification(sb, trainee.id, "practice_assigned", { title: "新人訓練場安排", text: `${label}，陪練：${companion.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:trainee`);
      await queueNotification(sb, companion.id, "practice_companion", { title: "陪練工作安排", text: `${label}，受訓員工：${trainee.name}。請至 LINE 班表確認並依規定上下班打卡。` }, true, `practice:${id}:companion`);
      const informed = new Set([trainee.id, companion.id, employee.id]);
      const { data: managers } = await sb.from("line_accounts").select("emp_id").eq("role", "manager").eq("active", true);
      for (const manager of managers ?? []) if (!informed.has(manager.emp_id)) await queueNotification(sb, manager.emp_id, "practice_scheduled_manager", {
        title: "訓練場已安排", text: `${employee.name}安排 ${label}：${trainee.name} 受訓，由 ${companion.name} 陪練。`,
      }, false, `practice:${id}:manager:${manager.emp_id}`);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "schedule_practice", target_type: "shift", target_id: id,
        details: { traineeId: trainee.id, traineeName: trainee.name, companionId: companion.id, trainingThemeId: trainingTheme.id, trainingThemeName: trainingTheme.name, date, start, end, storeId } });
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
      // 員工可能同日跨大忠店與謎先生支援；只要人在任一核准工作地點，
      // 即可回報被指派的主題，並保留實際定位店別供管理員核對。
      if (!site || site.distance > site.radius_m + Math.min(accuracy, 50)) return json({ error: "目前不在允許的打卡地點範圍內" }, 403);
      const checkedInAt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replace(" ", "T");
      // 放鳥:客人沒到場。只有 NPC 場放鳥才有薪水(1 小時),場控放鳥無薪,故僅 NPC 記錄放鳥旗標。
      const noShow = String(role).toUpperCase() === "NPC" && !!input.noShow;
      const { error } = await sb.from("session_checkins").insert({ emp_id: employee.id, shift_id: shift.id, checked_in_at: checkedInAt,
        worksite_id: site.id, latitude: lat, longitude: lng, accuracy_m: accuracy, verification: "line_location", source: "line",
        no_show: noShow, note: `${role}${shift.kind === "practice" ? "確認" : "場次完成"}${noShow ? "・客人放鳥" : ""}` });
      if (error) return json({ error: error.code === "23505" ? "這個場次已經回報過" : error.message }, error.code === "23505" ? 409 : 500);
      return json({ ok: true, ts: checkedInAt, site: site.name, role, noShow });
    }

    if (action === "request-haunted-prison-gm-assist") {
      if (employee.type !== "full") return json({ error: "只有正職可以登記協助詭獄場控" }, 403);
      const shiftId = String(input.shiftId ?? ""), lat = Number(input.latitude), lng = Number(input.longitude), accuracy = Number(input.accuracy ?? 9999);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 250) return json({ error: "定位精確度不足" }, 403);
      const shift = shifts.find((s: any) => String(s.id) === shiftId && s.kind === "theme" && !String(s.status ?? "").startsWith("cancelled"));
      const theme = (cfg.themes ?? []).find((row: any) => row.id === shift?.themeId);
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const allowedThemes = new Set(["詭獄", "詭獄加場"]);
      if (!shift || shift.date !== today || !allowedThemes.has(String(theme?.name ?? "").trim())) return json({ error: "正職只能選填今天的詭獄－場控或詭獄加場－場控" }, 403);
      if ((shift.assignments ?? []).some((row: any) => row.empId === employee.id && row.role === "場控")) return json({ error: "你已經是這一場的場控，不需要重複登記協助" }, 409);
      const { data: existingCheckin } = await sb.from("session_checkins").select("id").eq("emp_id", employee.id).eq("shift_id", shift.id).maybeSingle();
      if (existingCheckin) return json({ error: "這個場次已經完成回報" }, 409);
      const { data: latestPunch } = await sb.from("punches").select("type,ts").eq("emp_id", employee.id).is("voided_at", null).order("ts", { ascending: false }).limit(1).maybeSingle();
      if (!latestPunch || latestPunch.type !== "in" || String(latestPunch.ts ?? "").slice(0, 10) !== today) return json({ error: "請先完成今天的上班定位打卡，再登記協助場控" }, 409);
      const { data: sites } = await sb.from("worksites").select("*").eq("enabled", true).not("latitude", "is", null);
      const ranked = (sites ?? []).map((site: any) => ({ ...site, distance: distanceMeters(lat, lng, Number(site.latitude), Number(site.longitude)) })).sort((a: any, b: any) => a.distance - b.distance);
      const site = ranked[0];
      if (!site || site.distance > site.radius_m + Math.min(accuracy, 50)) return json({ error: "目前不在允許的打卡地點範圍內" }, 403);
      const { data: pendingDetails } = await sb.from("attendance_requests").select("id,requested").eq("emp_id", employee.id).eq("punch_date", today).eq("request_type", "gm_assist").eq("status", "pending");
      if ((pendingDetails ?? []).some((row: any) => String(row.requested?.shiftId ?? "") === shift.id)) return json({ error: "這一場已有待審的協助登記" }, 409);
      const requestedAt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replace(" ", "T");
      const requested = { shiftId: shift.id, time: requestedAt.slice(11, 16), requestedAt, role: "場控", themeName: theme.name,
        worksiteId: site.id, latitude: lat, longitude: lng, accuracy, workItem: { code: "haunted_prison", labels: [`${shift.start}–${shift.end} ${theme.name}（協助場控）`], source: "gm_assist_request" } };
      const { error } = await sb.from("attendance_requests").insert({ emp_id: employee.id, punch_date: today, request_type: "gm_assist", requested, reason: "正職協助詭獄場控" });
      if (error) throw error;
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "request_haunted_prison_gm_assist", target_type: "shift", target_id: shift.id, details: { worksiteId: site.id, requestedAt } });
      return json({ ok: true, message: "已送交管理員審核；核准後才會計入詭獄場控與薪資紀錄" });
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
              s.kind === "cleaning" ? "每週大清潔" : s.kind === "practice" ? "訓練場" : s.kind === "meeting" ? `開會（${s.paid ? "計薪" : "不計薪"}）` : s.kind === "floor" ? "場控／現場支援" : "其他工作";
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
        const hasOpenIn = latest && latest.type === "in" && String(latest.ts ?? "").slice(0, 10) === today;
        if (hasOpenIn) {
          selectedShifts = shifts.filter((s: any) => (latest.shift_ids ?? []).includes(s.id));
          workItem = latest.raw?.work_item ?? null;
          if (latest.raw?.verification === "line_location_unassigned") verification = "line_location_unassigned";
          else if (latest.worksite_id !== site.id) verification = "line_location_cross_site";
        } else {
          // 今天沒有尚未下班的上班卡(忘記上班打卡):仍即時記錄真正的下班時間並標記異常,
          // 員工另外提出「上班補卡」由管理員補上,兩者互不影響、不必等審核才能打卡。
          verification = "line_location_missing_in";
          workItem = { source: "missing_in_clock", attendance_mode: "clock_range", labels: ["缺上班卡（請補上班補卡）"] };
        }
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
        warning: verification === "line_location" ? null
          : verification === "line_location_missing_in" ? "已記錄下班時間。今天沒有上班卡，請補送「上班補卡」，管理員補上工時即完成；此下班時間不受補卡審核影響。"
          : "本次打卡屬於臨時支援或跨店下班，已記錄並交由管理員確認。" });
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

    if (action === "availability-submit") {
      const month = String(input.month ?? ""), entries = Array.isArray(input.entries) ? input.entries : [];
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "請選擇正確月份" }, 400);
      if (!entries.length || entries.length > 31) return json({ error: "請選擇 1 至 31 個日期" }, 400);
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const timeOk = (value: unknown) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ""));
      const allowedLeave = employee.type === "full" ? ["休假", "特休", "事假", "病假"] : ["不可上班"];
      const normalized: any[] = [];
      for (const source of entries) {
        const date = String(source?.date ?? ""), on = source?.on === true;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month || date < today) return json({ error: `日期 ${date || "空白"} 不在可申請範圍` }, 400);
        const requested: any = { on, source: "line_direct" };
        if (on) {
          const start = String(source?.start ?? ""), end = String(source?.end ?? "");
          if (!timeOk(start) || !timeOk(end) || start >= end) return json({ error: `${date} 的可上班時間不正確` }, 400);
          Object.assign(requested, { start, end });
        } else {
          const leaveType = String(source?.leaveType ?? (employee.type === "full" ? "休假" : "不可上班"));
          if (!allowedLeave.includes(leaveType)) return json({ error: `${date} 的假別不正確` }, 400);
          Object.assign(requested, { start: "09:00", end: "22:30", leaveType, leaveDays: Math.max(0.5, Math.min(1, Number(source?.leaveDays) || 1)) });
        }
        const affected = shifts.filter((shift: any) => shift.date === date && !String(shift.status ?? "").startsWith("cancelled") &&
          (shift.assignments ?? []).some((assignment: any) => assignment.empId === employee.id)).map((shift: any) => ({ id: shift.id, start: shift.start, end: shift.end, themeId: shift.themeId ?? null, kind: shift.kind }));
        requested.affectedShifts = affected;
        normalized.push({ date, requestKind: on ? "available" : "leave", requested });
      }
      const dates = normalized.map(row => row.date), batchId = crypto.randomUUID(), appliedEntries: Record<string, any> = {};
      for (const row of normalized) appliedEntries[row.date] = { ...row.requested, source: "line_direct", updatedAt: new Date().toISOString() };
      const { data: applied, error: applyError } = await sb.rpc("apply_line_availability", { p_emp_id: employee.id, p_entries: appliedEntries });
      if (applyError) throw applyError;
      if (!applied?.ok) return json({ error: applied?.msg ?? "儲存可上班資料失敗" }, 500);
      const { error: deleteError } = await sb.from("availability_requests").delete().eq("emp_id", employee.id).eq("status", "pending").in("work_date", dates);
      if (deleteError) throw deleteError;
      const { error } = await sb.from("availability_requests").insert(normalized.map(row => ({ batch_id: batchId, emp_id: employee.id,
        work_date: row.date, request_kind: row.requestKind, requested: row.requested, status: "approved", reviewed_at: new Date().toISOString() })));
      if (error) throw error;
      await sb.from("availability_month_confirmations").delete().eq("emp_id", employee.id).eq("month", month);
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "submit_monthly_availability",
        target_type: "availability_batch", target_id: batchId, details: { month, dates, count: normalized.length, direct: true } });
      const affectedCount = normalized.reduce((sum, row) => sum + row.requested.affectedShifts.length, 0);
      return json({ ok: true, batchId, count: normalized.length, affectedCount,
        message: `已儲存 ${normalized.length} 天，不需管理員審核。全部調整完後，請再按「確認本月已填完」${affectedCount ? `；其中 ${affectedCount} 個既有班次不會自動刪除` : ""}` });
    }

    if (action === "availability-confirm-month") {
      const month = String(input.month ?? ""), today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < today.slice(0, 7)) return json({ error: "請選擇本月或未來月份" }, 400);
      const confirmedAt = new Date().toISOString();
      const { error } = await sb.from("availability_month_confirmations").upsert({ emp_id: employee.id, month, confirmed_at: confirmedAt, updated_at: confirmedAt }, { onConflict: "emp_id,month" });
      if (error) throw error;
      await sb.from("audit_log").insert({ actor_type: "line_employee", actor_id: employee.id, action: "confirm_monthly_availability",
        target_type: "availability_month", target_id: `${employee.id}:${month}`,
        details: { month, blankRule: employee.type === "full" ? "available" : "unreported_unavailable" } });
      return json({ ok: true, month, confirmedAt, message: `已確認 ${month.replace("-", " 年 ")} 月的可上班／不可上班已填完` });
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
      let estimate: AttendanceEstimate | null = null;
      if (requestType !== "npc_checkin") {
        const nextDate = dateText(new Date(Date.parse(`${punchDate}T00:00:00Z`) + DAY));
        const { data: dayPunches, error: punchError } = await sb.from("punches").select("id,ts,type").eq("emp_id", employee.id)
          .is("voided_at", null).gte("ts", `${punchDate}T00:00:00`).lt("ts", `${nextDate}T00:00:00`).order("ts", { ascending: true });
        if (punchError) throw punchError;
        estimate = estimateAttendanceAfterRequest(dayPunches ?? [], requestType, requested);
        if (estimate) Object.assign(requested, estimate, { estimateStatus: "pending_manager_review", estimatedAt: new Date().toISOString() });
      }
      const { error } = await sb.from("attendance_requests").insert({ emp_id: employee.id, punch_date: punchDate,
        request_type: requestType, requested, reason });
      if (error) throw error;
      return json({ ok: true, estimate });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, message.includes("LINE_") ? 401 : 500);
  }
});
