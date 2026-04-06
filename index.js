import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

// =======================
// Проверка сервера
// =======================
app.get("/", (req, res) => {
  res.send("Bot is working 🚀");
});

// =======================
// Telegram sendMessage
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
// Получение токена Moyklass
// =======================
async function getToken() {
  const res = await fetch(
    "https://api.moyklass.com/v1/company/auth/getToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey: MOYK_API_KEY
      })
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
    {
      headers: {
        "x-access-token": token
      }
    }
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

  // считаем что пользователь отправил телефон
  const phone = normalizePhone(text);

  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  // дата начала обучения
  const startDate = formatDate(user.createdAt);

  await sendMessage(
    chatId,
    `✅ Найден: ${user.name}
📊 Статус: ${user.clientStateId}
📅 Начало обучения: ${startDate}`
  );
});

// =======================
// Запуск сервера
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
