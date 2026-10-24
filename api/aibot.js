const https = require("https");
const { OpenAI } = require("openai");
const Redis = require("ioredis");
const { waitUntil } = require("@vercel/functions");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const zlib = require("zlib");
const { promisify } = require("util");
const gunzipAsync = promisify(zlib.gunzip);

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
  enableReadyCheck: true,
});

// Cấu hình 9router (OpenAI-compatible endpoint)
const NINE_ROUTER_URL = process.env.NINE_ROUTER_URL || "http://localhost:20128/v1";
const NINE_ROUTER_KEY = process.env.NINE_ROUTER_KEY || process.env.OPENAI_API_KEY || "dummy-key";
const AI_MODEL = process.env.AI_MODEL || "gemini/gemini-3.8-flash";

const aiClient = new OpenAI({
  baseURL: NINE_ROUTER_URL,
  apiKey: NINE_ROUTER_KEY,
});

const ADMIN_UIDS = (process.env.OWNER_ID || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_AI;
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Chưa cấu hình TELEGRAM_BOT_TOKEN_AI");
}

const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_URL = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const CUSTOM_PERSONALITY = process.env.BOT_PERSONALITY_AI || "";
const STICKER_FAVORITE_PACKS = (process.env.STICKER_FAVORITE_PACKS_BOT || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_GENERATED_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_FREE_TOKENS = 50;
const RESET_DURATION_MS = 12 * 60 * 60 * 1000;
const REDIS_TTL_SEC = 24 * 60 * 60;
const MAX_MESSAGES = 15;
const MAX_HISTORY_MESSAGES = 100;
const MAX_HISTORY_TEXT = 300;
const MAX_CONTEXT_HISTORY = 12;
const MAX_REPLY_CHAIN = 15;
const MAX_OUTPUT_CHARS = 4000;
const PROCESS_TIMEOUT_MS = 120000;
const TOOL_TIMEOUT_MS = 20000;
const TTS_TIMEOUT_MS = 20000;
const AUTO_RESPONSE_CHANCE = 0.00001;

let cachedBotInfo = null;

const STICKER_FRAME_COUNT = 4;
const STICKER_FRAME_SIZE = 256;

const ramCache = new Map();
const stickerPackCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label = "Operation") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout sau ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function isAdmin(uid) {
  return ADMIN_UIDS.includes(String(uid));
}

function cleanMarkdownForTelegram(text) {
  return String(text || "");
}

function createDeadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Hết thời gian xử lý sau ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
    },
  };
}

