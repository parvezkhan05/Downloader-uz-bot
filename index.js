import express from "express";
import youtubedl from "youtube-dl-exec";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "1mb" }));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 49 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 2;
const MAX_PARALLEL_SEARCHES = 3;
const SEARCH_CACHE_MS = 10 * 60 * 1000; // bir xil so‘rov 10 daqiqa keshda turadi
const SEARCH_SESSION_MS = 30 * 60 * 1000; // "keyingi sahifa" tugmalari 30 daqiqa ishlaydi
const SEARCH_COOLDOWN_MS = 3000; // bitta foydalanuvchi uchun qidiruvlar orasidagi tanaffus
const SEARCH_PAGE_SIZE = 9;
const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES?.trim();
let activeDownloads = 0;
let activeSearches = 0;
let welcomePng;
const searchCache = new Map(); // tozalangan so‘rov -> { time, entries }
const searchSessions = new Map(); // sessionId -> { time, query, entries }
const lastSearchAt = new Map(); // chatId -> oxirgi qidiruv vaqti
const TELEGRAM_API = "https://api.telegram.org/bot" + TOKEN;
const ALLOWED_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com", "instagram.com", "instagr.am", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "facebook.com", "fb.watch", "fb.com", "t.me", "telegram.me", "telesco.pe"];

async function telegram(method, payload) {
  const response = await fetch(TELEGRAM_API + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram API so‘rovi bajarilmadi");
  return result.result;
}

async function sendText(chatId, text, options = {}) {
  return telegram("sendMessage", { chat_id: chatId, text, ...options });
}

function welcomeSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07172d"/><stop offset="1" stop-color="#151042"/></linearGradient><linearGradient id="accent"><stop stop-color="#36e0c2"/><stop offset="1" stop-color="#7584ff"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="34"/></filter></defs>',
    '<rect width="1200" height="630" rx="42" fill="url(#bg)"/><circle cx="1010" cy="155" r="175" fill="#5666ff" opacity=".28" filter="url(#glow)"/><circle cx="885" cy="520" r="145" fill="#29c7ae" opacity=".2" filter="url(#glow)"/>',
    '<path d="M700 0h500v630H860c100-120 130-310-160-630Z" fill="#fff" opacity=".025"/>',
    '<text x="84" y="108" fill="#71ead8" font-family="Arial,sans-serif" font-size="24" font-weight="700" letter-spacing="5">VIDEO YUKLASH BOTI</text>',
    '<text x="78" y="230" fill="#fff" font-family="Arial,sans-serif" font-size="76" font-weight="800">Downloader UZ</text>',
    '<text x="84" y="289" fill="#b8c8df" font-family="Arial,sans-serif" font-size="31">Havolani yuboring. Videoni oling.</text>',
    '<rect x="820" y="112" width="284" height="284" rx="72" fill="#202b52" stroke="#fff" stroke-opacity=".18" stroke-width="2"/><circle cx="962" cy="236" r="78" fill="url(#accent)"/><path d="M948 194v82l67-41-67-41Z" fill="#07172d"/><path d="M962 311v48m-26-24 26 26 26-26" fill="none" stroke="#e7fbff" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>',
    '<g font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#fff"><rect x="84" y="374" width="167" height="55" rx="27" fill="#fff" fill-opacity=".1"/><text x="112" y="410">YouTube</text><rect x="266" y="374" width="176" height="55" rx="27" fill="#fff" fill-opacity=".1"/><text x="294" y="410">Instagram</text><rect x="457" y="374" width="145" height="55" rx="27" fill="#fff" fill-opacity=".1"/><text x="486" y="410">TikTok</text><rect x="84" y="444" width="163" height="55" rx="27" fill="#fff" fill-opacity=".1"/><text x="112" y="480">Facebook</text><rect x="262" y="444" width="157" height="55" rx="27" fill="#fff" fill-opacity=".1"/><text x="292" y="480">Telegram</text></g>',
    '<text x="84" y="570" fill="#8ea2bd" font-family="Arial,sans-serif" font-size="20">/start bosing va havolani yuboring</text></svg>'
  ].join("");
}

