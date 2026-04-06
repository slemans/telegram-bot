import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json());

// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const users = new Map(); // chat_id → userId

// =======================
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// =======================
// Telegram webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Сообщение:", body);

  res.sendStatus(200);

  if (!body.message) return;

  const chatId = body.message.chat.id;
  const text = body.message.text?.trim();
  const firstName = body.message.from.first_name || "";

  if (text === "/start") {
    await sendMessage(chatId, `Привет, ${firstName} 👋\nВведи номер телефона`);
    return;
  }

  if (/^\d{10,15}$/.test(text)) {
    await handlePhone(chatId, text);
    return;
  }

  await sendMessage(chatId, "❌ Введите номер телефона цифрами");
});

// =======================
// Telegram send
// =======================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// =======================
// Moyklass TOKEN
// =======================
async function getToken() {
  const res = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ apiKey: MOYK_API_KEY })
  });

  const data = await res.json();
  console.log("TOKEN:", data);

  return data.accessToken;
}

// =======================
// Найти пользователя
// =======================
async function findUserByPhone(phone) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  );

  const data = await res.json();
  console.log("USERS:", data);

  return data.result?.[0] || null;
}

// =======================
// Получить абонементы
// =======================
async function getSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/subscriptions?userId=${userId}`,
    {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  );

  const data = await res.json();
  console.log("SUBS:", data);

  return data.result || [];
}

// =======================
// Обработка телефона
// =======================
async function handlePhone(chatId, phone) {
  await sendMessage(chatId, "🔍 Ищем...");

  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  users.set(chatId, user.id);

  await sendMessage(
    chatId,
    `✅ Найден: ${user.name}\nСтатус: ${user.clientStateId}`
  );

  const subs = await getSubscriptions(user.id);

  if (!subs.length) {
    await sendMessage(chatId, "У вас нет абонементов");
    return;
  }

  let msg = "📊 Абонементы:\n\n";

  subs.forEach(sub => {
    msg += `• ${sub.name}\n`;
    msg += `Осталось: ${sub.balance}\n`;
    msg += `До: ${sub.endDate}\n\n`;
  });

  await sendMessage(chatId, msg);
}

// =======================
// CRON
// =======================
cron.schedule("0 10 * * *", async () => {
  console.log("Проверка...");

  for (const [chatId, userId] of users.entries()) {
    const subs = await getSubscriptions(userId);

    subs.forEach(sub => {
      const end = new Date(sub.endDate);
      const now = new Date();
      const days = Math.ceil((end - now) / (1000 * 60 * 60 * 24));

      if (days <= 3) {
        sendMessage(
          chatId,
          `⚠️ ${sub.name} заканчивается через ${days} дней`
        );
      }
    });
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started", PORT);
});
