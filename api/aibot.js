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
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const RAM_TTL_MS = 1 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;
const MAX_MESSAGES = 20;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || 
  "";

// Danh sách các Model Gemini để xoay vòng & dự phòng (Fallback)
const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash",
  "gemini-3.5-flash",
  "gemini-3.6-flash"
];
let currentModelIndex = 0;

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

// Chuyển Ảnh/Sticker trên Telegram thành Buffer/Base64 để Gemini nhận diện
async function getTelegramFileBuffer(fileId) {
  try {
    const fileRes = await fetch(`${TELEGRAM_API_URL}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const imgRes = await fetch(`${TELEGRAM_FILE_URL}/${fileData.result.file_path}`);
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Xác định MIME type sơ bộ
    let mimeType = "image/jpeg";
    if (fileData.result.file_path.endsWith(".png")) mimeType = "image/png";
    if (fileData.result.file_path.endsWith(".webp")) mimeType = "image/webp";

    return {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: mimeType
      }
    };
  } catch (error) {
    console.error("Lỗi tải file Telegram:", error);
    return null;
  }
}

// Kiểm tra điều kiện phản hồi trong nhóm
function shouldRespondInGroup(message, text, botUsername) {
  if (message.chat.type === "private") return true;

  const lowerText = text.toLowerCase();

  // 1. Được Tag
  if (botUsername && lowerText.includes(`@${botUsername}`)) return true;

  // 2. Reply tin nhắn của Bot
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername) return true;

  // 3. Có từ "chan"
  if (/\bchan\b/i.test(lowerText)) return true;

  return false;
}

async function sendChatAction(chatId, action = "typing") {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: chatId, action });
    const req = https.request(
      `${TELEGRAM_API_URL}/sendChatAction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      () => resolve()
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
    if (now - cached.timestamp < RAM_TTL_MS) return cached.data;
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

async function sendMessageRaw(chatId, text, messageId = null, replyToMessageId = null, parseMode = "Markdown") {
  return new Promise((resolve, reject) => {
    const method = messageId ? "editMessageText" : "sendMessage";
    const payload = { chat_id: chatId, text: text };

    if (parseMode) payload.parse_mode = parseMode;
    if (messageId) {
      payload.message_id = messageId;
    } else if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

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
              resolve(response.result?.message_id || messageId);
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

async function sendOrUpdateMessage(chatId, text, messageId = null, replyToMessageId = null, parseMode = "Markdown") {
  try {
    return await sendMessageRaw(chatId, text, messageId, replyToMessageId, parseMode);
  } catch (error) {
    if (parseMode && error.message.includes("can't parse entities")) {
      return await sendMessageRaw(chatId, text, messageId, replyToMessageId, null);
    }
    throw error;
  }
}

function buildGeminiHistory(messages) {
  return messages.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));
}

// Thuật toán xoay vòng & Fallback Model Gemini
async function generateGeminiWithRotation(historyMessages, userParts) {
  let lastError = null;

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    // Tính toán model index theo kiểu xoay vòng Round-Robin
    const indexToTry = (currentModelIndex + i) % GEMINI_MODELS.length;
    const modelName = GEMINI_MODELS[indexToTry];

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: CUSTOM_PERSONALITY,
      });

      const formattedHistory = buildGeminiHistory(historyMessages);
      const chat = model.startChat({ history: formattedHistory });

      const result = await chat.sendMessage(userParts);
      const responseText = result.response.text();

      // Cập nhật index cho lượt gọi tiếp theo (xoay vòng)
      currentModelIndex = (indexToTry + 1) % GEMINI_MODELS.length;
      return responseText;
    } catch (error) {
      console.warn(`[Gemini] Model ${modelName} gặp lỗi/bị rate-limit. Đang chuyển sang model tiếp theo...`);
      lastError = error;
    }
  }

  throw lastError || new Error("Tất cả các model Gemini đều không phản hồi.");
}

async function processGeminiResponse(chatId, userParts, promptTextOnly, originalMessageId) {
  try {
    sendChatAction(chatId, "typing").catch(() => {});

    const historyMessages = await getChatMemory(chatId);

    // Gọi Gemini với cơ chế xoay vòng model
    const aiResponseText = await generateGeminiWithRotation(historyMessages, userParts);

    if (aiResponseText) {
      await sendOrUpdateMessage(chatId, aiResponseText, null, originalMessageId, "Markdown");

      // Luôn chỉ lưu chuỗi text vào Redis memory
      historyMessages.push({ role: "user", content: promptTextOnly });
      historyMessages.push({ role: "model", content: aiResponseText });
      await saveChatMemory(chatId, historyMessages);
    }
  } catch (error) {
    console.error("Lỗi xử lý Gemini:", error);
    await sendOrUpdateMessage(
      chatId,
      `❌ *Đã xảy ra lỗi.* Hiện không thể phản hồi.`,
      null,
      originalMessageId,
      "Markdown"
    );
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const originalMessageId = message.message_id;
  const rawText = message.text || message.caption || "";
  const botUsername = await getBotUsername();

  if (rawText.startsWith("/start")) {
    await sendOrUpdateMessage(
      chatId,
      "👋 *Xin chào!*\n\nTôi là Bot AI.\n\n" +
      "💬 *Cách tương tác trong nhóm:*\n" +
      "/clearmy để ai mất trí nhớ"
      null,
      originalMessageId
    );
    return;
  }

  if (rawText.startsWith("/clearmy")) {
    await clearChatMemory(chatId);
    await sendOrUpdateMessage(chatId, "✅ *Đã xóa bộ nhớ cuộc trò chuyện!*", null, originalMessageId);
    return;
  }

  // Lọc tin nhắn kích hoạt trong nhóm
  if (!shouldRespondInGroup(message, rawText, botUsername)) {
    return;
  }

  // Định danh người dùng
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Người dùng";
  const senderHandle = message.from?.username ? `@${message.from.username}` : "";
  const userHeader = `[Người gửi: ${senderName} ${senderHandle}]`;

  const promptTextOnly = `${userHeader}: ${rawText || "(Gửi hình ảnh/sticker)"}`;
  const userParts = [{ text: promptTextOnly }];

  // Xử lý Sticker / Ảnh đính kèm
  let fileData = null;
  if (message.sticker) {
    fileData = await getTelegramFileBuffer(message.sticker.file_id);
  } else if (message.photo && message.photo.length > 0) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    fileData = await getTelegramFileBuffer(fileId);
  }

  if (fileData) {
    userParts.push(fileData);
  }

  await processGeminiResponse(chatId, userParts, promptTextOnly, originalMessageId);
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