async function sendWelcomePhoto(chatId) {
  try {
    welcomePng ||= await sharp(Buffer.from(welcomeSvg())).png().toBuffer();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", "🎬 Video havolasini yoki qo‘shiq nomi/ijrochini yuboring. Musiqa qidirish: /music yoki /song");
    form.set("reply_markup", JSON.stringify({ keyboard: [[{ text: "🎵 Musiqa qidirish" }]], resize_keyboard: true, is_persistent: true }));
    form.set("photo", new Blob([welcomePng], { type: "image/png" }), "downloader-uz.png");
    const response = await fetch(TELEGRAM_API + "/sendPhoto", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || "Rasm yuborilmadi");
  } catch (error) {
    console.error("Welcome image failed:", error.message);
    await sendText(chatId, "🎬 Salom! YouTube, Instagram, TikTok, Facebook yoki Telegram video havolasini yuboring.");
  }
}

function isAllowedVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
  } catch { return false; }
}

function isNetscapeCookieFile(contents) {
  const normalized = contents.replace(/^\uFEFF/, "").trimStart();
  return /^(# Netscape HTTP Cookie File|# HTTP Cookie File)\b/.test(normalized);
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  return match ? match[0].replace(/[),.!?]+$/, "") : null;
}

async function returnTelegramMedia(chatId, media, method, label) {
  if (media.file_size && media.file_size > MAX_FILE_BYTES) {
    await sendText(chatId, "Telegram fayli 49 MB dan katta. Kichikroq video yuboring.");
    return;
  }
  await telegram(method, { chat_id: chatId, [label]: media.file_id, caption: "Video tayyor." });
}

