// ===== 雲端連線設定 =====
// 註冊 Supabase 後,到 Dashboard → Settings → API 複製這兩個值貼進來:
//   Project URL  → SUPABASE_URL
//   anon public  → SUPABASE_ANON_KEY(這把 key 是公開用的,放前端安全,權限由資料庫 RLS 控管)
window.CFG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
  DEMO: false // 改 true(或網址加 ?demo=1)= 不連雲端,用瀏覽器暫存試玩介面
};
