import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Well2GO ingest: steps / active energy / water (Apple Health Auto Export "HAE" + Shortcut direct format)
// athlete priority: URL ?athlete= > body.athlete > INGEST_DEFAULT_ATHLETE
// Whoop sends kJ → ÷4.184 → kcal. Resting energy summed per day (display only, no coins).
//
// SECRETS (set via `supabase secrets set`):
//   INGEST_TOKEN            shared secret the iOS Shortcut must send (?token= or x-token header)
//   INGEST_DEFAULT_ATHLETE  fallback athlete name when none supplied (e.g. your name)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  auto-provided by Supabase
const INGEST_TOKEN = Deno.env.get("INGEST_TOKEN") ?? "";
const DEFAULT_ATHLETE = (Deno.env.get("INGEST_DEFAULT_ATHLETE") ?? "me").trim().toLowerCase();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function localHour(ds: string): number {
  const m = ds.match(/[T ](\d{2}):/);
  return m ? parseInt(m[1], 10) : 12;
}
function dayOf(ds: string): string {
  const m = ds.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

type DayAgg = { sam: number; spm: number; cam: number; cpm: number; wat: number; bas: number; hasSteps: boolean; hasCal: boolean; hasWater: boolean; hasBasal: boolean };

function ensure(map: Record<string, DayAgg>, day: string): DayAgg {
  if (!map[day]) map[day] = { sam: 0, spm: 0, cam: 0, cpm: 0, wat: 0, bas: 0, hasSteps: false, hasCal: false, hasWater: false, hasBasal: false };
  return map[day];
}

// scale: calorie unit conversion factor (kJ→kcal pass 1/4.184, else 1)
function foldByDay(map: Record<string, DayAgg>, data: any[], kind: "steps" | "cal", scale = 1) {
  for (const pt of data || []) {
    const ds = String(pt?.date ?? pt?.start ?? "");
    const day = dayOf(ds);
    if (!day) continue;
    const q = (Number(pt?.qty ?? pt?.value ?? 0) || 0) * scale;
    const e = ensure(map, day);
    const am = localHour(ds) < 12;
    if (kind === "steps") { if (am) e.sam += q; else e.spm += q; e.hasSteps = true; }
    else { if (am) e.cam += q; else e.cpm += q; e.hasCal = true; }
  }
}
// Water: summed per day (not split am/pm), scale converts L → mL
function foldWater(map: Record<string, DayAgg>, data: any[], scale: number) {
  for (const pt of data || []) {
    const ds = String(pt?.date ?? pt?.start ?? "");
    const day = dayOf(ds);
    if (!day) continue;
    const q = Number(pt?.qty ?? pt?.value ?? 0) || 0;
    const e = ensure(map, day);
    e.wat += q * scale; e.hasWater = true;
  }
}
// Resting/basal energy: summed per day (constant, no am/pm split), scale handles kJ→kcal
function foldBasal(map: Record<string, DayAgg>, data: any[], scale: number) {
  for (const pt of data || []) {
    const ds = String(pt?.date ?? pt?.start ?? "");
    const day = dayOf(ds);
    if (!day) continue;
    const q = (Number(pt?.qty ?? pt?.value ?? 0) || 0) * scale;
    const e = ensure(map, day);
    e.bas += q; e.hasBasal = true;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || req.headers.get("x-token") || "";
  if (!INGEST_TOKEN || token !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bad token" }), { status: 401, headers: { ...cors, "content-type": "application/json" } });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json();
    const qAthlete = url.searchParams.get("athlete");
    const athlete = (qAthlete || body.athlete || DEFAULT_ATHLETE).trim().toLowerCase();
    const map: Record<string, DayAgg> = {};

    const metrics = body?.data?.metrics;
    const debug: any = { format: null, metricNames: [], metrics: [] };
    if (Array.isArray(metrics)) {
      debug.format = "HAE";
      for (const mtr of metrics) {
        const nm = String(mtr?.name || "");
        const units = String(mtr?.units || "");
        const pts = Array.isArray(mtr?.data) ? mtr.data : [];
        const days = Array.from(new Set(pts.map((p: any) => dayOf(String(p?.date ?? p?.start ?? ""))).filter(Boolean)));
        debug.metricNames.push(nm);
        debug.metrics.push({ name: nm, units, points: pts.length, days, sample: pts[0] ?? null,
          pts: pts.slice(0, 60).map((p: any) => ({ d: p?.date ?? p?.start, q: p?.qty ?? p?.value, src: p?.source })) });
        const kjScale = /^(kj|kilojoule|kilojoules)$/i.test(units.trim()) ? (1 / 4.184) : 1;  // kJ→kcal
        if (/step/i.test(nm)) foldByDay(map, pts, "steps");
        // resting/basal energy first (basal_energy_burned would be swallowed by active energy.?burned, must precede)
        else if (/basal.?energy|resting.?energy/i.test(nm)) foldBasal(map, pts, kjScale);
        else if (/active.?energy|active_energy|energy.?burned/i.test(nm)) {
          // Whoop etc. use kJ; Apple Watch uses kcal/Cal. Normalize to kcal.
          foldByDay(map, pts, "cal", kjScale);
        }
        else if (/water|dietary.?water/i.test(nm)) {
          const scale = /^(l|liter|litre)$/i.test(units.trim()) ? 1000 : 1;  // L → mL
          foldWater(map, pts, scale);
        }
      }
    }
    // Direct format (Shortcut)
    if (body.steps_am !== undefined || body.steps_pm !== undefined || body.calories_am !== undefined || body.calories_pm !== undefined || body.water_ml !== undefined) {
      debug.format = debug.format || "direct";
      const day = body.day || new Date().toISOString().slice(0, 10);
      const e = ensure(map, day);
      if (body.steps_am !== undefined || body.steps_pm !== undefined) { e.sam += Number(body.steps_am || 0); e.spm += Number(body.steps_pm || 0); e.hasSteps = true; }
      if (body.calories_am !== undefined || body.calories_pm !== undefined) { e.cam += Number(body.calories_am || 0); e.cpm += Number(body.calories_pm || 0); e.hasCal = true; }
      if (body.water_ml !== undefined) { e.wat += Number(body.water_ml || 0); e.hasWater = true; }
      if (body.basal_cal !== undefined) { e.bas += Number(body.basal_cal || 0); e.hasBasal = true; }
    }

    const days = Object.keys(map).sort();
    await sb.from("well2go_ingest_debug").insert({ athlete, metric_names: debug.metricNames, detail: { debug, days, agg: map } });

    if (days.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "no parseable data", debug }), { status: 400, headers: { ...cors, "content-type": "application/json" } });
    }

    const written: any[] = [];
    for (const day of days) {
      const e = map[day];
      const row: Record<string, unknown> = { athlete, day, source: "ingest" };
      if (e.hasSteps) { row.steps_am = Math.round(e.sam); row.steps_pm = Math.round(e.spm); }
      if (e.hasCal) { row.calories_am = Math.round(e.cam * 10) / 10; row.calories_pm = Math.round(e.cpm * 10) / 10; }
      if (e.hasWater) { row.water_ml = Math.round(e.wat); }
      if (e.hasBasal) { row.basal_cal = Math.round(e.bas * 10) / 10; }
      const { error } = await sb.from("well2go_daily_steps").upsert(row, { onConflict: "athlete,day" });
      if (error) { console.error("[well2go-ingest] upsert fail", day, JSON.stringify(error)); throw new Error(error.message || JSON.stringify(error)); }
      written.push(row);
    }
    return new Response(JSON.stringify({ ok: true, athlete, days, rows: written }), { headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 400, headers: { ...cors, "content-type": "application/json" } });
  }
});
