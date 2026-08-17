const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const Redis = require("ioredis");

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || "";

// Khởi tạo Redis Client
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
});

// Khởi tạo Cache RAM
global.searchCache = global.searchCache || new Map();
global.fileStoreCache = global.fileStoreCache || new Map();

let clientInstance = null;
let liveSweepCache = { data: [], lastFetch: 0 };
const CACHE_TTL = 3 * 60 * 1000; // Cache RAM 3 phút

function logInfo(tag, message, data = "") {
  console.log(
    `[${new Date().toISOString()}] [${tag}] ${message}`,
    data ? JSON.stringify(data) : "",
  );
}

function logError(tag, message, error) {
  console.error(
    `[${new Date().toISOString()}] [ERROR:${tag}] ${message}`,
    error,
  );
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
      {
        connectionRetries: 3,
        timeout: 10000,
      },
    );
    await clientInstance.start({ botAuthToken: process.env.BOT_TOKEN });
    return clientInstance;
  } catch (err) {
    logError("GRAMJS", "Lỗi kết nối GramJS", err);
    return null;
  }
}

// Dò ID lớn nhất trong kênh
async function getMaxMessageId(client, channelPeer) {
  const probeIds = [
    10, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000,
  ];
  try {
    const msgs = await client.getMessages(channelPeer, { ids: probeIds });
    const validMsgs = (Array.isArray(msgs) ? msgs : []).filter(
      (m) => m && m.id,
    );
    if (validMsgs.length === 0) return 500;
    const highestFound = Math.max(...validMsgs.map((m) => m.id));
    return highestFound + 100;
  } catch (e) {
    return 2000;
  }
}

// Quét theo nhóm có kiểm soát băng thông
async function fetchBatchesWithConcurrency(
  client,
  channelPeer,
  batches,
  limit = 4,
) {
  const results = [];
  for (let i = 0; i < batches.length; i += limit) {
    const chunk = batches.slice(i, i + limit);
    const chunkResults = await Promise.all(
      chunk.map((ids) =>
        client.getMessages(channelPeer, { ids }).catch(() => []),
      ),
    );
    results.push(...chunkResults);
  }
  return results;
}

// Quét tăng tiến (Tự động cập nhật nếu forceCheck = true)
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
    let storedApks = JSON.parse((await redis.get("apk_list")) || "[]");
    let lastScannedId = parseInt((await redis.get("apk_last_max_id")) || "0");

    const currentMaxId = await getMaxMessageId(client, channelPeer);

    if (lastScannedId >= currentMaxId) {
      storedApks.sort((a, b) => Number(b.message_id) - Number(a.message_id));
      liveSweepCache = { data: storedApks, lastFetch: Date.now() };
      return storedApks;
    }

    logInfo(
      "SWEEP",
      `Đang cập nhật APK mới từ ID ${lastScannedId + 1} đến ${currentMaxId}...`,
    );

    const startId =
      lastScannedId === 0
        ? Math.max(1, currentMaxId - 2000)
        : lastScannedId + 1;

    const chunkSize = 100;
    const batches = [];
    for (let current = currentMaxId; current >= startId; current -= chunkSize) {
      const ids = [];
      for (let i = 0; i < chunkSize && current - i >= startId; i++) {
        ids.push(current - i);
      }
      if (ids.length > 0) batches.push(ids);
    }

    const results = await fetchBatchesWithConcurrency(
      client,
      channelPeer,
      batches,
      4,
    );

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
              sender:
                msg.postAuthor ||
                (msg.fromId?.userId
                  ? `<a href="tg://user?id=${msg.fromId.userId}">Người dùng</a>`
                  : ""),
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

    liveSweepCache = { data: mergedApks, lastFetch: Date.now() };
    logInfo(
      "SWEEP",
      `Quét xong. Đã thêm ${newApks.length} file mới. Tổng: ${mergedApks.length}`,
    );

    return mergedApks;
  } catch (err) {
    logError("SWEEP", "Lỗi quét tăng tiến", err);
    const fallback = JSON.parse((await redis.get("apk_list")) || "[]");
    fallback.sort((a, b) => Number(b.message_id) - Number(a.message_id));
    return fallback;
  }
}