async function telegramCall(method, payload = {}, timeout = 8000) {
  const response = await withTimeout(
    fetch(`${TELEGRAM_API_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    timeout,
    `Telegram ${method}`,
  );

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

async function getBotInfo() {
  if (cachedBotInfo) return cachedBotInfo;

  try {
    const result = await telegramCall("getMe", {}, 5000);
    cachedBotInfo = {
      id: result.id,
      username: String(result.username || "").toLowerCase(),
    };
    return cachedBotInfo;
  } catch (error) {
    console.error("[Telegram getMe]", error.message);
    return { id: null, username: "" };
  }
}

async function getChatMetadata(chatId) {
  try {
    return await telegramCall("getChat", { chat_id: chatId }, 5000);
  } catch {
    return null;
  }
}

async function getGroupAdminsList(chatId) {
  try {
    const members = await telegramCall(
      "getChatAdministrators",
      { chat_id: chatId },
      5000,
    );

    const owners = [];
    const admins = [];

    for (const member of members) {
      const user = member.user || {};
      const name =
        [user.first_name, user.last_name].filter(Boolean).join(" ") || "N/A";
      const username = user.username ? `@${user.username}` : "Không có";
      const info = `${name} (${username} | ID: ${user.id})`;

      if (member.status === "creator") owners.push(info);
      else if (member.status === "administrator") admins.push(info);
    }

    return { owners, admins };
  } catch {
    return { owners: [], admins: [] };
  }
}

async function getUserRole(chatId, userId, chatType) {
  if (chatType === "private") return "Trò chuyện cá nhân";

  try {
    const member = await telegramCall(
      "getChatMember",
      { chat_id: chatId, user_id: userId },
      5000,
    );

    if (member.status === "creator") return "Chủ nhóm";
    if (member.status === "administrator") return "Quản trị viên";
  } catch {}

  return "Thành viên";
}

const muteCache = new Map();
const BOT_MUTE_CACHE_MS = 5000;

async function checkBotCanSend(chatId, forceRefresh = false) {
  const key = String(chatId);
  const now = Date.now();
  const cached = muteCache.get(key);

  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const bot = await getBotInfo();

  if (!bot.id) {
    return { canSend: null, reason: "Không lấy được ID bot" };
  }

  try {
    const member = await telegramCall(
      "getChatMember",
      { chat_id: chatId, user_id: bot.id },
      5000,
    );

    let canSend = true;
    let reason = "";

    if (member.status === "left" || member.status === "kicked") {
      canSend = false;
      reason = "Bot không còn trong nhóm";
    } else if (
      member.status === "restricted" &&
      member.is_member &&
      member.can_send_messages === false
    ) {
      canSend = false;
      reason = "Bot bị hạn chế quyền gửi tin nhắn";
    }

    const result = { canSend, reason };
    muteCache.set(key, { result, expiresAt: now + BOT_MUTE_CACHE_MS });
    return result;
  } catch (error) {
    console.error("[MuteCheck]", error.message);
    return { canSend: null, reason: "Không xác minh được quyền của bot" };
  }
}

async function sendChatAction(chatId, action = "typing") {
  try {
    await telegramCall("sendChatAction", { chat_id: chatId, action }, 3000);
  } catch {}
}

async function sendMessageRaw(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
  parseMode = "Markdown",
  replyMarkup = null,
) {
  const method = messageId ? "editMessageText" : "sendMessage";
  const payload = {
    chat_id: chatId,
    text: String(text || "").slice(0, MAX_OUTPUT_CHARS),
  };

  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  if (messageId) payload.message_id = messageId;
  else if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  try {
    const result = await telegramCall(method, payload, 8000);
    return result.message_id || messageId;
  } catch (error) {
    if (
      parseMode &&
      /parse entities|can't parse entities|unsupported start tag/i.test(
        error.message,
      )
    ) {
      return sendMessageRaw(
        chatId,
        text,
        messageId,
        replyToMessageId,
        null,
        replyMarkup,
      );
    }

    if (
      replyToMessageId &&
      !messageId &&
      /message to be replied not found|replied message not found|reply/i.test(
        error.message,
      )
    ) {
      return sendMessageRaw(chatId, text, null, null, parseMode, replyMarkup);
    }

    throw error;
  }
}

async function sendStreamingMessage(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
) {
  if (!text) return null;

  return sendMessageRaw(
    chatId,
    String(text).slice(0, MAX_OUTPUT_CHARS),
    messageId,
    replyToMessageId,
    "Markdown",
  ).catch(async (error) => {
    if (/parse entities|can't parse entities/i.test(error.message)) {
      return sendMessageRaw(
        chatId,
        String(text).slice(0, MAX_OUTPUT_CHARS),
        messageId,
        replyToMessageId,
        null,
      );
    }
    throw error;
  });
}

async function sendOrUpdateMessage(
  chatId,
  text,
  messageId = null,
  replyToMessageId = null,
  parseMode = "Markdown",
  replyMarkup = null,
) {
  try {
    return await sendMessageRaw(
      chatId,
      cleanMarkdownForTelegram(String(text || "").slice(0, MAX_OUTPUT_CHARS)),
      messageId,
      replyToMessageId,
      parseMode,
      replyMarkup,
    );
  } catch (error) {
    console.error("[Telegram send]", error.message);
    return null;
  }
}

async function setMessageReaction(chatId, messageId, emoji = "👍") {
  if (!messageId) return;
  await telegramCall("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}

async function sendSticker(chatId, fileId, replyToMessageId = null) {
  const payload = { chat_id: chatId, sticker: fileId };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  return telegramCall("sendSticker", payload);
}

async function muteUser(chatId, userId, durationSeconds) {
  const duration = Math.max(36, Math.min(Number(durationSeconds) || 36, 67));

  await telegramCall("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    permissions: { can_send_messages: false },
    until_date: Math.floor(Date.now() / 1000) + duration,
  });

  return duration;
}

async function searchDuckDuckGo(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

  try {
    const response = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    const html = await response.text();
    const snippets = [
      ...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi),
    ]
      .slice(0, 5)
      .map((match) =>
        match[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean);

    if (!snippets.length) {
      return "Không tìm thấy kết quả hoặc dịch vụ tìm kiếm tạm thời bị chặn.";
    }

    return `Kết quả tìm kiếm "${query}":\n- ${snippets.join("\n- ")}`;
  } catch (error) {
    return `Lỗi tìm kiếm: ${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}

async function getWeather(location) {
  try {
    const response = await withTimeout(
      fetch(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=vi`,
        { headers: { "User-Agent": "curl/7.68.0" } },
      ),
      TOOL_TIMEOUT_MS,
      "Weather",
    );

    if (!response.ok) return `Dịch vụ thời tiết trả về HTTP ${response.status}.`;

    const data = await response.json();
    const current = data.current_condition?.[0];
    const area = data.nearest_area?.[0]?.areaName?.[0]?.value || location;

    if (!current) return "Không đọc được dữ liệu thời tiết.";

    const desc =
      current.lang_vi?.[0]?.value ||
      current.weatherDesc?.[0]?.value ||
      "Không rõ";

    return `Thời tiết tại ${area}: ${desc}, ${current.temp_C}°C, cảm giác ${current.FeelsLikeC}°C, độ ẩm ${current.humidity}%, gió ${current.windspeedKmph} km/h.`;
  } catch (error) {
    return `Lỗi thời tiết: ${error.message}`;
  }
}

async function getStickerPack(packName) {
  if (stickerPackCache.has(packName)) return stickerPackCache.get(packName);

  try {
    const result = await telegramCall("getStickerSet", { name: packName }, 7000);
    const stickers = (result.stickers || [])
      .map((sticker) => ({
        file_id: sticker.file_id,
        emoji: sticker.emoji || "",
      }))
      .filter((sticker) => sticker.file_id);

    stickerPackCache.set(packName, stickers);
    return stickers;
  } catch (error) {
    console.error("[Sticker pack]", packName, error.message);
    return [];
  }
}

async function getFavoriteStickers() {
  const output = [];
  for (const pack of STICKER_FAVORITE_PACKS) {
    const stickers = await getStickerPack(pack);
    for (const sticker of stickers) output.push({ ...sticker, pack });
  }
  return output;
}

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

async function getMimeType(extension) {
  const fallback = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return fallback[extension] || "application/octet-stream";
}

async function getTelegramFileBuffer(fileId, forcedMimeType = null) {
  try {
    const fileInfo = await telegramCall("getFile", { file_id: fileId }, 7000);

    if (
      !fileInfo.file_path ||
      (typeof fileInfo.file_size === "number" &&
        fileInfo.file_size >= MAX_FILE_SIZE)
    ) {
      return null;
    }

    const response = await withTimeout(
      fetch(`${TELEGRAM_FILE_URL}/${fileInfo.file_path}`),
      10000,
      "Download Telegram file",
    );

    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength >= MAX_FILE_SIZE) return null;

    const extension = fileInfo.file_path.includes(".")
      ? fileInfo.file_path
          .slice(fileInfo.file_path.lastIndexOf("."))
          .toLowerCase()
      : "";

    return {
      inlineData: {
        data: Buffer.from(arrayBuffer).toString("base64"),
        mimeType: forcedMimeType || (await getMimeType(extension)),
      },
      fileSize: arrayBuffer.byteLength,
      filePath: fileInfo.file_path,
      mimeType: forcedMimeType || (await getMimeType(extension)),
    };
  } catch (error) {
    console.error("[Telegram file]", error.message);
    return null;
  }
}

async function getFileFromMessage(message) {
  if (!message) return null;

  if (message.photo?.length) {
    return getTelegramFileBuffer(
      message.photo[message.photo.length - 1].file_id,
      "image/jpeg",
    );
  }

  const sticker = message.sticker;
  if (sticker?.file_id) {
    const raw = await getTelegramRawFile(sticker.file_id);
    if (!raw) return null;

    if (sticker.is_animated) {
      const frames = await decodeTGSFrames(raw.buffer);
      return {
        kind: "frames",
        frames,
        fileSize: raw.fileSize,
        mimeType: "application/x-tgsticker",
      };
    }

    if (sticker.is_video) {
      const frames = await decodeWebMFrames(raw.buffer);
      return {
        kind: "frames",
        frames,
        fileSize: raw.fileSize,
        mimeType: "video/webm",
      };
    }

    return {
      inlineData: {
        mimeType: "image/webp",
        data: raw.buffer.toString("base64"),
      },
      fileSize: raw.fileSize,
      mimeType: "image/webp",
    };
  }

  for (const type of ["document", "video", "audio", "voice", "animation"]) {
    const item = message[type];
    if (!item?.file_id) continue;

    const defaults = {
      video: "video/mp4",
      audio: "audio/mpeg",
      voice: "audio/ogg",
      animation: "video/mp4",
    };

    return getTelegramFileBuffer(
      item.file_id,
      item.mime_type || defaults[type] || null,
    );
  }

  return null;
}

async function decodeTGSFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("TGS rỗng hoặc không hợp lệ");
  }

  const decompressed = await gunzipAsync(buffer);
  const animationJSON = JSON.parse(decompressed.toString("utf8"));
  const { parse, ImageSurface } = await import("lottie.js");

  const animation = parse(animationJSON);
  const totalFrames = Math.max(1, Math.floor(animation.totalFrames || 1));
  const surface = new ImageSurface(STICKER_FRAME_SIZE, STICKER_FRAME_SIZE);

  const frameIndexes = [
    0,
    Math.floor((totalFrames - 1) / 3),
    Math.floor(((totalFrames - 1) * 2) / 3),
    totalFrames - 1,
  ];

  const uniqueFrames = [...new Set(frameIndexes)];
  const frames = [];

  try {
    for (const frameIndex of uniqueFrames) {
      const png = await surface.png(animation, frameIndex);
      frames.push({
        mimeType: "image/png",
        data: Buffer.from(png).toString("base64"),
        frameIndex,
      });
    }
  } finally {
    surface.dispose?.();
  }

  return frames;
}

function runFFmpeg(args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("Không tìm thấy FFmpeg"));

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg timeout"));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 12000) stderr += chunk.toString();
    });

    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish(null, true);
      else finish(new Error(`FFmpeg exit ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

async function decodeWebMFrames(buffer) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "chan-sticker-"));
  const input = path.join(dir, "input.webm");
  const outputPattern = path.join(dir, "frame-%02d.png");

  try {
    await fs.promises.writeFile(input, buffer);
    await runFFmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-i",
      input,
      "-vf",
      "fps=2,scale=256:256:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=black@0",
      "-frames:v",
      String(STICKER_FRAME_COUNT),
      "-an",
      "-y",
      outputPattern,
    ]);

    const files = (await fs.promises.readdir(dir))
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .sort()
      .slice(0, STICKER_FRAME_COUNT);

    if (!files.length) throw new Error("Không trích xuất được khung hình WebM");

    const frames = [];
    for (const file of files) {
      const png = await fs.promises.readFile(path.join(dir, file));
      frames.push({ mimeType: "image/png", data: png.toString("base64") });
    }
    return frames;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function getTelegramRawFile(fileId) {
  const fileInfo = await telegramCall("getFile", { file_id: fileId }, 7000);

  if (
    !fileInfo.file_path ||
    (typeof fileInfo.file_size === "number" &&
      fileInfo.file_size >= MAX_FILE_SIZE)
  ) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${TELEGRAM_FILE_URL}/${fileInfo.file_path}`, {
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Download Telegram HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length >= MAX_FILE_SIZE) return null;

    return { buffer, filePath: fileInfo.file_path, fileSize: buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMultipart(
  method,
  chatId,
  buffer,
  filename,
  contentType,
  replyToMessageId = null,
  caption = "",
) {
  const boundary = `----ChanBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];

  const field = (name, value) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  };

  field("chat_id", chatId);
  if (replyToMessageId) field("reply_to_message_id", replyToMessageId);
  if (caption) field("caption", caption);

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${method === "sendVoice" ? "voice" : "document"}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
  );
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${TELEGRAM_API_URL}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 10000,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => (raw += chunk));
        response.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (!data.ok)
              return reject(new Error(data.description || "Telegram upload failed"));
            resolve(data.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("Upload timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function sendDocumentBuffer(chatId, buffer, filename, caption = "", replyToMessageId = null) {
  return sendMultipart("sendDocument", chatId, buffer, filename, "application/octet-stream", replyToMessageId, caption);
}

async function googleTranslateTTS(text, language = "vi") {
  const chunks = String(text).match(/.{1,160}(?:\s|$)/g) || [String(text)];
  const buffers = [];

  for (const chunk of chunks) {
    const response = await withTimeout(
      fetch(
        "https://translate.google.com/translate_tts" +
          `?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(language)}` +
          `&q=${encodeURIComponent(chunk)}`,
      ),
      TOOL_TIMEOUT_MS,
      "Google TTS",
    );

    if (!response.ok) throw new Error(`Google TTS HTTP ${response.status}`);
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }

  return Buffer.concat(buffers);
}

async function sendVoiceBuffer(chatId, buffer, replyToMessageId = null) {
  return sendMultipart("sendVoice", chatId, buffer, "voice.ogg", "audio/ogg", replyToMessageId);
}

function getMessageText(message) {
  if (!message) return "";
  if (message.text) return message.text;
  if (message.caption) return message.caption;
  if (message.photo) return "[Ảnh]";
  if (message.video) return "[Video]";
  if (message.document) return `[File: ${message.document.file_name || "document"}]`;
  if (message.voice) return "[Tin nhắn thoại]";
  if (message.audio) return "[Âm thanh]";
  if (message.sticker) return `[Sticker ${message.sticker.emoji || ""}]`;
  if (message.animation) return "[GIF]";
  if (message.location) return "[Vị trí]";
  if (message.contact) return "[Danh bạ]";
  return "[Tin nhắn không có văn bản]";
}

function normalizeStoredMessage(message) {
  const from = message.from || {};
  return {
    id: Number(message.message_id),
    chatId: String(message.chat?.id ?? ""),
    date: Number(message.date || Math.floor(Date.now() / 1000)),
    userId: from.id ? String(from.id) : "",
    name: [from.first_name, from.last_name].filter(Boolean).join(" ") || "Không rõ",
    username: from.username || "",
    isBot: Boolean(from.is_bot),
    text: getMessageText(message).slice(0, MAX_HISTORY_TEXT),
    languageCode: from.language_code || "",
    replyToId: message.reply_to_message?.message_id ? Number(message.reply_to_message.message_id) : null,
    entities: (message.entities || []).slice(0, 20).map((entity) => ({
      type: entity.type,
      offset: entity.offset,
      length: entity.length,
    })),
  };
}

function historyMessageKey(chatId, messageId) {
  return `group:${chatId}:msg:${messageId}`;
}

function historyIndexKey(chatId) {
  return `group:${chatId}:index`;
}

async function storeHistoryMessage(chatId, message) {
  if (!message?.message_id || !message?.chat) return;

  const item = normalizeStoredMessage(message);
  const key = historyMessageKey(chatId, item.id);

  try {
    await redis.set(key, JSON.stringify(item), "EX", REDIS_TTL_SEC);
    await redis.zadd(historyIndexKey(chatId), item.id, String(item.id));
    await redis.expire(historyIndexKey(chatId), REDIS_TTL_SEC);

    const excess = await redis.zcard(historyIndexKey(chatId));
    if (excess > MAX_HISTORY_MESSAGES) {
      const removeCount = excess - MAX_HISTORY_MESSAGES;
      const oldIds = await redis.zrange(historyIndexKey(chatId), 0, removeCount - 1);

      if (oldIds.length) {
        const pipeline = redis.pipeline();
        for (const id of oldIds) {
          pipeline.del(historyMessageKey(chatId, id));
          pipeline.zrem(historyIndexKey(chatId), id);
        }
        await pipeline.exec();
      }
    }
  } catch (error) {
    console.error("[Group history save]", error.message);
  }
}

async function getStoredMessage(chatId, messageId) {
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  try {
    const raw = await redis.get(historyMessageKey(chatId, id));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("[Group history read]", error.message);
    return null;
  }
}

async function getHistoryBeforeId(chatId, beforeId, count = 20) {
  const id = Number(beforeId);
  const limit = Math.max(1, Math.min(Number(count) || 20, 100));

  if (!Number.isSafeInteger(id) || id <= 0) return { messages: [], scanned: 0 };

  try {
    const ids = await redis.zrevrangebyscore(
      historyIndexKey(chatId),
      `(${id}`,
      "-inf",
      "LIMIT",
      0,
      limit,
    );

    if (!ids.length) return { messages: [], scanned: 0 };

    const pipeline = redis.pipeline();
    for (const messageId of ids) pipeline.get(historyMessageKey(chatId, messageId));

    const rows = await pipeline.exec();
    const messages = [];

    for (const row of rows || []) {
      if (!row || row[0] || !row[1]) continue;
      try {
        messages.push(JSON.parse(row[1]));
      } catch {}
    }

    return { messages: messages.sort((a, b) => a.id - b.id), scanned: ids.length };
  } catch (error) {
    console.error("[Group history scan]", error.message);
    return { messages: [], scanned: 0 };
  }
}

async function traceReplyChain(chatId, messageId, maxDepth = MAX_REPLY_CHAIN) {
  let currentId = Number(messageId);
  const chain = [];
  const seen = new Set();

  for (let i = 0; i < Math.min(maxDepth, MAX_REPLY_CHAIN); i++) {
    if (!Number.isSafeInteger(currentId) || currentId <= 0 || seen.has(currentId)) break;

    seen.add(currentId);
    const item = await getStoredMessage(chatId, currentId);
    if (!item) {
      chain.push({ id: currentId, missing: true, text: "Không tìm thấy tin nhắn trong lịch sử đã lưu." });
      break;
    }

    chain.push(item);
    if (!item.replyToId) break;
    currentId = item.replyToId;
  }

  return chain;
}

function formatHistoryItem(item) {
  const time = new Date((item.date || 0) * 1000).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });
  const username = item.username ? ` @${item.username}` : "";
  const reply = item.replyToId ? ` ↪ trả lời ID ${item.replyToId}` : "";
  return `[ID ${item.id}] ${time} | ${item.name}${username}${reply}\n${item.text}`;
}

