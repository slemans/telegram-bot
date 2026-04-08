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
});

// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
