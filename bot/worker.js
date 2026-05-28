// Seyir Tepesi — Telegram menü düzenleme botu (Cloudflare Worker)
// Akış: Telegram mesajı → Gemini ile yorumla → menu.json güncelle (önizleme + onay)
//       → onaylanınca GitHub'a commit → GitHub Pages otomatik yeniden yayınlar.
// Secret/ayarlar: wrangler.toml + `wrangler secret put ...` (bkz. README.md)

const GH_API = "https://api.github.com";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Seyir Tepesi menü botu çalışıyor ✅", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    // Telegram webhook gizli anahtar doğrulaması
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("x-telegram-bot-api-secret-token");
      if (got !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    }

    let update;
    try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

    // Telegram'a hızlı 200 dön; asıl işi arka planda yap
    ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error("handle error", err)));
    return new Response("ok");
  },
};

function allowed(env, userId) {
  const ids = (env.ALLOWED_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 && ids.includes(String(userId));
}

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message && update.message.text) return handleMessage(update.message, env);
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;
  const text = msg.text.trim();

  if (!allowed(env, userId)) {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "⛔️ Bu botu kullanma yetkin yok.\nSenin Telegram ID: " + userId + "\n(Yetki için bu numarayı site sahibine ilet.)",
    });
  }

  if (text === "/start" || text === "/yardim" || text === "/help") {
    return tg(env, "sendMessage", { chat_id: chatId, text: startText() });
  }
  if (text === "/menu" || text === "/liste") {
    try {
      const { json } = await ghGetMenu(env);
      return tg(env, "sendMessage", { chat_id: chatId, text: menuListText(json) });
    } catch (e) {
      return tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Menü okunamadı: " + e.message });
    }
  }

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  let cur;
  try { cur = await ghGetMenu(env); }
  catch (e) { return tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Menü dosyası okunamadı: " + e.message }); }

  let result;
  try { result = await askGemini(env, cur.json, text); }
  catch (e) { return tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Anlayamadım (yapay zekâ hatası): " + e.message + "\nBiraz farklı yazmayı dene." }); }

  if (!result || !result.menu || !Array.isArray(result.menu.categories)) {
    const q = (result && result.summary) || 'Bunu anlayamadım. Örnek: "Çay 30 lira oldu" ya da "Köfteyi bugünlük kaldır".';
    return tg(env, "sendMessage", { chat_id: chatId, text: "🤔 " + q });
  }

  const newContent = JSON.stringify(result.menu, null, 2) + "\n";
  await env.PENDING.put(
    "p:" + chatId,
    JSON.stringify({ sha: cur.sha, content: newContent, summary: result.summary || "" }),
    { expirationTtl: 3600 }
  );

  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: "📝 Önerilen değişiklik:\n\n" + (result.summary || "(özet yok)") + "\n\nUygulansın mı?",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Onayla", callback_data: "ok" },
        { text: "❌ Vazgeç", callback_data: "no" },
      ]],
    },
  });
}

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const userId = cq.from && cq.from.id;

  if (!allowed(env, userId)) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Yetki yok" });
  }

  const key = "p:" + chatId;
  const pendingRaw = await env.PENDING.get(key);
  if (!pendingRaw) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Süre doldu" });
    return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: "⌛️ Süre doldu. Lütfen değişikliği tekrar yaz." });
  }
  const pending = JSON.parse(pendingRaw);
  await env.PENDING.delete(key);

  if (cq.data === "no") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "İptal edildi" });
    return tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: "❌ Değişiklik iptal edildi." });
  }

  // cq.data === "ok"
  try {
    await ghPutMenu(env, pending.content, pending.sha, "menü: " + (pending.summary || "güncelleme") + " (Telegram bot)");
  } catch (e) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Hata" });
    return tg(env, "editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: "⚠️ Yayınlanamadı: " + e.message + "\n(Menü bu sırada başkası tarafından değişmiş olabilir; lütfen tekrar dene.)",
    });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Yayınlandı ✅" });
  return tg(env, "editMessageText", {
    chat_id: chatId, message_id: messageId,
    text: "✅ Yayınlandı!\n" + (pending.summary || "") + "\n\nSite ~1-2 dakika içinde güncellenir.",
  });
}

// ───────────────────────── Telegram ─────────────────────────
async function tg(env, method, body) {
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error("tg " + method + " failed", r.status, await r.text().catch(() => ""));
  return r;
}

