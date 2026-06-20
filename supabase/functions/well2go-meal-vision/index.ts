// well2go meal photo → calorie/health estimate (vision)
// After a diet-meal photo is uploaded: Qwen3-VL estimates {intake kcal + health score + dish}
// → patches the well2go_meals row (matched by photo_url).
// Note: calories are an estimate (portion/oil/sugar not fully visible) — directional, not exact.
//
// SECRETS: OPENROUTER_API_KEY, plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
const OR_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VL_MODEL = Deno.env.get("VL_MODEL") ?? "qwen/qwen3-vl-235b-a22b-instruct";

const PROMPT =
  "这是一张「节食餐」的食物照片。请估算这一餐的内容,只输出 JSON,不要解释:\n" +
  '{"is_food":是否是食物餐true或false,"dish":"菜名/内容(简短中文)","est_kcal":估算总热量整数kcal,' +
  '"health_score":健康度0-10整数(越清淡少油少糖少碳水越高),"note":"一句话点评(份量/油糖判断)"}\n' +
  "份量看不准就按常见单人份估;非食物(随便拍/网图)is_food=false。";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function estimate(imageUrl: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL, max_tokens: 350,
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

async function patchMeal(photoUrl: string, kcal: number, health: number, dish: string) {
  const r = await fetch(
    `${SB_URL}/rest/v1/well2go_meals?photo_url=eq.${encodeURIComponent(photoUrl)}`,
    { method: "PATCH",
      headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
        "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ est_kcal: kcal, health_score: health, dish }) });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { image_url } = await req.json();
    if (!image_url) return json({ error: "缺 image_url" }, 400);
    // 只处理本项目 well2go-meals 存储桶的公开 URL,防止该端点被当成开放 AI 接口刷 OpenRouter 额度
    if (!String(image_url).startsWith(`${SB_URL}/storage/v1/object/public/well2go-meals/`))
      return json({ error: "image_url 必须是本项目 well2go-meals 桶的公开 URL" }, 400);
    const v = await estimate(image_url);
    if (v.is_food !== true) return json({ ok: false, reason: v.note || "这张不像食物餐", verdict: v });
    const kcal = Math.max(0, Math.round(Number(v.est_kcal) || 0));
    const health = Math.max(0, Math.min(10, Math.round(Number(v.health_score) || 0)));
    const dish = String(v.dish || "").slice(0, 40);
    await patchMeal(image_url, kcal, health, dish);
    return json({ ok: true, dish, est_kcal: kcal, health_score: health, note: v.note || "" });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
