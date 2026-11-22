import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
res.send("Downloader UZ BOT ishlayapti!");
});

app.post("/webhook", async (req, res) => {
try {
const message = req.body.message;

if (!message || !message.text) {
  return res.sendStatus(200);
}

const chatId = message.chat.id;
const userText = message.text;

let reply = "Video havolasini yuboring.";

if (userText === "/start") {
  reply = "Salom! Downloader UZ botiga xush kelibsiz!";
} else if (userText.startsWith("http")) {
  reply = "Havola qabul qilindi. Yuklab olish funksiyasi hali ulanmagan.";
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.log("Bot tokeni topilmadi!");
  return res.sendStatus(200);
}

const telegramUrl = "https://api.telegram.org/bot" + token + "/sendMessage";

await fetch(telegramUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    chat_id: chatId,
    text: reply
  })
});

res.sendStatus(200);
} catch (error) {
console.log(error);
res.sendStatus(200);
}
});
const webhookUrl =
  "https://downloader-uz-bot.onrendex.com/webhook";

const response = await fetch(
  "https://api.telegram.org/bot" +
  process.env.TELEGRAM_BOT_TOKEN +
  "/setWebhook?url=" +
  encodeURIComponent(webhookUrl)
);

const result = await response.json();

console.log("WEBHOOK:", result.ok);
console.log("WEBHOOK XABARI:", result.description);

const result = await check.json();

console.log("TELEGRAM TEKSHIRUVI:", result.ok);
console.log("TELEGRAM XATOSI:", result.description || "Xato yo'q");
