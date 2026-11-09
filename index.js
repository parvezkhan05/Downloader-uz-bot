import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Downloader UZ BOT ishlayapti!");
});

app.post("/check", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      ok: false,
      message: "Video havolasini yuboring"
    });
  }

  let platform = "Noma'lum";

  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    platform = "YouTube";
  } else if (url.includes("instagram.com")) {
    platform = "Instagram";
  } else if (url.includes("tiktok.com")) {
    platform = "TikTok";
  } else if (url.includes("facebook.com") || url.includes("fb.watch")) {
    platform = "Facebook";
  } else if (url.includes("t.me")) {
    platform = "Telegram";
  }

  res.json({
    ok: true,
    platform,
    message: "Havola qabul qilindi"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Downloader UZ server ishga tushdi:", PORT);
});
