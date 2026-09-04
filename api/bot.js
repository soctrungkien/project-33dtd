const { Telegraf, Markup } = require("telegraf");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const Redis = require("ioredis");

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";

const MAX_RAM_CACHE = 50000;
const INITIAL_SCAN_LIMIT = 50000;
const MAX_SEARCH_CACHE = 1000;
const PAGE_SIZE = 25; // Số lượng APK hiển thị trên 1 trang /list

// Khởi tạo Redis Client
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
});

redis.on("error", (err) => {
  logError("REDIS", "Lỗi kết nối Redis", err);
});

// Bắt lỗi toàn cục cho Telegraf
bot.catch((err, ctx) => {
  logError("TELEGRAF", `Lỗi xử lý Update ID ${ctx.update?.update_id}`, err);
});

global.searchCache = global.searchCache || new Map();
global.fileStoreCache = global.fileStoreCache || new Map();

let clientInstance = null;
let liveSweepCache = { data: [], lastFetch: 0 };
const CACHE_TTL = 3 * 60 * 1000;

function logInfo(tag, message, data = "") {
  console.log(`[${new Date().toISOString()}] [${tag}] ${message}`, data ? JSON.stringify(data) : "");
}

function logError(tag, message, error) {
  console.error(`[${new Date().toISOString()}] [ERROR:${tag}] ${message}`, error);
}

function getParsedChannelPeer() {
  if (!STORAGE_CHANNEL) return null;
  try {
    if (/^-?\d+$/.test(STORAGE_CHANNEL)) {
      return BigInt(STORAGE_CHANNEL);
    }
    return STORAGE_CHANNEL;
  } catch (e) {
    logError("CONFIG", "Lỗi parse STORAGE_CHANNEL_ID", e);
    return STORAGE_CHANNEL;
  }
}

async function getGramClient() {
  if (clientInstance && clientInstance.connected) {
    return clientInstance;
  }
  if (!API_ID || !API_HASH || !process.env.BOT_TOKEN) {
    logError("GRAMJS", "Thiếu API_ID, API_HASH hoặc BOT_TOKEN");
    return null;
  }

  try {
    clientInstance = new TelegramClient(
      new StringSession(""),
      API_ID,
      API_HASH,
      { connectionRetries: 3, timeout: 10000 }
    );
    await clientInstance.start({ botAuthToken: process.env.BOT_TOKEN });
    return clientInstance;
  } catch (err) {
    logError("GRAMJS", "Lỗi kết nối GramJS", err);
    return null;
  }
}

// Xóa file hỏng/đã bị xóa khỏi cache RAM & Redis
async function removeApkFromCache(messageId) {
  try {
    liveSweepCache.data = liveSweepCache.data.filter((item) => Number(item.message_id) !== Number(messageId));
    let storedApks = JSON.parse((await redis.get("apk_list")) || "[]");
    storedApks = storedApks.filter((item) => Number(item.message_id) !== Number(messageId));
    await redis.set("apk_list", JSON.stringify(storedApks));
    logInfo("CACHE_PURGE", `Đã xóa message_id ${messageId} bị lỗi khỏi cache.`);
  } catch (e) {
    logError("CACHE_PURGE", "Lỗi xóa item khỏi cache", e);
  }
}

