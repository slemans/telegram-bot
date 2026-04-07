import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

// =======================
// Telegram
// =======================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

// =======================
// Moyklass API
// =======================
async function getToken() {
  const res = await fetch("https://api.moyklass.com/v1/company/auth/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: MOYK_API_KEY })
  });

  const data = await res.json();
  return data.accessToken;
}

function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

async function findUserByPhone(phone) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();
  return data.users?.[0] || null;
}

// =======================
// АКТИВНЫЕ АБОНЕМЕНТЫ
// =======================
async function getActiveSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();

  if (!data.userSubscriptions) return [];

  const now = new Date();

  const active = data.userSubscriptions
    .filter(sub => {
      if (!sub.beginDate || !sub.endDate) return false;

      const begin = new Date(sub.beginDate);
      const end = new Date(sub.endDate);

      return begin <= now && now <= end;
    })
    .map(sub => {
      let remaining = "∞";

      if (sub.visitCount != null && sub.visitedCount != null) {
        remaining = sub.visitCount - sub.visitedCount;
      }

      return {
        name: sub.name ?? "Без названия",
        beginDate: sub.beginDate,
        endDate: sub.endDate,
        remaining
      };
    });

  return active;
}

function formatDate(dateString) {
  if (!dateString) return "не указана";
  return new Date(dateString).toLocaleDateString("ru-RU");
}

// =======================
// Webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;

  if (text === "/start") {
    await sendMessage(chatId, "Отправь номер телефона 📱");
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const subs = await getActiveSubscriptions(user.id);

  let response = `✅ Найден: ${user.name} ${user.id}\n`;

  if (subs.length === 0) {
    response += "\n❌ Нет активных абонементов";
    await sendMessage(chatId, response);
    return;
  }

  response += `\n🎫 Активные абонементы:\n`;

  subs.forEach((sub, i) => {
    response += `
${i + 1}) ${sub.name}
- Осталось: ${sub.remaining}
- Период: ${formatDate(sub.beginDate)} - ${formatDate(sub.endDate)}
`;
  });

  await sendMessage(chatId, response);
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
