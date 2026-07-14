import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, serviceClient } from "../_shared/common.ts";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const authorization = req.headers.get("authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: { user: actor }, error: authError } = await userClient.auth.getUser();
    if (authError || !actor || actor.aud !== "authenticated" || !actor.email_confirmed_at) {
      return json({ error: "ADMIN_LOGIN_REQUIRED" }, 401);
    }
    const actorRole = String(actor.app_metadata?.role ?? "");
    if (!["owner", "manager"].includes(actorRole)) return json({ error: "ADMIN_PERMISSION_REQUIRED" }, 403);

    const input = await req.json().catch(() => ({}));
    const action = String(input.action ?? "list");
    const sb = serviceClient();

    if (action === "list") {
      const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      const users = (data.users ?? []).map((user) => ({
        id: user.id,
        email: user.email ?? "",
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at ?? null,
        role: String(user.app_metadata?.role ?? "manager"),
      })).sort((a, b) => a.email.localeCompare(b.email));
      return json({ users });
    }

    if (action === "create") {
      if (actorRole !== "owner") return json({ error: "只有帳號擁有者可以新增管理者" }, 403);
      const email = String(input.email ?? "").trim().toLowerCase();
      const password = String(input.password ?? "");
      if (!emailPattern.test(email)) return json({ error: "請填寫正確的登入信箱" }, 400);
      if (password.length < 8) return json({ error: "密碼至少需要 8 碼" }, 400);
      const { data, error } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: "manager" },
      });
      if (error) throw error;
      await sb.from("audit_log").insert({
        actor_type: "supabase_admin", actor_id: actor.id, action: "create_admin_user",
        target_type: "auth_user", target_id: data.user?.id ?? null, details: { email },
      });
      return json({ ok: true, user: { id: data.user?.id, email } });
    }

    if (action === "reset-password") {
      if (actorRole !== "owner") return json({ error: "只有帳號擁有者可以重設其他管理者密碼" }, 403);
      const userId = String(input.userId ?? "");
      const password = String(input.password ?? "");
      if (!userId) return json({ error: "缺少管理者帳號" }, 400);
      if (password.length < 8) return json({ error: "密碼至少需要 8 碼" }, 400);
      const { data, error } = await sb.auth.admin.updateUserById(userId, { password });
      if (error) throw error;
      await sb.from("audit_log").insert({
        actor_type: "supabase_admin", actor_id: actor.id, action: "reset_admin_password",
        target_type: "auth_user", target_id: userId, details: { email: data.user.email ?? "" },
      });
      return json({ ok: true });
    }

    return json({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
