// well2go Strava auto-sync — scheduled (pg_cron) daily: pull yesterday+today's Strava workouts
// → write well2go_workouts + strava_cal fallback. Fully unattended: refresh token (in secrets)
// → /athlete/activities → per-activity calories → upsert (service role).
//
// SECRETS: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN, STRAVA_ATHLETE,
//          plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
const CID = Deno.env.get("STRAVA_CLIENT_ID")!;
const CSEC = Deno.env.get("STRAVA_CLIENT_SECRET")!;
const RT = Deno.env.get("STRAVA_REFRESH_TOKEN")!;
const ATH = (Deno.env.get("STRAVA_ATHLETE") || "me").trim().toLowerCase();
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sbHdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };

async function accessToken(): Promise<string> {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: CSEC, grant_type: "refresh_token", refresh_token: RT }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).access_token;
}

async function sget(tok: string, path: string) {
  const r = await fetch(`https://www.strava.com/api/v3${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`strava ${r.status} ${path}: ${(await r.text()).slice(0, 100)}`);
  return r.json();
}

Deno.serve(async (req) => {
  try {
    const days = Number(new URL(req.url).searchParams.get("days") || 3);
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const tok = await accessToken();
    const acts: any[] = await sget(tok, `/athlete/activities?after=${after}&per_page=50`);

    const rows: any[] = [];
    const calByDay: Record<string, { am: number; pm: number }> = {};
    for (const a of acts) {
      let cal = a.calories;
      if (cal == null) { try { cal = (await sget(tok, `/activities/${a.id}`)).calories; } catch (_) {} }
      const local: string = a.start_date_local || a.start_date || "";
      const day = local.slice(0, 10);
      const hour = Number((local.slice(11, 13)) || "12");
      rows.push({
        athlete: ATH, day, sport_type: a.sport_type || a.type, name: String(a.name || "").slice(0, 120),
        started_at: a.start_date, started_at_local_text: a.start_date_local,
        moving_seconds: a.moving_time, distance_meters: a.distance, calories_kcal: cal,
        external_id: String(a.id), trainer: a.trainer ?? null,
      });
      if (cal != null && day) { (calByDay[day] ||= { am: 0, pm: 0 }); calByDay[day][hour < 12 ? "am" : "pm"] += Number(cal); }
    }

    // workouts: dedupe by external_id then write
    if (rows.length) {
      const ids = rows.map((r) => `"${r.external_id}"`).join(",");
      await fetch(`${SB_URL}/rest/v1/well2go_workouts?external_id=in.(${ids})`, { method: "DELETE", headers: sbHdr });
      const ins = await fetch(`${SB_URL}/rest/v1/well2go_workouts`, { method: "POST", headers: { ...sbHdr, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
      if (!ins.ok) throw new Error(`db workouts ${ins.status}: ${(await ins.text()).slice(0, 120)}`);
    }
    // strava_cal fallback: aggregate per day → upsert daily_steps
    for (const [day, c] of Object.entries(calByDay)) {
      await fetch(`${SB_URL}/rest/v1/well2go_daily_steps?on_conflict=athlete,day`, {
        method: "POST", headers: { ...sbHdr, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ athlete: ATH, day, strava_cal_am: Math.round(c.am), strava_cal_pm: Math.round(c.pm) }),
      });
    }
    return json({ ok: true, athlete: ATH, activities: rows.length, days_touched: Object.keys(calByDay), latest: rows[0]?.started_at_local_text || null });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
