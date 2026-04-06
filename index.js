import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

// =======================
// Telegram sendMessage
// =======================
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// =======================
// Получение токена Moyklass
// =======================
async function getToken() {
  const res = await fetch(
    "https://api.moyklass.com/v1/company/auth/getToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: MOYK_API_KEY })
    }
  );
  const data = await res.json();
  console.log("TOKEN:", data);
  return data.accessToken;
}

// =======================
// Нормализация телефона
// =======================
function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

// =======================
// Поиск пользователя
// =======================
async function findUserByPhone(phone) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/users?phone=${phone}`,
    { headers: { "x-access-token": token } }
  );

  const data = await res.json();
  console.log("USERS:", data);

  return data.users?.[0] || null;
}

// =======================
// Формат даты
// =======================
function formatDate(dateString) {
  if (!dateString) return "не указана";
  const date = new Date(dateString);
  return date.toLocaleDateString("ru-RU");
}

// =======================
// Формат joins
// =======================
function formatJoins(joins) {
  if (!joins || joins.length === 0) return "Нет занятий";

  return joins.map((j, idx) => {
    const s = j.stats || {};
    return `\n📌 Занятие ${idx + 1}:
- Статус: ${j.status || "-"}
- Дата следующей записи: ${formatDate(s.nextRecord)}
- Последнее посещение: ${formatDate(s.lastVisit)}
- Всего посещений: ${s.visits ?? 0}
- Бесплатные посещения: ${s.freeVisits ?? 0}
- Потеряно занятий: ${s.lessonsLost ?? 0}
- Оплачено всего: ${s.totalPayed ?? 0}
- Неоплаченные занятия: ${s.nonPayedLessons ?? 0}`;
  }).join("\n");
}

// =======================
// Webhook Telegram
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  console.log("Сообщение:", body);

  res.sendStatus(200);
  if (!body.message) return;

  const chatId = body.message.chat.id;
  const text = body.message.text;

  // команда старт
  if (text === "/start") {
    await sendMessage(chatId, "Привет! Отправь свой номер телефона 📱");
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const startDate = formatDate(user.createdAt);
  const joinsInfo = formatJoins(user.joins);

  await sendMessage(
    chatId,
    `✅ Найден: ${user.name}
📅 Начало обучения: ${startDate}
${joinsInfo}`
  );
});

// =======================
// Запуск сервера
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
