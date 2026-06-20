// Copy this file to `config.js` and fill in YOUR OWN Supabase project values.
// config.js is git-ignored — never commit your real keys.
window.WELL2GO_CONFIG = {
  // From Supabase dashboard → Project Settings → API
  url:  'https://YOUR-PROJECT-REF.supabase.co',
  anon: 'YOUR_SUPABASE_ANON_KEY',

  // Your athlete tag. Use LOWERCASE (the edge functions store it lowercase).
  // Must match INGEST_DEFAULT_ATHLETE / STRAVA_ATHLETE in your edge secrets.
  athlete: 'me',

  // App title shown in the tab/header/footer. Make it your own.
  brand: '健康养成搞钱闯关游戏',

  // First day the game counts toward coins (data before this is shown but not scored).
  gameStart: '2026-06-04',
};
