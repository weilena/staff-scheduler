const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-setup-key",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function lineFetch(path: string, token: string, init: RequestInit = {}, dataApi = false) {
  const host = dataApi ? "https://api-data.line.me" : "https://api.line.me";
  const response = await fetch(`${host}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`LINE ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const setupSecret = Deno.env.get("LINE_SETUP_SECRET") || "";
  if (!setupSecret || request.headers.get("x-setup-key") !== setupSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
  if (!token) return json({ error: "LINE_CHANNEL_ACCESS_TOKEN is missing" }, 500);

  try {
    const body = await request.json();
    if (typeof body.imageBase64 !== "string" || !body.imageBase64) {
      return json({ error: "imageBase64 is required" }, 400);
    }

    const menuName = "mythworker 員工選單";
    const oldMenus = await (await lineFetch("/v2/bot/richmenu/list", token)).json();
    for (const menu of oldMenus.richmenus || []) {
      if (menu.name === menuName) {
        await lineFetch(`/v2/bot/richmenu/${menu.richMenuId}`, token, { method: "DELETE" });
      }
    }

    const liff = "https://liff.line.me/2010690079-ysvO02nW";
    const createResponse = await lineFetch("/v2/bot/richmenu", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: { width: 2500, height: 843 },
        selected: true,
        name: menuName,
        chatBarText: "員工功能",
        areas: [
          { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "uri", label: "查看班表", uri: `${liff}?tab=schedule` } },
          { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "uri", label: "定位打卡", uri: `${liff}?tab=punch` } },
          { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "uri", label: "換班申請", uri: `${liff}?tab=mine` } },
        ],
      }),
    });
    const { richMenuId } = await createResponse.json();

    const binary = Uint8Array.from(atob(body.imageBase64), (char) => char.charCodeAt(0));
    await lineFetch(`/v2/bot/richmenu/${richMenuId}/content`, token, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: binary,
    }, true);
    await lineFetch(`/v2/bot/user/all/richmenu/${richMenuId}`, token, { method: "POST" });

    return json({ ok: true, richMenuId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