async function getMaxMessageId(client, channelPeer) {
  const probeIds = [10, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
  try {
    const msgs = await client.getMessages(channelPeer, { ids: probeIds });
    const validMsgs = (Array.isArray(msgs) ? msgs : []).filter((m) => m && m.id);
    if (validMsgs.length === 0) return 500;
    const highestFound = Math.max(...validMsgs.map((m) => m.id));
    return highestFound + 100;
  } catch (e) {
    return 2000;
  }
}

async function fetchBatchesWithConcurrency(client, channelPeer, batches, limit = 4) {
  const results = [];
  for (let i = 0; i < batches.length; i += limit) {
    const chunk = batches.slice(i, i + limit);
    const chunkResults = await Promise.all(
      chunk.map((ids) => client.getMessages(channelPeer, { ids }).catch(() => []))
    );
    results.push(...chunkResults);
  }
  return results;
}

async function getAllApksFromChannelOptimized(forceCheck = false) {
  if (
    !forceCheck &&
    Date.now() - liveSweepCache.lastFetch < CACHE_TTL &&
    liveSweepCache.data.length > 0
  ) {
    return liveSweepCache.data;
  }

  const client = await getGramClient();
  const channelPeer = getParsedChannelPeer();
  if (!client || !channelPeer) return [];

  try {
    const entity = await client.getEntity(channelPeer);
    let storedApks = [];
    try {
      storedApks = JSON.parse((await redis.get("apk_list")) || "[]");
    } catch {
      storedApks = [];
    }

    let lastScannedId = parseInt((await redis.get("apk_last_max_id")) || "0");
    const currentMaxId = await getMaxMessageId(client, entity);

    if (lastScannedId >= currentMaxId && storedApks.length > 0) {
      storedApks.sort((a, b) => Number(b.message_id) - Number(a.message_id));
      const ramCache = storedApks.slice(0, MAX_RAM_CACHE);
      liveSweepCache = { data: ramCache, lastFetch: Date.now() };
      return ramCache;
    }

    const startId = lastScannedId === 0 
      ? Math.max(1, currentMaxId - INITIAL_SCAN_LIMIT) 
      : lastScannedId + 1;

    logInfo("SWEEP", `Đang quét từ ID ${startId} đến ${currentMaxId}...`);

    const chunkSize = 100;
    const batches = [];
    for (let current = currentMaxId; current >= startId; current -= chunkSize) {
      const ids = [];
      for (let i = 0; i < chunkSize && current - i >= startId; i++) {
        ids.push(current - i);
      }
      if (ids.length > 0) batches.push(ids);
    }

    const results = await fetchBatchesWithConcurrency(client, entity, batches, 4);

    const newApks = [];
    for (const msgs of results) {
      if (!Array.isArray(msgs)) continue;
      for (const msg of msgs) {
        if (msg && msg.media && msg.media.document) {
          const attr = msg.media.document.attributes?.find((a) => a.fileName);
          const fileName = attr ? attr.fileName : "";

          if (fileName.toLowerCase().endsWith(".apk")) {
            newApks.push({
              message_id: msg.id,
              file_name: fileName,
              sender: msg.postAuthor || (msg.fromId?.userId ? `<a href="tg://user?id=${msg.fromId.userId}">Người dùng</a>` : ""),
              chat_id: STORAGE_CHANNEL,
            });
          }
        }
      }
    }

    const apkMap = new Map();
    storedApks.forEach((item) => apkMap.set(item.message_id, item));
    newApks.forEach((item) => apkMap.set(item.message_id, item));

    const mergedApks = Array.from(apkMap.values());
    mergedApks.sort((a, b) => Number(b.message_id) - Number(a.message_id));

    await redis.set("apk_list", JSON.stringify(mergedApks));
    await redis.set("apk_last_max_id", currentMaxId.toString());

    const ramCache = mergedApks.slice(0, MAX_RAM_CACHE);
    liveSweepCache = { data: ramCache, lastFetch: Date.now() };

    return ramCache;
  } catch (err) {
    logError("SWEEP", "Lỗi quét dữ liệu", err);
    let fallback = [];
    try {
      fallback = JSON.parse((await redis.get("apk_list")) || "[]");
    } catch {
      fallback = [];
    }
    fallback.sort((a, b) => Number(b.message_id) - Number(a.message_id));
    return fallback.slice(0, MAX_RAM_CACHE);
  }
}

function parseStandardApkName(fileName) {
  if (!fileName) return null;
  const clean = fileName.replace(/\.apk$/i, "").trim();

  const modsMatch = clean.match(/\((.*?)\)\s*$/);
  if (!modsMatch || !modsMatch[1].trim()) {
    return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
  }

  const mods = modsMatch[1].trim();
  let nameAndVer = clean.replace(/\s*\((.*?)\)\s*$/, "").trim().replace(/[_\-]+$/, "").trim();

  const lastUnderscore = nameAndVer.lastIndexOf("_");
  if (lastUnderscore === -1) {
    return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
  }

  const appName = nameAndVer.substring(0, lastUnderscore).trim();
  const version = nameAndVer.substring(lastUnderscore + 1).trim();

  if (appName && version && mods) {
    return { appName, version, mods, isValid: true };
  }

  return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
}

async function searchApksRaw(queryStr) {
  const allApks = await getAllApksFromChannelOptimized(false);
  if (allApks.length === 0) return [];

  const cleanQuery = queryStr.toLowerCase().replace(/\.apk$/i, "").trim();
  return allApks
    .filter((item) => (item.file_name || "").toLowerCase().includes(cleanQuery))
    .sort((a, b) => Number(b.message_id) - Number(a.message_id));
}

async function searchApksStandard(queryStr) {
  const allApks = await getAllApksFromChannelOptimized(false);
  if (allApks.length === 0) return [];

  const cleanQuery = queryStr.toLowerCase().replace(/\.apk$/i, "").trim();
  return allApks
    .filter((item) => {
      const data = parseStandardApkName(item.file_name);
      return data && data.isValid && data.appName.toLowerCase().includes(cleanQuery);
    })
    .sort((a, b) => Number(b.message_id) - Number(a.message_id));
}

function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return "";
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || "Người dùng"}</a>`;
}

async function sendApkViaCopy(ctx, item) {
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, { caption: "" });
  } catch (e) {
    logError("SEND", `Lỗi copyMessage ID ${item.message_id}`, e);

    if (e.response && e.response.error_code === 400) {
      await removeApkFromCache(item.message_id);
      await ctx.reply("❌ File APK này không còn tồn tại hoặc đã bị xóa!");
    } else {
      await ctx.reply("❌ Hệ thống gián đoạn, không thể gửi file lúc này!");
    }
    return false;
  }

  const data = parseStandardApkName(item.file_name);
  let text = data && data.isValid 
    ? `Tên ứng dụng: <code>${data.appName}</code>\nPhiên bản: <code>${data.version}</code>\nMods: <code>${data.mods}</code>\n`
    : `Tên file: <code>${item.file_name}</code>\n`;

  if (item.sender) text += `Apk đc gửi bởi: ${item.sender}`;

  if (text.trim()) {
    await ctx.reply(text.trim(), { parse_mode: "HTML" });
  }
  return true;
}

async function handleSearchResults(ctx, matches) {
  if (matches.length === 0) {
    return ctx.reply("Không tìm thấy APK!");
  }

  if (matches.length < 3) {
    for (const item of matches) {
      await sendApkViaCopy(ctx, item);
    }
  } else {
    const searchId = Date.now().toString();

    if (global.searchCache.size >= MAX_SEARCH_CACHE) {
      const firstKey = global.searchCache.keys().next().value;
      global.searchCache.delete(firstKey);
    }

    const idList = matches.map((m) => m.message_id);
    global.searchCache.set(searchId, idList);

    setTimeout(() => {
      global.searchCache.delete(searchId);
    }, 5 * 60 * 1000);

    await ctx.reply(
      `Tìm thấy ${matches.length} kết quả. Bạn muốn hiển thị như thế nào?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Một 😅", `show_1_${searchId}`),
          Markup.button.callback("Toàn bộ 😈", `show_all_${searchId}`),
        ],
      ])
    );
  }
}