async function getChatMemory(chatId) {
  try {
    const raw = await redis.get(`chat:${chatId}:memory`);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("[AI memory read]", error.message);
    return [];
  }
}

async function saveChatMemory(chatId, messages) {
  const safe = messages
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").slice(0, MAX_HISTORY_TEXT * 2),
    }));

  try {
    await redis.set(`chat:${chatId}:memory`, JSON.stringify(safe), "EX", REDIS_TTL_SEC);
  } catch (error) {
    console.error("[AI memory save]", error.message);
  }
}

async function clearChatMemory(chatId) {
  try {
    await redis.del(`chat:${chatId}:memory`);
  } catch (error) {
    console.error("[AI memory clear]", error.message);
  }
}

async function checkRateLimit(userId) {
  try {
    const key = `ratelimit:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count <= 10;
  } catch (error) {
    console.error("[Rate limit]", error.message);
    return false;
  }
}

const activeRequests = new Map();

function cancelUserRequest(uid) {
  const req = activeRequests.get(String(uid));
  if (!req) return false;

  try {
    req.abortController.abort(new Error("Người dùng hủy bằng /c"));
  } catch {}

  activeRequests.delete(String(uid));
  return true;
}

async function consumeExtraToken(userId, amount = 1) {
  const tokenKey = `user:${userId}:tokens`;
  try {
    const script = `
      local tokens = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tokens < tonumber(ARGV[1]) then return -1 end
      return redis.call('DECRBY', KEYS[1], ARGV[1])
    `;
    const result = await redis.eval(script, 1, tokenKey, String(amount));
    return Number(result) >= 0;
  } catch (e) {
    console.error("[Extra token]", e.message);
    return false;
  }
}

async function getBotProfile() {
  const result = await telegramCall("getMe", {}, 5000);
  let description = "";
  let shortDescription = "";

  try {
    const data = await telegramCall("getMyDescription", {}, 5000);
    description = data.description || "";
  } catch {}

  try {
    const data = await telegramCall("getMyShortDescription", {}, 5000);
    shortDescription = data.short_description || "";
  } catch {}

  return {
    id: result.id,
    is_bot: result.is_bot,
    first_name: result.first_name,
    last_name: result.last_name || "",
    username: result.username || "",
    language_code: result.language_code || "",
    description,
    short_description: shortDescription,
  };
}

async function getUserTokens(userId) {
  const tokenKey = `user:${userId}:tokens`;
  const resetKey = `user:${userId}:reset_at`;

  try {
    let [tokenText, resetText] = await redis.mget(tokenKey, resetKey);
    const now = Date.now();

    if (tokenText === null) {
      await redis.set(tokenKey, DEFAULT_FREE_TOKENS);
      return DEFAULT_FREE_TOKENS;
    }

    let tokens = Number.parseInt(tokenText, 10);
    if (!Number.isFinite(tokens)) tokens = 0;

    if (resetText && now >= Number(resetText)) {
      tokens = DEFAULT_FREE_TOKENS;
      await redis.set(tokenKey, tokens);
      await redis.del(resetKey);
    }

    return Math.max(0, tokens);
  } catch (error) {
    console.error("[Token read]", error.message);
    return 0;
  }
}

async function getResetRemainingTimeString(userId) {
  try {
    const value = await redis.get(`user:${userId}:reset_at`);
    if (!value) return null;

    const diff = Number(value) - Date.now();
    if (diff <= 0) return null;

    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours} giờ ${minutes} phút`;
  } catch {
    return null;
  }
}

