const https = require("https");
const { OpenAI, toFile } = require("openai");
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
const NINE_ROUTER_KEY = process.env.NINE_ROUTER_KEY || "dummy-key";
const AI_MODEL = "chan";
// Model/combos cho các dịch vụ khác của 9router (xem GET /v1/models/<loại>)
const NINE_EMBEDDING_MODEL = "gemini/gemini-embedding-001";
const NINE_IMAGE_MODEL = "gemini/gemini-2.5-flash-image";
const NINE_STT_MODEL = "gemini/gemini-2.5-flash-lite";
const NINE_TTS_MODEL = "google-tts/vi";
const NINE_VIDEO_MODEL = "openrouter/google/veo-3.1";
const NINE_SEARCH_MODEL = "search-combo";
const NINE_FETCH_MODEL = "fetch-combo";

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
const MAX_FILE_TEXT_CHARS = 8000;
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
const MAX_FETCH_CHARS = 6000;
const STT_TIMEOUT_MS = 60000;
const VIDEO_POLL_MS = 5000;
const VIDEO_MAX_WAIT_MS = 10 * 60 * 1000;
// Token trừ cho mỗi lần gọi tool (mặc định 1)
const TOOL_COSTS = { text_to_image: 5, generate_video: 10 };
const TOOL_TIMEOUTS = { text_to_image: 90000, web_fetch: 30000, generate_video: 30000 };

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

