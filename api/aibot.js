const https = require("https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
});
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEY_BOT || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

if (GEMINI_API_KEYS.length === 0) {
  throw new Error("Chưa cấu hình GEMINI_API_KEYS");
}

const geminiClients = GEMINI_API_KEYS.map((key) => new GoogleGenerativeAI(key));

let currentApiKeyIndex = 0;

const hide_text = "ㅤ";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_AI;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_GENERATED_FILE_SIZE = 10 * 1024 * 1024;

// Tỉ lệ tự động nhắn trong nhóm
const AUTO_RESPONSE_CHANCE = parseFloat("0.00001"); // 0.001%

const RAM_TTL_MS = 1 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;
const MAX_MESSAGES = 10;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || "";

const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-3.1-pro-preview",
];

let currentModelIndex = 0;

const STICKER_FAVORITE_PACKS = (process.env.STICKER_FAVORITE_PACKS_BOT || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const stickerPackCache = new Map();
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
        username: data.result.username.toLowerCase(),
      };
      return cachedBotInfo;
    }
  } catch (e) {
    console.error("Lỗi getMe:", e);
  }
  return { id: null, username: "" };
}

function cleanMarkdownForTelegram(text) {
  if (!text) return "";
  return text;
}

// 1. Lấy thông tin chi tiết của Nhóm/Kênh
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
    const res = await fetch(
      `${TELEGRAM_API_URL}/getChatAdministrators?chat_id=${chatId}`,
    );
    const data = await res.json();
    if (data.ok && Array.isArray(data.result)) {
      const owners = [];
      const admins = [];
      data.result.forEach((member) => {
        const name =
          [member.user.first_name, member.user.last_name]
            .filter(Boolean)
            .join(" ") || "N/A";
        const username = member.user.username
          ? `@${member.user.username}`
          : "Không có";
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
    const res = await fetch(
      `${TELEGRAM_API_URL}/getChatMember?chat_id=${chatId}&user_id=${userId}`,
    );
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
        reaction: [{ type: "emoji", emoji: emoji }],
      }),
    });
  } catch (error) {
    console.error("Lỗi thả cảm xúc:", error);
  }
}

// 5. Gửi Sticker Telegram
async function sendSticker(chatId, fileId, replyToMessageId = null) {
  const payload = { chat_id: chatId, sticker: fileId };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  const res = await fetch(`${TELEGRAM_API_URL}/sendSticker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || "Telegram từ chối gửi sticker");
  }
  return data.result;
}

// 6. Mute (Cấm chat) thành viên trong nhóm
async function muteUser(chatId, userId, durationSeconds) {
  // Thay Math.max(30, ...) thành Math.max(36, ...)
  const duration = Math.max(36, Math.min(Number(durationSeconds) || 36, 67));
  const untilDate = Math.floor(Date.now() / 1000) + duration;

  const res = await fetch(`${TELEGRAM_API_URL}/restrictChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: userId,
      permissions: {
        can_send_messages: false,
      },
      until_date: untilDate,
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || "Không thể thực hiện lệnh mute.");
  }

  return duration;
}

// 7. Tìm kiếm Web (DuckDuckGo Lite)
async function searchDuckDuckGo(query) {
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
    });
    const html = await res.text();

    const matches = [
      ...html.matchAll(/class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi),
    ];
    if (matches.length > 0) {
      const snippets = matches
        .slice(0, 4)
        .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
        .join("\n- ");
      return `Kết quả tìm kiếm cho "${query}":\n- ${snippets}`;
    }

    const htmlMatches = [
      ...html.matchAll(/<a class="result__snippet[^>]*>(.*?)<\/a>/g),
    ];
    if (htmlMatches.length > 0) {
      const snippets = htmlMatches
        .slice(0, 4)
        .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
        .join("\n- ");
      return `Kết quả tìm kiếm cho "${query}":\n- ${snippets}`;
    }

    return "Không tìm thấy kết quả hoặc dịch vụ tìm kiếm tạm thời bị chặn.";
  } catch (e) {
    return `Lỗi khi tìm kiếm: ${e.message}`;
  }
}

