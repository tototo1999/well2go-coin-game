# 把手机数据喂进库（步数 / 活动消耗 / 喝水）

钱包的数字来自 `well2go_daily_steps` 表,要靠你每天把苹果健康数据 POST 到 `well2go-steps-ingest` 函数。

**接口:**
```
POST https://<你的项目ref>.supabase.co/functions/v1/well2go-steps-ingest?token=<INGEST_TOKEN>&athlete=<你的名字>
Content-Type: application/json
```
`token` 必须等于你设的 `INGEST_TOKEN`,否则 401。`athlete` 也可以放在 body 里。

函数收两种 body 格式,任选其一:

## 方式 A：Health Auto Export（最省事，推荐）

App Store 装 **Health Auto Export – JSON+CSV**,新建一个 **Automation**:
- 选指标:Step Count、Active Energy、(可选)Resting Energy、Dietary Water
- 导出格式:**JSON (HAE)**
- 目的地:**REST API**,URL 填上面的接口地址,方法 POST
- 频率:每天(或每小时)

它会发这种结构,函数自动按上午/下午分桶、按天求和、单位自动换算(kJ→kcal、L→mL):
```json
{ "data": { "metrics": [
  { "name": "step_count", "units": "count", "data": [ { "date": "2026-06-19 08:30:00 +0800", "qty": 1200 } ] },
  { "name": "active_energy", "units": "kcal", "data": [ { "date": "2026-06-19 18:00:00 +0800", "qty": 210 } ] },
  { "name": "dietary_water", "units": "mL", "data": [ { "date": "2026-06-19 12:00:00 +0800", "qty": 500 } ] }
] } }
```

## 方式 B：快捷指令直填（简单粗暴）

用 iOS「快捷指令」取健康数据,直接发汇总值:
```json
{
  "day": "2026-06-19",
  "steps_am": 2000, "steps_pm": 5000,
  "calories_am": 0, "calories_pm": 300,
  "water_ml": 1000,
  "basal_cal": 1500
}
```
缺哪个字段就不更新哪个(只发步数也行)。`day` 不填默认今天。

## 验证

发一次后,去 Supabase 后台看 `well2go_daily_steps` 有没有你这天的行;或看 `well2go_ingest_debug` 表里的解析详情。前端刷新就能看到币。
