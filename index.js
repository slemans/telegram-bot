import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = "8742140576:AAEbSBWqm2Ec_rRIjoSPsMiMvEvy3yS3gVQ";

// массив для хранения chat_id пользователей
const users = new Set();

// проверка сервера
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// webhook endpoint для Telegram
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Получено сообщение от Telegram:", body);

  res.sendStatus(200); // обязательно, иначе Telegram будет получать 404

  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text;
    const firstName = body.message.from.first_name || "";

    // сохраняем пользователя
    users.add(chatId);

    // отправляем ответ пользователю
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Привет, ${firstName}! Ты написал: ${text}`
      })
    });
  }
});

// функция для рассылки уведомлений всем пользователям
async function sendNotification(message) {
  for (const chatId of users) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });
  }
}

// пример использования: уведомление о конце абонемента
// sendNotification("Внимание! Ваш абонемент заканчивается завтра! 🚀");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
