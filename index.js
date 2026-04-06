import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json());

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

// =======================
// Хранилище пользователей
// =======================
const users = new Map(); // chat_id → clientId

// =======================
// Проверка сервера
// =======================
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// =======================
// Telegram Webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Получено сообщение от Telegram:", body);

  res.sendStatus(200);

  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text;
    const firstName = body.message.from.first_name || "";

    // сохраняем пользователя (пока без clientId)
    users.set(chatId, null);

    // ответ
    await sendMessage(chatId, `Привет, ${firstName}! Ты написал: ${text}`);
  }
});

// =======================
// Отправка сообщений
// =======================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

// =======================
// Moyklass API
// =======================
async function getLessons() {
  try {
    const response = await fetch("https://api.moyklass.com/lessons", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${MOYK_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    console.log("Moyklass status:", response.status);

    const data = await response.json();
    console.log("Moyklass data:", data);

    return data;
  } catch (err) {
    console.error("Ошибка Moyklass:", err);
    return [];
  }
}

// =======================
// Проверка абонементов
// =======================
async function checkExpiringSubscriptions() {
  const lessons = await getLessons();

  console.log("Получили lessons:", lessons);

  lessons.forEach(lesson => {
    console.log("Lesson:", lesson);

    if (!lesson.subscriptionEndDate) return;

    const endDate = new Date(lesson.subscriptionEndDate);
    const now = new Date();
    const diffDays = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

    if (diffDays <= 3) {
      const chatId = Array.from(users.entries())
        .find(([chat, clientId]) => clientId === lesson.clientId)?.[0];

      if (chatId) {
        sendMessage(
          chatId,
          `⚠️ Ваш абонемент заканчивается через ${diffDays} дней!`
        );
      }
    }
  });
}

// =======================
// CRON
// =======================

// тест — каждую минуту
cron.schedule("*/1 * * * *", () => {
  console.log("CRON работает 🚀");
  checkExpiringSubscriptions();
});

// прод — раз в день в 10:00
// cron.schedule("0 10 * * *", () => {
//   console.log("Проверяем абонементы...");
//   checkExpiringSubscriptions();
// });

// =======================
// Запуск сервера
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
