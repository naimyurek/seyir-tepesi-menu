# Seyir Tepesi — Telegram Menü Botu

Amcalar/aile, **Telegram'a normal Türkçe yazarak** menüyü güncelleyebilsin diye yapılmış küçük bir bot.
Hepsi **ücretsiz** katmanlarla çalışır: Telegram + Cloudflare Workers + Google Gemini + GitHub.

## Nasıl çalışır?
1. Kişi bota yazar: *"Çay 30 lira oldu"*.
2. Bot, isteği yapay zekâ ile yorumlar ve **önizleme + ✅ Onayla / ❌ Vazgeç** gönderir.
3. Onaylanınca `menu.json` GitHub'a kaydedilir → **GitHub Pages** siteyi ~1–2 dk içinde günceller.

> Güvenlik: Yalnızca `ALLOWED_IDS` listesindeki Telegram hesapları kullanabilir. Her değişiklik
> önce onaylanır ve GitHub geçmişinden tek tıkla geri alınabilir. Gizli anahtarlar Cloudflare'de
> saklanır, bu repoda **yer almaz**.

---

## Kurulum (tek seferlik, ~20 dk)

Gereksinim: bilgisayarında **Node.js** kurulu olsun.

### 1) Telegram botu + kullanıcı ID'leri
- Telegram'da **@BotFather** → `/newbot` → bir isim ver → sana bir **token** verir (`TELEGRAM_TOKEN`).
- Botu kullanacak herkes **@userinfobot**'a yazsın; verdiği **sayısal Id**'leri not al (`ALLOWED_IDS`).

### 2) Gemini API anahtarı (ücretsiz)
- https://aistudio.google.com/app/apikey → **Create API key** → `GEMINI_API_KEY`.

### 3) GitHub erişim anahtarı (sadece bu repoya)
- GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
  - Repository access: **Only select repositories** → `seyir-tepesi-menu`
  - Permissions → Repository → **Contents: Read and write**
  - Oluştur → `GITHUB_TOKEN`.

### 4) Cloudflare + dağıtım
```bash
cd bot
npm install -g wrangler        # ya da her komutta: npx wrangler ...
wrangler login                 # tarayıcıda ücretsiz Cloudflare hesabıyla giriş

# Onay-bekleyen deposu (KV) oluştur, çıkan id'yi wrangler.toml'daki BURAYA_KV_ID_YAZ ile değiştir:
wrangler kv namespace create PENDING

# wrangler.toml'u aç: GITHUB_REPO ve ALLOWED_IDS değerlerini doldur.

# Gizli anahtarları ekle (her komut seni değeri yapıştırmaya yönlendirir):
wrangler secret put TELEGRAM_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put WEBHOOK_SECRET   # rastgele bir kelime uydur (örn. seyir-2026-gizli)

# Yayına al:
wrangler deploy
```
`wrangler deploy` sana bir adres verir: `https://seyir-menu-bot.<hesabın>.workers.dev`

### 5) Telegram webhook'unu bağla
Aşağıda `<TELEGRAM_TOKEN>`, `<WORKER_URL>` ve `<WEBHOOK_SECRET>` yerlerini doldur:
```bash
curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook" \
  -d "url=<WORKER_URL>/" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

### 6) Test
Bota `/start` yaz → karşılama gelir. Sonra `"Çay 30 lira oldu"` yaz → önizleme + **Onayla**.

---

## Kullanım örnekleri
- `Çay 30 lira oldu`
- `Pide 1.5 fiyatını 650 yap`
- `Köfteyi bugünlük kaldır` / `Köfteyi geri ekle`
- `İçeceklere Limonata 40 TL ekle`
- `/menu` → mevcut listeyi gösterir · `/yardim` → yardım

## Sorun giderme
- Canlı log: `wrangler tail`
- Webhook durumu: `curl "https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo"`
- "Yetki yok" yazısı: kişinin Telegram ID'sini `ALLOWED_IDS`'e ekleyip `wrangler deploy` çalıştır.
- Değişiklik sitede görünmüyor: GitHub Pages derlemesi + CDN önbelleği birkaç dakika sürebilir; sayfayı sert yenile.

## Maliyet
Tipik bir kafe için **pratikte 0 ₺** — Telegram bedava, Cloudflare Workers/KV ücretsiz katman,
Gemini ücretsiz kota, GitHub Pages ücretsiz.