// Bắt buộc phải có ĐỦ CẢ 3: Tên ứng dụng, Phiên bản, và Mods trong ngoặc
function parseStandardApkName(fileName) {
  if (!fileName) return null;
  const clean = fileName.replace(/\.apk$/i, "").trim();

  // 1. Kiểm tra phần Mods nằm trong ngoặc tròn ở cuối
  const modsMatch = clean.match(/\((.*?)\)\s*$/);
  if (!modsMatch || !modsMatch[1].trim()) {
    return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
  }

  const mods = modsMatch[1].trim();
  let nameAndVer = clean.replace(/\s*\((.*?)\)\s*$/, "").trim();
  nameAndVer = nameAndVer.replace(/[_\-]+$/, "").trim();

  // 2. Tìm dấu gạch dưới để tách Tên ứng dụng và Phiên bản
  const lastUnderscore = nameAndVer.lastIndexOf("_");
  if (lastUnderscore === -1) {
    return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
  }

  const appName = nameAndVer.substring(0, lastUnderscore).trim();
  const version = nameAndVer.substring(lastUnderscore + 1).trim();

  // 3. Đảm bảo cả 3 thành phần đều không được rỗng
  if (appName && version && mods) {
    return {
      appName,
      version,
      mods,
      isValid: true,
    };
  }

  return { appName: clean, version: "N/A", mods: "N/A", isValid: false };
}

// Tìm kiếm thô trực tiếp (Có tự động check update)
async function searchApksRaw(queryStr) {
  const allApks = await getAllApksFromChannelOptimized(true);
  if (allApks.length === 0) return [];

  const cleanQuery = queryStr
    .toLowerCase()
    .replace(/\.apk$/i, "")
    .trim();

  const results = allApks.filter((item) => {
    const fileName = (item.file_name || "").toLowerCase();
    return fileName.includes(cleanQuery);
  });

  return results.sort((a, b) => Number(b.message_id) - Number(a.message_id));
}

// Tìm kiếm chuẩn hóa (Bỏ qua nếu thiếu 1 trong 3 thông tin & tự động check update)
async function searchApksStandard(queryStr) {
  const allApks = await getAllApksFromChannelOptimized(true);
  if (allApks.length === 0) return [];

  const cleanQuery = queryStr
    .toLowerCase()
    .replace(/\.apk$/i, "")
    .trim();

  const results = allApks.filter((item) => {
    const data = parseStandardApkName(item.file_name);
    // Bắt buộc phải đủ cả 3 thông tin (isValid = true) mới giữ lại
    if (!data || !data.isValid) return false;

    const appName = data.appName.toLowerCase();
    return appName.includes(cleanQuery);
  });

  return results.sort((a, b) => Number(b.message_id) - Number(a.message_id));
}

function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return "";
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || "Người dùng"}</a>`;
}

async function sendApkViaCopy(ctx, item) {
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, {
      caption: "",
    });
  } catch (e) {
    logError("SEND", "Lỗi copyMessage", e);
  }

  const data = parseStandardApkName(item.file_name);
  let text = "";
  if (data && data.isValid) {
    text += `Tên ứng dụng: ${data.appName}\nPhiên bản: ${data.version}\nMods: ${data.mods}\n`;
  } else {
    text += `Tên file: ${item.file_name}\n`;
  }
  if (item.sender) {
    text += `Apk đc gửi bởi: ${item.sender}`;
  }

  if (text.trim()) {
    await ctx.reply(text.trim(), { parse_mode: "HTML" });
  }
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
    global.searchCache.set(searchId, matches);

    await ctx.reply(
      `Tìm thấy ${matches.length} kết quả. Bạn muốn hiển thị như thế nào?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Một 😅", `show_1_${searchId}`),
          Markup.button.callback("Toàn bộ 😈", `show_all_${searchId}`),
        ],
      ]),
    );
  }
}

bot.use(async (ctx, next) => {
  return next();
});

bot.command("start", async (ctx) => {
  await ctx.reply("Chào bạn! Vui lòng nhập /help để xem hướng dẫn sử dụng.");
});

bot.command("help", async (ctx) => {
  let helpText = `Danh sách lệnh hỗ trợ:
/ping - Kiểm tra tốc độ
/apk - Đếm số lượng APK có sẵn
/any <từ khoá> - Tìm kiếm tên file trực tiếp
/many <từ khoá> - Tìm kiếm APK (Chuẩn thông tin)
/regex <pattern> - Tìm kiếm bằng Regex trực tiếp
/msg - Gửi tin nhắn tới Owner`;

  if (OWNER_ID && String(ctx.from.id) === String(OWNER_ID)) {
    helpText += `\n/delcache - Xóa bộ nhớ tạm (Redis & RAM)`;
  }

  await ctx.reply(helpText);
});

bot.command(["delcache"], async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.reply("Lệnh này chỉ dành cho Owner!");
  }

  try {
    await redis.del("apk_list");
    await redis.del("apk_last_max_id");

    liveSweepCache = { data: [], lastFetch: 0 };
    global.searchCache.clear();
    global.fileStoreCache.clear();

    await ctx.reply(
      "🧹 Đã xóa sạch toàn bộ Cache trong Redis và RAM thành công!",
    );
    logInfo("OWNER", `Owner (ID: ${ctx.from.id}) đã thực hiện xóa cache.`);
  } catch (err) {
    logError("OWNER", "Lỗi khi xóa cache", err);
    await ctx.reply("Xóa cache thất bại!");
  }
});

