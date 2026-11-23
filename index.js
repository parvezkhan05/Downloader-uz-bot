import express from "express";
import youtubedl from "youtube-dl-exec";
import { mkdtemp, readdir, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = 49 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 2;
let activeDownloads = 0;
const TELEGRAM_API = "https://api.telegram.org/bot" + TOKEN;
const ALLOWED_HOSTS = [
  "youtube.com", "youtu.be", "youtube-nocookie.com",
  "instagram.com", "instagr.am",
  "tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
  "facebook.com", "fb.watch", "fb.com",
  "t.me", "telegram.me", "telesco.pe"
];

async function telegram(method, payload) {
  const response = await fetch(TELEGRAM_API + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || "Telegram API so‘rovi bajarilmadi");
  }
  return result.result;
}

async function sendText(chatId, text) {
  return telegram("sendMessage", { chat_id: chatId, text });
}

function isAllowedVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
  } catch {
    return false;
  }
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
  await telegram(method, {
    chat_id: chatId,
    [label]: media.file_id,
    caption: "Video tayyor."
  });
}

async function downloadAndSend(chatId, url) {
  if (activeDownloads >= MAX_PARALLEL_DOWNLOADS) {
    await sendText(chatId, "Hozir boshqa videolar yuklanmoqda. Birozdan keyin qayta yuboring.");
    return;
  }
  activeDownloads += 1;
  const workDir = await mkdtemp(path.join(tmpdir(), "downloader-uz-"));
  try {
    await sendText(chatId, "⏳ Video yuklanmoqda...");
    await youtubedl.exec(url, {
      output: path.join(workDir, "video.%(ext)s"),
      format: "best[ext=mp4][height<=720]/best[height<=720]/best",
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      remoteComponents: "ejs:github",
      retries: 2,
      socketTimeout: 30
    }, { timeout: 180000 });

    const files = (await readdir(workDir)).filter((name) => name.startsWith("video."));
    if (!files.length) throw new Error("Yuklangan video topilmadi");
    const filePath = path.join(workDir, files[0]);
    const fileInfo = await stat(filePath);
    if (fileInfo.size > MAX_FILE_BYTES) {
      await sendText(chatId, "Video Telegram yuborish chegarasidan katta (49 MB). Boshqa video yoki qisqaroq havolani yuboring.");
      return;
    }

    const file = new Blob([await readFile(filePath)], { type: "video/mp4" });
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("supports_streaming", "true");
    form.set("video", file, files[0]);
    const response = await fetch(TELEGRAM_API + "/sendVideo", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.description || "Telegram videoni yubora olmadi");
    }
  } catch (error) {
    console.error("Video download failed:", error.message);
    await sendText(chatId, "Videoni yuklab bo‘lmadi. Havola ochiq ekanini tekshirib, qayta urinib ko‘ring.");
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeDownloads -= 1;
  }
}

app.get("/", (req, res) => {
  res.send("Downloader UZ BOT ishlayapti!");
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.message;
  if (!TOKEN || !message) return;
  const chatId = message.chat.id;

  try {
    if (message.text === "/start") {
      await sendText(chatId, "Salom! YouTube, Instagram, TikTok, Facebook yoki Telegram video havolasini yuboring. Telegram postida videoni botga forward qiling.");
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
      await sendText(chatId, "Video havolasini yuboring. Telegram videosi bo‘lsa, videoni botga forward qiling.");
      return;
    }
    if (!isAllowedVideoUrl(url)) {
      await sendText(chatId, "Hozircha YouTube, Instagram, TikTok, Facebook va Telegram havolalari qo‘llanadi.");
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
  const result = await telegram("setWebhook", {
    url: "https://downloader-uz-bot.onrender.com/webhook"
  });
  console.log("WEBHOOK o‘rnatildi:", Boolean(result));
}

app.listen(PORT, () => {
  console.log("Downloader UZ server ishga tushdi:", PORT);
  setupWebhook().catch((error) => console.error("Webhook setup failed:", error.message));
});
