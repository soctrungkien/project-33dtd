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

// Tỉ lệ tự động nhắn trong nhóm
const AUTO_RESPONSE_CHANCE = parseFloat("0.01");

const RAM_TTL_MS = 1 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;
const MAX_MESSAGES = 20;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || "";

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
let cachedBotInfo = null;

async function getBotInfo() {
  if (cachedBotInfo) return cachedBotInfo;
  try {
    const res = await fetch(`${TELEGRAM_API_URL}/getMe`);
    const data = await res.json();
    if (data.ok && data.result) {
      cachedBotInfo = {
        id: data.result.id,
        username: data.result.username.toLowerCase()
      };
      return cachedBotInfo;
    }
  } catch (e) {
    console.error("Lỗi getMe:", e);
  }
  return { id: null, username: "" };
}

// 1. Lấy thông tin chi tiết của Nhóm/Kênh (Mô tả, Invite Link, Linked Chat ID)
async function getChatMetadata(chatId) {
  try {
    const res = await fetch(`${TELEGRAM_API_URL}/getChat?chat_id=${chatId}`);
    const data = await res.json();
    if (data.ok) return data.result;
  } catch (e) {
    console.error("Lỗi getChat:", e);
  }
  return null;
}

// 2. Lấy toàn bộ danh sách Owners và Admins trong nhóm
async function getGroupAdminsList(chatId) {
  try {
    const res = await fetch(`${TELEGRAM_API_URL}/getChatAdministrators?chat_id=${chatId}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.result)) {
      const owners = [];
      const admins = [];
      data.result.forEach(member => {
        const name = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ") || "N/A";
        const username = member.user.username ? `@${member.user.username}` : "Không có";
        const info = `${name} (${username} | ID: ${member.user.id})`;
        if (member.status === "creator") owners.push(info);
        else if (member.status === "administrator") admins.push(info);
      });
      return { owners, admins };
    }
  } catch (error) {
    console.error("Lỗi getChatAdministrators:", error);
  }
  return { owners: [], admins: [] };
}

// 3. Kiểm tra vai trò của người gửi
async function getUserRole(chatId, userId, chatType) {
  if (chatType === "private") return "Trò chuyện cá nhân";
  try {
    const res = await fetch(`${TELEGRAM_API_URL}/getChatMember?chat_id=${chatId}&user_id=${userId}`);
    const data = await res.json();
    if (data.ok && data.result) {
      const status = data.result.status;
      if (status === "creator") return "Chủ nhóm (Owner/Creator)";
      if (status === "administrator") return "Quản trị viên (Admin)";
      return "Thành viên (Member)";
    }
  } catch (error) {
    console.error("Lỗi getChatMember:", error);
  }
  return "Thành viên";
}

// 4. Thả cảm xúc Emoji vào tin nhắn Telegram
async function setMessageReaction(chatId, messageId, emoji = "👍") {
  try {
    await fetch(`${TELEGRAM_API_URL}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: emoji }]
      })
    });
  } catch (error) {
    console.error("Lỗi thả cảm xúc:", error);
  }
}