async function consumeUserToken(userId) {
  const tokenKey = `user:${userId}:tokens`;
  const resetKey = `user:${userId}:reset_at`;

  try {
    const script = `
      local tokens = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tokens <= 0 then return -1 end
      tokens = redis.call('DECR', KEYS[1])
      if not redis.call('EXISTS', KEYS[2]) then
        redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
      end
      return tokens
    `;

    const result = await redis.eval(
      script,
      2,
      tokenKey,
      resetKey,
      String(Date.now() + RESET_DURATION_MS),
      String(12 * 60 * 60 + 3600),
    );

    return Number(result) >= 0;
  } catch (error) {
    console.error("[Token consume]", error.message);
    return false;
  }
}

async function addTokens(userId, amount) {
  const tokenKey = `user:${userId}:tokens`;
  const resetKey = `user:${userId}:reset_at`;

  try {
    const balance = await redis.incrby(tokenKey, amount);
    if (balance >= DEFAULT_FREE_TOKENS) await redis.del(resetKey);
    return balance;
  } catch (error) {
    console.error("[Token add]", error.message);
    return 0;
  }
}

function shouldRespondInGroup(message, text, botUsername) {
  if (message.chat.type === "private") return true;
  if (message.is_automatic_forward) return true;

  const lower = String(text || "").toLowerCase();
  if (botUsername && lower.includes(`@${botUsername}`)) return true;
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername) return true;
  if (/\bchan\b/i.test(lower)) return true;

  return Math.random() < AUTO_RESPONSE_CHANCE;
}