// 8. Lấy thời tiết an toàn
async function getWeather(location) {
  try {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=vi`,
      {
        headers: { "User-Agent": "curl/7.68.0" },
      },
    );

    if (!res.ok) {
      return `Không thể lấy thông tin thời tiết lúc này (Lỗi Server: ${res.status}).`;
    }

    const text = await res.text();
    let data;
    try {
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

async function getFavoriteStickers() {
  if (STICKER_FAVORITE_PACKS.length === 0) {
    return [];
  }

  const all = [];
  for (const packName of STICKER_FAVORITE_PACKS) {
    const stickers = await getStickerPack(packName);
    for (const sticker of stickers) {
      all.push({
        ...sticker,
        pack: packName,
      });
    }
  }
  return all;
}

// 9. Lấy thời gian Việt Nam
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
    hour12: false,
  });
}

async function getStickerPack(packName) {
  if (stickerPackCache.has(packName)) {
    return stickerPackCache.get(packName);
  }

  try {
    const res = await fetch(
      `${TELEGRAM_API_URL}/getStickerSet?name=${encodeURIComponent(packName)}`,
    );

    const data = await res.json();
    if (!data.ok || !data.result?.stickers) {
      console.error(
        `[Sticker] Không lấy được pack ${packName}:`,
        data.description,
      );
      return [];
    }

    const stickers = data.result.stickers
      .map((sticker) => ({
        file_id: sticker.file_id,
        emoji: sticker.emoji || "",
      }))
      .filter((x) => x.file_id);

    stickerPackCache.set(packName, stickers);
    return stickers;
  } catch (error) {
    console.error(`[Sticker] ${packName}:`, error.message);
    return [];
  }
}

const MIME_TYPES_URL = "https://pastefy.app/54r4Jf0t/raw";
let mimeMapCache = null;

async function loadMimeMap() {
  if (mimeMapCache) return mimeMapCache;

  try {
    const res = await fetch(MIME_TYPES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const mimeMap = new Map();
    const regex = /"(\.[^"]+)"\s*:\s*"([^"]+)"/g;

    let match;
    while ((match = regex.exec(text)) !== null) {
      const ext = match[1].toLowerCase();
      const mime = match[2].trim();
      if (ext && mime) mimeMap.set(ext, mime);
    }

    if (mimeMap.size === 0) throw new Error("Không tìm thấy MIME map");
    mimeMapCache = mimeMap;
    return mimeMap;
  } catch (error) {
    console.error("Lỗi tải mimetypes.go:", error);
    const fallback = new Map([
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".png", "image/png"],
      [".gif", "image/gif"],
      [".webp", "image/webp"],
      [".mp4", "video/mp4"],
      [".mp3", "audio/mpeg"],
      [".pdf", "application/pdf"],
      [".txt", "text/plain"],
    ]);
    mimeMapCache = fallback;
    return fallback;
  }
}

function getExtension(filePath) {
  const cleanPath = filePath.split("?")[0];
  const index = cleanPath.lastIndexOf(".");
  if (index === -1) return "";
  return cleanPath.slice(index).toLowerCase();
}

async function getTelegramFileBuffer(fileId, forcedMimeType = null) {
  try {
    const fileRes = await fetch(
      `${TELEGRAM_API_URL}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );

    const fileData = await fileRes.json();

    if (!fileData.ok || !fileData.result?.file_path) {
      return null;
    }

    const fileInfo = fileData.result;

    // Không cho quét file >= 10 MB
    if (
      typeof fileInfo.file_size === "number" &&
      fileInfo.file_size >= MAX_FILE_SIZE
    ) {
      console.warn(`[File] Bỏ qua file quá lớn: ${fileInfo.file_size} bytes`);
      return null;
    }

    const filePath = fileInfo.file_path;

    const fileRes2 = await fetch(`${TELEGRAM_FILE_URL}/${filePath}`);

    if (!fileRes2.ok) return null;

    const arrayBuffer = await fileRes2.arrayBuffer();

    // Kiểm tra lần 2 phòng trường hợp file_size Telegram không có
    if (arrayBuffer.byteLength >= MAX_FILE_SIZE) {
      console.warn(
        `[File] File tải xuống >= 10 MB: ${arrayBuffer.byteLength} bytes`,
      );
      return null;
    }

    const buffer = Buffer.from(arrayBuffer);

    const mimeMap = await loadMimeMap();
    const ext = getExtension(filePath);

    const mimeType =
      forcedMimeType || mimeMap.get(ext) || "application/octet-stream";

    return {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType,
      },
      fileSize: buffer.length,
      filePath,
      mimeType,
    };
  } catch (error) {
    console.error("Lỗi tải file Telegram:", error);
    return null;
  }
}

async function getFileFromMessage(message) {
  if (!message) return null;

  // Ảnh
  if (message.photo?.length > 0) {
    const photo = message.photo[message.photo.length - 1];

    return await getTelegramFileBuffer(photo.file_id, "image/jpeg");
  }

  // Document / file
  if (message.document) {
    return await getTelegramFileBuffer(
      message.document.file_id,
      message.document.mime_type || null,
    );
  }

  // Video
  if (message.video) {
    return await getTelegramFileBuffer(
      message.video.file_id,
      message.video.mime_type || "video/mp4",
    );
  }

  // Audio
  if (message.audio) {
    return await getTelegramFileBuffer(
      message.audio.file_id,
      message.audio.mime_type || "audio/mpeg",
    );
  }

  // Voice
  if (message.voice) {
    return await getTelegramFileBuffer(
      message.voice.file_id,
      message.voice.mime_type || "audio/ogg",
    );
  }

  // Animation/GIF
  if (message.animation) {
    return await getTelegramFileBuffer(
      message.animation.file_id,
      message.animation.mime_type || "video/mp4",
    );
  }

  // Sticker
  if (message.sticker) {
    return await getTelegramFileBuffer(
      message.sticker.file_id,
      message.sticker.is_animated ? "application/x-tgsticker" : "image/webp",
    );
  }

  return null;
}

async function googleTranslateTTS(text, language = "vi") {
  const chunks = String(text)
    .match(/.{1,180}(?:\s|$)/g) || [String(text)];

  const buffers = [];

  for (const chunk of chunks) {
    const url =
      "https://translate.google.com/translate_tts" +
      `?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(language)}` +
      `&q=${encodeURIComponent(chunk)}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google TTS HTTP ${response.status}`);
    }

    buffers.push(Buffer.from(await response.arrayBuffer()));
  }

  return Buffer.concat(buffers);
}