// 5. Gửi Sticker Telegram
async function sendSticker(chatId, fileId, replyToMessageId = null) {
  try {
    const payload = { chat_id: chatId, sticker: fileId };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

    await fetch(`${TELEGRAM_API_URL}/sendSticker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("Lỗi gửi Sticker:", error);
  }
}

// 6. Tìm kiếm Web (DuckDuckGo Lite)
async function searchDuckDuckGo(query) {
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: `q=${encodeURIComponent(query)}`
    });
    const html = await res.text();
    
    // Tìm các đoạn snippet thông tin từ giao diện Lite
    const matches = [...html.matchAll(/class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi)];
    
    if (matches.length > 0) {
      const snippets = matches.slice(0, 4).map(m => m[1].replace(/<[^>]+>/g, '').trim()).join("\n- ");
      return `Kết quả tìm kiếm cho "${query}":\n- ${snippets}`;
    }
    
    // Fallback cho bản HTML thường nếu bản Lite bị lỗi
    const htmlMatches = [...html.matchAll(/<a class="result__snippet[^>]*>(.*?)<\/a>/g)];
    if (htmlMatches.length > 0) {
      const snippets = htmlMatches.slice(0, 4).map(m => m[1].replace(/<[^>]+>/g, '').trim()).join("\n- ");
      return `Kết quả tìm kiếm cho "${query}":\n- ${snippets}`;
    }

    return "Không tìm thấy kết quả hoặc dịch vụ tìm kiếm tạm thời bị chặn.";
  } catch (e) {
    return `Lỗi khi tìm kiếm: ${e.message}`;
  }
}

// 7. Lấy thời tiết an toàn
async function getWeather(location) {
  try {
    // Dùng User-Agent là curl để wttr.in ưu tiên trả về phản hồi không bị chặn
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=vi`, {
      headers: { "User-Agent": "curl/7.68.0" }
    });
    
    if (!res.ok) {
      return `Không thể lấy thông tin thời tiết lúc này (Lỗi Server: ${res.status}).`;
    }
    
    const text = await res.text();
    let data;
    try {
      // Phân tích cú pháp an toàn, tránh bị crash bot nếu server trả về HTML báo lỗi
      data = JSON.parse(text);
    } catch (err) {
      return "Dịch vụ thời tiết đang quá tải hoặc trả về dữ liệu lỗi. Vui lòng thử lại sau.";
    }

    const current = data.current_condition[0];
    const area = data.nearest_area[0]?.areaName[0]?.value || location;
    const desc = current.lang_vi?.[0]?.value || current.weatherDesc[0]?.value;
    
    return `Thời tiết tại ${area}: ${desc}, Nhiệt độ: ${current.temp_C}°C (Cảm giác như ${current.FeelsLikeC}°C), Độ ẩm: ${current.humidity}%, Sức gió: ${current.windspeedKmph} km/h.`;
  } catch (e) {
    return `Lỗi kết nối dịch vụ thời tiết: ${e.message}`;
  }
}