// Định nghĩa Tools theo chuẩn OpenAI (để tương thích với 9router)
const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Tìm kiếm thông tin trên internet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Từ khóa tìm kiếm" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Lấy thời tiết hiện tại.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "Tên địa điểm" },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "react_message",
      description: "Thả reaction vào tin nhắn người dùng đang hỏi.",
      parameters: {
        type: "object",
        properties: {
          emoji: { type: "string", description: "Emoji reaction" },
        },
        required: ["emoji"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_sticker",
      description: "Gửi sticker bằng Telegram file_id.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID của sticker" },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_favorite_sticker",
      description: "Chọn sticker từ pack yêu thích và gửi.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Lý do gửi sticker" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mute_user",
      description: "Mute một thành viên trong 36 đến 67 giây.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "number", description: "ID Telegram người dùng" },
          duration_seconds: { type: "number", description: "Thời gian mute (giây)" },
          reason: { type: "string", description: "Lý do mute" },
        },
        required: ["user_id", "duration_seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Tạo file văn bản và gửi qua Telegram.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Tên file" },
          content: { type: "string", description: "Nội dung file" },
        },
        required: ["filename", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "text_to_speech",
      description: "Chuyển văn bản thành giọng nói và gửi voice note.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Văn bản cần đọc" },
          language: { type: "string", description: "Mã ngôn ngữ (vi, en,...)" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_message_by_id",
      description: "Tìm nội dung một tin nhắn đã được lưu bằng ID trong nhóm hiện tại.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "number", description: "ID tin nhắn" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_group_history",
      description: "Quét ngược lịch sử nhóm từ trước một message ID đã lưu.",
      parameters: {
        type: "object",
        properties: {
          before_message_id: { type: "number", description: "ID mốc lịch sử" },
          count: { type: "number", description: "Số lượng tin nhắn cần quét" },
        },
        required: ["before_message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trace_reply_chain",
      description: "Truy ngược chuỗi reply từ message ID về tin gốc.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "number", description: "ID tin nhắn bắt đầu" },
          max_depth: { type: "number", description: "Độ sâu tối đa" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bot_profile",
      description: "Lấy hồ sơ tài khoản Telegram của chính bot Chan.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_profile",
      description: "Lấy thông tin Telegram của người dùng.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "number", description: "ID Telegram cần tra cứu." },
        },
      },
    },
  },
];