async function downloadAndSend(chatId, url) {
  if (activeDownloads >= MAX_PARALLEL_DOWNLOADS) {
    await sendText(chatId, "Hozir boshqa videolar yuklanmoqda. Birozdan keyin qayta yuboring.");
    return;
  }
  activeDownloads += 1;
  const workDir = await mkdtemp(path.join(tmpdir(), "downloader-uz-"));
  let actionTimer;
  try {
    await sendText(chatId, "🎞 Video tayyorlanyapti...");
    const showAnimation = () => telegram("sendChatAction", { chat_id: chatId, action: "upload_video" }).catch(() => {});
    await showAnimation();
    actionTimer = setInterval(showAnimation, 4000);
    const host = new URL(url).hostname.toLowerCase();
    const isYouTube = host === "youtu.be" || host.endsWith("youtube.com") || host === "youtube-nocookie.com";
    const cookiesPath = await writeYouTubeCookies(workDir, isYouTube);
    const downloadOptions = {
      output: path.join(workDir, "video.%(ext)s"),
      format: isYouTube ? "best[height<=720]/best" : "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      remoteComponents: "ejs:github",
      ...(cookiesPath ? { cookies: cookiesPath } : {}),
      retries: 2,
      socketTimeout: 30,
      ...(ffmpegStatic ? { ffmpegLocation: ffmpegStatic } : {})
    };
    const { cookies: _cookiesForLoggedInRequest, ...anonymousDownloadOptions } = downloadOptions;
    try {
      await youtubedl.exec(url, downloadOptions, { timeout: 180000 });
    } catch (error) {
      const firstError = String(error.stderr || error.message || "").toLowerCase();
      const noFormats = /requested format.*not available|format not available|no video formats found/.test(firstError);
      if (!isYouTube || !noFormats) throw error;

      let lastError = error;
      const fallbacks = [
        { client: "web_safari (without cookies)", extractorArgs: "youtube:player-client=web_safari", options: anonymousDownloadOptions },
        { client: "default (without cookies)", extractorArgs: "youtube:player-client=default", options: anonymousDownloadOptions },
        { client: "android (without cookies)", extractorArgs: "youtube:player-client=android", options: anonymousDownloadOptions },
        { client: "ios (without cookies)", extractorArgs: "youtube:player-client=ios", options: anonymousDownloadOptions },
        { client: "web_embedded (with cookies)", extractorArgs: "youtube:player-client=web_embedded", options: downloadOptions }
      ];
      for (const fallback of fallbacks) {
        try {
          console.log("Retrying YouTube with client:", fallback.client);
          await youtubedl.exec(url, {
            ...fallback.options,
            format: "best",
            extractorArgs: fallback.extractorArgs
          }, { timeout: 180000 });
          lastError = null;
          break;
        } catch (retryError) {
          lastError = retryError;
          const retryOutput = String(retryError.stderr || retryError.message || "").toLowerCase();
          if (!/requested format.*not available|format not available|no video formats found/.test(retryOutput)) throw retryError;
        }
      }
      if (lastError) throw lastError;
    }

    const files = (await readdir(workDir)).filter((name) => name.startsWith("video."));
    if (!files.length) throw new Error("Yuklangan video topilmadi");
    const filePath = path.join(workDir, files[0]);
    const fileInfo = await stat(filePath);
    if (fileInfo.size > MAX_FILE_BYTES) {
      await sendText(chatId, "Video Telegram yuborish chegarasidan katta (49 MB). Qisqaroq havolani yuboring.");
      return;
    }

    const isMp4 = path.extname(files[0]).toLowerCase() === ".mp4";
    const field = isMp4 ? "video" : "document";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (isMp4) form.set("supports_streaming", "true");
    form.set(field, new Blob([await readFile(filePath)], { type: isMp4 ? "video/mp4" : "application/octet-stream" }), files[0]);
    const response = await fetch(TELEGRAM_API + (isMp4 ? "/sendVideo" : "/sendDocument"), { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || "Telegram videoni yubora olmadi");
  } catch (error) {
    const output = String(error.stderr || error.message || "").toLowerCase();
    let failureCode = "unknown";
    let failureMessage = "Videoni yuklab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.";
    if (/does not look like a netscape|invalid length|cookie file/.test(output)) {
      failureCode = "cookie_format";
      failureMessage = "YouTube cookie fayli yaroqsiz. Render’dagi YOUTUBE_COOKIES qiymatiga cookies.txt ichidagi to‘liq matnni qo‘ying.";
    } else if (/sign in to confirm|confirm.*not a bot|not a bot|login required/.test(output)) {
      failureCode = "youtube_auth";
      failureMessage = "YouTube botdan kirishni tasdiqlashni so‘radi. YouTube’dan cookie’ni qayta eksport qilib Render’ga yangilang.";
    } else if (/http error 403|403 forbidden|forbidden/.test(output)) {
      failureCode = "youtube_403";
      failureMessage = "YouTube bu serverdan yuklashni rad etdi (403). Keyinroq qayta urinib ko‘ring.";
    } else if (/http error 429|too many requests/.test(output)) {
      failureCode = "youtube_rate_limit";
      failureMessage = "YouTube so‘rovlarni vaqtincha chekladi. Biroz kutib, qayta urinib ko‘ring.";
    } else if (/requested format.*not available|format not available/.test(output)) {
      failureCode = "format_unavailable";
      failureMessage = "Bu Shorts uchun mos video formati topilmadi.";
    } else if (/private video|video unavailable|members.only|age.restricted|not available in your country/.test(output)) {
      failureCode = "video_unavailable";
      failureMessage = "Bu video bot uchun ochiq emas yoki hudud/akkaunt cheklovi bor.";
    }
    console.error("Video download failed; code:", failureCode);
    await sendText(chatId, failureMessage);

  } finally {
    clearInterval(actionTimer);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeDownloads -= 1;
  }
}

async function writeYouTubeCookies(workDir, isYouTube = true) {
  if (!YOUTUBE_COOKIES || !isYouTube) return undefined;
  if (!isNetscapeCookieFile(YOUTUBE_COOKIES)) {
    throw new Error("YOUTUBE_COOKIES must contain the full Netscape-format cookie file.");
  }
  const cookiesPath = path.join(workDir, "youtube-cookies.txt");
  await writeFile(cookiesPath, YOUTUBE_COOKIES + "\n", { mode: 0o600 });
  return cookiesPath;
}

function musicSearchOptions(cookiesPath) {
  return {
    dumpSingleJson: true,
    flatPlaylist: true,
    skipDownload: true,
    noWarnings: true,
    noProgress: true,
    remoteComponents: "ejs:github",
    ...(cookiesPath ? { cookies: cookiesPath } : {})
  };
}

function musicQueryFromMessage(text) {
  const value = (text || "").trim();
  if (!value) return null;
  if (value === "🎵 Musiqa qidirish") return "";
  const command = value.match(/^\/(?:music|song)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command) return (command[1] || "").trim();
  if (value.startsWith("/") || extractUrl(value)) return null;
  return value;
}

// ======================= MUSIQA QIDIRISH (yaxshilangan qism) =======================

// Qidiruvga foyda keltirmaydigan so‘zlar ("official", "lyrics", "skachat" va h.k.)
const NOISE_WORDS = new Set(["official", "video", "lyrics", "audio", "hd", "4k", "mp3", "скачать", "skachat", "yuklab", "olish"]);

// Sarlavhada bo‘lsa, natijani pastga tushiradigan so‘zlar (agar foydalanuvchi o‘zi so‘ramagan bo‘lsa)
const PENALTY_WORDS = ["karaoke", "reaction", "slowed", "nightcore", "sped up", "8d", "remix", "cover", "live", "concert", "instrumental", "minus", "shorts", "full album", "mix", "playlist", "compilation"];

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function cleanMusicQuery(query) {
  const words = query
    .replace(/[(\[][^)\]]*[)\]]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !NOISE_WORDS.has(word.toLowerCase()));
  return words.join(" ").trim() || query.trim();
}

