import express from "express";
import cron from "node-cron";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

// Map для хранения chatId -> { phone, notifyLessons, notifyExpiry }
const users = new Map(); // Map<chatId, {phone, notifyLessons, notifyExpiry}>

// =======================
// Telegram sendMessage
// =======================
async function sendMessage(chatId, text, buttons = null) {
  const body = { chat_id: chatId, text };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// =======================
// Moyklass API: токен и поиск пользователя
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
  const res = await fetch(`https://api.moyklass.com/v1/company/users?phone=${phone}`, {
    headers: { "x-access-token": token }
  });
  const data = await res.json();
  return data.users?.[0] || null;
}

function formatDate(dateString) {
  if (!dateString) return "не указана";
  const date = new Date(dateString);
  return date.toLocaleDateString("ru-RU");
}

// =======================
// Найти следующее занятие
// =======================
function getNextLesson(user) {
  if (!user.joins || user.joins.length === 0) return null;

  const upcoming = user.joins
    .filter(j => j.status === "study" && j.stats?.nextRecord)
    .sort((a, b) => new Date(a.stats.nextRecord) - new Date(b.stats.nextRecord));

  return upcoming[0] || null;
}

// =======================
// Webhook Telegram
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (!body.message) return;

  const chatId = body.message.chat.id;
  const text = body.message.text;

  // команда /start
  if (text === "/start") {
    await sendMessage(chatId, "Привет! Отправь свой номер телефона 📱");
    return;
  }

  // inline кнопки для уведомлений
  const buttons = [
    [
      { text: "Да ✅", callback_data: "notify_yes" },
      { text: "Нет ❌", callback_data: "notify_no" }
    ]
  ];

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  users.set(chatId, { phone, notifyLessons: false, notifyExpiry: false });

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const startDate = formatDate(user.createdAt);
  const nextLesson = getNextLesson(user);

  let message = `✅ Найден: ${user.name}\n📅 Начало обучения: ${startDate}\n`;

  if (!nextLesson) {
    message += "\nУ вас нет активных занятий или действующего абонемента";
    await sendMessage(chatId, message);
  } else {
    message += `\n📌 Следующее занятие (${formatDate(nextLesson.stats.nextRecord)}):
- Название группы: ${nextLesson.classId} 
- Тренер: ${nextLesson.trainer ?? "не указан"}
- Дни и время: ${nextLesson.schedule ?? "не указано"}
`;

    // Предложение получать уведомления за день до занятия
    message += "\nХотите получать уведомление за день до занятия?";
    await sendMessage(chatId, message, buttons);
  }

  // Предложение получать уведомления за 3 дня до окончания абонемента
  message = "Хотите получать уведомления за 3 дня до окончания абонемента?";
  await sendMessage(chatId, message, buttons);
});

// =======================
// Обработка inline кнопок
// =======================
app.post(`/bot${BOT_TOKEN}/callback`, async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (!body.callback_query) return;

  const chatId = body.callback_query.message.chat.id;
  const data = body.callback_query.data;

  if (!users.has(chatId)) return;
  const userSettings = users.get(chatId);

  if (data === "notify_yes") userSettings.notifyLessons = true;
  if (data === "notify_no") userSettings.notifyLessons = false;

  users.set(chatId, userSettings);

  await sendMessage(chatId, "Настройки уведомлений обновлены ✅");
});

// =======================
// Проверка абонементов и занятий
// =======================
async function checkNotifications() {
  if (users.size === 0) return;
  const token = await getToken();

  for (const [chatId, settings] of users.entries()) {
    const user = await findUserByPhone(settings.phone);
    if (!user) continue;

    // Уведомление за день до занятия
    if (settings.notifyLessons) {
      const nextLesson = getNextLesson(user);
      if (nextLesson) {
        const lessonDate = new Date(nextLesson.stats.nextRecord);
        const now = new Date();
        const diffDays = Math.ceil((lessonDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          await sendMessage(chatId, `Напоминаем о занятии завтра (${formatDate(lessonDate)})`);
        }
      }
    }

    // Уведомление за 3 дня до окончания абонемента
    if (settings.notifyExpiry && user.joins) {
      user.joins.forEach(async join => {
        if (!join.remindDate) return;
        const endDate = new Date(join.remindDate);
        const now = new Date();
        const diffDays = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays === 3) {
          await sendMessage(chatId, `⚠️ Ваш абонемент заканчивается через 3 дня!`);
        }
      });
    }
  }
}

// =======================
// Планировщик cron
// =======================
cron.schedule("0 10 * * *", () => {
  console.log("Проверяем уведомления...");
  checkNotifications();
});

// =======================
// Запуск сервера
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