// Hàm render trang /list
async function renderListPage(botUsername, page = 1) {
  const validUsername = botUsername || bot.botInfo?.username || "";
  const allApks = await getAllApksFromChannelOptimized(false);
  const totalItems = allApks.length;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;

  page = Math.max(1, Math.min(page, totalPages));

  const startIndex = (page - 1) * PAGE_SIZE;
  const pageItems = allApks.slice(startIndex, startIndex + PAGE_SIZE);

  if (pageItems.length === 0) {
    return { text: "Hiện chưa có file APK nào!", keyboard: null };
  }

  let text = `Danh sách apk (Trang ${page}/${totalPages}):\n`;

  pageItems.forEach((item) => {
    const deepLink = `https://t.me/${validUsername}?start=get_${item.message_id}`;
    const itemText = `<code>${item.message_id}</code>. <a href="${deepLink}">${item.file_name}</a>\n`;

    if ((text + itemText).length <= 3800) {
      text += itemText;
    }
  });

  const buttons = [];
  if (page > 1) {
    buttons.push(Markup.button.callback("⬅️", `list_page_${page - 1}`));
  }
  if (page < totalPages) {
    buttons.push(Markup.button.callback("➡️", `list_page_${page + 1}`));
  }

  const keyboard = Markup.inlineKeyboard([
    buttons,
    [Markup.button.callback("Đóng", "close_list")]
  ]);

  return { text, keyboard };
}