function scoreMusicEntry(entry, rawQuery, queryWords) {
  const title = String(entry.title || "").toLowerCase();
  const channel = String(entry.channel || entry.uploader || "").toLowerCase();
  const query = rawQuery.toLowerCase();
  let score = 0;

  const duration = Number(entry.duration);
  if (Number.isFinite(duration) && duration > 0) {
    if (duration < 60) score -= 40; // Shorts yoki parcha
    else if (duration <= 480) score += 15; // oddiy qo‘shiq uzunligi
    else if (duration > 900) score -= 35; // mix, konsert, podkast
    else score -= 10;
  }

  if (channel.endsWith("- topic")) score += 30; // YouTube’ning avtomatik "Artist - Topic" kanallari: toza audio
  if (/official (audio|music video|video)|rasmiy/.test(title)) score += 10;
  for (const word of PENALTY_WORDS) {
    if (title.includes(word) && !query.includes(word)) score -= 25;
  }

  const haystack = title + " " + channel;
  const hits = queryWords.filter((word) => haystack.includes(word)).length;
  if (queryWords.length) score += Math.round((hits / queryWords.length) * 40);

  const views = Number(entry.view_count);
  if (Number.isFinite(views) && views > 0) score += Math.min(15, Math.log10(views) * 2);
  return score;
}

