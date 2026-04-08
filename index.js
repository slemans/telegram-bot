import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// In-memory state for reminders.
// If app restarts, this state resets.
const reminderJobs = new Map();
const availableSubscriptions = new Map();

// =======================
// Telegram
// =======================
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra
    })
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
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
    `https://api.moyklass.com/v1/company/users?phone=${phone}&limit=1`,
    {
      headers: { "x-access-token": token }
    }
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0] || null;
}

async function getClassNameById(classId, token) {
  if (!classId) return "Группа не указана";

  const res = await fetch(`https://api.moyklass.com/v1/company/classes/${classId}`, {
    headers: { "x-access-token": token }
  });

  if (!res.ok) return `Группа ${classId}`;
  const data = await res.json();
  return data.name || `Группа ${classId}`;
}

// =======================
// Берем только активные абонементы (statusId = 2)
// и считаем остаток посещений.
// =======================
async function getSubscriptions(userId) {
  const token = await getToken();

  const res = await fetch(
    `https://api.moyklass.com/v1/company/userSubscriptions?userId=${userId}&statusId=2&limit=100`,
    {
      headers: { "x-access-token": token }
    }
  );

  if (!res.ok) return [];
  const data = await res.json();
  const subs = data.subscriptions || [];

  const preparedSubs = subs
    .map(sub => {
      let remaining = null;

      if (sub.visitCount != null && sub.visitedCount != null) {
        remaining = Math.max(0, sub.visitCount - sub.visitedCount);
      }

      return {
        id: sub.id,
        externalId: sub.externalId ?? null,
        endDate: sub.endDate ?? null,
        visitCount: sub.visitCount ?? null,
        visitedCount: sub.visitedCount ?? null,
        remaining,
        statusId: sub.statusId,
        mainClassId: sub.mainClassId ?? null
      };
    })
    .filter(sub => sub.remaining == null || sub.remaining > 0);

  return Promise.all(
    preparedSubs.map(async sub => ({
      ...sub,
      className: await getClassNameById(sub.mainClassId, token)
    }))
  );
}

function formatDate(dateString) {
  if (!dateString) return "не указана";
  return new Date(dateString).toLocaleDateString("ru-RU");
}

function isValidPhoneInput(text) {
  return /^\d{12}$/.test(text.trim());
}

function formatIsoDay(date) {
  return date.toISOString().slice(0, 10);
}

function getReminderDateIso(endDate) {
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  const reminderDate = new Date(end.getTime() - 3 * ONE_DAY_MS);
  return formatIsoDay(reminderDate);
}

async function processScheduledReminders() {
  const todayIso = formatIsoDay(new Date());

  for (const [key, reminder] of reminderJobs.entries()) {
    if (reminder.sent) continue;
    if (reminder.remindOnIso !== todayIso) continue;

    await sendMessage(
      reminder.chatId,
      `⏰ Ваш абонемент "${reminder.className}" скоро закончится (${formatDate(
        reminder.endDate
      )}), не забудьте продлить.`
    );

    reminderJobs.set(key, { ...reminder, sent: true });
  }
}

setInterval(() => {
  processScheduledReminders().catch(err => {
    console.error("Failed to process reminders:", err);
  });
}, 60 * 60 * 1000);

// =======================
// Webhook
// =======================
app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const callbackQuery = req.body.callback_query;
  if (callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const callbackData = callbackQuery.data || "";

    if (!chatId || !callbackData) {
      await answerCallbackQuery(callbackQuery.id, "Некорректные данные.");
      return;
    }

    const [action, subIdRaw] = callbackData.split(":");
    const subId = Number.parseInt(subIdRaw, 10);
    const subscriptionKey = `${chatId}:${subId}`;
    const sub = availableSubscriptions.get(subscriptionKey);

    if (!sub) {
      await answerCallbackQuery(callbackQuery.id, "Абонемент не найден.");
      return;
    }

    if (action === "reminder_yes") {
      const remindOnIso = getReminderDateIso(sub.endDate);
      if (!remindOnIso || sub.endDate == null) {
        await answerCallbackQuery(callbackQuery.id, "Не удалось поставить напоминание.");
        return;
      }

      reminderJobs.set(subscriptionKey, {
        chatId,
        subscriptionId: sub.id,
        className: sub.className,
        endDate: sub.endDate,
        remindOnIso,
        sent: false
      });

      await answerCallbackQuery(callbackQuery.id, "Напоминание включено.");
      await sendMessage(
        chatId,
        `✅ Напоминание включено для "${sub.className}". Напишу за 3 дня до окончания (${formatDate(
          sub.endDate
        )}).`
      );
      return;
    }

    if (action === "reminder_no") {
      reminderJobs.delete(subscriptionKey);
      await answerCallbackQuery(callbackQuery.id, "Ок, без напоминания.");
      await sendMessage(chatId, `Ок, для "${sub.className}" напоминание не включено.`);
      return;
    }

    await answerCallbackQuery(callbackQuery.id, "Неизвестная команда.");
    return;
  }

  const message = req.body.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;
  if (!text) return;

  if (text === "/start") {
    await sendMessage(chatId, "Отправь номер телефона в формате 375295781758 (только цифры) 📱");
    return;
  }

  if (!isValidPhoneInput(text)) {
    await sendMessage(
      chatId,
      "❌ Некорректный номер.\nВведите номер только цифрами в формате: 375295781758"
    );
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const subs = await getSubscriptions(user.id);

  if (subs.length === 0) {
    await sendMessage(chatId, "❌ Активных абонементов с остатком не найдено");
    return;
  }

  let response = `✅ Клиент найден: ${user.name}`;
  response += "\n\n🎫 Активные абонементы:";

  subs.forEach((sub, i) => {
    const remainingText =
      sub.remaining == null
        ? "безлимит"
        : `${sub.remaining} (из ${sub.visitCount ?? "?"})`;

    response += `
${i + 1}. ${sub.className}
- Осталось занятий: ${remainingText}
- Действует до: ${formatDate(sub.endDate)}
`;
  });

  await sendMessage(chatId, response);

  for (const sub of subs) {
    const subscriptionKey = `${chatId}:${sub.id}`;
    availableSubscriptions.set(subscriptionKey, sub);

    await sendMessage(chatId, "Хотите получать уведомления за 3 дня до окончания абонемента?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Да", callback_data: `reminder_yes:${sub.id}` },
            { text: "Нет", callback_data: `reminder_no:${sub.id}` }
          ]
        ]
      }
    });
  }
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
