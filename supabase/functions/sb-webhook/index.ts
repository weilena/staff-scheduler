// SimplyBook create/change/cancel callback.
// The callback contains only a booking reference. We never trust it as booking
// data; it merely asks sb-sync to re-read the authoritative SimplyBook API.

const ALLOWED_TYPES = new Set(["create", "change", "cancel", "notify"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return Response.json({ ok: true, service: "simplybook-webhook" });

  try {
    const contentType = req.headers.get("content-type") ?? "";
    let payload: Record<string, string> = {};
    if (contentType.includes("application/json")) {
      payload = await req.json();
    } else {
      const text = await req.text();
      payload = Object.fromEntries(new URLSearchParams(text));
    }

    const company = String(payload.company ?? "");
    const notificationType = String(payload.notification_type ?? "").toLowerCase();
    const bookingId = String(payload.booking_id ?? "");
    const bookingHash = String(payload.booking_hash ?? "");

    // SimplyBook probes a callback URL while saving the API custom feature.
    // A probe may be an empty POST, so acknowledge it without starting a sync.
    if (!company && !notificationType && !bookingId && !bookingHash) {
      return Response.json({ ok: true, probe: true }, { headers: corsHeaders() });
    }

    if (!company || company !== Deno.env.get("SB_COMPANY")) {
      return Response.json(
        { ok: true, ignored: true, reason: "company mismatch" },
        { headers: corsHeaders() },
      );
    }
    if (!ALLOWED_TYPES.has(notificationType) || (!bookingId && !bookingHash)) {
      return Response.json(
        { ok: true, ignored: true, reason: "invalid callback payload" },
        { headers: corsHeaders() },
      );
    }

    const syncUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sb-sync?apply=1&source=webhook`;
    const task = fetch(syncUrl, {
      method: "POST",
      headers: { "x-sync-secret": Deno.env.get("SYNC_SECRET") ?? "" },
    }).then(async (response) => {
      if (!response.ok) console.error("sb-sync failed", response.status, await response.text());
    }).catch((error) => console.error("sb-sync request failed", error));

    // Acknowledge SimplyBook quickly; keep the synchronization running after
    // the HTTP response so SimplyBook does not time out and retry unnecessarily.
    EdgeRuntime.waitUntil(task);
    return Response.json({ ok: true, accepted: notificationType }, { headers: corsHeaders() });
  } catch (error) {
    console.error(error);
    // Return 200 to prevent a malformed callback from causing a retry storm.
    return Response.json({ ok: false, error: "callback could not be parsed" }, { headers: corsHeaders() });
  }
});