bot.command("ping", async (ctx) => {
  const start = Date.now();
  await ctx.sendChatAction("typing");
  const latency = Date.now() - start;
  await ctx.reply(`🏓 Pong: ${latency}ms`);
});

// Tự động kiểm tra và quét thêm APK mới khi bấm /apk
bot.command("apk", async (ctx) => {
  const statusMsg = await ctx.reply("Đang kiểm tra...");
  await ctx.sendChatAction("typing");

  const allApks = await getAllApksFromChannelOptimized(true);

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `Tổng số APK: ${allApks.length}`,
  );
});

bot.command("msg", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return ctx.reply("Lệnh này chỉ dùng trong chat riêng!");
  }

  const msg = await ctx.reply(
    "Hãy trả lời tin nhắn này với nội dung bạn muốn nói:　",
    {
      reply_markup: { force_reply: true },
    },
  );

  global.msgState = global.msgState || new Map();
  global.msgState.set(ctx.from.id, msg.message_id);
});

bot.command("any", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("Vui lòng nhập từ khoá! (VD: /any zarchiver)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");

  const matches = await searchApksRaw(args);

  try {
    await ctx.deleteMessage(waitMsg.message_id);
  } catch {}

  await handleSearchResults(ctx, matches);
});

bot.command("many", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("Vui lòng nhập từ khoá! (VD: /many zarchiver)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");

  const matches = await searchApksStandard(args);

  try {
    await ctx.deleteMessage(waitMsg.message_id);
  } catch {}

  await handleSearchResults(ctx, matches);
});

bot.command("regex", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args)
    return ctx.reply("Vui lòng nhập mẫu Regex! (VD: /regex zarchiver.*)");

  const waitMsg = await ctx.reply("Đang tìm apk...");
  await ctx.sendChatAction("upload_document");

  const allApks = await getAllApksFromChannelOptimized(true);
  let matched = [];

  try {
    const reg = new RegExp(args.replace(/\.apk$/i, "").trim(), "i");
    matched = allApks.filter((item) => reg.test(item.file_name || ""));
    matched.sort((a, b) => Number(b.message_id) - Number(a.message_id));
  } catch (e) {
    return ctx.reply("Cú pháp Regex không hợp lệ!");
  }

  try {
    await ctx.deleteMessage(waitMsg.message_id);
  } catch {}

  await handleSearchResults(ctx, matched);
});

bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
  const results = global.searchCache.get(searchId);

  await ctx.answerCbQuery();
  if (!results) return ctx.reply("Kết quả đã hết hạn!");

  await ctx.sendChatAction("upload_document");
  const itemsToSend = mode === "1" ? [results[0]] : results;

  for (const item of itemsToSend) {
    await sendApkViaCopy(ctx, item);
  }
  global.searchCache.delete(searchId);
});

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith(".apk")) return;

  const storeKey = Math.random().toString(36).substring(2, 8);
  global.fileStoreCache.set(storeKey, doc.file_id);

  const parsedData = parseStandardApkName(doc.file_name);

  if (parsedData && parsedData.isValid) {
    await ctx.reply(
      `Tên ứng dụng: ${parsedData.appName}
Phiên bản: ${parsedData.version}
Mods: ${parsedData.mods}`,
    );
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
    ]),
  );
});

bot.action(/^store_(.+)$/, async (ctx) => {
  if (!OWNER_ID || String(ctx.from.id) !== String(OWNER_ID)) {
    return ctx.answerCbQuery("⛔ Chỉ Owner mới có quyền lưu trữ file!", {
      show_alert: true,
    });
  }

  const storeKey = ctx.match[1];
  const fileId = global.fileStoreCache.get(storeKey);

  if (!fileId) return ctx.answerCbQuery("Yêu cầu đã hết hạn!");

  await ctx.answerCbQuery("Đang gửi...");

  if (STORAGE_CHANNEL) {
    try {
      await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
      await ctx.editMessageText(
        "✅ Đã gửi file vào dữ liệu lưu trữ thành công!",
      );
      global.fileStoreCache.delete(storeKey);
    } catch (e) {
      await ctx.editMessageText(
        "Lỗi: Bot chưa được phong quyền Admin trong Kênh lưu trữ!",
      );
    }
  }
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  const storeKey = ctx.match[1];
  global.fileStoreCache.delete(storeKey);
  await ctx.answerCbQuery("Đã hủy!");
  try {
    await ctx.editMessageText("❌ Đã hủy thao tác lưu trữ.");
  } catch (e) {}
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
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
        { parse_mode: "HTML" },
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

  try {
    await ctx.deleteMessage(waitMsg.message_id);
  } catch {}

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
