import express from "express";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MOYK_API_KEY = process.env.MOYK_API_KEY;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// In-memory state for dialog and reminders.
// If app restarts, this state resets.
const pendingSubscriptionChoice = new Map();
const pendingReminderConfirm = new Map();
const reminderJobs = new Map();

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

function normalizeText(text) {
  return text.trim().toLowerCase();
}

function isYes(text) {
  const normalized = normalizeText(text);
  return normalized === "да" || normalized === "yes" || normalized === "y";
}

function isNo(text) {
  const normalized = normalizeText(text);
  return normalized === "нет" || normalized === "no" || normalized === "n";
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

  const message = req.body.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;
  if (!text) return;

  if (text === "/start") {
    await sendMessage(chatId, "Отправь номер телефона 📱");
    return;
  }

  const pendingChoice = pendingSubscriptionChoice.get(chatId);
  if (pendingChoice) {
    const selectedIndex = Number.parseInt(text, 10) - 1;
    const selectedSub = pendingChoice.subscriptions[selectedIndex];

    if (!selectedSub) {
      await sendMessage(chatId, "Выберите номер абонемента из списка (например: 1).");
      return;
    }

    pendingSubscriptionChoice.delete(chatId);
    pendingReminderConfirm.set(chatId, {
      userName: pendingChoice.userName,
      subscription: selectedSub
    });

    await sendMessage(
      chatId,
      `Напомнить за 3 дня до окончания абонемента "${selectedSub.className}"?\nОтветь: Да или Нет`
    );
    return;
  }

  const pendingConfirm = pendingReminderConfirm.get(chatId);
  if (pendingConfirm) {
    if (isYes(text)) {
      const { subscription, userName } = pendingConfirm;
      const remindOnIso = getReminderDateIso(subscription.endDate);

      if (!remindOnIso || subscription.endDate == null) {
        await sendMessage(chatId, "Не удалось поставить напоминание: у абонемента не указана дата окончания.");
        pendingReminderConfirm.delete(chatId);
        return;
      }

      const reminderKey = `${chatId}:${subscription.id}`;
      reminderJobs.set(reminderKey, {
        chatId,
        userName,
        subscriptionId: subscription.id,
        className: subscription.className,
        endDate: subscription.endDate,
        remindOnIso,
        sent: false
      });

      pendingReminderConfirm.delete(chatId);
      await sendMessage(
        chatId,
        `✅ Отлично! Напомню за 3 дня до окончания (${formatDate(subscription.endDate)}).`
      );
      return;
    }

    if (isNo(text)) {
      pendingReminderConfirm.delete(chatId);
      await sendMessage(chatId, "Ок, напоминание не включено.");
      return;
    }

    await sendMessage(chatId, "Пожалуйста, ответь: Да или Нет.");
    return;
  }

  const phone = normalizePhone(text);
  const user = await findUserByPhone(phone);

  if (!user) {
    await sendMessage(chatId, "❌ Пользователь не найден");
    return;
  }

  const subs = await getSubscriptions(user.id);

  let response = `✅ Клиент найден: ${user.name}`;

  if (subs.length === 0) {
    response += "\n\n❌ Активных абонементов с остатком нет";
    await sendMessage(chatId, response);
    return;
  }

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
  pendingSubscriptionChoice.set(chatId, {
    userName: user.name,
    subscriptions: subs
  });
  await sendMessage(
    chatId,
    "Выберите абонемент для напоминания: отправьте номер из списка (1, 2, 3...)."
  );
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
