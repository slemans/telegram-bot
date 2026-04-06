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
  console.log("Получено сообщение:", body);

  res.sendStatus(200);

  if (!body.message) return;

  const chatId = body.message.chat.id;
  const text = body.message.text?.trim();
  const firstName = body.message.from.first_name || "";

  // /start
  if (text === "/start") {
    await sendMessage(
      chatId,
      `Привет, ${firstName}! 👋\n\nВведите ваш номер телефона (например: 375291234567)`
    );
    return;
  }

  // если ввели телефон
  if (/^\d{10,15}$/.test(text)) {
    await handlePhone(chatId, text);
    return;
  }

  await sendMessage(chatId, "❌ Введите корректный номер телефона");
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
// Moyklass TOKEN
// =======================
async function getMoyklassToken() {
  try {
    const response = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: MOYK_API_KEY
      })
    });

    const data = await response.json();
    console.log("TOKEN:", data);

    return data.accessToken;
  } catch (err) {
    console.error("Ошибка токена:", err);
    return null;
  }
}

// =======================
// Найти клиента по телефону
// =======================
async function findClientByPhone(phone) {
  const token = await getMoyklassToken();
  if (!token) return null;

  try {
    const response = await fetch(`https://api.moyklass.com/v1/company/clients?phone=${phone}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();
    console.log("CLIENTS:", data);

    return data.result?.[0] || null;
  } catch (err) {
    console.error("Ошибка поиска клиента:", err);
    return null;
  }
}

// =======================
// Получить абонементы
// =======================
async function getSubscriptions(clientId) {
  const token = await getMoyklassToken();
  if (!token) return [];

  try {
    const response = await fetch(
      `https://api.moyklass.com/v1/company/subscriptions?clientId=${clientId}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();
    console.log("SUBSCRIPTIONS:", data);

    return data.result || [];
  } catch (err) {
    console.error("Ошибка абонементов:", err);
    return [];
  }
}

// =======================
// Обработка телефона
// =======================
async function handlePhone(chatId, phone) {
  await sendMessage(chatId, "🔍 Ищем вас в системе...");

  const client = await findClientByPhone(phone);

  if (!client) {
    await sendMessage(chatId, "❌ Клиент не найден. Проверьте номер телефона.");
    return;
  }

  // сохраняем связь
  users.set(chatId, client.id);

  await sendMessage(chatId, `✅ Найден: ${client.name}`);

  const subscriptions = await getSubscriptions(client.id);

  if (!subscriptions.length) {
    await sendMessage(chatId, "У вас нет активных абонементов");
    return;
  }

  let message = "📊 Ваши абонементы:\n\n";

  subscriptions.forEach(sub => {
    message += `• ${sub.name}\n`;
    message += `Осталось занятий: ${sub.balance}\n`;
    message += `Действует до: ${sub.endDate}\n\n`;
  });

  await sendMessage(chatId, message);
}

// =======================
// CRON (уведомления)
// =======================
cron.schedule("0 10 * * *", async () => {
  console.log("Проверка абонементов...");

  for (const [chatId, clientId] of users.entries()) {
    if (!clientId) continue;

    const subs = await getSubscriptions(clientId);

    subs.forEach(sub => {
      const endDate = new Date(sub.endDate);
      const now = new Date();
      const diffDays = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

      if (diffDays <= 3) {
        sendMessage(
          chatId,
          `⚠️ Абонемент "${sub.name}" заканчивается через ${diffDays} дней!`
        );
      }
    });
  }
});

// =======================
// Запуск сервера
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