async function sendVoiceBuffer(chatId, buffer, replyToMessageId = null) {
  const boundary = `----TelegramForm${Date.now()}`;

  const parts = [];

  const addField = (name, value) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      )
    );
  };

  const addFile = (name, filename, contentType, data) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
      )
    );
    parts.push(data);
    parts.push(Buffer.from("\r\n"));
  };

  addField("chat_id", chatId);

  if (replyToMessageId) {
    addField("reply_to_message_id", replyToMessageId);
  }

  addFile("audio", "tts.mp3", "audio/mpeg", buffer);

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${TELEGRAM_API_URL}/sendAudio`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function shouldRespondInGroup(message, text, botUsername) {
  if (message.chat.type === "private") return true;
  if (message.is_automatic_forward) return true;

  const lowerText = text.toLowerCase();
  if (botUsername && lowerText.includes(`@${botUsername}`)) return true;
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername)
    return true;

  if (/\bchan\b/i.test(lowerText)) return true;
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
      () => resolve(),
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
    await redis.set(
      `chat:${chatId}:memory`,
      JSON.stringify(trimmed),
      "EX",
      REDIS_TTL_SEC,
    );
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

// Bỏ qua lỗi reply khi tin nhắn gốc bị xóa & tự động chuyển sang gửi thường
async function sendMessageRaw(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
  parseMode = "Markdown",
) {
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
        res.on("end", async () => {
          try {
            const response = JSON.parse(body);
            if (response.ok) {
              resolve(response.result?.message_id || messageId);
            } else {
              // Bắt và xử lý lỗi không tìm thấy tin nhắn cần reply (message to be replied not found)
              if (
                replyToMessageId &&
                !messageId &&
                response.description &&
                (response.description.includes(
                  "message to be replied not found",
                ) ||
                  response.description.includes("replied message not found") ||
                  response.description.includes("reply"))
              ) {
                try {
                  const fallbackId = await sendMessageRaw(
                    chatId,
                    text,
                    null,
                    null,
                    parseMode,
                  );
                  resolve(fallbackId);
                } catch (fallbackErr) {
                  reject(fallbackErr);
                }
              } else {
                reject(new Error(`Lỗi Telegram: ${response.description}`));
              }
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendOrUpdateMessage(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
  parseMode = "Markdown",
) {
  try {
    const safeText = text.slice(0, 4000);
    const contentToSend =
      parseMode === "Markdown" ? cleanMarkdownForTelegram(safeText) : safeText;

    return await sendMessageRaw(
      chatId,
      contentToSend,
      messageId,
      replyToMessageId,
      parseMode,
    );
  } catch (error) {
    if (error.message?.includes("can't parse entities")) {
      return await sendMessageRaw(
        chatId,
        text,
        messageId,
        replyToMessageId,
        null,
      );
    }
    console.error("Lỗi sendOrUpdateMessage:", error.message);
  }
}

async function sendStreamingMessage(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
) {
  if (!text) text = hide_text;
  const safeText = text.slice(0, 4000);

  try {
    return await sendMessageRaw(
      chatId,
      cleanMarkdownForTelegram(safeText),
      messageId,
      replyToMessageId,
      "Markdown",
    );
  } catch (error) {
    if (error.message?.includes("can't parse entities")) {
      return await sendMessageRaw(
        chatId,
        safeText,
        messageId,
        replyToMessageId,
        null,
      );
    }
    throw error;
  }
}

function validateHistoryFormat(messages) {
  if (!Array.isArray(messages)) {
    console.error("[Validate] History không phải array");
    return false;
  }

  const issues = [];
  messages.forEach((msg, idx) => {
    if (!msg.role) {
      issues.push(`[${idx}] Không có role`);
      return;
    }

    const role = String(msg.role).toUpperCase();
    if (role !== "user" && role !== "model" && role !== "assistant") {
      issues.push(`[${idx}] Role không hợp lệ: "${role}"`);
    }

    if (!msg.content && !msg.parts) {
      issues.push(`[${idx}] Không có content hoặc parts`);
    }
  });

  if (issues.length > 0) {
    console.warn("[Validate] History issues:", issues);
    return false;
  }

  return true;
}

function buildGeminiHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  return messages
    .map((msg) => {
      if (!msg || !msg.role) return null;

      const role = String(msg.role).toLowerCase();

      const normalizedRole =
        role === "model" || role === "assistant"
          ? "model"
          : "user";

      let parts = [];

      if (Array.isArray(msg.parts)) {
        parts = msg.parts
          .map((part) => {
            if (!part || typeof part !== "object") {
              return null;
            }

            const newPart = { ...part };

            if (
              typeof newPart.text === "string"
            ) {
              newPart.text = newPart.text.slice(
                0,
                30000,
              );
            }

            /*
             * QUAN TRỌNG:
             *
             * Không tạo thoughtSignature.
             * Không dùng:
             *
             *   "skip_thought_signature"
             *
             * Nếu signature tồn tại thì giữ NGUYÊN.
             */

            if (
              part.thoughtSignature !== undefined
            ) {
              newPart.thoughtSignature =
                part.thoughtSignature;
            }

            if (
              part.thought_signature !== undefined
            ) {
              newPart.thought_signature =
                part.thought_signature;
            }

            return newPart;
          })
          .filter(Boolean);
      }

      /*
       * History Redis hiện tại của bot chủ yếu là
       * text user/model, nên nếu có content thì chuyển
       * thành text part.
       */
      if (
        parts.length === 0 &&
        typeof msg.content === "string" &&
        msg.content.length > 0
      ) {
        parts = [
          {
            text: msg.content.slice(0, 30000),
          },
        ];
      }

      if (parts.length === 0) {
        return null;
      }

      return {
        role: normalizedRole,
        parts,
      };
    })
    .filter(Boolean);
}

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description:
          "Tìm kiếm thông tin thực tế hoặc tin tức trên internet qua DuckDuckGo.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Từ khóa cần tìm kiếm" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_weather",
        description: "Lấy thông tin thời tiết hiện tại của một địa điểm.",
        parameters: {
          type: "OBJECT",
          properties: {
            location: {
              type: "STRING",
              description: "Tên địa điểm hoặc thành phố",
            },
          },
          required: ["location"],
        },
      },
      {
        name: "react_message",
        description: "Thả cảm xúc emoji vào tin nhắn vừa nhận.",
        parameters: {
          type: "OBJECT",
          properties: {
            emoji: {
              type: "STRING",
              description: "Emoji cần thả (👍, ❤️, 🔥, 😂, 👏, 🤔, v.v.)",
            },
          },
          required: ["emoji"],
        },
      },
      {
        name: "send_sticker",
        description: "Gửi sticker bằng Telegram file_id.",
        parameters: {
          type: "OBJECT",
          properties: {
            file_id: {
              type: "STRING",
              description: "Telegram sticker file_id",
            },
          },
          required: ["file_id"],
        },
      },
      {
        name: "send_favorite_sticker",
        description:
          "Chọn và gửi một sticker phù hợp từ các sticker pack yêu thích đã cấu hình.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: {
              type: "STRING",
              description: "Mô tả ngắn lý do/chủ đề sticker cần tìm",
            },
          },
          required: ["reason"],
        },
      },
      {
        name: "mute_user",
        description:
          "Tạm thời cấm chat (mute) một thành viên trong nhóm với thời gian tối đa 67 giây (tối thiểu 36s).",
        parameters: {
          type: "OBJECT",
          properties: {
            user_id: {
              type: "NUMBER",
              description: "ID Telegram của người dùng cần mute",
            },
            duration_seconds: {
              type: "NUMBER",
              description:
                "Thời gian mute tính bằng giây (tối đa 67s, tối thiểu 36s)",
            },
            reason: { type: "STRING", description: "Lý do cấm chat" },
          },
          required: ["user_id", "duration_seconds"],
        },
      },
      {
        name: "create_file",
        description:
          "Tạo một file văn bản và gửi file đó cho người dùng qua Telegram. Dùng khi người dùng yêu cầu tạo file, code, ghi chú, JSON, CSV, Markdown, HTML hoặc nội dung tương tự.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: {
              type: "STRING",
              description:
                "Tên file, ví dụ note.txt, code.js, data.json, README.md",
            },
            content: {
              type: "STRING",
              description: "Toàn bộ nội dung cần ghi vào file",
            },
          },
          required: ["filename", "content"],
        },
      },
      {
        name: "text_to_speech",
        description:
          "Chuyển văn bản thành giọng nói tiếng Việt nhẹ và gửi audio/voice cho người dùng. Dùng khi người dùng yêu cầu đọc, nói, phát âm hoặc tạo giọng nói.",
        parameters: {
          type: "OBJECT",
          properties: {
            text: {
              type: "STRING",
              description: "Nội dung cần đọc thành tiếng",
            },
            language: {
              type: "STRING",
              description: "Mã ngôn ngữ, mặc định vi",
            },
          },
          required: ["text"],
        },
      },
    ],
  },
];

async function deleteTelegramMessage(chatId, messageId) {
  if (!messageId) return false;

  try {
    const res = await fetch(`${TELEGRAM_API_URL}/deleteMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });

    const data = await res.json();

    if (!data.ok) {
      console.warn("[Telegram] Không thể xóa message:", data.description);
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Telegram] Lỗi xóa message:", error.message);
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isQuotaZeroError(error) {
  const message = String(error?.message || "");

  return (
    error?.status === 429 &&
    (message.includes("limit: 0") ||
      message.includes("FreeTier") ||
      message.includes("free_tier"))
  );
}