// ───────────────────────── GitHub ─────────────────────────
function ghHeaders(env) {
  return {
    Authorization: "Bearer " + env.GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "seyir-menu-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
async function ghGetMenu(env) {
  const r = await fetch(GH_API + "/repos/" + env.GITHUB_REPO + "/contents/menu.json?ref=main", { headers: ghHeaders(env) });
  if (!r.ok) throw new Error("GitHub GET " + r.status);
  const data = await r.json();
  const json = JSON.parse(b64decodeUtf8(String(data.content).replace(/\n/g, "")));
  return { sha: data.sha, json };
}
async function ghPutMenu(env, contentStr, sha, message) {
  const r = await fetch(GH_API + "/repos/" + env.GITHUB_REPO + "/contents/menu.json", {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, content: b64encodeUtf8(contentStr), sha, branch: "main" }),
  });
  if (!r.ok) throw new Error("GitHub PUT " + r.status + " " + (await r.text().catch(() => "")));
  return r.json();
}

// ───────────────────────── Gemini (ücretsiz) ─────────────────────────
async function askGemini(env, currentMenu, instruction) {
  const model = env.GEMINI_MODEL || "gemini-1.5-flash-latest";
  const sys = [
    "Sen bir Türk kafesinin menü JSON dosyasını düzenleyen yardımcısın.",
    "Sana mevcut menü JSON'u (içinde categories dizisi) ve kullanıcının Türkçe isteği verilir.",
    "GÖREV: isteğe göre güncellenmiş TAM menü nesnesini üret.",
    "ÇIKTI: SADECE şu biçimde JSON döndür: {\"summary\": \"...\", \"menu\": {\"categories\": [...]}}",
    "- summary: ne değiştiğinin KISA Türkçe özeti (kullanıcı bunu görüp onaylayacak).",
    "- id alanlarını ASLA değiştirme; yeni ürün eklerken küçük-harf-tireli yeni bir id üret (örn. 'limonata').",
    "- Fiyatlar sayıdır (Türk Lirası). Pide gibi iki boyutlu ürünlerde price (tek) ve priceL (1.5) bulunur.",
    "- Bir ürünü gizlemek için ürüne \"available\": false ekle; geri getirmek için true yap ya da alanı kaldır. Kullanıcı açıkça istemedikçe ürünü SİLME.",
    "- note (açıklama) beş dilli olmalı: tr, en, de, ru, zh. Yeni/değişen açıklamada beşini de doldur (çevirerek).",
    "- allergens kodları: G gluten, L süt, Y yumurta, F fındık, S susam, K kafein.",
    "- İstek belirsizse menüyü AYNEN bırak ve summary alanına Türkçe bir açıklayıcı soru yaz.",
    "- Yalnızca istenen değişikliği yap; menünün geri kalanını olduğu gibi koru.",
  ].join("\n");

  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: "user", parts: [{ text: "MEVCUT MENÜ:\n" + JSON.stringify(currentMenu) + "\n\nİSTEK:\n" + instruction }] }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  };

  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + env.GEMINI_API_KEY,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("Gemini " + r.status + " " + (await r.text().catch(() => "")));
  const data = await r.json();
  let txt = ((((data.candidates || [])[0] || {}).content || {}).parts || [])[0];
  txt = txt && txt.text ? txt.text : "";
  txt = txt.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(txt);
}

// ───────────────────────── base64 (UTF-8 güvenli) ─────────────────────────
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ───────────────────────── metinler ─────────────────────────
function startText() {
  return [
    "👋 Seyir Tepesi menü botuna hoş geldin!",
    "",
    "Menüyü değiştirmek için normal Türkçe yaz. Örnekler:",
    '• "Çay 30 lira oldu"',
    '• "Pide 1.5 fiyatını 650 yap"',
    '• "Köfteyi bugünlük kaldır"  /  "Köfteyi geri ekle"',
    '• "İçeceklere Limonata 40 TL ekle"',
    "",
    "Her değişikliği önce sana göstereceğim; ✅ Onayla dersen yayınlanır.",
    "",
    "Komutlar:  /menu (mevcut liste)  ·  /yardim",
  ].join("\n");
}
function menuListText(mj) {
  const lines = ["📋 Güncel menü:"];
  for (const c of mj.categories || []) {
    lines.push("");
    lines.push("— " + ((c.name && c.name.tr) || c.id) + " —");
    for (const it of c.items || []) {
      const hidden = it.available === false ? "  (gizli)" : "";
      const price = it.priceL != null ? it.price + "/" + it.priceL + "₺" : (it.price != null ? it.price + "₺" : "—");
      lines.push("• " + it.name + " — " + price + hidden);
    }
  }
  return lines.join("\n");
}
