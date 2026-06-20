-- well2go coin game — full schema (run once on a fresh Supabase project)
-- Single-user-per-deploy model: each row is tagged with an `athlete` string.
-- Display tables are read by the frontend with the ANON key; privileged writes
-- (steps/calories/water/bodycomp) go through edge functions using the SERVICE ROLE key.

-- ─────────────────────────── tables ───────────────────────────

create table if not exists public.well2go_daily_steps (
  id                  uuid primary key default gen_random_uuid(),
  athlete             text not null default 'me',
  day                 date not null,
  steps_am            integer not null default 0,
  steps_pm            integer not null default 0,
  source              text not null default 'ios_shortcut',
  calories_am         numeric not null default 0,
  calories_pm         numeric not null default 0,
  calories_synced_at  timestamptz,
  water_ml            numeric not null default 0,
  basal_cal           numeric,
  strava_cal_am       numeric,
  strava_cal_pm       numeric,
  import_cal_am       integer,
  import_cal_pm       integer,
  flow_points         integer,
  flow_ai_points      integer,
  tok_io              numeric,
  tok_total           numeric,
  tok_cost            numeric,
  updated_at          timestamptz not null default now(),
  unique (athlete, day)
);

create table if not exists public.well2go_workouts (
  id                   uuid primary key default gen_random_uuid(),
  athlete              text,
  day                  date,
  user_id              uuid,
  source_id            uuid,
  provider             text not null default 'strava',
  external_id          text not null,
  upload_id            text,
  external_file_id     text,
  name                 text,
  sport_type           text,
  started_at           timestamptz,
  started_at_local_text text,
  duration_seconds     integer,
  moving_seconds       integer,
  distance_meters      numeric,
  calories_kcal        numeric,
  avg_heart_rate       numeric,
  max_heart_rate       numeric,
  avg_speed_mps        numeric,
  max_speed_mps        numeric,
  avg_watts            numeric,
  weighted_avg_watts   numeric,
  avg_cadence          numeric,
  device_name          text,
  trainer              boolean,
  manual               boolean,
  private              boolean,
  visibility           text,
  raw_json             jsonb not null default '{}',
  deleted_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, external_id)
);
create index if not exists well2go_workouts_athlete_day on public.well2go_workouts (athlete, day);
create index if not exists well2go_workouts_extid on public.well2go_workouts (external_id);

create table if not exists public.well2go_meals (
  id           uuid primary key default gen_random_uuid(),
  athlete      text not null,
  day          date not null,
  week_start   date not null,
  photo_path   text,
  photo_url    text,
  est_kcal     integer,
  health_score integer,
  dish         text,
  created_at   timestamptz default now()
);
create index if not exists well2go_meals_athlete on public.well2go_meals (athlete, week_start);

create table if not exists public.well2go_body_comp (
  id              uuid primary key default gen_random_uuid(),
  athlete         text not null,
  day             date not null,
  score           integer,
  body_fat_pct    numeric,
  weight          numeric,
  skeletal_muscle numeric,
  phase_angle     numeric,
  bmr             integer,
  raw             jsonb,
  created_at      timestamptz default now(),
  unique (athlete, day)
);

create table if not exists public.well2go_workout_sources (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  provider            text not null default 'strava',
  provider_athlete_id text not null,
  display_name        text,
  status              text not null default 'connected',
  scopes              text[] not null default '{}',
  last_synced_at      timestamptz,
  raw_json            jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.well2go_ingest_debug (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default now(),
  athlete      text,
  metric_names text[],
  detail       jsonb
);

-- ─────────────────────────── RLS ───────────────────────────
-- Personal single-user model: the frontend reads display tables with the anon key,
-- and inserts meal rows directly. Everything else is written by edge functions
-- (service role bypasses RLS). NOTE: anyone with the anon key + an athlete name can
-- read that athlete's rows — acceptable for a personal/small-circle deploy, NOT for
-- a public multi-tenant app.

alter table public.well2go_daily_steps     enable row level security;
alter table public.well2go_workouts        enable row level security;
alter table public.well2go_meals           enable row level security;
alter table public.well2go_body_comp       enable row level security;
alter table public.well2go_workout_sources enable row level security;
alter table public.well2go_ingest_debug    enable row level security;

-- read for the app
create policy "anon read steps"    on public.well2go_daily_steps for select to anon, authenticated using (true);
create policy "anon read workouts" on public.well2go_workouts    for select to anon, authenticated using (true);
create policy "anon read meals"    on public.well2go_meals       for select to anon, authenticated using (true);
create policy "anon read bodycomp" on public.well2go_body_comp   for select to anon, authenticated using (true);

-- the frontend inserts meal rows (photo) with the anon key before the vision fn fills them in
create policy "anon insert meals"  on public.well2go_meals       for insert to anon, authenticated with check (true);

-- ─────────────────────────── storage ───────────────────────────
-- public bucket for uploaded meal/water/technogym/bodycomp photos
insert into storage.buckets (id, name, public)
values ('well2go-meals', 'well2go-meals', true)
on conflict (id) do nothing;

create policy "anon upload well2go photos"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'well2go-meals');

create policy "public read well2go photos"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'well2go-meals');
