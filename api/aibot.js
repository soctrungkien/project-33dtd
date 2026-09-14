const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Redis = require("ioredis");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_BOT);

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_AI;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const RAM_TTL_MS = 1 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;
const MAX_MESSAGES = 20;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || 
  "Hãy nói setup BOT_PERSONALITY đi";

const ramCache = new Map();
let cachedBotUsername = null;

async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;

  return new Promise((resolve) => {
    https.get(`${TELEGRAM_API_URL}/getMe`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.ok && data.result?.username) {
            cachedBotUsername = data.result.username.toLowerCase();
            resolve(cachedBotUsername);
          } else {
            resolve("");
          }
        } catch {
          resolve("");
        }
      });
    }).on("error", () => resolve(""));
  });
}

function isCommand(text, commandName, botUsername) {
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  if (firstWord === commandName) return true;
  if (botUsername && firstWord === `${commandName}@${botUsername}`) return true;
  return false;
}

// Bổ sung Action hiển thị trạng thái "Đang nhập..." trên thanh tiêu đề Telegram
async function sendTypingAction(chatId) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: chatId, action: "typing" });
    const req = https.request(
      `${TELEGRAM_API_URL}/sendChatAction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => resolve()
    );
    req.on("error", () => resolve());
    req.write(data);
    req.end();
  });
}

async function getChatMemory(chatId) {
  const now = Date.now();

  if (ramCache.has(chatId)) {
    const cached = ramCache.get(chatId);
    if (now - cached.timestamp < RAM_TTL_MS) {
      return cached.data;
    }
    ramCache.delete(chatId);
  }

  try {
    const data = await redis.get(`chat:${chatId}:memory`);
    if (data) {
      const parsed = JSON.parse(data);
      ramCache.set(chatId, { data: parsed, timestamp: now });
      return parsed;
    }
  } catch (error) {
    console.error("Lỗi đọc Redis:", error);
  }

  return [];
}

async function saveChatMemory(chatId, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  const now = Date.now();

  ramCache.set(chatId, { data: trimmed, timestamp: now });

  try {
    await redis.set(`chat:${chatId}:memory`, JSON.stringify(trimmed), "EX", REDIS_TTL_SEC);
  } catch (error) {
    console.error("Lỗi ghi Redis:", error);
  }
}

async function clearChatMemory(chatId) {
  ramCache.delete(chatId);
  try {
    await redis.del(`chat:${chatId}:memory`);
  } catch (error) {
    console.error("Lỗi xóa Redis:", error);
  }
}

async function sendMessageRaw(chatId, text, messageId = null, parseMode = null) {
  return new Promise((resolve, reject) => {
    const method = messageId ? "editMessageText" : "sendMessage";
    const payload = {
      chat_id: chatId,
      text: text,
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (messageId) payload.message_id = messageId;

    const data = JSON.stringify(payload);
    const req = https.request(
      `${TELEGRAM_API_URL}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const response = JSON.parse(body);
            if (response.ok) {
              resolve(response.result?.message_id);
            } else {
              reject(new Error(`Lỗi Telegram: ${response.description}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Bổ sung cơ chế tự động Fallback Plain Text nếu parse Markdown thất bại
async function sendMessage(chatId, text, messageId = null, parseMode = "HTML") {
  try {
    return await sendMessageRaw(chatId, text, messageId, parseMode);
  } catch (error) {
    if (parseMode && error.message.includes("can't parse entities")) {
      // Gửi lại dưới dạng Plain Text không parse_mode để tránh crash stream
      return await sendMessageRaw(chatId, text, messageId, null);
    }
    throw error;
  }
}

function buildConversationHistory(messages) {
  return messages.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));
}

async function streamGeminiResponse(chatId, userMessage) {
  try {
    // Kích hoạt icon "typing..." chuẩn của Telegram
    sendTypingAction(chatId).catch(() => {});

    const historyMessages = await getChatMemory(chatId);

    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      systemInstruction: CUSTOM_PERSONALITY,
    });

    const formattedHistory = buildConversationHistory(historyMessages);
    const chat = model.startChat({ history: formattedHistory });

    // Thay thế "Thinking..." thành "Đang nhập..."
    let messageId = await sendMessage(chatId, "<i>Đang nhập...</i>", null, "HTML");
    let fullResponse = "";
    let updateCounter = 0;

    const result = await chat.sendMessageStream(userMessage);

    for await (const chunk of result.stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        fullResponse += text;

        if (updateCounter++ % 3 === 0) {
          try {
            messageId = await sendMessage(
              chatId,
              fullResponse,
              messageId,
              "Markdown"
            );
          } catch (e) {
            console.error("Lỗi cập nhật stream:", e.message);
          }
        }
      }
    }

    if (fullResponse) {
      await sendMessage(chatId, fullResponse, messageId, "Markdown");

      historyMessages.push({ role: "user", content: userMessage });
      historyMessages.push({ role: "model", content: fullResponse });
      await saveChatMemory(chatId, historyMessages);
    }
  } catch (error) {
    console.error("Lỗi xử lý Gemini:", error);
    await sendMessage(
      chatId,
      `❌ <b>Đã xảy ra lỗi.</b> Không thể tạo câu trả lời.`,
      null,
      "HTML"
    );
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  const botUsername = await getBotUsername();

  if (isCommand(text, "/start", botUsername)) {
    await sendMessage(
      chatId,
      "👋 <b>Xin chào!</b>\n\nTôi là trợ lý AI thông minh.\n\n" +
      "💬 <b>Hướng dẫn:</b>\n" +
      "- Nhắn tin trực tiếp hoặc nhắn trong nhóm để trò chuyện.\n" +
      "- /clearmy : Xóa bộ nhớ cuộc trò chuyện hiện tại.",
      null,
      "HTML"
    );
    return;
  }

  if (isCommand(text, "/clearmy", botUsername)) {
    await clearChatMemory(chatId);
    await sendMessage(chatId, "✅ <b>Đã xóa lịch sử trò chuyện của đoạn chat me!</b>", null, "HTML");
    return;
  }

  const baseCmd = text.split(/\s+/)[0].split("@")[0];
  if (text.startsWith("/") && text.includes("@") && !isCommand(text, baseCmd, botUsername)) {
    return;
  }

  await streamGeminiResponse(chatId, text);
}

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      if (req.body?.update_id) {
        await handleUpdate(req.body);
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Lỗi Serverless:", error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
};
