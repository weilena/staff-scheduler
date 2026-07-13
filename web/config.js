// ===== 雲端連線設定 =====
// 註冊 Supabase 後,到 Dashboard → Settings → API 複製這兩個值貼進來:
//   Project URL  → SUPABASE_URL
//   anon public  → SUPABASE_ANON_KEY(這把 key 是公開用的,放前端安全,權限由資料庫 RLS 控管)
window.CFG = {
  SUPABASE_URL: 'https://xrkdwdcsyzivkjankfsg.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_5F4vyMSDMFtJBVgShrLHwg_CwZFnu5T',
  // 建立 LINE Login / LIFF 後填入；這是公開識別碼，不是密碼。
  LINE_LIFF_ID: '2010690079-ysvO02nW',
  DEMO: false // 改 true(或網址加 ?demo=1)= 不連雲端,用瀏覽器暫存試玩介面
};