async function nineRouterPost(route, payload, timeoutMs = TOOL_TIMEOUT_MS) {
  const response = await withTimeout(
    fetch(`${NINE_ROUTER_URL}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NINE_ROUTER_KEY}`,
      },
      body: JSON.stringify(payload),
    }),
    timeoutMs,
    `9router ${route}`,
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`9router HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

function requireModel(value, envName) {
  if (!value) throw new Error(`Chưa cấu hình ${envName}`);
  return value;
}

async function searchWeb(query) {
  if (!query) throw new Error("Thiếu từ khóa tìm kiếm.");

  const response = await nineRouterPost("/search", {
    model: NINE_SEARCH_MODEL,
    query,
    max_results: 5,
  });
  const data = await response.json();
  const results = (data.results || []).slice(0, 5);
  if (!results.length) return `Không tìm thấy kết quả cho "${query}".`;

  const lines = results.map((item, index) => {
    const snippet = String(item.snippet || item.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return `${index + 1}. ${item.title || "Không tiêu đề"}\n${item.url || ""}\n${snippet}`;
  });
  return `Kết quả tìm kiếm "${query}":\n\n${lines.join("\n\n")}`;
}

async function fetchWebPage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("URL phải bắt đầu bằng http:// hoặc https://");

  const response = await nineRouterPost(
    "/web/fetch",
    { model: NINE_FETCH_MODEL, url, format: "markdown", max_characters: MAX_FETCH_CHARS },
    30000,
  );
  const data = await response.json();
  const body = data.data || data;
  const content = typeof body.content === "string" ? body.content : body.content?.text || "";
  if (!content) throw new Error("Không đọc được nội dung trang.");

  return `${body.title ? `${body.title}\n\n` : ""}${content.slice(0, MAX_FETCH_CHARS)}`;
}

async function getEmbeddings(texts) {
  const result = await aiClient.embeddings.create({
    model: requireModel(NINE_EMBEDDING_MODEL, "NINE_EMBEDDING_MODEL"),
    input: texts,
    encoding_format: "float",
  });
  return result.data.map((item) => item.embedding);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function generateImage(prompt) {
  const response = await nineRouterPost(
    "/images/generations",
    { model: requireModel(NINE_IMAGE_MODEL, "NINE_IMAGE_MODEL"), prompt },
    80000,
  );
  const data = await response.json();
  const item = data.data?.[0];

  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const image = await withTimeout(fetch(item.url), 20000, "Tải ảnh");
    if (!image.ok) throw new Error(`Tải ảnh lỗi HTTP ${image.status}`);
    return Buffer.from(await image.arrayBuffer());
  }
  throw new Error("9router không trả về ảnh.");
}

async function synthesizeSpeech(text, voice) {
  const response = await nineRouterPost(
    "/audio/speech?response_format=mp3",
    { model: String(voice || "").trim() || NINE_TTS_MODEL, input: text },
    TTS_TIMEOUT_MS,
  );
  return Buffer.from(await response.arrayBuffer());
}

// Trả về chuỗi phiên âm; ném lỗi nếu thất bại
async function transcribeAudio(base64Data, mimeType) {
  const model = requireModel(NINE_STT_MODEL, "NINE_STT_MODEL");
  const ext = /mpeg|mp3/.test(mimeType)
    ? "mp3"
    : /mp4|m4a|aac/.test(mimeType)
      ? "m4a"
      : /wav/.test(mimeType)
        ? "wav"
        : /webm/.test(mimeType)
          ? "webm"
          : "ogg";
  const file = await toFile(Buffer.from(base64Data, "base64"), `audio.${ext}`, { type: mimeType });
  const result = await withTimeout(
    aiClient.audio.transcriptions.create({ file, model }),
    STT_TIMEOUT_MS,
    "Speech to text",
  );
  return String(result.text || "").trim();
}

async function startVideoJob(prompt, duration, aspectRatio) {
  const body = { model: NINE_VIDEO_MODEL, prompt };
  const seconds = Number(duration);
  if (Number.isFinite(seconds) && seconds > 0) body.duration = seconds;
  if (["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"].includes(aspectRatio)) {
    body.aspect_ratio = aspectRatio;
  }

  const response = await nineRouterPost("/videos/generations", body, 25000);
  const data = await response.json();
  if (!data.request_id) throw new Error("9router không trả về request_id.");

  return {
    requestId: data.request_id,
    connectionId: response.headers.get("x-9router-connection-id") || "",
  };
}

async function waitForVideo(job) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < VIDEO_MAX_WAIT_MS) {
    await sleep(VIDEO_POLL_MS);

    const headers = { Authorization: `Bearer ${NINE_ROUTER_KEY}` };
    if (job.connectionId) headers["x-connection-id"] = job.connectionId;

    const response = await withTimeout(
      fetch(`${NINE_ROUTER_URL}/videos/${encodeURIComponent(job.requestId)}`, { headers }),
      15000,
      "Kiểm tra video",
    );
    if (!response.ok) {
      if (response.status >= 500) continue;
      throw new Error(`9router HTTP ${response.status}`);
    }

    const data = await response.json();
    if (data.status === "done" && data.video?.url) return data.video.url;
    if (data.status === "failed") {
      throw new Error(data.error?.message || "Tạo video thất bại.");
    }
  }

  throw new Error("Tạo video quá lâu.");
}

// Chạy nền sau khi tool trả lời: poll tới khi xong rồi gửi video vào chat
async function deliverVideo(chatId, replyToMessageId, job, cost, uid) {
  try {
    const url = await waitForVideo(job);
    try {
      await telegramCall(
        "sendVideo",
        { chat_id: chatId, video: url, reply_to_message_id: replyToMessageId || undefined },
        60000,
      );
    } catch (error) {
      console.error("[Video send]", error.message);
      await sendOrUpdateMessage(chatId, `Video xong rồi: ${url}`, null, replyToMessageId, null);
    }
  } catch (error) {
    console.error("[Video]", error.message);
    await addTokens(uid, cost);
    await sendOrUpdateMessage(
      chatId,
      `Tạo video lỗi: ${String(error.message).slice(0, 200)}\nĐã hoàn ${cost} token.`,
      null,
      replyToMessageId,
      null,
    );
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

// Đổi khung hình sticker sang định dạng ảnh của OpenAI-compatible API
function framesToImageParts(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return [];

  return frames
    .filter(
      (frame) =>
        frame &&
        typeof frame.data === "string" &&
        frame.data.length > 0 &&
        typeof frame.mimeType === "string",
    )
    .map((frame) => ({
      type: "image_url",
      image_url: { url: `data:${frame.mimeType};base64,${frame.data}` },
    }));
}

const MULTIPART_FIELDS = { sendVoice: "voice", sendPhoto: "photo" };

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
      `--${boundary}\r\nContent-Disposition: form-data; name="${MULTIPART_FIELDS[method] || "document"}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
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

async function sendVoiceBuffer(chatId, buffer, replyToMessageId = null) {
  return sendMultipart("sendVoice", chatId, buffer, "voice.mp3", "audio/mpeg", replyToMessageId);
}

