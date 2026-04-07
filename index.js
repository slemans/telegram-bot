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
    body: JSON.stringify({ chat_id: chatId, text })
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
// Получаем "активный" абонемент через endDate
// =======================
async function getActiveSubscription(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();

  if (!data.userSubscriptions || data.userSubscriptions.length === 0) {
    return null;
  }

  const now = new Date();

  // фильтруем только с датой окончания
  const validSubs = data.userSubscriptions.filter(sub => sub.endDate);

  if (validSubs.length === 0) return null;

  // сортируем по самой дальней дате
  const sorted = validSubs.sort(
    (a, b) => new Date(b.endDate) - new Date(a.endDate)
  );

  const best = sorted[0];

  // если уже закончился — считаем неактивным
  if (new Date(best.endDate) < now) return null;

  return best;
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
    await sendMessage(chatId, "Отправь номер телефона 📱 375000000000");
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const subscription = await getActiveSubscription(user.id);

  let response = `✅ Найден: ${user.name}\n`;

  if (!subscription) {
    response += "\n❌ Нет активного абонемента";
    await sendMessage(chatId, response);
    return;
  }

  response += `
🎫 Абонемент:
- Название: ${subscription.name ?? "не указано"}
- Осталось занятий: ${subscription.remainingVisits ?? "неизвестно"}
- Действует до: ${formatDate(subscription.endDate)}
`;

  await sendMessage(chatId, response);
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
