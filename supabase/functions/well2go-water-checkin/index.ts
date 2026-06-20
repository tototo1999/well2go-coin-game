// well2go water check-in (vision ingest)
// Frontend uploads a cup photo (public URL) → Qwen3-VL judges "really drinking water"
// → if pass, server adds water_ml += 500 (capped at 1500). Written via service role so the
// frontend can't fake it = core anti-cheat.
//
// SECRETS: OPENROUTER_API_KEY, plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
const OR_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VL_MODEL = Deno.env.get("VL_MODEL") ?? "qwen/qwen3-vl-235b-a22b-instruct";
const GOAL = 1500;      // daily water goal ml (matches frontend WATER_GOAL)
const REWARD_ML = 500;  // one valid check-in = +500ml

const JUDGE =
  "你是健身养成游戏的喝水打卡审核。看用户上传照片，判断能否算「喝了一杯水」的有效打卡。" +
  "只输出 JSON，不要解释:\n" +
  '{"is_water":真水/水杯true或false,"est_fill_pct":水位百分比0-100整数,' +
  '"est_ml":粗估毫升按常见杯~300ml整数,"pass":是否有效喝水打卡true或false,"reason":"一句话理由"}\n' +
  "诱饵(咖啡/含糖饮料/酒/空杯/空瓶/水龙头流水/无关照片)应 pass=false。";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function judge(imageUrl: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: JUDGE },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error(`vision ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const data = await r.json();
  const txt: string = data?.choices?.[0]?.message?.content ?? "";
  const s = txt.replace(/```(json)?/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("vision 未返回 JSON");
  return JSON.parse(s.slice(i, j + 1));
}

async function getWater(athlete: string, day: string): Promise<number> {
  const r = await fetch(
    `${SB_URL}/rest/v1/well2go_daily_steps?athlete=eq.${encodeURIComponent(athlete)}&day=eq.${day}&select=water_ml`,
    { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } },
  );
  const rows = await r.json();
  return rows?.[0]?.water_ml ? Number(rows[0].water_ml) : 0;
}

async function setWater(athlete: string, day: string, ml: number) {
  const r = await fetch(`${SB_URL}/rest/v1/well2go_daily_steps?on_conflict=athlete,day`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ athlete, day, water_ml: ml }),
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { athlete, image_url, day } = await req.json();
    if (!athlete || !image_url) return json({ error: "缺 athlete / image_url" }, 400);
    if (!String(image_url).startsWith(`${SB_URL}/storage/v1/object/public/well2go-meals/`))
      return json({ error: "image_url 必须是本项目 well2go-meals 桶的公开 URL" }, 400);
    const d = (day || new Date().toISOString().slice(0, 10));

    const v = await judge(image_url);
    const ok = v.pass === true && v.is_water === true;
    if (!ok) {
      return json({ pass: false, reason: v.reason || "未通过审核", verdict: v });
    }
    const before = await getWater(athlete, d);
    if (before >= GOAL) {
      return json({ pass: true, capped: true, water_ml: before, goal: GOAL,
                    reason: "今日已达标，无需再打卡", verdict: v });
    }
    const after = Math.min(GOAL, before + REWARD_ML);
    await setWater(athlete, d, after);
    return json({
      pass: true, reward_ml: after - before, water_ml: after, goal: GOAL,
      reached: after >= GOAL, est_ml: v.est_ml, reason: v.reason || "有效打卡", verdict: v,
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
