import express from "express";
import youtubedl from "youtube-dl-exec";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { mkdtemp, readdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "1mb" }));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 49 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 2;
const YOUTUBE_COOKIES = process.env.YOUTUBE_COOKIES?.trim();
let activeDownloads = 0;
let welcomePng;
const TELEGRAM_API = "https://api.telegram.org/bot" + TOKEN;
const ALLOWED_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com", "instagram.com", "instagr.am", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "facebook.com", "fb.watch", "fb.com", "t.me", "telegram.me", "telesco.pe"];

async function telegram(method, payload) {
  const response = await fetch(TELEGRAM_API + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram API so‘rovi bajarilmadi");
  return result.result;
}

async function sendText(chatId, text) {
  return telegram("sendMessage", { chat_id: chatId, text });
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
    form.set("caption", "🎬 Salom! Video havolasini yuboring — bot uni tayyorlab chatga qaytaradi.");
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
    let cookiesPath;
    if (YOUTUBE_COOKIES && isYouTube) {
      if (!isNetscapeCookieFile(YOUTUBE_COOKIES)) {
        throw new Error("YOUTUBE_COOKIES must contain the full Netscape-format cookie file.");
      }
      cookiesPath = path.join(workDir, "youtube-cookies.txt");
      await writeFile(cookiesPath, YOUTUBE_COOKIES + "\n", { mode: 0o600 });
    }
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

app.get("/", (req, res) => res.send("Downloader UZ BOT ishlayapti!"));

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
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
}

app.listen(PORT, () => {
  console.log("Downloader UZ server ishga tushdi:", PORT);
  setupWebhook().catch((error) => console.error("Webhook setup failed:", error.message));
});