async function sendPhotoBuffer(chatId, buffer, replyToMessageId = null) {
  return sendMultipart("sendPhoto", chatId, buffer, "image.png", "image/png", replyToMessageId);
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

    ramCache.delete(`group:${chatId}:latest`);
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

async function getHistoryAroundId(chatId, messageId, count = 10) {
  const targetId = Number(messageId);
  const limit = Math.max(1, Math.min(Number(count) || 10, 40));

  if (!Number.isSafeInteger(targetId) || targetId <= 0) return [];

  const beforeCount = Math.floor((limit - 1) / 2);
  const afterCount = limit - beforeCount - 1;

  const before = await getHistoryBeforeId(chatId, targetId, beforeCount);
  const target = await getStoredMessage(chatId, targetId);

  let after = [];
  try {
    const ids = await redis.zrangebyscore(
      historyIndexKey(chatId),
      `(${targetId}`,
      "+inf",
      "LIMIT",
      0,
      afterCount,
    );

    if (ids.length) {
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.get(historyMessageKey(chatId, id));
      const rows = await pipeline.exec();

      after = (rows || [])
        .filter((row) => row && !row[0] && row[1])
        .map((row) => {
          try {
            return JSON.parse(row[1]);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch (error) {
    console.error("[History around]", error.message);
  }

  const combined = [...before.messages];
  if (target) combined.push(target);
  combined.push(...after);

  const unique = new Map();
  for (const item of combined) unique.set(item.id, item);

  return [...unique.values()].sort((a, b) => a.id - b.id).slice(-limit);
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
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant" || item.role === "model"),
    )
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: item.role === "model" ? "assistant" : item.role,
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
      name: "web_fetch",
      description: "Đọc nội dung một trang web từ URL (trả về markdown).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL bắt đầu bằng http:// hoặc https://" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "text_to_image",
      description: "Tạo ảnh từ mô tả và gửi vào chat. Tốn 5 token.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Mô tả ảnh cần tạo" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description:
        "Tạo video từ mô tả. Video được gửi vào chat sau khi xong (có thể mất vài phút). Tốn 10 token.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Mô tả video" },
          duration: { type: "number", description: "Độ dài (giây), tùy chọn" },
          aspect_ratio: { type: "string", description: "16:9, 9:16, 1:1,... tùy chọn" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "embedding",
      description:
        "Tạo embedding cho văn bản. Trả về số chiều và vài giá trị đầu; nếu có text2 thì trả thêm độ tương đồng cosine.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Văn bản thứ nhất" },
          text2: { type: "string", description: "Văn bản thứ hai để so sánh (tùy chọn)" },
        },
        required: ["text"],
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
      name: "send_favorite_sticker",
      description:
        "Lấy danh sách sticker từ pack yêu thích để tự chọn. Chọn một file_id rồi gửi bằng thẻ <send_sticker>file_id</send_sticker> trong câu trả lời.",
      parameters: {
        type: "object",
        properties: {
          emoji: { type: "string", description: "Lọc theo emoji của sticker (tùy chọn)" },
        },
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
          voice: { type: "string", description: "ID giọng 9router, ví dụ edge-tts/en-US-AriaNeural. Bỏ trống để dùng giọng mặc định" },
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
      description:
        "Lấy hồ sơ tài khoản Telegram của chính bot Chan, bao gồm ID, tên, username, trạng thái bot và mô tả hồ sơ nếu Telegram cho phép truy cập.",
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
      description:
        "Lấy thông tin Telegram của người dùng. Ưu tiên người đang hỏi nếu không cung cấp user_id. Có thể lấy ID, tên, username, ngôn ngữ và trạng thái bot từ dữ liệu tin nhắn đã nhận. Có thể kiểm tra tư cách thành viên trong nhóm hiện tại khi Telegram cho phép.",
      parameters: {
        type: "object",
        properties: {
          user_id: {
            type: "number",
            description:
              "ID Telegram cần tra cứu. Bỏ trống để lấy thông tin người đang hỏi.",
          },
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

  const cost = TOOL_COSTS[name] ?? 1;
  if (!(await consumeExtraToken(uid, cost))) {
    return { success: false, text: `Không đủ token (cần ${cost}) để dùng ${name}.` };
  }

  try {
    const response = await withTimeout(
      (async () => {
        if (name === "web_search") {
          return { text: await searchWeb(String(args.query || "").trim()) };
        }
        if (name === "get_weather") {
          return { text: await getWeather(String(args.location || "").trim()) };
        }
        if (name === "get_message_by_id") {
          const item = await getStoredMessage(chatId, args.message_id);
          return {
            found: Boolean(item),
            message: item
              ? formatHistoryItem(item)
              : "Không tìm thấy ID trong lịch sử đã lưu.",
            note: "Bot API không thể tải tin nhắn bất kỳ chỉ bằng ID. Kết quả chỉ dựa trên lịch sử đã lưu.",
          };
        }
        if (name === "scan_group_history") {
          const count = Math.max(1, Math.min(Number(args.count) || 20, 60));
          const result = await getHistoryBeforeId(chatId, args.before_message_id, count);
          return {
            scanned: result.scanned,
            messages: result.messages.map(formatHistoryItem),
            note: "Chỉ quét các tin nhắn đã được bot lưu.",
          };
        }
        if (name === "trace_reply_chain") {
          const chain = await traceReplyChain(
            chatId,
            args.message_id,
            Math.max(1, Math.min(Number(args.max_depth) || MAX_REPLY_CHAIN, MAX_REPLY_CHAIN)),
          );
          return {
            chain: chain.map(formatHistoryItem),
            note: "Chuỗi chỉ có thể truy tiếp khi tin nhắn đã được lưu và có replyToId.",
          };
        }
        if (name === "send_favorite_sticker") {
          const all = await getFavoriteStickers();
          if (!all.length) return { success: false, text: "Không có sticker pack." };

          const emoji = String(args.emoji || "").trim();
          const matched = emoji ? all.filter((s) => s.emoji.includes(emoji)) : [];
          const pool = [...(matched.length ? matched : all)]
            .sort(() => Math.random() - 0.5)
            .slice(0, 30);

          return {
            success: true,
            stickers: pool.map((s) => ({ file_id: s.file_id, emoji: s.emoji })),
            note: "Chọn một file_id rồi viết <send_sticker>file_id</send_sticker> trong câu trả lời để gửi.",
          };
        }
        if (name === "web_fetch") {
          return { text: await fetchWebPage(String(args.url || "").trim()) };
        }
        if (name === "text_to_image") {
          const prompt = String(args.prompt || "").trim();
          if (!prompt) return { success: false, text: "Thiếu mô tả ảnh." };
          await sendChatAction(chatId, "upload_photo");
          const image = await generateImage(prompt);
          await sendPhotoBuffer(chatId, image, originalMessageId);
          return { success: true, text: "Đã gửi ảnh vào chat." };
        }
        if (name === "generate_video") {
          const prompt = String(args.prompt || "").trim();
          if (!prompt) return { success: false, text: "Thiếu mô tả video." };
          const job = await startVideoJob(prompt, args.duration, String(args.aspect_ratio || ""));
          waitUntil(deliverVideo(chatId, originalMessageId, job, TOOL_COSTS.generate_video, uid));
          return {
            success: true,
            text: "Đã nhận yêu cầu. Video xong sẽ tự được gửi vào chat. Không gọi lại công cụ này.",
          };
        }
        if (name === "embedding") {
          const text = String(args.text || "").trim();
          const text2 = String(args.text2 || "").trim();
          if (!text) return { success: false, text: "Thiếu văn bản." };
          const vectors = await getEmbeddings(text2 ? [text, text2] : [text]);
          const result = {
            success: true,
            dimensions: vectors[0].length,
            preview: vectors[0].slice(0, 8).map((v) => Number(v.toFixed(4))),
          };
          if (text2) result.cosine_similarity = Number(cosineSimilarity(vectors[0], vectors[1]).toFixed(4));
          return result;
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
          if (!text) return { success: false, text: "Không có văn bản để đọc." };

          try {
            await sendChatAction(chatId, "record_audio");

            const audio = await withTimeout(
              synthesizeSpeech(text, args.voice),
              TTS_TIMEOUT_MS,
              "Tạo voice",
            );

            if (!audio || !audio.length) {
              return { success: false, text: "Không tạo được dữ liệu âm thanh." };
            }

            await withTimeout(
              sendVoiceBuffer(chatId, audio, originalMessageId),
              TTS_TIMEOUT_MS,
              "Gửi voice",
            );

            console.log("[TTS OK] Voice đã gửi thành công.");

            return {
              success: true,
              text: "Voice đã được gửi thành công. Không gửi lại voice.",
            };
          } catch (error) {
            console.error("[TTS ERROR]", error.message);
            return {
              success: false,
              text: `Tạo hoặc gửi voice thất bại: ${error.message}`,
            };
          }
        }
        if (name === "get_bot_profile") {
          return await getBotProfile();
        }
        if (name === "get_user_profile") {
          const requestedId = Number(args.user_id);

          if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
            return {
              success: false,
              text:
                "Không có user_id hợp lệ. Hãy sử dụng thông tin người đang hỏi " +
                "đã có trong ngữ cảnh tin nhắn.",
            };
          }

          let member = null;

          try {
            member = await telegramCall(
              "getChatMember",
              { chat_id: chatId, user_id: requestedId },
              5000,
            );
          } catch (error) {
            console.error("[User profile]", error.message);
          }

          return {
            user_id: requestedId,
            group_membership: member
              ? {
                  status: member.status,
                  is_anonymous: Boolean(member.is_anonymous),
                }
              : null,
            user: member?.user || null,
            note:
              "Chỉ trả về dữ liệu Telegram cho phép bot truy cập. " +
              "Không được tự suy đoán thông tin cá nhân.",
          };
        }
        return { success: false, text: `Không tồn tại công cụ ${name}.` };
      })(),
      TOOL_TIMEOUTS[name] || TOOL_TIMEOUT_MS,
      `Tool ${name}`,
    );

    if (response?.success === false) await addTokens(uid, cost);
    console.log(`[Tool OK] ${name}`);
    return response;
  } catch (error) {
    await addTokens(uid, cost);
    console.error(`[Tool ERROR] ${name}:`, error.message);
    return {
      success: false,
      error: error.message,
      text: `Công cụ ${name} lỗi: ${error.message}`,
    };
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Yêu cầu đã bị hủy");
  }
}

// Xử lý AI qua 9router (OpenAI-compatible client)
// userContent: string hoặc mảng parts [{type:"text"},{type:"image_url"}]
async function generateAIWith9Router(
  historyMessages,
  userContent,
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
        "Không được khẳng định đã đọc tin nhắn nếu công cụ báo không tìm thấy. " +
        "Nếu ID không có trong lịch sử đã lưu, hãy giải thích giới hạn của Telegram Bot API. " +
        "Để thả reaction vào tin nhắn người dùng, viết <react_message>emoji</react_message> ngay trong câu trả lời. " +
        "Để gửi sticker, viết <send_sticker>file_id</send_sticker> (lấy file_id từ công cụ send_favorite_sticker). " +
        "Các thẻ này tự bị xóa khỏi tin nhắn hiển thị. " +
        "Muốn tách sang tin nhắn mới, viết --- hoặc *** trên một dòng riêng.",
    },
  ];

  const past = [];
  for (const item of historyMessages || []) {
    if (!item) continue;
    const role = item.role === "model" || item.role === "assistant" ? "assistant" : "user";
    const text = String(item.content || "").slice(0, MAX_HISTORY_TEXT * 2);
    if (text.trim()) past.push({ role, content: text });
  }
  messages.push(...past.slice(-MAX_CONTEXT_HISTORY));

  const finalContent =
    Array.isArray(userContent) &&
    userContent.length === 1 &&
    userContent[0].type === "text"
      ? userContent[0].text
      : userContent;

  messages.push({ role: "user", content: finalContent });

  console.log(`[AI] Model ${AI_MODEL} @ ${NINE_ROUTER_URL}`);

  let callCount = 0;
  let fullText = "";

  while (true) {
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
      if (callCount > 8) {
        throw new Error("Vượt giới hạn 8 vòng gọi công cụ.");
      }

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

const ACTION_TAG_RE = /<(react_message|send_sticker)>([\s\S]*?)<\/\1>/gi;
const ACTION_TAG_OPENERS = ["<react_message>", "<send_sticker>"];

function parseActionTags(text) {
  return [...String(text || "").matchAll(ACTION_TAG_RE)].map((match) => ({
    type: match[1].toLowerCase(),
    value: match[2].trim(),
  }));
}

// Xóa thẻ hành động, kể cả thẻ đang viết dở ở cuối chuỗi khi stream
function stripActionTags(text) {
  let clean = String(text || "").replace(ACTION_TAG_RE, "");

  const unclosed = clean.search(/<(?:react_message|send_sticker)>/i);
  if (unclosed !== -1) clean = clean.slice(0, unclosed);

  const lt = clean.lastIndexOf("<");
  if (lt !== -1) {
    const tail = clean.slice(lt).toLowerCase();
    if (ACTION_TAG_OPENERS.some((opener) => opener.startsWith(tail))) clean = clean.slice(0, lt);
  }
  return clean;
}

// --- hoặc *** trên một dòng riêng = sang tin nhắn mới
function splitMessageParts(text) {
  return String(text || "")
    .split(/^[ \t]*(?:-{3,}|\*{3,})[ \t]*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function runActionTags(chatId, replyToMessageId, actions) {
  let reacted = false;
  let stickers = 0;

  for (const action of actions) {
    try {
      if (action.type === "react_message" && !reacted && replyToMessageId) {
        reacted = true;
        await setMessageReaction(chatId, replyToMessageId, action.value || "👍");
      } else if (action.type === "send_sticker" && action.value && stickers < 3) {
        stickers++;
        await sendSticker(chatId, action.value, replyToMessageId);
      }
    } catch (error) {
      console.error(`[Action ${action.type}]`, error.message);
    }
  }
}

// userContent: parts gửi cho AI (có thể kèm ảnh)
// promptTextOnly: chỉ văn bản, dùng để lưu vào bộ nhớ Redis
async function processAIResponse(
  chatId,
  uid,
  userContent,
  promptTextOnly,
  originalMessageId,
  senderHandle = "",
) {
  const startedAt = Date.now();
  const segments = []; // mỗi phần ngăn bởi --- / *** là một tin nhắn: { id, text }
  let finished = false;

  const abortController = new AbortController();
  activeRequests.set(String(uid), { abortController, chatId });

  let suggestTimer = setTimeout(async () => {
    if (finished || segments.length) return;
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

  const updateTelegram = async (rawText) => {
    if (finished) return;

    const parts = splitMessageParts(stripActionTags(rawText));
    if (!parts.length) return;

    if (suggestTimer) {
      clearTimeout(suggestTimer);
      suggestTimer = null;
    }

    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const segment = segments[i];

      try {
        if (!segment) {
          const id = await sendStreamingMessage(chatId, text, null, originalMessageId);
          segments[i] = { id, text };
        } else if (segment.text !== text) {
          segment.text = text;
          segment.id = (await sendStreamingMessage(chatId, text, segment.id, null)) || segment.id;
        }
      } catch (error) {
        console.error("[Stream -> Telegram]", error.message);
      }
    }
  };

  try {
    await sendChatAction(chatId, "typing");
    const history = await getChatMemory(chatId);

    const aiResponse = await withTimeout(
      generateAIWith9Router(
        history,
        userContent,
        uid,
        chatId,
        originalMessageId,
        updateTelegram,
        combineSignals(abortController.signal, deadline.signal),
      ),
      PROCESS_TIMEOUT_MS,
      "Xử lý",
    );

    if (aiResponse && aiResponse.trim()) {
      history.push({ role: "user", content: promptTextOnly });
      history.push({ role: "assistant", content: aiResponse });
      await saveChatMemory(chatId, history);

      await updateTelegram(aiResponse);
      await runActionTags(chatId, originalMessageId, parseActionTags(aiResponse));
    } else if (!segments.length) {
      await sendOrUpdateMessage(
        chatId,
        "Chan đã xử lý xong nhưng không nhận được văn bản trả lời.",
        null,
        originalMessageId,
        null,
      );
    }

    console.log(`[Chan] Hoàn tất sau ${Date.now() - startedAt}ms`);
  } catch (error) {
    // Nếu yêu cầu bị hủy bởi người dùng qua /c, không gửi thông báo lỗi về chat
    if (
      abortController.signal.aborted ||
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
    if (suggestTimer) clearTimeout(suggestTimer);
    deadline.close();
    activeRequests.delete(String(uid));
  }
}

// Gộp nhiều AbortSignal thành một (hủy khi bất kỳ signal nào bị hủy)
function combineSignals(...signals) {
  const controller = new AbortController();

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }

  return controller.signal;
}

async function claimUpdate(updateId) {
  if (!updateId) return true;
  try {
    const result = await redis.set(`telegram:update:${updateId}`, "1", "NX", "EX", 86400);
    return result === "OK";
  } catch (error) {
    console.error("[Update dedupe]", error.message);
    return true;
  }
}

async function handleHistoryCommand(message, command, args) {
  const chatId = message.chat.id;
  const replyTo = message.message_id;
  const targetId = Number(args[0]);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    await sendOrUpdateMessage(
      chatId,
      "Cú pháp:\n/msgid <id>\n/history <id> [số tin]\n/chain <id>",
      null,
      replyTo,
      null,
    );
    return true;
  }

  if (command === "/msgid") {
    const item = await getStoredMessage(chatId, targetId);

    await sendOrUpdateMessage(
      chatId,
      item
        ? formatHistoryItem(item)
        : `Không tìm thấy ID ${targetId} trong lịch sử đã lưu.\nTelegram Bot API không thể tự tải tin nhắn cũ chỉ bằng ID.`,
      null,
      replyTo,
      null,
    );
    return true;
  }

  if (command === "/history") {
    const count = Math.max(1, Math.min(Number(args[1]) || 20, 60));
    const result = await getHistoryBeforeId(chatId, targetId, count);

    if (!result.messages.length) {
      await sendOrUpdateMessage(
        chatId,
        `Không tìm thấy tin nhắn đã lưu trước ID ${targetId}.`,
        null,
        replyTo,
        null,
      );
      return true;
    }

    const output = result.messages.map(formatHistoryItem).join("\n\n");
    await sendOrUpdateMessage(
      chatId,
      `Lịch sử quét ngược trước ID ${targetId} (${result.messages.length} tin):\n\n${output}`,
      null,
      replyTo,
      null,
    );
    return true;
  }

  if (command === "/chain") {
    const chain = await traceReplyChain(chatId, targetId);
    const output = chain.map(formatHistoryItem).join("\n\n");

    await sendOrUpdateMessage(
      chatId,
      output || `Không có chuỗi trả lời cho ID ${targetId}.`,
      null,
      replyTo,
      null,
    );
    return true;
  }

  return false;
}

async function handleUpdate(update) {
  if (update.pre_checkout_query) {
    try {
      await telegramCall("answerPreCheckoutQuery", {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      });
    } catch (error) {
      console.error("[Pre checkout]", error.message);
    }
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
  if (permission.canSend === false) {
    console.log(`[MuteCheck] Chat ${chatId}: ${permission.reason}`);
    return;
  }
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
    } catch (error) {
      console.error("[Token invoice]", error.message);
      await sendOrUpdateMessage(chatId, "Không thể gửi hóa đơn ở đây. Hãy dùng /token trong chat riêng với bot.", null, originalMessageId, null);
    }
    return;
  }

  if (command === "/addtoken" || command === "/checktoken") {
    if (!isPrivate || !isAdmin(uid)) {
      if (isPrivate) {
        await sendOrUpdateMessage(
          chatId,
          "Bạn không có quyền dùng lệnh này.",
          null,
          originalMessageId,
          null,
        );
      }
      return;
    }
    if (command === "/addtoken") {
      if (args.length < 2) {
        await sendOrUpdateMessage(
          chatId,
          "Cú pháp: /addtoken <uid> <số_lượng>",
          null,
          originalMessageId,
          null,
        );
        return;
      }

      const targetUid = args[0];
      const amount = Number(args[1]);

      if (!Number.isSafeInteger(amount) || amount === 0) {
        await sendOrUpdateMessage(
          chatId,
          "Số lượng token không hợp lệ.",
          null,
          originalMessageId,
          null,
        );
        return;
      }

      const balance = await addTokens(targetUid, amount);
      await sendOrUpdateMessage(
        chatId,
        `Đã cập nhật token cho ${targetUid}. Số dư: ${balance}`,
        null,
        originalMessageId,
        null,
      );
      return;
    }
    if (command === "/checktoken") {
      if (!args[0]) {
        await sendOrUpdateMessage(
          chatId,
          "Cú pháp: /checktoken <uid>",
          null,
          originalMessageId,
          null,
        );
        return;
      }
      const balance = await getUserTokens(args[0]);
      const remaining = await getResetRemainingTimeString(args[0]);

      await sendOrUpdateMessage(
        chatId,
        `UID ${args[0]} còn ${balance} token.${remaining ? `\nHồi token sau: ${remaining}` : ""}`,
        null,
        originalMessageId,
        null,
      );
      return;
    }
  }

  if (["/msgid", "/history", "/chain"].includes(command)) {
    if (await handleHistoryCommand(message, command, args)) return;
  }

  if (command === "/start" || command === "/c" || command === "/clearmy") {
    if (
      !isPrivate &&
      commandText.includes("@") &&
      commandText.split(/\s+/)[0].toLowerCase() !==
        `/${command.replace("/", "")}@${botInfo.username}`
    ) {
      return;
    }

    if (command === "/c") {
      const cancelled = cancelUserRequest(uid);
      await redis.del(`lock:user:${uid}`).catch(() => {});
      await sendOrUpdateMessage(chatId, cancelled ? "Đã hủy yêu cầu." : "Đang không có yêu cầu nào chạy.", null, originalMessageId, null);
      return;
    }

    if (command === "/start") {
      const tokens = await getUserTokens(uid);
      let text =
        "Xin chào! Tôi là Chan, bot AI.\n\n" +
        `Bạn đang có ${tokens} token.\n\n` +
        "Lệnh:\n" +
        "/clearmy — Xóa bộ nhớ hội thoại\n" +
        "/token — Kiểm tra/mua token";

      if (isPrivate && isAdmin(uid)) {
        text +=
          "\n\nLệnh quản trị:\n/addtoken <uid> <số_lượng>\n/checktoken <uid>";
      }
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
  } catch (error) {
    console.error("[User lock]", error.message);
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
      groupDetails =
        `\n[Thông tin nhóm: ${meta?.title || message.chat.title || "N/A"}]` +
        `\n[ID nhóm: ${chatId}]` +
        `\n[Chủ nhóm: ${admins.owners.join("; ") || "Không rõ"}]` +
        `\n[Quản trị viên: ${admins.admins.join("; ") || "Không có"}]`;
    }

    let replyContext = "";
    if (message.reply_to_message) {
      const reply = message.reply_to_message;
      replyContext =
        `\n[Đang reply ID ${reply.message_id}, người gửi: ${reply.from?.first_name || "Không rõ"}]` +
        `\n[Nội dung reply: ${getMessageText(reply).slice(0, 1200)}]`;
    }

    let groupHistoryContext = "";
    if (!isPrivate) {
      const history = await getHistoryBeforeId(chatId, originalMessageId, 20);
      if (history.messages.length) {
        groupHistoryContext =
          "\n[LỊCH SỬ HỘI THOẠI]\n" +
          "Các tin nhắn dưới đây được lấy từ lịch sử đã lưu trong database. " +
          "Sử dụng chúng để hiểu ngữ cảnh, người nói và chuỗi hội thoại. " +
          "Không được khẳng định đã đọc những tin nhắn không xuất hiện trong dữ liệu.\n\n" +
          history.messages.map(formatHistoryItem).join("\n\n");
      }
    }

    const tokensLeft = await getUserTokens(uid);

    const userHeader =
      `[Thời gian UTC+7: ${getVietnamTimeString()}]\n` +
      `[Người gửi: ${senderName} | Username: ${senderHandle} | UID: ${uid} | Vai trò: ${userRole} | Token còn: ${tokensLeft}]\n` +
      `${groupDetails}${replyContext}${groupHistoryContext}`;

    let promptTextOnly = `${userHeader}\n[Nội dung tin nhắn]: ${rawText || getMessageText(message)}`;
    const userParts = [{ type: "text", text: promptTextOnly }];

    let fileData = await getFileFromMessage(message);
    if (!fileData && message.reply_to_message) {
      fileData = await getFileFromMessage(message.reply_to_message);
    }

    if (fileData) {
      if (fileData.kind === "frames") {
        userParts.push({
          type: "text",
          text:
            "Các ảnh tiếp theo là khung hình theo thứ tự thời gian của một sticker động. " +
            "Hãy xem nội dung và sự thay đổi giữa các khung hình, " +
            "không suy đoán những chi tiết không thể quan sát.",
        });

        userParts.push(...framesToImageParts(fileData.frames));

        promptTextOnly +=
          `\n[Sticker động: ${fileData.frames.length} khung hình, ` +
          `${fileData.mimeType}, ${fileData.fileSize} bytes]`;
      } else if (fileData.inlineData) {
        const { mimeType, data } = fileData.inlineData;

        if (mimeType.startsWith("image/")) {
          userParts.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${data}` },
          });
        } else if (mimeType.startsWith("text/") || mimeType === "application/json") {
          const fileText = Buffer.from(data, "base64")
            .toString("utf8")
            .slice(0, MAX_FILE_TEXT_CHARS);
          userParts.push({
            type: "text",
            text: `[Nội dung file đính kèm]\n${fileText}`,
          });
        } else if (mimeType.startsWith("audio/")) {
          let transcript;
          if (!(await consumeExtraToken(uid, 1))) {
            transcript = "[Người dùng gửi âm thanh nhưng không đủ token để phiên âm.]";
          } else {
            try {
              const text = await transcribeAudio(data, mimeType);
              transcript = text ? `[Phiên âm giọng nói]: ${text}` : "[Âm thanh không có lời nói nhận diện được.]";
            } catch (error) {
              console.error("[STT]", error.message);
              await addTokens(uid, 1);
              transcript = `[Không phiên âm được âm thanh: ${String(error.message).slice(0, 150)}]`;
            }
          }
          userParts.push({ type: "text", text: transcript });
          promptTextOnly += `\n${transcript}`;
        } else {
          userParts.push({
            type: "text",
            text: `[Người dùng đính kèm file ${mimeType} nhưng định dạng này chưa đọc trực tiếp được.]`,
          });
        }

        promptTextOnly +=
          `\n[File đính kèm: ${fileData.mimeType}, ` +
          `${fileData.fileSize} bytes]`;
      }
    }

    const replyTargetId = message.from?.is_bot ? null : originalMessageId;

    await processAIResponse(
      chatId,
      uid,
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });

  try {
    if (update.update_id && !(await claimUpdate(update.update_id))) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
  } catch (error) {
    console.error("[Webhook dedupe]", error.message);
    return res.status(503).json({ ok: false });
  }

  waitUntil(
    handleUpdate(update).catch((error) => {
      console.error("[Handle update]", error.message);
    }),
  );

  return res.status(200).json({ ok: true });
};
