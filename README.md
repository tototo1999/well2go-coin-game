# well2go · 健康养成搞钱闯关游戏（开源自部署版）

把每天的**走路 / 运动消耗折算成游戏币**,做喝水、节食餐、体测等任务赚币的单人健康养成小游戏。
拍照打卡靠 AI 看图(识餐热量、判断真喝水、读运动消耗、抽体测指标)。

> **单人模式**:整个项目按「一人一份、各连各的 Supabase」设计。你 clone 下来,接上**自己的 Supabase**,
> 把 `athlete` 设成自己的名字,就是一份完全独立、数据只属于你的 App。想分享给朋友 → 让他也照这份 README 各自部署一份。

---

## 这套东西有哪些零件

| 层 | 内容 |
|---|---|
| **前端** | `app/index.html` 一个单文件页面,配置抽在 `app/config.js` |
| **数据库** | 6 张表(`supabase/migrations/001_init.sql` 一键建好) |
| **存储** | `well2go-meals` 公开桶(存打卡照片) |
| **Edge 函数(6个)** | 步数 ingest、Strava 同步、4 个 AI 识图 |

数据流:手机步数/运动 → ingest 函数 / Strava 同步 → Supabase → 前端读数算币。拍照打卡 → 上传存储桶 → AI 识图函数判定 → 写回。

---

## 你需要准备

1. **Supabase 账号**(免费档够用)— https://supabase.com
2. **Supabase CLI** — `npm i -g supabase`(或 `brew install supabase/tap/supabase`)
3. **OpenRouter API key**(给 4 个 AI 识图函数用)— https://openrouter.ai/keys　*不配的话,只有步数钱包能用,识图按钮全废*
4. *(可选)* **Strava 开发者应用**(要自动同步运动记录才需要)— https://www.strava.com/settings/api
5. *(可选)* **苹果开发者账号**(把 App 装手机 / 上 TestFlight 才需要)

---

## 部署步骤

### 1. 建 Supabase 项目并建表

在 https://supabase.com 新建一个项目。然后用 CLI 关联并跑迁移:

```bash
supabase login
supabase link --project-ref <你的项目ref>
supabase db push           # 执行 supabase/migrations/001_init.sql
```

> 没装 CLI 也行:把 `supabase/migrations/001_init.sql` 全文复制到 Supabase 后台 **SQL Editor** 里执行一次。

### 2. 设置 Edge 函数密钥

照 `.env.example` 把密钥设上(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 是 Supabase 自带的,不用设):

```bash
supabase secrets set INGEST_TOKEN=随便一串随机字符
supabase secrets set INGEST_DEFAULT_ATHLETE=你的名字   # 例如 mike,跟 config.js 的 athlete 一致
supabase secrets set OPENROUTER_API_KEY=sk-or-...
# 可选(要 Strava 才设):
supabase secrets set STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=... STRAVA_ATHLETE=你的名字
```

### 3. 部署 Edge 函数

```bash
supabase functions deploy well2go-steps-ingest --no-verify-jwt
supabase functions deploy well2go-meal-vision --no-verify-jwt
supabase functions deploy well2go-water-checkin --no-verify-jwt
supabase functions deploy well2go-technogym-import --no-verify-jwt
supabase functions deploy well2go-bodycomp-import --no-verify-jwt
supabase functions deploy well2go-strava-sync --no-verify-jwt   # 可选
```

### 4. 配置前端

```bash
cp app/config.example.js app/config.js
```
编辑 `app/config.js`,填你的 Supabase `url` / `anon`(后台 → Project Settings → API)和 `athlete`(跟上面一致)。

本地预览:
```bash
cd app && python3 -m http.server 8080      # 打开 http://localhost:8080
```
部署到网上:把 `app/` 目录传到任意静态托管(GitHub Pages / Cloudflare Pages / Vercel)即可。

### 5. 接数据来源(让钱包有数)

光建好库是空的,得把你的活动数据喂进去:

- **步数 / 活动消耗 / 喝水(必需)**:用 iOS App **Health Auto Export** 或一个**快捷指令**,定时把苹果健康数据 POST 到:
  ```
  https://<你的项目ref>.supabase.co/functions/v1/well2go-steps-ingest?token=<你的INGEST_TOKEN>&athlete=<你的名字>
  ```
  详见 `shortcuts/README.md`(含 body 格式说明,支持 HAE 格式和直接 `{steps_am,steps_pm,...}` 格式)。
- **运动记录(可选)**:配好 Strava 密钥后,在 Supabase 里加个 pg_cron 定时调用 `well2go-strava-sync`(或手动调一次试):
  ```
  curl "https://<ref>.supabase.co/functions/v1/well2go-strava-sync?days=7"
  ```
- **运动消耗 / 体测**:也可以在 App 里直接拍 Technogym/InBody 截图上传,AI 自动读数入库,不依赖上面两条。

### 6.(可选)打包成 iPhone App

页面是纯静态的,用 [Capacitor](https://capacitorjs.com) 套个壳就能上 iOS。简版步骤:
```bash
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap init well2go ai.你的域名.app --web-dir app
npx cap add ios
npx cap copy ios
# 用你自己的苹果开发者账号在 Xcode 里签名运行,或命令行 xcodebuild archive 上 TestFlight
```

---

## 赚币规则(初始版)

| | |
|---|---|
| 赚币 | 1 步 = 15 币;1 大卡 = 15 币 |
| 基础 | 每天前 4000 步不计入,超出才给币 |
| 上午加成 | 00:00–12:00 的步数+燃脂币 ×2 |
| 卡路里去重 | Strava / Technogym / Apple 三源按上午下午各取最大值(不漏算也不重复加) |
| 喝水任务 | 拍照打卡满 1500ml → +500 币 |
| 节食餐 | 每周传 8 份餐照,每份 1000 币 |
| 提现 | 100 币 = 1 元(这是激励显示,**不真发钱**) |

规则常量都在 `app/index.html` 顶部(`RATE` / `BASE` / `MULT` 等),想改自己改。

---

## 安全说明(重要)

这是**个人单人模型**:前端用 anon key 读数据,RLS 已开但策略是「允许 anon 读」。
也就是说,**任何拿到你 anon key 的人,把 athlete 换成你的名字就能看你的数据**。
自己/小圈子用没问题;**别拿这套直接对陌生人公开**——那需要改成「登录 + 每人只能看自己」的多用户鉴权模型。

防作弊的部分(喝水 +500、体测、运动消耗写入)都走 service role 服务端校验,前端伪造不了。

---

## 目录结构

```
well2go-coin-game/
├─ app/
│  ├─ index.html            前端页面
│  ├─ config.example.js     复制成 config.js 填你自己的
├─ supabase/
│  ├─ migrations/001_init.sql   建表 + 存储桶 + RLS
│  └─ functions/            6 个 edge function
├─ shortcuts/               iOS 数据上报说明
├─ .env.example             edge 函数密钥清单
└─ README.md
```