async function executeTool(call, uid, chatId, originalMessageId) {
  const name = String(call?.name || "");
  let args = {};
  try {
    args = JSON.parse(call?.arguments || "{}");
  } catch {
    args = {};
  }

  await consumeExtraToken(uid, 1);

  try {
    const response = await withTimeout(
      (async () => {
        if (name === "web_search") {
          return { text: await searchDuckDuckGo(String(args.query || "").trim()) };
        }
        if (name === "get_weather") {
          return { text: await getWeather(String(args.location || "").trim()) };
        }
        if (name === "get_message_by_id") {
          const item = await getStoredMessage(chatId, args.message_id);
          return {
            found: Boolean(item),
            message: item ? formatHistoryItem(item) : "Không tìm thấy ID trong lịch sử đã lưu.",
          };
        }
        if (name === "scan_group_history") {
          const count = Math.max(1, Math.min(Number(args.count) || 20, 60));
          const result = await getHistoryBeforeId(chatId, args.before_message_id, count);
          return { scanned: result.scanned, messages: result.messages.map(formatHistoryItem) };
        }
        if (name === "trace_reply_chain") {
          const chain = await traceReplyChain(chatId, args.message_id, Math.max(1, Math.min(Number(args.max_depth) || MAX_REPLY_CHAIN, MAX_REPLY_CHAIN)));
          return { chain: chain.map(formatHistoryItem) };
        }
        if (name === "react_message") {
          if (!originalMessageId) return { success: false, text: "Không có ID tin nhắn." };
          const emoji = String(args.emoji || "👍");
          await setMessageReaction(chatId, originalMessageId, emoji);
          return { success: true, text: `Đã thả reaction ${emoji}.` };
        }
        if (name === "send_sticker") {
          const fileId = String(args.file_id || "").trim();
          if (!fileId) return { success: false, text: "Thiếu file_id." };
          await sendSticker(chatId, fileId, originalMessageId);
          return { success: true, text: "Đã gửi sticker." };
        }
        if (name === "send_favorite_sticker") {
          const stickers = await getFavoriteStickers();
          if (!stickers.length) return { success: false, text: "Không có sticker pack." };
          const chosen = stickers[Math.floor(Math.random() * stickers.length)];
          await sendSticker(chatId, chosen.file_id, originalMessageId);
          return { success: true, text: `Đã gửi sticker từ pack ${chosen.pack}.` };
        }
        if (name === "mute_user") {
          const userId = Number(args.user_id);
          if (!Number.isSafeInteger(userId) || userId <= 0) return { success: false, text: "ID không hợp lệ." };
          const duration = await muteUser(chatId, userId, Number(args.duration_seconds) || 36);
          return { success: true, text: `Đã mute ${userId} trong ${duration} giây.` };
        }
        if (name === "create_file") {
          const content = String(args.content || "");
          if (!content) return { success: false, text: "Nội dung file trống." };
          const buffer = Buffer.from(content, "utf8");
          if (buffer.length > MAX_GENERATED_FILE_SIZE) return { success: false, text: "File vượt giới hạn 10 MB." };
          const filename = String(args.filename || "output.txt").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 150) || "output.txt";
          await sendDocumentBuffer(chatId, buffer, filename, "", originalMessageId);
          return { success: true, text: `Đã gửi file ${filename}.` };
        }
        if (name === "text_to_speech") {
          const text = String(args.text || "").trim();
          if (!text) return { success: false, text: "Không có văn bản." };
          await sendChatAction(chatId, "record_audio");
          const audio = await withTimeout(googleTranslateTTS(text, String(args.language || "vi")), TTS_TIMEOUT_MS, "Tạo voice");
          await withTimeout(sendVoiceBuffer(chatId, audio, originalMessageId), TTS_TIMEOUT_MS, "Gửi voice");
          return { success: true, text: "Voice đã được gửi thành công." };
        }
        if (name === "get_bot_profile") {
          return await getBotProfile();
        }
        if (name === "get_user_profile") {
          const requestedId = Number(args.user_id);
          if (!Number.isSafeInteger(requestedId) || requestedId <= 0) return { success: false, text: "Thiếu user_id." };
          const member = await telegramCall("getChatMember", { chat_id: chatId, user_id: requestedId }, 5000).catch(() => null);
          return { user_id: requestedId, group_membership: member ? { status: member.status } : null, user: member?.user || null };
        }
        return { success: false, text: `Không tồn tại công cụ ${name}.` };
      })(),
      TOOL_TIMEOUT_MS,
      `Tool ${name}`,
    );
    return response;
  } catch (error) {
    return { success: false, error: error.message, text: `Lỗi tool ${name}: ${error.message}` };
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Yêu cầu đã bị hủy");
  }
}