// 1. CHỈ LỆNH /list HOẶC DEEP LINK ?start=list
bot.command("list", async (ctx) => {
  const waitMsg = await ctx.reply("Đang lấy danh sách...");
  const botUsername = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;

  const { text, keyboard } = await renderListPage(botUsername, 1);
  try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

  await ctx.reply(text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard || {})
  });
});

// 2. CHỈ XỬ LÝ /start DẠNG t.me/username?start=list HOẶC t.me/username?start=get_id
bot.command("start", async (ctx) => {
  const text = ctx.message.text.trim();
  const args = text.split(/\s+/);
  const payload = args[1]?.trim() || "";

  // Xử lý t.me/username?start=list
  if (payload.toLowerCase() === "list") {
    const waitMsg = await ctx.reply("Đang lấy danh sách...");
    try {
      const botUsername = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;
      const { text: listText, keyboard } = await renderListPage(botUsername, 1);

      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

      await ctx.reply(listText, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(keyboard || {})
      });
    } catch (e) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      logError("START_LIST", "Lỗi hiển thị danh sách", e);
      await ctx.reply("❌ Không thể lấy danh sách APK!");
    }
    return;
  }

  // Xử lý t.me/username?start=get_12345
  if (payload.toLowerCase().startsWith("get_")) {
    const rawId = payload.substring(4).trim();
    const msgId = Number(rawId);

    if (!Number.isSafeInteger(msgId) || msgId <= 0) {
      return ctx.reply("❌ ID tin nhắn không hợp lệ!");
    }

    const waitMsg = await ctx.reply("🚀 Đang kiểm tra file...");
    await ctx.sendChatAction("upload_document");

    try {
      const allApks = await getAllApksFromChannelOptimized(false);
      let item = allApks.find((a) => Number(a.message_id) === msgId);

      if (!item) {
        const client = await getGramClient();
        const channelPeer = getParsedChannelPeer();

        if (client && channelPeer) {
          const msgs = await client.getMessages(channelPeer, { ids: [msgId] }).catch(() => []);
          const msg = Array.isArray(msgs) ? msgs[0] : null;

          if (msg && msg.media && msg.media.document) {
            const attr = msg.media.document.attributes?.find((a) => a.fileName);
            const fileName = attr ? attr.fileName : "";

            if (fileName.toLowerCase().endsWith(".apk")) {
              item = {
                message_id: msg.id,
                file_name: fileName,
                sender: msg.postAuthor || (msg.fromId?.userId ? `<a href="tg://user?id=${msg.fromId.userId}">Người dùng</a>` : ""),
                chat_id: STORAGE_CHANNEL,
              };
            }
          }
        }
      }

      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

      if (!item) {
        return ctx.reply("❌ File APK không tồn tại hoặc đã bị gỡ!");
      }

      await sendApkViaCopy(ctx, item);

    } catch (e) {
      try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
      logError("START_GET", `Lỗi lấy APK ID ${msgId}`, e);
      return ctx.reply("❌ Đã xảy ra lỗi khi lấy file APK!");
    }
    return;
  }

  // Lệnh /start bình thường không tham số
  await ctx.reply("Chào bạn! Vui lòng nhập /help để xem hướng dẫn sử dụng.");
});

bot.command("help", async (ctx) => {
  let helpText = `Danh sách lệnh hỗ trợ:
/ping - Kiểm tra tốc độ
/apk - Đếm số lượng APK có sẵn
/list - Liệt kê danh sách APK
/any <từ khoá> - Tìm kiếm tên file trực tiếp
/many <từ khoá> - Tìm kiếm APK (Chuẩn thông tin)
/regex <pattern> - Tìm kiếm bằng Regex trực tiếp
/msg - Gửi tin nhắn tới Owner`;

  if (OWNER_ID && String(ctx.from.id) === String(OWNER_ID)) {
    helpText += `\n/delcache - Xóa bộ nhớ tạm (Redis & RAM)`;
  }

  await ctx.reply(helpText);
});

