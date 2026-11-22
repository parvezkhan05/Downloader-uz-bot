import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = https://api.telegram.org/bot${TOKEN};

app.get("/", (req, res) => {
res.send("Downloader UZ BOT ishlayapti!");
});

app.post("/webhook", async (req, res) => {
const message = req.body.message;

if (!message?.text) {
return res.sendStatus(200);
}

const chatId = message.chat.id;
const text = message.text;

let reply = "Video havolasini yuboring.";

if (text === "/start") {
reply = "👋 Downloader UZ botiga xush kelibsiz!\n\nYouTube, Instagram, TikTok, Facebook yoki Telegram havolasini yuboring.";
} else if (text.startsWith("http")) {
reply = "✅ Havola qabul qilindi!\n\nHozircha yuklab olish funksiyasi ulanmagan.";
}

try {
await fetch(${API}/sendMessage, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
chat_id: chatId,
text: reply
})
});
} catch (error) {
console.error(error);
}

res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("Downloader UZ server ishga tushdi:", PORT);
});
