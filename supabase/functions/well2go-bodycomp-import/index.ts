// well2go body-composition card import — vision OCR
// Upload a Technogym/InBody body-composition report → Qwen3-VL extracts all metrics + measure date
// → saves a well2go_body_comp snapshot.
//
// SECRETS: OPENROUTER_API_KEY, plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
const OR_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VL_MODEL = Deno.env.get("VL_MODEL") ?? "qwen/qwen3-vl-235b-a22b-instruct";

const PROMPT =
  "这是一张身体成分(体测)报告(Technogym/InBody 类)。提取关键指标,只输出 JSON,不要解释:\n" +
  '{"is_report":是否体测报告true或false,"measure_date":"测量日期YYYY-MM-DD(读不到填空)",' +
  '"score":综合评分整数,"body_fat_pct":体脂率数字,"weight":体重数字,"weight_unit":"lbs或kg",' +
  '"skeletal_muscle":骨骼肌或去脂体重数字,"phase_angle":相位角数字,"bmr":基础代谢整数,"bmi":数字,' +
  '"note":"一句话(读到哪些)"}\n读不到的字段填 null;非体测报告 is_report=false。';

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function extract(imageUrl: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL, max_tokens: 500,
      messages: [{ role: "user", content: [
        { type: "text", text: PROMPT },
        { type: "image_url", image_url: { url: imageUrl } },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`vision ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = await r.json();
  const txt: string = d?.choices?.[0]?.message?.content ?? "";
  const s = txt.replace(/```(json)?/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("vision 未返回 JSON");
  return JSON.parse(s.slice(i, j + 1));
}

const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

async function save(athlete: string, day: string, v: any) {
  const row = {
    athlete, day,
    score: num(v.score), body_fat_pct: num(v.body_fat_pct), weight: num(v.weight),
    skeletal_muscle: num(v.skeletal_muscle), phase_angle: num(v.phase_angle),
    bmr: num(v.bmr) != null ? Math.round(num(v.bmr)!) : null, raw: v,
  };
  const r = await fetch(`${SB_URL}/rest/v1/well2go_body_comp?on_conflict=athlete,day`, {
    method: "POST",
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { athlete, image_url } = await req.json();
    if (!athlete || !image_url) return json({ error: "缺 athlete / image_url" }, 400);
    if (!String(image_url).startsWith(`${SB_URL}/storage/v1/object/public/well2go-meals/`))
      return json({ error: "image_url 必须是本项目 well2go-meals 桶的公开 URL" }, 400);
    const v = await extract(image_url);
    if (v.is_report !== true) return json({ ok: false, reason: v.note || "这张不像体测报告", verdict: v });
    const md = (typeof v.measure_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.measure_date))
      ? v.measure_date : new Date().toISOString().slice(0, 10);
    await save(athlete, md, v);
    return json({ ok: true, day: md, score: num(v.score), body_fat_pct: num(v.body_fat_pct),
      weight: num(v.weight), phase_angle: num(v.phase_angle), bmr: num(v.bmr), note: v.note || "" });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
