# well2go · 健康养成搞钱闯关游戏(开源自部署版)

把每天的**走路 / 运动消耗折算成游戏币**,再靠喝水、节食餐、体测等任务赚币的单人健康养成小游戏。拍照打卡用 AI 看图判定(识餐热量、判断真喝水、读运动消耗、抽体测指标)。

> **单人模式**:一人一份、各连各的 Supabase。clone 下来接上**自己的** Supabase、把 `athlete` 设成自己名字,就是一份数据只属于你的 App。想分享给朋友 → 让他照样各自部署一份。

## 零件

| 层 | 内容 |
|---|---|
| 前端 | `app/index.html` 单文件,配置抽在 `app/config.js` |
| 数据库 | 6 张表,`supabase/migrations/001_init.sql` 一键建好 |
| 存储 | `well2go-meals` 公开桶,存打卡照片 |
| Edge 函数 | 6 个:步数 ingest、Strava 同步、4 个 AI 识图 |

数据流:手机步数/运动 → ingest / Strava 同步 → Supabase → 前端读数算币;拍照 → 上传桶 → AI 识图判定 → 写回。

## 快速开始

```bash
# 1. 建表(先在 supabase.com 新建项目)
supabase login && supabase link --project-ref <你的ref>
supabase db push

# 2. 设密钥
supabase secrets set INGEST_TOKEN=随机串 INGEST_DEFAULT_ATHLETE=你的名字 OPENROUTER_API_KEY=sk-or-...

# 3. 部署 6 个 edge 函数
for f in well2go-steps-ingest well2go-meal-vision well2go-water-checkin \
         well2go-technogym-import well2go-bodycomp-import well2go-strava-sync; do
  supabase functions deploy $f --no-verify-jwt
done

# 4. 配前端(必须,否则页面读不到数据)
cp app/config.example.js app/config.js   # 填 url / anon / athlete(全小写)
cd app && python3 -m http.server 8080     # 预览 http://localhost:8080
```

接数据源:用 iOS **Health Auto Export** 或快捷指令定时把苹果健康数据 POST 到 `…/functions/v1/well2go-steps-ingest`(详见 `shortcuts/README.md`);运动记录可选配 Strava。

> 📖 **完整部署步骤、密钥清单、Strava 定时同步、打包成 iPhone App、赚币规则**:见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## ⚠️ 安全

个人单人模型:前端用 anon key 读,RLS 策略是「允许 anon 读」。**拿到你 anon key 的人换上你的 athlete 就能看你数据**——自己/小圈子用没问题,**别直接对陌生人公开**(那需要改成「登录 + 每人只看自己」的多用户鉴权)。详见 [docs/DEPLOY.md](docs/DEPLOY.md#安全说明重要)。

## 目录

```
app/        前端(index.html + config.example.js)
supabase/   migrations/001_init.sql + 6 个 edge function
shortcuts/  iOS 数据上报说明
docs/       DEPLOY.md 完整部署指南
.env.example
```
