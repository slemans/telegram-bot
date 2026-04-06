import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = "8742140576:AAEbSBWqm2Ec_rRIjoSPsMiMvEvy3yS3gVQ";

// проверка сервера
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// webhook endpoint
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  console.log("Получено сообщение от Telegram:", req.body); // <-- сюда Telegram шлёт данные
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
