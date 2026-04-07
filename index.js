import express from "express";
import cron from "node-cron";
import fs from "fs";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;

const USERS_FILE = "./users.json";
let users = new Map();

// Загрузка пользователей
try {
  const raw = fs.readFileSync(USERS_FILE);
  const json = JSON.parse(raw);
  users = new Map(Object.entries(json));
  console.log("Загружены пользователи из файла:", users.size);
} catch (err) {
  console.log("Файл пользователей не найден, создаем новый");
}

function saveUsers() {
  const obj = Object.fromEntries(users);
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}

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

async function getNextLesson(user) {
  const token = await getToken();

  const now = new Date().toISOString();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/records?userId=${user.id}&dateFrom=${now}`,
    {
      headers: { "x-access-token": token }
    }
  );

  const data = await res.json();

  if (!data.records || data.records.length === 0) return null;

  const upcoming = data.records
    .filter(r => r.date) // есть дата
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const lesson = upcoming[0];

  return {
    date: lesson.date,
    className: lesson.class?.name ?? "не указано",
    trainer: lesson.trainer?.name ?? "не указан",
    schedule: lesson.class?.schedule ?? "не указано"
  };
}

// =======================
// Telegram webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (!body.message) return;

  const chatId = body.message.chat.id;
  const text = body.message.text;

  if (text === "/start") {
    await sendMessage(chatId, "Привет! Отправь свой номер телефона 📱");
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  // Создаем или обновляем настройки пользователя
  users.set(chatId, { phone, notifyLessons: false, notifyExpiry: false });
  saveUsers();

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
    return; // не показываем кнопки уведомлений
  }

  message += `\n📌 Следующее занятие (${formatDate(nextLesson.date)}):
- Название группы: ${nextLesson.className} 
- Тренер: ${nextLesson.trainer}
- Дни и время: ${nextLesson.schedule}
`;

  // Кнопки уведомлений только если есть занятие
  const buttons = [
    [
      { text: "Да ✅", callback_data: "notify_lessons_yes" },
      { text: "Нет ❌", callback_data: "notify_lessons_no" }
    ]
  ];
  await sendMessage(chatId, message + "\nХотите получать уведомление за день до занятия?", buttons);

  const buttonsExpiry = [
    [
      { text: "Да ✅", callback_data: "notify_expiry_yes" },
      { text: "Нет ❌", callback_data: "notify_expiry_no" }
    ]
  ];
  await sendMessage(chatId, "Хотите получать уведомления за 3 дня до окончания абонемента?", buttonsExpiry);
});

// =======================
// Inline кнопки
// =======================
app.post(`/bot${BOT_TOKEN}/callback`, async (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (!body.callback_query) return;

  const chatId = body.callback_query.message.chat.id;
  const data = body.callback_query.data;

  if (!users.has(chatId)) return;
  const userSettings = users.get(chatId);

  if (data === "notify_lessons_yes") userSettings.notifyLessons = true;
  if (data === "notify_lessons_no") userSettings.notifyLessons = false;
  if (data === "notify_expiry_yes") userSettings.notifyExpiry = true;
  if (data === "notify_expiry_no") userSettings.notifyExpiry = false;

  users.set(chatId, userSettings);
  saveUsers();

  await sendMessage(chatId, "Настройки уведомлений обновлены ✅");
});

// =======================
// Уведомления
// =======================
async function checkNotifications() {
  if (users.size === 0) return;

  const token = await getToken();
  for (const [chatId, settings] of users.entries()) {
    const user = await findUserByPhone(settings.phone);
    if (!user) continue;

    if (settings.notifyLessons) {
      const nextLesson = getNextLesson(user);
      if (nextLesson) {
        const lessonDate = new Date(nextLesson.date);
        const now = new Date();
        const diffDays = Math.ceil((lessonDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          await sendMessage(chatId, `Напоминаем о занятии завтра (${formatDate(lessonDate)})`);
        }
      }
    }

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
// Cron
// =======================
cron.schedule("0 10 * * *", () => {
  console.log("Проверяем уведомления...");
  checkNotifications();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