async function sendDocumentBuffer(
  chatId,
  buffer,
  filename,
  caption = "",
  replyToMessageId = null,
) {
  const boundary = "----TelegramBoundary" + Math.random().toString(16).slice(2);

  const parts = [];

  const addField = (name, value) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  };

  addField("chat_id", chatId);

  if (caption) {
    addField("caption", caption);
  }

  if (replyToMessageId) {
    addField("reply_to_message_id", replyToMessageId);
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );

  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${TELEGRAM_API_URL}/sendDocument`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let responseBody = "";

        res.on("data", (chunk) => {
          responseBody += chunk;
        });

        res.on("end", () => {
          try {
            const data = JSON.parse(responseBody);

            if (!data.ok) {
              reject(
                new Error(data.description || "Telegram không gửi được file"),
              );
              return;
            }

            resolve(data.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function generateGeminiWithRotation(
  historyMessages,
  userParts,
  chatId,
  originalMessageId,
  onTextUpdate,
  onToolOnlyResponse,
) {
  let lastError = null;
  const totalAttempts =
    GEMINI_API_KEYS.length * GEMINI_MODELS.length;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const apiKeyIndex =
      (currentApiKeyIndex +
        Math.floor(attempt / GEMINI_MODELS.length)) %
      GEMINI_API_KEYS.length;

    const modelIndex =
      (currentModelIndex + attempt) % GEMINI_MODELS.length;

    const genAI = geminiClients[apiKeyIndex];
    const modelName = GEMINI_MODELS[modelIndex];

    try {
      console.log(
        `[Gemini] Key ${apiKeyIndex + 1}/${GEMINI_API_KEYS.length} | ${modelName}`,
      );

      const model = genAI.getGenerativeModel(
        {
          model: modelName,
          systemInstruction: CUSTOM_PERSONALITY,
          tools: GEMINI_TOOLS,
        },
        { apiVersion: "v1beta" },
      );

      // ============================================================
      // BUILD HISTORY
      // ============================================================

      const trimmedMessages = historyMessages.slice(-MAX_MESSAGES);

      console.log(
        `[History] Using ${trimmedMessages.length}/${historyMessages.length} messages`,
      );

      const builtHistory = buildGeminiHistory(trimmedMessages);

      console.log(
        `[History] Built ${builtHistory.length} messages, ~${JSON.stringify(builtHistory).length} bytes`,
      );

      /*
       * KHÔNG dùng model.startChat() ở đây.
       *
       * Lý do:
       * @google/generative-ai legacy SDK tự biến:
       *
       *   functionResponse
       *
       * thành:
       *
       *   role: "function"
       *
       * Gemini 3.x không chấp nhận role này.
       *
       * Ta tự quản lý contents để functionResponse nằm trong
       * role: "user".
       */

      const contents = Array.isArray(builtHistory)
        ? builtHistory.map((message) => ({
            role: message.role,
            parts: Array.isArray(message.parts)
              ? message.parts.map((part) => ({ ...part }))
              : [],
          }))
        : [];

      // ============================================================
      // APPEND CURRENT USER MESSAGE
      // ============================================================

      contents.push({
        role: "user",
        parts: Array.isArray(userParts)
          ? userParts.map((part) => ({ ...part }))
          : [],
      });

      let fullText = "";
      let hasReceivedText = false;

      // ============================================================
      // RUN GEMINI
      // ============================================================

      const runGemini = async () => {
        const result = await model.generateContentStream({
          contents,
        });

        let streamedText = "";

        for await (const chunk of result.stream) {
          try {
            const chunkText = chunk.text();

            if (chunkText) {
              if (!hasReceivedText) {
                fullText = "";
                hasReceivedText = true;
              }

              streamedText += chunkText;
              fullText += chunkText;

              await onTextUpdate(fullText);
            }
          } catch (_) {
            // Chunk có thể chỉ chứa functionCall/thoughtSignature
          }
        }

        const response = await result.response;

        return {
          response,
          streamedText,
        };
      };

      // ============================================================
      // FIRST GEMINI REQUEST
      // ============================================================

      let result = await runGemini();

      let finalResponse = result.response;

      let calls = [];

      // Lấy trực tiếp từ raw model response.
      // Không dùng finalResponse.functionCalls() vì có thể
      // làm mất metadata thoughtSignature.
      const firstModelParts =
        finalResponse?.candidates?.[0]?.content?.parts || [];

      const firstFunctionParts = firstModelParts.filter(
        (part) => part && part.functionCall,
      );

      if (firstFunctionParts.length > 0) {
        calls = firstFunctionParts.map((part) => ({
          ...part.functionCall,

          // Giữ nguyên signature nếu SDK/API trả về.
          thoughtSignature: part.thoughtSignature,
          thought_signature: part.thought_signature,

          // Giữ nguyên ID nếu có.
          id: part.functionCall.id,
        }));
      }

      // ============================================================
      // TOOL LOOP
      // ============================================================

      while (calls.length > 0) {
        /*
         * QUAN TRỌNG:
         *
         * Lưu nguyên content của MODEL response.
         *
         * Không sửa:
         *   thoughtSignature
         *   thought_signature
         *   functionCall.id
         *   functionCall.args
         *
         * Không tạo signature giả.
         */

        const modelContent =
          finalResponse?.candidates?.[0]?.content;
        
        if (
          modelContent &&
          Array.isArray(modelContent.parts)
        ) {
          // QUAN TRỌNG:
          // Giữ nguyên object Part do Gemini SDK trả về.
          // Không spread / clone Part vì Gemini 3 cần
          // thoughtSignature đúng vị trí ban đầu.
          contents.push(modelContent);
        }

        // ==========================================================
        // EXECUTE ALL FUNCTION CALLS
        // ==========================================================

        const functionResponseParts = [];

        for (const call of calls) {
          const callName = String(call?.name || "");

          let toolResponse = {
            success: false,
          };

          console.log(
            `[Tool] Executing ${callName}${
              call?.id ? ` | id=${call.id}` : ""
            }`,
          );

          // ========================================================
          // web_search
          // ========================================================

          if (callName === "web_search") {
            const query = String(
              call?.args?.query || "",
            ).trim();

            const searchResult =
              await searchDuckDuckGo(query);

            toolResponse = {
              text: searchResult,
            };
          }

          // ========================================================
          // get_weather
          // ========================================================

          else if (callName === "get_weather") {
            const location = String(
              call?.args?.location || "",
            ).trim();

            const weatherResult =
              await getWeather(location);

            toolResponse = {
              text: weatherResult,
            };
          }

          // ========================================================
          // react_message
          // ========================================================

          else if (callName === "react_message") {
            const emoji = String(
              call?.args?.emoji || "👍",
            );

            await setMessageReaction(
              chatId,
              originalMessageId,
              emoji,
            );

            toolResponse = {
              text: `Đã thả cảm xúc ${emoji}`,
            };
          }

          // ========================================================
          // send_sticker
          // ========================================================

          else if (callName === "send_sticker") {
            const fileId = String(
              call?.args?.file_id || "",
            ).trim();

            await sendSticker(
              chatId,
              fileId,
              originalMessageId,
            );

            toolResponse = {
              text: "Đã gửi sticker",
            };

            await onToolOnlyResponse();
          }

          // ========================================================
          // send_favorite_sticker
          // ========================================================

          else if (
            callName === "send_favorite_sticker"
          ) {
            const stickers =
              await getFavoriteStickers();

            if (!Array.isArray(stickers) || stickers.length === 0) {
              toolResponse = {
                text: "Không có sticker pack yêu thích.",
              };
            } else {
              const shuffled = [...stickers].sort(
                () => Math.random() - 0.5,
              );

              let sent = false;
              let lastStickerError = null;

              for (const sticker of shuffled) {
                try {
                  await sendSticker(
                    chatId,
                    sticker.file_id,
                    originalMessageId,
                  );

                  toolResponse = {
                    text: `Đã gửi sticker từ pack ${sticker.pack}`,
                    emoji: sticker.emoji,
                  };

                  sent = true;

                  await onToolOnlyResponse();

                  break;
                } catch (error) {
                  lastStickerError = error;
                }
              }

              if (!sent) {
                toolResponse = {
                  text:
                    "Toàn bộ sticker trong pack yêu thích đều không gửi được.",
                  error:
                    lastStickerError?.message ||
                    "Unknown sticker error",
                };
              }
            }
          }

          // ========================================================
          // mute_user
          // ========================================================

          else if (callName === "mute_user") {
            const targetUserId = Number(
              call?.args?.user_id,
            );

            const duration = Number(
              call?.args?.duration_seconds ||
                call?.args?.duration ||
                60,
            );

            if (!targetUserId) {
              toolResponse = {
                text:
                  "Thất bại: ID người dùng không hợp lệ.",
              };
            } else {
              try {
                const mutedSecs = await muteUser(
                  chatId,
                  targetUserId,
                  duration,
                );

                toolResponse = {
                  text:
                    `Đã mute thành công user ID ${targetUserId} trong ${mutedSecs} giây.`,
                };
              } catch (muteErr) {
                toolResponse = {
                  text:
                    `Không thể mute user ID ${targetUserId}: ${muteErr.message}`,
                };
              }
            }
          }

          // ========================================================
          // create_file
          // ========================================================

          else if (callName === "create_file") {
            const filename = String(
              call?.args?.filename ||
                "output.txt",
            ).trim();

            const content = String(
              call?.args?.content || "",
            );

            if (!content) {
              toolResponse = {
                text: "Nội dung file trống.",
              };
            } else {
              let safeFilename = filename
                .replace(/[\/\\:*?"<>|]/g, "_")
                .slice(0, 150);

              if (!safeFilename) {
                safeFilename = "output.txt";
              }

              const buffer = Buffer.from(
                content,
                "utf8",
              );

              if (
                buffer.length >=
                MAX_GENERATED_FILE_SIZE
              ) {
                toolResponse = {
                  text:
                    "File tạo ra vượt quá giới hạn 10 MB.",
                };
              } else {
                await sendDocumentBuffer(
                  chatId,
                  buffer,
                  safeFilename,
                  "",
                  originalMessageId,
                );

                toolResponse = {
                  text:
                    `Đã tạo và gửi file ${safeFilename}.`,
                };

                await onToolOnlyResponse();
              }
            }
          }

          // ========================================================
          // text_to_speech
          // ========================================================

          else if (callName === "text_to_speech") {
            const text = String(
              call?.args?.text || "",
            ).trim();

            const language = String(
              call?.args?.language || "vi",
            ).trim();

            if (!text) {
              toolResponse = {
                text: "Không có nội dung để đọc.",
              };
            } else {
              try {
                const audioBuffer =
                  await googleTranslateTTS(
                    text,
                    language,
                  );

                await sendVoiceBuffer(
                  chatId,
                  audioBuffer,
                  originalMessageId,
                );

                toolResponse = {
                  text: "Đã tạo và gửi giọng nói.",
                };

                await onToolOnlyResponse();
              } catch (error) {
                toolResponse = {
                  text:
                    `Không thể tạo giọng nói: ${error.message}`,
                };
              }
            }
          }

          // ========================================================
          // UNKNOWN TOOL
          // ========================================================

          else {
            toolResponse = {
              text: `Tool không tồn tại: ${callName}`,
              success: false,
            };
          }

          // ========================================================
          // BUILD FUNCTION RESPONSE
          // ========================================================

          const functionResponse = {
            name: callName,
            response: toolResponse,
          };

          /*
           * Gemini 3.x yêu cầu giữ function-call ID khi
           * manual tool calling.
           *
           * Chỉ thêm id khi Gemini thực sự trả id.
           * Không tự tạo id.
           */

          if (call?.id) {
            functionResponse.id = call.id;
          }

          functionResponseParts.push({
            functionResponse,
          });
        }

        // ==========================================================
        // SEND TOOL RESULTS BACK TO GEMINI
        // ==========================================================

        let toolSubmitSuccess = false;
        let nextResult = null;

        for (let toolRetry = 0; toolRetry < 2; toolRetry++) {
          try {
            console.log(
              `[Tool] Attempt ${toolRetry + 1}: Sending ${
                functionResponseParts.length
              } function response(s)...`,
            );

            /*
             * QUAN TRỌNG:
             *
             * Không dùng:
             *
             *   chat.sendMessage([
             *     { functionResponse: ... }
             *   ])
             *
             * vì legacy SDK sẽ đổi role thành "function".
             *
             * Ở đây ép rõ:
             *
             *   role: "user"
             */

            contents.push({
              role: "user",
              parts: functionResponseParts,
            });

            nextResult = await runGemini();

            console.log(
              `[Tool] ${
                calls.map((c) => c.name).join(", ")
              } sent successfully`,
            );

            toolSubmitSuccess = true;
            break;
          } catch (sendErr) {
            /*
             * Nếu request thất bại, bỏ function-response vừa
             * push để retry không tạo duplicate contents.
             */

            if (
              contents.length > 0 &&
              contents[contents.length - 1]?.role ===
                "user" &&
              contents[contents.length - 1]?.parts ===
                functionResponseParts
            ) {
              contents.pop();
            }

            const errorMessage =
              sendErr?.message || String(sendErr);

            const statusCode =
              sendErr?.status ||
              sendErr?.response?.status ||
              "unknown";

            console.error(
              `[Tool Error] ${
                calls.map((c) => c.name).join(", ")
              }:`,
            );

            console.error(
              `  Status: ${statusCode}`,
            );

            console.error(
              `  Message: ${errorMessage.slice(0, 500)}`,
            );

            if (
              (statusCode === 429 ||
                statusCode === 500 ||
                statusCode === 503) &&
              toolRetry === 0
            ) {
              console.warn(
                `[Tool] ${statusCode} - retrying...`,
              );

              await sleep(
                statusCode === 429
                  ? 3500
                  : 2000,
              );
            } else {
              toolSubmitSuccess = false;
              break;
            }
          }
        }

        if (!toolSubmitSuccess || !nextResult) {
          console.warn(
            `[Tool] Failed to send ${
              calls.map((c) => c.name).join(", ")
            }`,
          );

          break;
        }

        // ==========================================================
        // GET NEXT MODEL RESPONSE
        // ==========================================================

        result = nextResult;
        finalResponse = result.response;

        let nextCalls = [];

        try {
        const nextModelParts =
          finalResponse?.candidates?.[0]?.content?.parts || [];
        
        nextCalls = nextModelParts
          .filter((part) => part && part.functionCall)
          .map((part) => ({
            ...part.functionCall,
        
            // Giữ metadata nếu cần debug / xử lý tiếp.
            thoughtSignature: part.thoughtSignature,
            thought_signature: part.thought_signature,
        
            id: part.functionCall?.id,
          }));
        } catch (e) {
          console.warn(
            "[Tool] Error calling functionCalls():",
            e?.message || e,
          );

          nextCalls = [];
        }

        calls = nextCalls;
      }

      // ============================================================
      // FINAL TEXT
      // ============================================================

      if (!fullText) {
        try {
          const finalText =
            finalResponse?.text?.();

          if (finalText) {
            fullText = finalText;
            await onTextUpdate(fullText);
          }
        } catch (_) {}
      }

      // ============================================================
      // ROTATION SUCCESS
      // ============================================================

      currentApiKeyIndex =
        (apiKeyIndex + 1) %
        GEMINI_API_KEYS.length;

      currentModelIndex =
        (modelIndex + 1) %
        GEMINI_MODELS.length;

      return fullText;
    } catch (error) {
      console.warn(
        `[Gemini] Key ${apiKeyIndex + 1} | ${modelName} lỗi: ${error.message}`,
      );

      lastError = error;

      if (isQuotaZeroError(error)) {
        console.warn(
          `[Gemini] ${modelName} đang có quota = 0, bỏ qua model này.`,
        );

        continue;
      }

      if (error?.status === 429) {
        await sleep(2000);
      }

      continue;
    }
  }

  throw (
    lastError ||
    new Error(
      "Tất cả Gemini API key và model đều không phản hồi.",
    )
  );
}

async function processGeminiResponse(
  chatId,
  userParts,
  promptTextOnly,
  originalMessageId,
  senderHandle = "",
) {
  try {
    sendChatAction(chatId, "typing").catch(() => {});

    const historyMessages = await getChatMemory(chatId);

    let telegramMessageId = null;
    let lastUpdate = 0;
    let lastText = "";

    const updateTelegram = async (text) => {
      if (!text || text === lastText) return;
    
      lastText = text;
    
      try {
        if (!telegramMessageId) {
          telegramMessageId = await sendStreamingMessage(
            chatId,
            text + hide_text,
            null,
            originalMessageId,
          );
        } else {
          await sendStreamingMessage(
            chatId,
            text + hide_text,
            telegramMessageId,
            null,
          );
        }
      } catch (error) {
        console.error("[Telegram Stream]", error.message);
      }
    };

    const aiResponseText = await generateGeminiWithRotation(
      historyMessages,
      userParts,
      chatId,
      originalMessageId,
      updateTelegram,
      async () => {
        if (telegramMessageId) {
        }
      },
    );

    if (aiResponseText) {
      if (typeof aiResponseText !== "string" || !aiResponseText.trim()) {
        console.warn("[Save] aiResponseText invalid, skipping history save");
      } else {
        // ✅ Lưu user message
        historyMessages.push({
          role: "user",
          content: promptTextOnly,
        });
    
        // ✅ Lưu model response
        historyMessages.push({
          role: "model",
          content: aiResponseText,
        });
    
        // ✅ Lưu vào Redis
        await saveChatMemory(chatId, historyMessages);
    
        console.log(
          "[Save] Saved history:",
          historyMessages.length,
          "messages"
        );
      }
    }
  } catch (error) {
    console.error("Lỗi xử lý Gemini:", error);

    const tagUser =
      senderHandle && senderHandle !== "Không có" ? `${senderHandle} ` : "";
    await sendOrUpdateMessage(
      chatId,
      `${tagUser} *Lệnh đã đc thực hiện nhưng ko thể tạo text trả lời*`,
      null,
      originalMessageId,
      "Markdown",
    ).catch(() => {});
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const nowSec = Math.floor(Date.now() / 1000);
  if (message.date && nowSec - message.date > 60) {
    console.log(
      `[Skip] Bỏ qua tin nhắn cũ (${nowSec - message.date}s) ID: ${message.message_id}`,
    );
    return;
  }

  const chatId = message.chat.id;
  const originalMessageId = message.message_id;
  const rawText = message.text || message.caption || "";
  const botInfo = await getBotInfo();

  const replyTargetId = message.from?.is_bot ? null : originalMessageId;

  const botUsername = (await botInfo.username).toLowerCase();

    if (rawText.startsWith("/start") || rawText.startsWith("/clearmy")) {
      const command = rawText.split(/\s+/)[0];
    
      // Trong group: nếu có @username thì chỉ nhận @bot của mình
      if (
        message.chat.type !== "private" &&
        command.includes("@") &&
        command.toLowerCase() !== `${command.split("@")[0].toLowerCase()}@${botUsername}`
      ) {
        return;
      }
    
      if (rawText.startsWith("/start")) {
        await sendOrUpdateMessage(
          chatId,
          "👋 *Xin chào!*\n> Tôi là Bot AI tên là chan.\n" +
            "💬 *command:*\n" +
            "/clearmy để xóa bộ nhớ trò chuyện",
          null,
          originalMessageId,
        );
        return;
      }
    
      await clearChatMemory(chatId);
      await sendOrUpdateMessage(
        chatId,
        "✅ *Đã xóa bộ nhớ cuộc trò chuyện!*",
        null,
        originalMessageId,
      );
      return;
    }

  if (!shouldRespondInGroup(message, rawText, botInfo.username)) {
    return;
  }

  const uid = message.from?.id;
  if (!uid) return;

  const lockKey = `lock:user:${uid}`;
  const acquiredLock = await redis.set(lockKey, "processing", "NX", "EX", 30);
  if (!acquiredLock) {
    console.log(
      `[Lock] User ${uid} đang có 1 tin nhắn đang xử lý, bỏ qua tin nhắn mới này.`,
    );
    return;
  }

  try {
    const firstName = message.from?.first_name || "";
    const lastName = message.from?.last_name || "";
    const senderName =
      [firstName, lastName].filter(Boolean).join(" ") || "Người dùng";
    const senderHandle = message.from?.username
      ? `@${message.from.username}`
      : "Không có";

    const userRole = await getUserRole(chatId, uid, message.chat.type);

    let groupDetailsStr = "";
    if (message.chat.type !== "private") {
      const chatMetadata = await getChatMetadata(chatId);
      const adminData = await getGroupAdminsList(chatId);

      let linkedChannelInfo = "Không kết nối kênh nào";
      if (chatMetadata?.linked_chat_id) {
        const channelMeta = await getChatMetadata(chatMetadata.linked_chat_id);
        if (channelMeta) {
          linkedChannelInfo = `Tên kênh: "${channelMeta.title || "N/A"}" | ID: ${channelMeta.id} | Username: ${channelMeta.username ? "@" + channelMeta.username : "Riêng tư"} | Link: ${channelMeta.invite_link || "Không có"}`;
        }
      }

      const ownersList =
        adminData.owners.length > 0
          ? adminData.owners.join("; ")
          : "Không xác định";
      const adminsList =
        adminData.admins.length > 0 ? adminData.admins.join("; ") : "Không có";

      groupDetailsStr =
        `\n[Thông tin Nhóm Hiện Tại]:\n` +
        `- Tên nhóm: "${chatMetadata?.title || message.chat.title || "N/A"}"\n` +
        `- Mô tả nhóm: "${chatMetadata?.description || "Không có"}"\n` +
        `- Link nhóm: "${chatMetadata?.invite_link || "Không có"}"\n` +
        `- Chủ nhóm (Owners): ${ownersList}\n` +
        `- Danh sách Quản trị viên (Admins): ${adminsList}\n` +
        `- Kênh liên kết với nhóm: [${linkedChannelInfo}]`;
    }

    const channelPostNote = message.is_automatic_forward
      ? " [LƯU Ý: Đây là bài viết tự động gửi từ Kênh liên kết vào nhóm]"
      : "";

    let replyContext = "";
    if (message.reply_to_message) {
      const rMsg = message.reply_to_message;
      const rFrom = rMsg.from;
      const isBotSelf = rFrom?.id === botInfo.id;
      const rName =
        [rFrom?.first_name, rFrom?.last_name].filter(Boolean).join(" ") ||
        "Người dùng";
      const rHandle = rFrom?.username ? `@${rFrom.username}` : "Không có";
      const rText =
        rMsg.text ||
        rMsg.caption ||
        "(Nội dung không phải văn bản/Ảnh/Sticker)";

      replyContext = `\n[Đang trả lời tin nhắn của ${isBotSelf ? "Chính Bot" : `${rName} (${rHandle}, ID:${rFrom?.id})`}: "${rText}"]`;
    }

    let stickerInfo = "";
    if (message.sticker) {
      stickerInfo = ` [Gửi Sticker file_id: "${message.sticker.file_id}", Emoji: "${message.sticker.emoji || "N/A"}"]`;
    }

    const userHeader =
      `[Thời gian hiện tại ở Việt Nam: ${getVietnamTimeString()}]\n` +
      `[Người gửi: ${senderName} | Username: ${senderHandle} | UID: ${uid} | Vai trò: ${userRole}]` +
      `${channelPostNote}` +
      `${replyContext}` +
      `${groupDetailsStr}`;

    let promptTextOnly = `${userHeader}\n[Nội dung tin nhắn]: ${rawText}${stickerInfo || " (Gửi phương tiện)"}`;
    const userParts = [{ text: promptTextOnly }];

    let fileData = null;

    // File/ảnh trực tiếp trong tin nhắn hiện tại
    fileData = await getFileFromMessage(message);

    // Nếu đang reply một tin nhắn có file/ảnh,
    // lấy luôn file của tin nhắn được reply.
    if (!fileData && message.reply_to_message) {
      fileData = await getFileFromMessage(message.reply_to_message);
    }

    if (fileData) {
      userParts.push({
        inlineData: fileData.inlineData,
      });

      promptTextOnly +=
        `\n[File đính kèm đã được cung cấp cho AI]` +
        `\n- MIME: ${fileData.mimeType}` +
        `\n- Kích thước: ${fileData.fileSize} bytes` +
        `\n- Tên/đường dẫn: ${fileData.filePath}`;
    }

    await processGeminiResponse(
      chatId,
      userParts,
      promptTextOnly,
      replyTargetId,
      senderHandle,
    );
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
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
