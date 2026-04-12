import express from "express";

const app = express();
app.use(express.json());

// =======================
// ENV
// =======================
const BOT_TOKEN = process.env.BOT_TOKEN;

// =======================
// Telegram API
// =======================
async function sendMessage(chatId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...extra,
      }),
    });
  } catch (e) {
    console.error("sendMessage error:", e);
  }
}

async function answerCallbackQuery(id, text = "") {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: id,
        text,
      }),
    });
  } catch (e) {
    console.error("callback error:", e);
  }
}

// =======================
// /webhook
// =======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;

  // =======================
  // CALLBACK BUTTONS
  // =======================
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    await answerCallbackQuery(cb.id);

    if (data === "remind_yes") {
      await sendMessage(chatId, "Выберите время:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "10:00", callback_data: "time_10" },
              { text: "14:00", callback_data: "time_14" },
              { text: "20:00", callback_data: "time_20" },
            ],
          ],
        },
      });
    }

    if (data === "remind_no") {
      await sendMessage(chatId, "Ок, без напоминаний.");
    }

    return;
  }

  // =======================
  // MESSAGE
  // =======================
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = message.text;

  // =======================
  // START
  // =======================
  if (text === "/start") {
    await sendMessage(chatId, "Привет! Нажми кнопку и отправь контакт 👇", {
      reply_markup: {
        keyboard: [
          [{ text: "📱 Поделиться контактом", request_contact: true }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  // =======================
  // CONTACT
  // =======================
  if (message.contact) {
    const phone = message.contact.phone_number;

    await sendMessage(
      chatId,
      `Спасибо! Ваш номер: ${phone}\nВключить напоминания?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Да", callback_data: "remind_yes" },
              { text: "Нет", callback_data: "remind_no" },
            ],
          ],
        },
      }
    );
    return;
  }

  // =======================
  // DEFAULT
  // =======================
  await sendMessage(chatId, "Используй /start");
});

// =======================
// START SERVER (Render fix)
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Bot started on port", PORT);
});
