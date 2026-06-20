// well2go Technogym activity-calorie import — vision OCR
// Frontend uploads a Technogym/Mywellness workout screenshot → Qwen3-VL extracts "active burn kcal"
// → writes import_cal_am/pm (server side). Bypasses the broken Technogym→Strava / Apple-Health→HAE
// bridges by ingesting straight from the screenshot.
//
// SECRETS: OPENROUTER_API_KEY, plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
const OR_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VL_MODEL = Deno.env.get("VL_MODEL") ?? "qwen/qwen3-vl-235b-a22b-instruct";

const EXTRACT =
  "这是 Technogym / Mywellness App 的运动/活动截图。请提取这一天的「活动(运动)消耗卡路里」(kcal)——" +
  "只算运动多烧的那部分,不要基础代谢、不要全天总消耗。" +
  "若能看出运动发生在上午(00:00–12:00)还是下午,分别填 kcal_am / kcal_pm;看不出时段就把总数全填进 kcal_am(默认算上午)。" +
  '只输出 JSON,不要任何解释:{"ok":是否读到有效运动消耗true或false,"kcal_am":整数,"kcal_pm":整数,"kcal_total":整数,"note":"一句话说读到了什么"}';

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
      model: VL_MODEL, max_tokens: 350,
      messages: [{ role: "user", content: [
        { type: "text", text: EXTRACT },
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

async function writeCal(athlete: string, day: string, am: number, pm: number) {
  const r = await fetch(`${SB_URL}/rest/v1/well2go_daily_steps?on_conflict=athlete,day`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ athlete, day, import_cal_am: am, import_cal_pm: pm }),
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { athlete, image_url, day } = await req.json();
    if (!athlete || !image_url) return json({ error: "缺 athlete / image_url" }, 400);
    const d = day || new Date().toISOString().slice(0, 10);

    const v = await extract(image_url);
    if (v.ok !== true) return json({ ok: false, reason: v.note || "没读到有效运动消耗", verdict: v });

    let am = Math.max(0, Math.round(Number(v.kcal_am) || 0));
    let pm = Math.max(0, Math.round(Number(v.kcal_pm) || 0));
    const total = Math.max(0, Math.round(Number(v.kcal_total) || 0));
    if (am + pm === 0 && total > 0) am = total;       // only total given → default to am
    if (am + pm === 0) return json({ ok: false, reason: v.note || "消耗为 0", verdict: v });

    await writeCal(athlete, d, am, pm);
    return json({ ok: true, day: d, kcal_am: am, kcal_pm: pm, kcal_total: am + pm, note: v.note || "已导入" });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