// Chuyển trang qua nút bấm Inline
bot.action(/^list_page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const botUsername = ctx.botInfo?.username || (await ctx.telegram.getMe()).username;

  await ctx.answerCbQuery();
  const { text, keyboard } = await renderListPage(botUsername, page);

  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard || {})
    });
  } catch (e) {
    logError("LIST", "Lỗi cập nhật trang", e);
  }
});

bot.action("close_list", async (ctx) => {
  try { await ctx.deleteMessage(); } catch (e) {}
});

bot.command("delcache", async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.reply("Lệnh này chỉ dành cho Owner!");
  }

  await ctx.reply(
    "⚠️ Bạn chắc chắn muốn xoá toàn bộ cache?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("XOÁ! 🔥", "confirm_delcache"),
        Markup.button.callback("thui bỏ đi 😆", "cancel_delcache"),
      ],
    ])
  );
});

bot.action("confirm_delcache", async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.answerCbQuery("⛔ Không có quyền!", { show_alert: true });
  }

  try {
    await redis.del("apk_list");
    await redis.del("apk_last_max_id");

    liveSweepCache = { data: [], lastFetch: 0 };
    global.searchCache.clear();
    global.fileStoreCache.clear();

    if (clientInstance) {
      try {
        await clientInstance.disconnect();
      } catch (e) {}
      clientInstance = null;
    }

    await ctx.answerCbQuery("Đã xoá cache!");
    await ctx.editMessageText("🧹 Đã xoá toàn bộ dữ liệu tạm RAM & Redis thành công.");
  } catch (e) {
    logError("CACHE", "Lỗi xoá cache", e);
    await ctx.answerCbQuery("Lỗi xoá cache!", { show_alert: true });
  }
});

bot.action("cancel_delcache", async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.answerCbQuery("⛔ Không có quyền!", { show_alert: true });
  }
  await ctx.answerCbQuery("Đã huỷ!");
  await ctx.editMessageText("❌ Đã huỷ xoá cache.");
});

bot.command("ping", async (ctx) => {
  const start = Date.now();
  await ctx.sendChatAction("typing");
  await ctx.reply(`🏓 Pong! ${Date.now() - start}ms`);
});

bot.command("apk", async (ctx) => {
  const statusMsg = await ctx.reply("Đang kiểm tra...");
  await ctx.sendChatAction("typing");
  const allApks = await getAllApksFromChannelOptimized(false);
  await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `Tổng số APK: ${allApks.length}`);
});

bot.command("msg", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Lệnh này chỉ dùng trong chat riêng!");
  await ctx.reply("Hãy trả lời tin nhắn này với nội dung bạn muốn nói:　", {
    reply_markup: { force_reply: true },
  });
});

bot.command("any", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("Vui lòng nhập từ khoá! (VD: /any zarchiver)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");
  const matches = await searchApksRaw(args);

  try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  await handleSearchResults(ctx, matches);
});

bot.command("many", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("Vui lòng nhập từ khoá! (VD: /many zarchiver)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");
  const matches = await searchApksStandard(args);

  try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  await handleSearchResults(ctx, matches);
});

bot.command("regex", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("Vui lòng nhập mẫu Regex! (VD: /regex zarchiver.*)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");

  let matched = [];
  try {
    const allApks = await getAllApksFromChannelOptimized(false);
    const reg = new RegExp(args.replace(/\.apk$/i, "").trim(), "i");
    matched = allApks.filter((item) => reg.test(item.file_name || "")).sort((a, b) => Number(b.message_id) - Number(a.message_id));
  } catch (e) {
    try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
    return ctx.reply("Cú pháp Regex không hợp lệ!");
  }

  try { await ctx.deleteMessage(waitMsg.message_id); } catch {}
  await handleSearchResults(ctx, matched);
});

bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
  const matchedIds = global.searchCache.get(searchId);

  await ctx.answerCbQuery();

  try { await ctx.deleteMessage(); } catch (e) {}

  if (!matchedIds || matchedIds.length === 0) {
    return ctx.reply("Kết quả đã hết hạn!");
  }

  await ctx.sendChatAction("upload_document");

  const allApks = await getAllApksFromChannelOptimized(false);
  const apkMap = new Map(allApks.map((item) => [item.message_id, item]));

  const targetIds = mode === "1" ? [matchedIds[0]] : matchedIds;
  for (const id of targetIds) {
    const item = apkMap.get(id);
    if (item) {
      await sendApkViaCopy(ctx, item);
    }
  }

  global.searchCache.delete(searchId);
});

bot.on("document", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith(".apk")) return;

  const storeKey = Math.random().toString(36).substring(2, 8);
  global.fileStoreCache.set(storeKey, doc.file_id);

  setTimeout(() => { global.fileStoreCache.delete(storeKey); }, 10 * 60 * 1000);

  const parsedData = parseStandardApkName(doc.file_name);
  if (parsedData && parsedData.isValid) {
    await ctx.reply(`Tên ứng dụng: ${parsedData.appName}\nPhiên bản: ${parsedData.version}\nMods: ${parsedData.mods}`);
  } else {
    await ctx.reply(`Tên file: ${doc.file_name}`);
  }

  await ctx.reply(
    "Bạn có muốn gửi file này vào dữ liệu lưu trữ không?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🟢", `store_${storeKey}`),
        Markup.button.callback("🔴", `cancel_${storeKey}`),
      ],
    ])
  );
});

bot.action(/^store_(.+)$/, async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.answerCbQuery("⛔ Chỉ Owner mới có quyền lưu trữ file!", { show_alert: true });
  }

  const storeKey = ctx.match[1];
  const fileId = global.fileStoreCache.get(storeKey);
  if (!fileId) return ctx.answerCbQuery("Yêu cầu đã hết hạn!");

  await ctx.answerCbQuery("Đang gửi...");

  if (STORAGE_CHANNEL) {
    try {
      await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
      await ctx.editMessageText("✅ Đã gửi file vào dữ liệu lưu trữ thành công!");
      global.fileStoreCache.delete(storeKey);
    } catch (e) {
      await ctx.editMessageText("Lỗi: Bot chưa được phong quyền Admin trong Kênh lưu trữ!");
    }
  }
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  const storeKey = ctx.match[1];
  global.fileStoreCache.delete(storeKey);
  await ctx.answerCbQuery("Đã hủy!");
  try { await ctx.editMessageText("❌ Đã hủy thao tác lưu trữ."); } catch (e) {}
});

// Xử lý tin nhắn văn bản thông thường (Search APK)
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (ctx.chat.type !== "private") return;
    if (/^(https?:\/\/)?t\.me\//i.test(text) || text.toLowerCase() === "list") {
    return ctx.reply("/list");
    }
  const repliedMessage = ctx.message.reply_to_message;
  if (
    repliedMessage &&
    repliedMessage.from?.id === ctx.botInfo.id &&
    repliedMessage.text?.includes("　")
  ) {
    if (OWNER_ID) {
      await ctx.telegram.sendMessage(
        OWNER_ID,
        `Tin nhắn từ ${getSenderTag(ctx)}:\n${text}`,
        { parse_mode: "HTML" }
      );
    }

    try {
      await ctx.deleteMessage(ctx.message.message_id);
      await ctx.deleteMessage(repliedMessage.message_id);
      await ctx.reply("Cảm ơn, tin nhắn đã được gửi!");
    } catch (e) {
      await ctx.reply("Cảm ơn, tin nhắn đã được gửi!");
    }
    return;
  }

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");

  const matches = await searchApksStandard(text);

  try { await ctx.deleteMessage(waitMsg.message_id); } catch {}

  if (matches.length > 0) {
    await sendApkViaCopy(ctx, matches[0]);
  } else {
    await ctx.reply("Không tìm thấy APK!");
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      await bot.handleUpdate(req.body);
      res.status(200).send("OK");
    } else {
      res.status(200).send("Bot đang hoạt động...");
    }
  } catch (err) {
    logError("WEBHOOK", "Lỗi xử lý Webhook", err);
    res.status(500).send("Internal Server Error");
  }
};