// 8. Lấy thời gian Việt Nam
function getVietnamTimeString() {
  return new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

// Lấy buffer file
async function getTelegramFileBuffer(fileId) {
  try {
    const fileRes = await fetch(`${TELEGRAM_API_URL}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result?.file_path) return null;

    const imgRes = await fetch(`${TELEGRAM_FILE_URL}/${fileData.result.file_path}`);
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
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

// Kiểm tra điều kiện phản hồi trong nhóm (Đã thêm Tỉ lệ Auto & Đọc bài kênh liên kết)
function shouldRespondInGroup(message, text, botUsername) {
  if (message.chat.type === "private") return true;

  // 1. Tự động phản hồi tin nhắn forwarded tự động từ Kênh liên kết
  if (message.is_automatic_forward) return true;

  const lowerText = text.toLowerCase();

  // 2. Được Tag
  if (botUsername && lowerText.includes(`@${botUsername}`)) return true;

  // 3. Reply tin nhắn của Bot
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername) return true;

  // 4. Có từ khóa "chan"
  if (/\bchan\b/i.test(lowerText)) return true;

  // 5. Tỉ lệ ngẫu nhiên tự động nhắn
  if (Math.random() < AUTO_RESPONSE_CHANCE) return true;

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
    const errStr = error.message || "";
    
    // 1. Lỗi parse Markdown -> gửi lại văn bản thô (không dùng parseMode)
    if (parseMode && errStr.includes("can't parse entities")) {
      return await sendMessageRaw(chatId, text, messageId, replyToMessageId, null);
    }
    
    // 2. Lỗi tin nhắn gốc đã bị xóa -> gửi lại tin nhắn mới (không reply nữa)
    if (errStr.includes("message to be replied not found") || errStr.includes("reply message not found")) {
      return await sendMessageRaw(chatId, text, messageId, null, parseMode);
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

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description: "Tìm kiếm thông tin thực tế hoặc tin tức trên internet qua DuckDuckGo.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Từ khóa cần tìm kiếm" }
          },
          required: ["query"]
        }
      },
      {
        name: "get_weather",
        description: "Lấy thông tin thời tiết hiện tại của một địa điểm.",
        parameters: {
          type: "OBJECT",
          properties: {
            location: { type: "STRING", description: "Tên địa điểm hoặc thành phố" }
          },
          required: ["location"]
        }
      },
      {
        name: "react_message",
        description: "Thả cảm xúc emoji vào tin nhắn vừa nhận.",
        parameters: {
          type: "OBJECT",
          properties: {
            emoji: { type: "STRING", description: "Emoji cần thả (👍, ❤️, 🔥, 😂, 👏, 🤔, v.v.)" }
          },
          required: ["emoji"]
        }
      },
      {
        name: "send_sticker",
        description: "Gửi sticker bằng Telegram file_id.",
        parameters: {
          type: "OBJECT",
          properties: {
            file_id: { type: "STRING", description: "Telegram sticker file_id" }
          },
          required: ["file_id"]
        }
      }
    ]
  }
];

async function generateGeminiWithRotation(historyMessages, userParts, chatId, originalMessageId) {
  let lastError = null;

  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const indexToTry = (currentModelIndex + i) % GEMINI_MODELS.length;
    const modelName = GEMINI_MODELS[indexToTry];

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: CUSTOM_PERSONALITY,
        tools: GEMINI_TOOLS
      });

      const formattedHistory = buildGeminiHistory(historyMessages);
      const chat = model.startChat({ history: formattedHistory });

      let result = await chat.sendMessage(userParts);
      let calls = result.response.functionCalls();

      while (calls && calls.length > 0) {
        const call = calls[0];
        let toolResponse = null;

        if (call.name === "web_search") {
          toolResponse = await searchDuckDuckGo(call.args.query);
        } else if (call.name === "get_weather") {
          toolResponse = await getWeather(call.args.location);
        } else if (call.name === "react_message") {
          await setMessageReaction(chatId, originalMessageId, call.args.emoji);
          toolResponse = { success: true, detail: `Đã thả cảm xúc ${call.args.emoji}` };
        } else if (call.name === "send_sticker") {
          await sendSticker(chatId, call.args.file_id, originalMessageId);
          toolResponse = { success: true, detail: `Đã gửi sticker` };
        }

        result = await chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: typeof toolResponse === 'object' ? toolResponse : { result: toolResponse }
            }
          }
        ]);
        calls = result.response.functionCalls();
      }

      const responseText = result.response.text();
      currentModelIndex = (indexToTry + 1) % GEMINI_MODELS.length;
      return responseText;
    } catch (error) {
      console.warn(`[Gemini] Model ${modelName} gặp lỗi/bị rate-limit: ${error.message}. Chuyển model...`);
      lastError = error;
    }
  }

  throw lastError || new Error("Tất cả các model Gemini đều không phản hồi.");
}

async function processGeminiResponse(chatId, userParts, promptTextOnly, originalMessageId) {
  try {
    sendChatAction(chatId, "typing").catch(() => {});

    const historyMessages = await getChatMemory(chatId);
    const aiResponseText = await generateGeminiWithRotation(historyMessages, userParts, chatId, originalMessageId);

    if (aiResponseText) {
      await sendOrUpdateMessage(chatId, aiResponseText, null, originalMessageId, "Markdown");

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
  const botInfo = await getBotInfo();

  if (rawText.startsWith("/start")) {
    await sendOrUpdateMessage(
      chatId,
      "👋 *Xin chào!*\n\nTôi là Bot AI.\n\n" +
      "💬 *Cách tương tác trong nhóm:*\n" +
      "/clearmy để xóa bộ nhớ trò chuyện",
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

  // Lọc điều kiện phản hồi trong nhóm
  if (!shouldRespondInGroup(message, rawText, botInfo.username)) {
    return;
  }

  // Thông tin người gửi
  const uid = message.from?.id || "N/A";
  const firstName = message.from?.first_name || "";
  const lastName = message.from?.last_name || "";
  const senderName = [firstName, lastName].filter(Boolean).join(" ") || "Người dùng";
  const senderHandle = message.from?.username ? `@${message.from.username}` : "Không có";

  const userRole = await getUserRole(chatId, uid, message.chat.type);

  // Thu thập thông tin nhóm & kênh liên kết nếu ở trong nhóm
  let groupDetailsStr = "";
  if (message.chat.type !== "private") {
    const chatMetadata = await getChatMetadata(chatId);
    const adminData = await getGroupAdminsList(chatId);

    let linkedChannelInfo = "Không kết nối kênh nào";
    if (chatMetadata?.linked_chat_id) {
      const channelMeta = await getChatMetadata(chatMetadata.linked_chat_id);
      if (channelMeta) {
        linkedChannelInfo = `Tên kênh: "${channelMeta.title || 'N/A'}" | ID: ${channelMeta.id} | Username: ${channelMeta.username ? '@' + channelMeta.username : 'Riêng tư'} | Link: ${channelMeta.invite_link || 'Không có'}`;
      }
    }

    const ownersList = adminData.owners.length > 0 ? adminData.owners.join("; ") : "Không xác định";
    const adminsList = adminData.admins.length > 0 ? adminData.admins.join("; ") : "Không có";

    groupDetailsStr = `\n[Thông tin Nhóm Hiện Tại]:\n` +
      `- Tên nhóm: "${chatMetadata?.title || message.chat.title || 'N/A'}"\n` +
      `- Mô tả nhóm: "${chatMetadata?.description || 'Không có'}"\n` +
      `- Link nhóm: "${chatMetadata?.invite_link || 'Không có'}"\n` +
      `- Chủ nhóm (Owners): ${ownersList}\n` +
      `- Danh sách Quản trị viên (Admins): ${adminsList}\n` +
      `- Kênh liên kết với nhóm: [${linkedChannelInfo}]`;
  }

  // Cờ nhận biết tin nhắn đăng từ Kênh liên kết
  const channelPostNote = message.is_automatic_forward 
    ? " [LƯU Ý: Đây là bài viết tự động gửi từ Kênh liên kết vào nhóm]" 
    : "";

  // Ngữ cảnh Reply
  let replyContext = "";
  if (message.reply_to_message) {
    const rMsg = message.reply_to_message;
    const rFrom = rMsg.from;
    const isBotSelf = rFrom?.id === botInfo.id;
    const rName = [rFrom?.first_name, rFrom?.last_name].filter(Boolean).join(" ") || "Người dùng";
    const rHandle = rFrom?.username ? `@${rFrom.username}` : "Không có";
    const rText = rMsg.text || rMsg.caption || "(Nội dung không phải văn bản/Ảnh/Sticker)";

    replyContext = `\n[Đang trả lời tin nhắn của ${isBotSelf ? "Chính Bot" : `${rName} (${rHandle}, ID: ${rFrom?.id})`}: "${rText}"]`;
  }

  let stickerInfo = "";
  if (message.sticker) {
    stickerInfo = ` [Gửi Sticker file_id: "${message.sticker.file_id}", Emoji: "${message.sticker.emoji || "N/A"}"]`;
  }

  const userHeader = `[Thời gian hiện tại ở Việt Nam: ${getVietnamTimeString()}]\n` +
    `[Người gửi: ${senderName} | Username: ${senderHandle} | UID: ${uid} | Vai trò: ${userRole}]` +
    `${channelPostNote}` +
    `${replyContext}` +
    `${groupDetailsStr}`;

  const promptTextOnly = `${userHeader}\n[Nội dung tin nhắn]: ${rawText}${stickerInfo || " (Gửi phương tiện)"}`;
  const userParts = [{ text: promptTextOnly }];

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
