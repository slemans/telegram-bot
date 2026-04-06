import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN; // Telegram bot token из Render env
const MOYK_API_KEY = process.env.MOYK_API_KEY; // Moyklass API key из Render env

// Массив для хранения chat_id пользователей
const users = new Map(); // Map<Telegram chat_id, Moyklass clientId> для сопоставления

// Проверка сервера
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// Webhook endpoint для Telegram
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Получено сообщение от Telegram:", body);

  res.sendStatus(200);

  if (body.message) {
    const chatId = body.message.chat.id;
    const text = body.message.text;
    const firstName = body.message.from.first_name || "";

    // Сохраняем пользователя
    users.set(chatId, null); // Пока clientId неизвестен, можно позже сопоставить

    // Ответ пользователю
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
// Проверка абонементов и уведомления
// =======================
async function checkExpiringSubscriptions() {
  const lessons = await getLessons();

  lessons.forEach(lesson => {
    const endDate = new Date(lesson.subscriptionEndDate);
    const now = new Date();
    const diffDays = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

    if (diffDays <= 3) { // если абонемент заканчивается через 3 дня
      // Найдем chat_id пользователя по clientId Moyklass
      const chatId = Array.from(users.entries())
        .find(([chat, clientId]) => clientId === lesson.clientId)?.[0];

      if (chatId) {
        sendNotificationToUser(chatId, `⚠️ Ваш абонемент заканчивается через ${diffDays} дней!`);
      } 
    }
  });
}

// =======================
// Отправка уведомлений пользователю
// =======================
async function sendNotificationToUser(chatId, message) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
}

// =======================
// Планировщик проверки
// =======================
import cron from "node-cron";

// Раз в день в 10:00 проверяем абонементы
cron.schedule("0 10 * * *", () => {
  console.log("Проверяем абонементы...");
  checkExpiringSubscriptions();
});

// проверим cron
cron.schedule("*/1 * * * *", () => {
  console.log("CRON работает 🚀");
  checkExpiringSubscriptions();
});

async function checkExpiringSubscriptions() {
  const lessons = await getLessons();

  console.log("Получили lessons:", lessons);

  lessons.forEach(lesson => {
    console.log("Lesson:", lesson);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
