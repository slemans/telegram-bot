import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = "8742140576:AAEbSBWqm2Ec_rRIjoSPsMiMvEvy3yS3gVQ";

// проверка сервера
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Получено сообщение от Telegram:", body);

  res.sendStatus(200); // обязательно

  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text;

    // отправка ответа пользователю
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Привет, ${body.message.from.first_name}! Ты написал: ${text}`
      })
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
