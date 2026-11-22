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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Downloader UZ server ishga tushdi: " + PORT);
});
console.log("TOKEN BOR:", !!process.env.TELEGRAM_BOT_TOKEN);
