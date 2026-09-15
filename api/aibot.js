const https = require("https");
const OpenAI = require("openai");
const Redis = require("ioredis");

// 1. Khởi tạo OpenAI Client kết nối tới NVIDIA API
const openai = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY,
});

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_AI;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const RAM_TTL_MS = 1 * 60 * 1000;
const REDIS_TTL_SEC = 180 * 60;
const MAX_MESSAGES = 20;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || 
  "";

// Cấu hình Model
const TEXT_MODEL = "deepseek-ai/deepseek-v4-flash-0731"; // Model cho Chat/Logic
const VISION_MODEL = "nvidia/neva-22b"; // Model fallback nếu có ảnh/sticker (NVIDIA Vision)

const ramCache = new Map();
let cachedBotUsername = null;

// Lấy thông tin Username của Bot
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

// Chuyển File Telegram (Ảnh/Sticker) thành Base64
async function getTelegramFileBase64(fileId) {
  try {
    const fileRes = await fetch(`${TELEGRAM_API_URL}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const imgRes = await fetch(`${TELEGRAM_FILE_URL}/${fileData.result.file_path}`);
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error("Lỗi tải file từ Telegram:", error);
    return null;
  }
}

// Kiểm tra xem Bot có được kích hoạt trong Group hay không
function shouldRespondInGroup(message, text, botUsername) {
  const chatType = message.chat.type;

  // Nếu là chat riêng tư với Bot -> Always Yes
  if (chatType === "private") return true;

  const lowerText = text.toLowerCase();

  // 1. Tag tên bot (@botusername)
  if (botUsername && lowerText.includes(`@${botUsername}`)) return true;

  // 2. Reply lại tin nhắn của Bot
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername) return true;

  // 3. Có chứa từ khóa "chan" (hoặc "chan " / "chan,")
  if (/\bchan\b/i.test(lowerText)) return true;

  return false;
}

// Bật trạng thái "typing..."
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

// Quản lý Bộ nhớ Chat (Redis + RAM Cache)
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

// Gửi tin nhắn Telegram (Hỗ trợ Reply tin nhắn gốc)
async function sendMessageRaw(chatId, text, messageId = null, replyToMessageId = null, parseMode = "Markdown") {
  return new Promise((resolve, reject) => {
    const method = messageId ? "editMessageText" : "sendMessage";
    const payload = {
      chat_id: chatId,
      text: text,
    };

    if (parseMode) payload.parse_mode = parseMode;
    if (messageId) {
      payload.message_id = messageId;
    } else if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId; // Reply câu hỏi gốc
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

// Xử lý gọi NVIDIA API với OpenAI Format
async function processNvidiaAiResponse(chatId, userContent, originalMessageId) {
  try {
    sendChatAction(chatId, "typing").catch(() => {});

    const history = await getChatMemory(chatId);

    // Chuẩn bị danh sách Message theo chuẩn OpenAI
    const messagesPayload = [
      { role: "system", content: CUSTOM_PERSONALITY },
      ...history,
      { role: "user", content: userContent }
    ];

    // Kiểm tra xem userContent có chứa Hình ảnh/Sticker hay không
    const hasImage = Array.isArray(userContent) && userContent.some(item => item.type === "image_url");
    const selectedModel = hasImage ? VISION_MODEL : TEXT_MODEL;

    const extraBody = !hasImage ? { chat_template_kwargs: { thinking: true, reasoning_effort: "high" } } : {};

    const completion = await openai.chat.completions.create({
      model: selectedModel,
      messages: messagesPayload,
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: 4096,
      extra_body: extraBody
    });

    const aiMessage = completion.choices[0]?.message?.content || "Xin lỗi, tôi không thể phản hồi lúc này.";

    // Gửi tin nhắn trả lời và REPLY trực tiếp tin nhắn gốc
    await sendOrUpdateMessage(chatId, aiMessage, null, originalMessageId, "Markdown");

    // Lưu lại lịch sử trò chuyện (Chỉ lưu dạng text rút gọn để tiết kiệm bộ nhớ)
    const textOnlyPrompt = typeof userContent === "string" 
      ? userContent 
      : userContent.find(c => c.type === "text")?.text || "[Gửi hình ảnh/sticker]";

    history.push({ role: "user", content: textOnlyPrompt });
    history.push({ role: "assistant", content: aiMessage });
    await saveChatMemory(chatId, history);

  } catch (error) {
    console.error("Lỗi NVIDIA API:", error);
    await sendOrUpdateMessage(
      chatId,
      "❌ *Đã xảy ra lỗi khi kết nối AI.*",
      null,
      originalMessageId,
      "Markdown"
    );
  }
}

// Xử lý Update từ Telegram Webhook
async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const originalMessageId = message.message_id;
  const rawText = message.text || message.caption || "";
  const botUsername = await getBotUsername();

  // 1. Xử lý Lệnh cơ bản (/start, /clearmy)
  if (rawText.startsWith("/start")) {
    await sendOrUpdateMessage(
      chatId,
      "👋 *Xin chào!*\n\nTôi là Bot AI nhóm thông minh.\n\n" +
      "💬 *Cách dùng trong Group:*\n" +
      "- Tag tên `@bot` hoặc Reply tin nhắn của bot.\n" +
      "- Gọi tên `chan` trong câu nói.\n" +
      "- Gửi ảnh hoặc Sticker đi kèm câu hỏi.",
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

  // 2. Lọc kích hoạt trong nhóm
  if (!shouldRespondInGroup(message, rawText, botUsername)) {
    return;
  }

  // 3. Trích xuất tên người dùng
  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Người dùng";
  const senderHandle = message.from?.username ? `@${message.from.username}` : "";
  const userHeader = `[Người gửi: ${senderName} ${senderHandle}]`;

  // 4. Xử lý nội dung Đa phương tiện (Text / Photo / Sticker)
  let userContentPayload = [];
  let base64Image = null;

  // Lấy file_id từ Sticker hoặc Photo
  if (message.sticker) {
    const fileId = message.sticker.file_id;
    base64Image = await getTelegramFileBase64(fileId);
  } else if (message.photo && message.photo.length > 0) {
    // Lấy ảnh có độ phân giải cao nhất (phần tử cuối)
    const fileId = message.photo[message.photo.length - 1].file_id;
    base64Image = await getTelegramFileBase64(fileId);
  }

  const promptText = `${userHeader}: ${rawText || "(Gửi hình ảnh/sticker)"}`;

  if (base64Image) {
    userContentPayload = [
      { type: "text", text: promptText },
      { type: "image_url", image_url: { url: base64Image } }
    ];
  } else {
    userContentPayload = promptText;
  }

  // 5. Gọi AI trả lời
  await processNvidiaAiResponse(chatId, userContentPayload, originalMessageId);
}

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      if (req.body?.update_id) {
        await handleUpdate(req.body);
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Serverless Error:", error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
};
