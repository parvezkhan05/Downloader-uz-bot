import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

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
      reply = "Havola qabul qilindi!";
    }

    const telegramUrl =
      "https://api.telegram.org/bot" + TOKEN + "/sendMessage";

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

async function setupWebhook() {
  if (!TOKEN) {
    console.log("TOKEN TOPILMADI");
    return;
  }

  const response = await fetch(
    "https://api.telegram.org/bot" + TOKEN + "/setWebhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: "https://downloader-uz-bot.onrender.com/webhook"
      })
    }
  );

  const result = await response.json();

  console.log("WEBHOOK:", result.ok);
  console.log("WEBHOOK XABARI:", result.description);
}

app.listen(PORT, () => {
  console.log("Downloader UZ server ishga tushdi:", PORT);
  setupWebhook().catch(console.error);
});