function rankMusicEntries(entries, rawQuery, searchTerm) {
  const queryWords = searchTerm.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = String(entry.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((entry, index) => ({ entry, score: scoreMusicEntry(entry, rawQuery, queryWords) + (unique.length - index) * 0.3 }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);
}

function musicResultsView(session, sessionId, page) {
  const pages = Math.max(1, Math.ceil(session.entries.length / SEARCH_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pages - 1);
  const start = safePage * SEARCH_PAGE_SIZE;
  const slice = session.entries.slice(start, start + SEARCH_PAGE_SIZE);

  const inline_keyboard = slice.map((entry, index) => {
    const seconds = Number(entry.duration);
    const duration = Number.isFinite(seconds) && seconds > 0 ? ` · ${formatDuration(seconds)}` : "";
    const prefix = `${start + index + 1}. 🎵 `;
    const room = Math.max(10, 64 - prefix.length - duration.length);
    const title = String(entry.title || "Nomi topilmadi").replace(/\s+/g, " ");
    const shortTitle = title.length > room ? title.slice(0, room - 1) + "…" : title;
    return [{ text: `${prefix}${shortTitle}${duration}`, callback_data: `music:${entry.id}` }];
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: "◀️ Oldingi", callback_data: `mpage:${sessionId}:${safePage - 1}` });
  if (safePage < pages - 1) nav.push({ text: "Keyingi ▶️", callback_data: `mpage:${sessionId}:${safePage + 1}` });
  if (nav.length) inline_keyboard.push(nav);

  const shownQuery = session.query.length > 60 ? session.query.slice(0, 59) + "…" : session.query;
  const pageInfo = pages > 1 ? ` (${safePage + 1}/${pages})` : "";
  return { text: `🎧 “${shownQuery}” bo‘yicha natijalar${pageInfo}. Keraklisini tanlang:`, reply_markup: { inline_keyboard } };
}

// ====================================================================================

function createSearchSession(query, entries) {
  if (searchSessions.size >= 500) searchSessions.delete(searchSessions.keys().next().value);
  const sessionId = randomBytes(4).toString("hex");
  searchSessions.set(sessionId, { time: Date.now(), query, entries });
  return sessionId;
}

async function fetchMusicEntries(searchTerm, cookiesPath) {
  const run = (cookies) => youtubedl.exec(`ytsearch18:${searchTerm}`, musicSearchOptions(cookies), { timeout: 60000 });
  let result;
  try {
    result = await run(cookiesPath);
  } catch (error) {
    if (!cookiesPath) throw error;
    result = await run(undefined); // cookie sabab bo‘lsa, cookie’siz qayta urinib ko‘ramiz
  }
  const data = JSON.parse(result.stdout || "{}");
  return (data.entries || []).filter((entry) => entry?.id && /^[\w-]{6,20}$/.test(entry.id) && entry.live_status !== "is_live");
}

async function searchMusic(chatId, query) {
  const rawQuery = query.trim().slice(0, 150);
  if (!rawQuery) {
    await sendText(chatId, "🎵 Qo‘shiq nomi yoki ijrochini yozing. Masalan: /music Sevara Nazarkhan");
    return;
  }
  const searchTerm = cleanMusicQuery(rawQuery);
  const cacheKey = searchTerm.toLowerCase();

  // 1) Keshda bor bo‘lsa, darhol javob beramiz
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_MS) {
    const sessionId = createSearchSession(rawQuery, cached.entries);
    const view = musicResultsView(searchSessions.get(sessionId), sessionId, 0);
    await sendText(chatId, view.text, { reply_markup: view.reply_markup });
    return;
  }

  // 2) Haddan tashqari ko‘p qidiruvlardan himoya
  if (Date.now() - (lastSearchAt.get(chatId) || 0) < SEARCH_COOLDOWN_MS) {
    await sendText(chatId, "Biroz sekinroq 🙂 Bir necha soniyadan keyin qayta qidiring.");
    return;
  }
  if (activeSearches >= MAX_PARALLEL_SEARCHES) {
    await sendText(chatId, "Hozir qidiruv band. Birozdan keyin qayta urinib ko‘ring.");
    return;
  }
  lastSearchAt.set(chatId, Date.now());

  activeSearches += 1;
  let workDir;
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "downloader-music-search-"));
    const waiting = await sendText(chatId, `🔎 “${rawQuery}” bo‘yicha musiqa qidiryapman...`);
    const showResult = (text, extra = {}) =>
      telegram("editMessageText", { chat_id: chatId, message_id: waiting.message_id, text, ...extra })
        .catch(() => sendText(chatId, text, extra));

    let cookiesPath;
    try {
      cookiesPath = await writeYouTubeCookies(workDir);
    } catch {
      console.warn("YOUTUBE_COOKIES yaroqsiz, qidiruv cookie’siz bajariladi");
    }

    const entries = await fetchMusicEntries(searchTerm, cookiesPath);
    const ranked = rankMusicEntries(entries, rawQuery, searchTerm);
    if (!ranked.length) {
      await showResult("Bu nom bo‘yicha musiqa topilmadi. Ijrochi va qo‘shiq nomini boshqacha yozib ko‘ring.");
      return;
    }

    if (searchCache.size >= 200) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(cacheKey, { time: Date.now(), entries: ranked });
    const sessionId = createSearchSession(rawQuery, ranked);
    const view = musicResultsView(searchSessions.get(sessionId), sessionId, 0);
    await showResult(view.text, { reply_markup: view.reply_markup });
  } catch (error) {
    console.error("Music search failed:", String(error.stderr || error.message || "unknown").slice(0, 400));
    await sendText(chatId, "Musiqa qidiruvi hozir ishlamadi. Birozdan keyin yana urinib ko‘ring.").catch(() => {});
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeSearches -= 1;
  }
}