// Xử lý AI qua 9router (OpenAI-compatible client)
async function generateAIWith9Router(
  historyMessages,
  userPromptText,
  uid,
  chatId,
  originalMessageId,
  onTextUpdate,
  signal,
) {
  const messages = [
    {
      role: "system",
      content:
        `${CUSTOM_PERSONALITY}\n\n` +
        "Bạn là Chan. Khi người dùng hỏi về lịch sử nhóm, hãy dùng các công cụ lịch sử. " +
        "Không được khẳng định đã đọc tin nhắn nếu công cụ báo không tìm thấy.",
    },
  ];

  for (const item of historyMessages || []) {
    if (!item) continue;
    const role = item.role === "model" || item.role === "assistant" ? "assistant" : "user";
    const text = String(item.content || "").slice(0, MAX_HISTORY_TEXT * 2);
    if (text.trim()) messages.push({ role, content: text });
  }

  messages.push({ role: "user", content: userPromptText });

  let callCount = 0;
  let fullText = "";

  while (callCount < 8) {
    throwIfAborted(signal);

    const stream = await aiClient.chat.completions.create(
      {
        model: AI_MODEL,
        messages,
        tools: OPENAI_TOOLS,
        stream: true,
      },
      { signal },
    );

    let currentChunkText = "";
    let toolCallsMap = new Map();

    for await (const chunk of stream) {
      throwIfAborted(signal);
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        currentChunkText += delta.content;
        fullText += delta.content;
        if (typeof onTextUpdate === "function") {
          await onTextUpdate(fullText);
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, { id: tc.id || "", function: { name: "", arguments: "" } });
          }
          const entry = toolCallsMap.get(index);
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.function.name += tc.function.name;
          if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls = Array.from(toolCallsMap.values());

    if (toolCalls.length > 0) {
      callCount++;
      messages.push({
        role: "assistant",
        content: currentChunkText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: tc.function,
        })),
      });

      for (const tc of toolCalls) {
        throwIfAborted(signal);
        const toolResult = await executeTool(tc.function, uid, chatId, originalMessageId);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    break;
  }

  return fullText;
}

async function processAIResponse(
  chatId,
  uid,
  userPromptText,
  originalMessageId,
  senderHandle = "",
) {
  const startedAt = Date.now();
  let telegramMessageId = null;
  let lastText = "";
  let finished = false;

  const abortController = new AbortController();
  activeRequests.set(String(uid), { abortController, chatId });

  let suggestTimer = setTimeout(async () => {
    if (finished || lastText) return;
    try {
      const suggestId = await sendOrUpdateMessage(
        chatId,
        "Đang xử lý hơi lâu... Gõ /c để hủy.",
        null,
        originalMessageId,
        null,
      );
      setTimeout(async () => {
        try {
          await telegramCall("deleteMessage", { chat_id: chatId, message_id: suggestId });
        } catch {}
      }, 30000);
    } catch {}
  }, Math.floor((PROCESS_TIMEOUT_MS * 2) / 3));

  const deadline = createDeadline(PROCESS_TIMEOUT_MS);

  const updateTelegram = async (text) => {
    if (finished || !text || text === lastText) return;
    if (suggestTimer) {
      clearTimeout(suggestTimer);
      suggestTimer = null;
    }
    lastText = text;

    try {
      if (!telegramMessageId) {
        telegramMessageId = await sendStreamingMessage(chatId, text, null, originalMessageId);
      } else {
        telegramMessageId = await sendStreamingMessage(chatId, text, telegramMessageId, null);
      }
    } catch (error) {
      console.error("[Stream -> Telegram]", error.message);
    }
  };

  try {
    await sendChatAction(chatId, "typing");
    const history = await getChatMemory(chatId);

    const aiResponse = await withTimeout(
      generateAIWith9Router(
        history,
        userPromptText,
        uid,
        chatId,
        originalMessageId,
        updateTelegram,
        deadline.signal,
      ),
      PROCESS_TIMEOUT_MS,
      "Xử lý",
    );

    if (aiResponse && aiResponse.trim()) {
      history.push({ role: "user", content: userPromptText });
      history.push({ role: "assistant", content: aiResponse });
      await saveChatMemory(chatId, history);

      if (aiResponse !== lastText) {
        await updateTelegram(aiResponse);
      }
    }
    console.log(`[Chan] Hoàn tất sau ${Date.now() - startedAt}ms`);
  } catch (error) {
    // FIX: Nếu yêu cầu bị hủy bởi người dùng qua /c, không gửi thông báo lỗi về chat
    if (
      abortController.signal.aborted ||
      deadline.signal.aborted ||
      /hủy|aborted|canceled|cancel/i.test(error.message)
    ) {
      console.log(`[Chan] Yêu cầu của UID ${uid} đã bị hủy.`);
      return;
    }

    console.error("[Chan process]", error.message);
    const mention = senderHandle && senderHandle !== "Không có" ? `${senderHandle} ` : "";
    const message = `${mention}Chan không thể hoàn thành yêu cầu.\nLỗi: ${String(error.message || "Unknown error").slice(0, 350)}`;
    await sendOrUpdateMessage(chatId, message, null, originalMessageId, null);
  } finally {
    finished = true;
    deadline.close();
    activeRequests.delete(String(uid));
  }
}

async function claimUpdate(updateId) {
  if (!updateId) return true;
  try {
    const result = await redis.set(`telegram:update:${updateId}`, "1", "NX", "EX", 86400);
    return result === "OK";
  } catch {
    return true;
  }
}