async function downloadAndSendMusic(chatId, videoId, title) {
  if (activeDownloads >= MAX_PARALLEL_DOWNLOADS) {
    await sendText(chatId, "Hozir boshqa fayllar yuklanmoqda. Birozdan keyin qayta tanlang.");
    return;
  }
  activeDownloads += 1;
  const workDir = await mkdtemp(path.join(tmpdir(), "downloader-music-"));
  let actionTimer;
  try {
    await sendText(chatId, `🎵 “${title.slice(0, 80)}” audiosi tayyorlanyapti...`);
    const showAnimation = () => telegram("sendChatAction", { chat_id: chatId, action: "upload_audio" }).catch(() => {});
    await showAnimation();
    actionTimer = setInterval(showAnimation, 4000);
    const cookiesPath = await writeYouTubeCookies(workDir);
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const baseOptions = {
      output: path.join(workDir, "audio.%(ext)s"),
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      remoteComponents: "ejs:github",
      retries: 2,
      socketTimeout: 30,
      ...(ffmpegStatic ? { ffmpegLocation: ffmpegStatic } : {})
    };
    const attempts = [
      { name: "best audio", format: "bestaudio/best", cookies: Boolean(cookiesPath) },
      { name: "best available", format: "best", cookies: false },
      { name: "web audio", format: "bestaudio/best", cookies: false, extractorArgs: "youtube:player-client=web" },
      { name: "android audio", format: "bestaudio/best", cookies: false, extractorArgs: "youtube:player-client=android" },
      { name: "ios audio", format: "bestaudio/best", cookies: false, extractorArgs: "youtube:player-client=ios" }
    ];
    let downloadError;
    for (const attempt of attempts) {
      try {
        await youtubedl.exec(sourceUrl, {
          ...baseOptions,
          format: attempt.format,
          ...(attempt.cookies && cookiesPath ? { cookies: cookiesPath } : {}),
          ...(attempt.extractorArgs ? { extractorArgs: attempt.extractorArgs } : {})
        }, { timeout: 90000 });
        downloadError = undefined;
        break;
      } catch (error) {
        downloadError = error;
        console.warn(`Music download retry (${attempt.name}) failed:`, String(error.stderr || error.message || "unknown").slice(0, 240));
      }
    }
    if (downloadError) throw downloadError;

    const files = (await readdir(workDir))
      .filter((name) => name.startsWith("audio.") && !name.endsWith(".part") && !name.endsWith(".ytdl"))
      .sort((a, b) => Number(b.endsWith(".mp3")) - Number(a.endsWith(".mp3")));
    if (!files.length) throw new Error("Yuklangan audio topilmadi");
    const filePath = path.join(workDir, files[0]);
    if (path.extname(filePath).toLowerCase() !== ".mp3") {
      throw new Error(`Audio MP3 ga o‘girilmagan: ${files[0]}`);
    }
    const fileInfo = await stat(filePath);
    if (fileInfo.size > MAX_FILE_BYTES) {
      await sendText(chatId, "Audio Telegram yuborish chegarasidan katta (49 MB).");
      return;
    }
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("title", title.slice(0, 64));
    form.set("audio", new Blob([await readFile(filePath)], { type: "audio/mpeg" }), `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "music"}.mp3`);
    const response = await fetch(TELEGRAM_API + "/sendAudio", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      console.warn("Telegram sendAudio rejected MP3, retrying as document:", result.description || response.status);
      const documentForm = new FormData();
      documentForm.set("chat_id", String(chatId));
      documentForm.set("caption", `🎵 ${title.slice(0, 900)}`);
      documentForm.set("document", new Blob([await readFile(filePath)], { type: "audio/mpeg" }), `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "music"}.mp3`);
      const documentResponse = await fetch(TELEGRAM_API + "/sendDocument", { method: "POST", body: documentForm });
      const documentResult = await documentResponse.json();
      if (!documentResponse.ok || !documentResult.ok) throw new Error(documentResult.description || result.description || "Telegram audio faylni yubora olmadi");
    }
  } catch (error) {
    console.error("Music download failed:", String(error.stderr || error.message || "unknown").slice(0, 400));
    await sendText(chatId, "Bu musiqani olishning imkoni bo‘lmadi. Boshqa natijani tanlab ko‘ring.");
  } finally {
    clearInterval(actionTimer);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeDownloads -= 1;
  }
}

app.get("/", (req, res) => res.send("Downloader UZ BOT ishlayapti!"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const callback = req.body?.callback_query;
  if (callback) {
    if (!TOKEN) return;
    try {
      // "Oldingi / Keyingi" tugmalari
      const pageMatch = String(callback.data || "").match(/^mpage:([a-f0-9]{8}):(\d{1,2})$/);
      if (pageMatch) {
        const session = searchSessions.get(pageMatch[1]);
        if (!session) {
          await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Natijalar eskirgan, qaytadan qidiring." });
          return;
        }
        const view = musicResultsView(session, pageMatch[1], Number(pageMatch[2]));
        await telegram("editMessageText", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, ...view })
          .catch((error) => console.warn("Page edit failed:", error.message));
        await telegram("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
        return;
      }

      const match = String(callback.data || "").match(/^music:([\w-]{6,20})$/);
      if (!match) {
        await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Bu natija yaroqsiz." });
        return;
      }
      const button = callback.message?.reply_markup?.inline_keyboard?.flat().find((item) => item.callback_data === callback.data);
      const title = String(button?.text || "Tanlangan musiqa").replace(/^\d+\.\s*/, "").replace(/^🎵\s*/, "").replace(/\s+·\s+\d+:\d{2}$/, "");
      await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Audio tayyorlanyapti..." });
      await downloadAndSendMusic(callback.message.chat.id, match[1], title);
    } catch (error) {
      console.error("Music callback failed:", error.message);
      if (callback.message?.chat?.id) await sendText(callback.message.chat.id, "Musiqani tayyorlab bo‘lmadi. Boshqa natijani tanlang.").catch(() => {});
    }
    return;
  }
  const message = req.body?.message;
  if (!TOKEN || !message) return;
  const chatId = message.chat.id;
  try {
    if (message.text === "/start" || message.text === "/help") {
      await sendWelcomePhoto(chatId);
      return;
    }
    const telegramVideo = message.video || message.animation;
    if (telegramVideo) {
      await returnTelegramMedia(chatId, telegramVideo, "sendVideo", "video");
      return;
    }
    if (message.document?.mime_type?.startsWith("video/")) {
      await returnTelegramMedia(chatId, message.document, "sendDocument", "document");
      return;
    }
    const musicQuery = musicQueryFromMessage(message.text || "");
    if (musicQuery !== null) {
      await searchMusic(chatId, musicQuery);
      return;
    }
    const url = extractUrl(message.text || message.caption || "");
    if (!url) {
      await sendText(chatId, "Havolani yuboring 🎬 Telegram videosi bo‘lsa, uni botga forward qiling.");
      return;
    }
    if (!isAllowedVideoUrl(url)) {
      await sendText(chatId, "YouTube, Instagram, TikTok, Facebook yoki Telegram havolalarini yuboring.");
      return;
    }
    await downloadAndSend(chatId, url);
  } catch (error) {
    console.error("Update handling failed:", error.message);
    await sendText(chatId, "So‘rovni bajarib bo‘lmadi. Birozdan keyin yana urinib ko‘ring.").catch(() => {});
  }
});

async function setupWebhook() {
  if (!TOKEN) {
    console.log("TELEGRAM_BOT_TOKEN topilmadi");
    return;
  }
  const result = await telegram("setWebhook", { url: "https://downloader-uz-bot.onrender.com/webhook" });
  console.log("WEBHOOK o‘rnatildi:", Boolean(result));
  await telegram("setMyCommands", { commands: [
    { command: "music", description: "Qo‘shiq nomi yoki ijrochini qidirish" },
    { command: "song", description: "Qo‘shiq nomi bo‘yicha qidirish" },
    { command: "help", description: "Botdan foydalanish yo‘riqnomasi" }
  ] });
}

// Eski kesh va qidiruv sessiyalarini vaqti-vaqti bilan tozalash
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of searchCache) if (now - value.time > SEARCH_CACHE_MS) searchCache.delete(key);
  for (const [key, value] of searchSessions) if (now - value.time > SEARCH_SESSION_MS) searchSessions.delete(key);
  for (const [key, value] of lastSearchAt) if (now - value > 60000) lastSearchAt.delete(key);
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log("Downloader UZ server ishga tushdi:", PORT);
  setupWebhook().catch((error) => console.error("Webhook setup failed:", error.message));
});