async function handleUpdate(update) {
  if (update.pre_checkout_query) {
    try {
      await telegramCall("answerPreCheckoutQuery", {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      });
    } catch {}
    return;
  }

  const message = update.message;
  if (!message?.chat) return;

  const chatId = message.chat.id;
  const originalMessageId = message.message_id;
  const rawText = message.text || message.caption || "";
  const uid = message.from?.id;

  if (message.chat.type !== "private") {
    await storeHistoryMessage(chatId, message);
    if (message.reply_to_message) {
      await storeHistoryMessage(chatId, message.reply_to_message);
    }
  }

  const permission = await checkBotCanSend(chatId);
  if (permission.canSend === false) return;
  if (!uid) return;

  if (message.successful_payment) {
    const payload = message.successful_payment.invoice_payload || "";
    if (payload.startsWith("buy_tokens_100_")) {
      await addTokens(uid, 100);
      const balance = await getUserTokens(uid);
      await sendOrUpdateMessage(chatId, `Thanh toán thành công. Đã cộng 100 token.\nSố dư: ${balance}`, null, originalMessageId, null);
    }
    return;
  }

  const botInfo = await getBotInfo();
  const isPrivate = message.chat.type === "private";
  const commandText = rawText.trim();
  const command = commandText.split(/\s+/)[0].split("@")[0].toLowerCase();
  const args = commandText.split(/\s+/).slice(1);

  if (command === "/token") {
    const tokens = await getUserTokens(uid);
    const remaining = await getResetRemainingTimeString(uid);
    let text = `Số token hiện có: ${tokens}\n`;
    if (remaining) text += `Tự hồi token sau: ${remaining}\n`;
    text += "100 token = 10 Telegram Stars.\n\nĐể mua token, hãy thanh toán hóa đơn bên dưới.";
    await sendOrUpdateMessage(chatId, text, null, originalMessageId, null);

    try {
      await telegramCall("sendInvoice", {
        chat_id: chatId,
        title: "100 Token AI",
        description: "Quy đổi 10 Telegram Stars thành 100 Tokens AI",
        payload: `buy_tokens_100_${uid}`,
        provider_token: "",
        currency: "XTR",
        prices: [{ label: "100 Tokens", amount: 10 }],
      });
    } catch {
      await sendOrUpdateMessage(chatId, "Không thể gửi hóa đơn ở đây. Hãy dùng /token trong chat riêng với bot.", null, originalMessageId, null);
    }
    return;
  }

  if (command === "/addtoken" || command === "/checktoken") {
    if (!isPrivate || !isAdmin(uid)) return;
    if (command === "/addtoken") {
      if (args.length < 2) return;
      const balance = await addTokens(args[0], Number(args[1]));
      await sendOrUpdateMessage(chatId, `Đã cập nhật token cho ${args[0]}. Số dư: ${balance}`, null, originalMessageId, null);
      return;
    }
    if (command === "/checktoken") {
      if (!args[0]) return;
      const balance = await getUserTokens(args[0]);
      await sendOrUpdateMessage(chatId, `UID ${args[0]} còn ${balance} token.`, null, originalMessageId, null);
      return;
    }
  }

  if (command === "/start" || command === "/c" || command === "/clearmy") {
    if (command === "/c") {
      const cancelled = cancelUserRequest(uid);
      await redis.del(`lock:user:${uid}`).catch(() => {});
      await sendOrUpdateMessage(chatId, cancelled ? "Đã hủy yêu cầu." : "Đang không có yêu cầu nào chạy.", null, originalMessageId, null);
      return;
    }

    if (command === "/start") {
      const tokens = await getUserTokens(uid);
      let text = `Xin chào! Tôi là Chan, bot AI.\n\nBạn đang có ${tokens} token.\n\n/clearmy — Xóa bộ nhớ\n/token — Kiểm tra/mua token`;
      if (isPrivate && isAdmin(uid)) text += `\n\nQuản trị: /addtoken <uid> <số> | /checktoken <uid>`;
      await sendOrUpdateMessage(chatId, text, null, originalMessageId, null);
      return;
    }

    await clearChatMemory(chatId);
    await sendOrUpdateMessage(chatId, "Đã xóa bộ nhớ hội thoại AI.", null, originalMessageId, null);
    return;
  }

  if (!shouldRespondInGroup(message, rawText, botInfo.username)) return;

  const rateOk = await checkRateLimit(uid);
  if (!rateOk) {
    await sendOrUpdateMessage(chatId, "Bạn đã gửi quá nhanh. Giới hạn 10 câu/phút.", null, originalMessageId, null);
    return;
  }

  const tokens = await getUserTokens(uid);
  if (tokens <= 0) {
    await sendOrUpdateMessage(chatId, "Bạn đã hết token. Dùng /token để mua thêm.", null, originalMessageId, null);
    return;
  }

  const lockKey = `lock:user:${uid}`;
  let acquiredLock;
  try {
    acquiredLock = await redis.set(lockKey, "processing", "NX", "EX", 90);
  } catch {
    return;
  }

  if (!acquiredLock) return;

  try {
    if (!(await consumeUserToken(uid))) {
      await sendOrUpdateMessage(chatId, "Không thể trừ token hoặc hết token.", null, originalMessageId, null);
      return;
    }

    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Người dùng";
    const senderHandle = message.from?.username ? `@${message.from.username}` : "Không có";
    const userRole = await getUserRole(chatId, uid, message.chat.type);

    let groupDetails = "";
    if (!isPrivate) {
      const meta = await getChatMetadata(chatId);
      const admins = await getGroupAdminsList(chatId);
      groupDetails = `\n[Nhóm: ${meta?.title || message.chat.title || "N/A"}]\n[Chủ nhóm: ${admins.owners.join("; ") || "Không rõ"}]`;
    }

    let groupHistoryContext = "";
    if (!isPrivate) {
      const history = await getHistoryBeforeId(chatId, originalMessageId, 20);
      if (history.messages.length) {
        groupHistoryContext = "\n[LỊCH SỬ HỘI THOẠI]\n" + history.messages.map(formatHistoryItem).join("\n\n");
      }
    }

    const userPromptText =
      `[Thời gian: ${getVietnamTimeString()}]\n` +
      `[Người gửi: ${senderName} (${senderHandle}) | UID: ${uid} | Vai trò: ${userRole}]\n` +
      `${groupDetails}${groupHistoryContext}\n[Nội dung]: ${rawText || getMessageText(message)}`;

    const replyTargetId = message.from?.is_bot ? null : originalMessageId;

    await processAIResponse(
      chatId,
      uid,
      userPromptText,
      replyTargetId,
      senderHandle,
    );
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });

  try {
    if (update.update_id && !(await claimUpdate(update.update_id))) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
  } catch {
    return res.status(503).json({ ok: false });
  }

  waitUntil(
    handleUpdate(update).catch((error) => {
      console.error("[Handle update]", error.message);
    }),
  );

  return res.status(200).json({ ok: true });
};
