const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const API_ID = Number(process.env.API_ID || 0);
const API_HASH = process.env.API_HASH || '';

global.msgState = global.msgState || new Map();
global.searchCache = global.searchCache || new Map();

let clientInstance = null;

// Hàm hỗ trợ ghi Log Vercel chi tiết
function logInfo(tag, message, data = '') {
  console.log(`[${new Date().toISOString()}] [${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

function logError(tag, message, error) {
  console.error(`[${new Date().toISOString()}] [ERROR:${tag}] ${message}`, error);
}

// Xử lý ID Kênh phù hợp với GramJS (Cần chuyển sang BigInt nếu là số)
function getParsedChannelPeer() {
  if (!STORAGE_CHANNEL) return null;
  try {
    if (/^-?\d+$/.test(STORAGE_CHANNEL)) {
      return BigInt(STORAGE_CHANNEL);
    }
    return STORAGE_CHANNEL;
  } catch (e) {
    logError('CONFIG', 'Lỗi parse STORAGE_CHANNEL_ID', e);
    return STORAGE_CHANNEL;
  }
}

// Khởi tạo GramJS Client
async function getGramClient() {
  if (clientInstance && clientInstance.connected) {
    return clientInstance;
  }
  if (!API_ID || !API_HASH || !process.env.BOT_TOKEN) {
    logError('GRAMJS', 'Thiếu cấu hình API_ID, API_HASH hoặc BOT_TOKEN');
    return null;
  }

  try {
    logInfo('GRAMJS', 'Đang khởi tạo Telegram Client...');
    clientInstance = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 3,
      timeout: 10000,
    });
    await clientInstance.start({ botAuthToken: process.env.BOT_TOKEN });
    logInfo('GRAMJS', 'Khởi tạo GramJS thành công!');
    return clientInstance;
  } catch (err) {
    logError('GRAMJS', 'Không thể kết nối GramJS', err);
    return null;
  }
}

// Tính khoảng cách Levenshtein (Fuzzy search)
function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

// Tìm kiếm APK trong Kênh qua GramJS
async function searchApksInChannel(queryStr) {
  const client = await getGramClient();
  const channelPeer = getParsedChannelPeer();

  if (!client || !channelPeer) {
    logError('SEARCH', 'Client GramJS hoặc STORAGE_CHANNEL_ID không hợp lệ');
    return [];
  }

  const cleanQuery = queryStr.toLowerCase().replace(/\.apk$/i, '').trim();
  logInfo('SEARCH', `Bắt đầu quét file trong Kênh với từ khoá: "${cleanQuery}"`);

  try {
    // Quét trực tiếp bằng từ khóa
    const res = await client.getMessages(channelPeer, {
      search: cleanQuery,
      filter: new Api.InputMessagesFilterDocument(),
      limit: 50,
    });

    logInfo('SEARCH', `Tìm thấy ${res.length} tin nhắn phù hợp qua tìm kiếm trực tiếp`);

    let matches = [];
    for (const msg of res) {
      if (msg.media && msg.media.document) {
        const attr = msg.media.document.attributes.find(a => a.fileName);
        const fileName = attr ? attr.fileName : '';
        if (fileName.toLowerCase().endsWith('.apk')) {
          let senderTag = '';
          if (msg.postAuthor) {
            senderTag = msg.postAuthor;
          } else if (msg.fromId && msg.fromId.userId) {
            senderTag = `<a href="tg://user?id=${msg.fromId.userId}">Người dùng</a>`;
          }

          matches.push({
            message_id: msg.id,
            file_name: fileName,
            sender: senderTag,
            chat_id: STORAGE_CHANNEL
          });
        }
      }
    }

    // Nếu không khớp từ khóa -> Tự động bật Fuzzy Match trên 100 file mới nhất
    if (matches.length === 0) {
      logInfo('SEARCH', 'Không thấy kết quả chính xác, chuyển sang quét mờ (Fuzzy Search)...');
      const recentRes = await client.getMessages(channelPeer, {
        filter: new Api.InputMessagesFilterDocument(),
        limit: 100,
      });

      const allFiles = [];
      for (const msg of recentRes) {
        if (msg.media && msg.media.document) {
          const attr = msg.media.document.attributes.find(a => a.fileName);
          const fileName = attr ? attr.fileName : '';
          if (fileName.toLowerCase().endsWith('.apk')) {
            let senderTag = '';
            if (msg.postAuthor) senderTag = msg.postAuthor;
            else if (msg.fromId && msg.fromId.userId) senderTag = `<a href="tg://user?id=${msg.fromId.userId}">Người dùng</a>`;

            allFiles.push({
              message_id: msg.id,
              file_name: fileName,
              sender: senderTag,
              chat_id: STORAGE_CHANNEL
            });
          }
        }
      }

      const scored = allFiles.map(item => {
        const cleanName = item.file_name.toLowerCase().replace(/\.apk$/i, '');
        const dist = levenshteinDistance(cleanQuery, cleanName);
        const words = cleanName.split(/[\s_\-\(\)\.]+/);
        let minWordDist = dist;
        for (const w of words) {
          if (w) {
            const d = levenshteinDistance(cleanQuery, w);
            if (d < minWordDist) minWordDist = d;
          }
        }
        return { item, score: Math.min(dist, minWordDist) };
      });

      const maxAllowed = Math.max(2, Math.floor(cleanQuery.length / 3));
      matches = scored
        .filter(s => s.score <= maxAllowed)
        .sort((a, b) => a.score - b.score)
        .map(s => s.item);
    }

    logInfo('SEARCH', `Tổng kết quả tìm kiếm cuối cùng: ${matches.length}`);
    return matches;
  } catch (err) {
    logError('SEARCH', 'Lỗi khi gọi GramJS getMessages', err);
    return [];
  }
}

// Parse tên ứng dụng chuẩn
function parseStandardApkName(fileName) {
  if (!fileName || !fileName.endsWith('.apk')) return null;
  const regex = /^(.+)_(.+)\((.+)\)\.apk$/i;
  const match = fileName.match(regex);
  if (!match) return null;
  return {
    appName: match[1].trim(),
    version: match[2].trim(),
    mods: match[3].trim()
  };
}

// Lấy Tag người gửi
function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || 'Người dùng'}</a>`;
}

// Chuyển tiếp file APK
async function sendApkViaCopy(ctx, item) {
  try {
    logInfo('SEND', `Đang copy message ${item.message_id} từ ${item.chat_id}`);
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, { caption: '' });
  } catch (e) {
    logError('SEND', 'Lỗi copyMessage', e);
  }

  if (item.sender) {
    await ctx.reply(`Apk đc gửi bởi: ${item.sender}`, { parse_mode: 'HTML' });
  }
}

// Xử lý gửi trả kết quả
async function handleSearchResults(ctx, matches) {
  if (matches.length === 0) {
    return ctx.reply('Không tìm thấy APK phù hợp trong kênh!');
  }

  if (matches.length <= 3) {
    for (const item of matches) {
      await sendApkViaCopy(ctx, item);
    }
  } else {
    const searchId = Date.now().toString();
    global.searchCache.set(searchId, matches);

    await ctx.reply(`Tìm thấy ${matches.length} kết quả. Bạn muốn hiển thị như thế nào?`, Markup.inlineKeyboard([
      [
        Markup.button.callback('Chỉ 1', `show_1_${searchId}`),
        Markup.button.callback('Toàn bộ', `show_all_${searchId}`)
      ]
    ]));
  }
}

// Bỏ qua lệnh trong Nhóm
bot.use(async (ctx, next) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) return;
  return next();
});

// Lệnh /start
bot.command('start', async (ctx) => {
  logInfo('BOT', `Lệnh /start từ ${ctx.from.id}`);
  await ctx.reply('Chào bạn! Vui lòng nhập /help để xem hướng dẫn sử dụng.');
});

// Lệnh /help
bot.command('help', async (ctx) => {
  logInfo('BOT', `Lệnh /help từ ${ctx.from.id}`);
  const helpText = 
`Danh sách lệnh hỗ trợ:
/ping - Kiểm tra tốc độ
/apk - Đếm số lượng APK có sẵn
/any <từ khoá>.apk - Tìm kiếm APK
/regex <pattern>.apk - Tìm kiếm bằng Regex
/msg - Gửi tin nhắn tới Owner`;
  await ctx.reply(helpText);
});

// Lệnh /ping
bot.command('ping', async (ctx) => {
  logInfo('BOT', `Lệnh /ping từ ${ctx.from.id}`);
  const start = Date.now();
  await ctx.sendChatAction('typing');
  const latency = Date.now() - start;
  await ctx.reply(`⚡ Tốc độ phản hồi: ${latency}ms`);
});

// Lệnh /apk
bot.command('apk', async (ctx) => {
  logInfo('BOT', `Lệnh /apk từ ${ctx.from.id}`);
  const statusMsg = await ctx.reply('Đang đếm số lượng...');
  await ctx.sendChatAction('typing');

  const client = await getGramClient();
  const channelPeer = getParsedChannelPeer();

  let total = 0;
  if (client && channelPeer) {
    try {
      const res = await client.getMessages(channelPeer, {
        filter: new Api.InputMessagesFilterDocument(),
        limit: 1,
      });
      total = res.total || 0;
      logInfo('BOT', `Đã đếm tổng số APK trong Kênh: ${total}`);
    } catch (e) {
      logError('BOT', 'Lỗi đếm số lượng APK', e);
    }
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id, 
    statusMsg.message_id, 
    null, 
    `Tổng số APK có trong kênh: ${total}`
  );
});

// Lệnh /msg
bot.command('msg', async (ctx) => {
  logInfo('BOT', `Lệnh /msg từ ${ctx.from.id}`);
  const prompt = await ctx.reply('Hãy trả lời (reply) tin nhắn này với nội dung bạn muốn nói:', {
    reply_markup: { force_reply: true }
  });
  global.msgState.set(ctx.from.id, prompt.message_id);
});

// Lệnh /any <từ khoá>.apk
bot.command('any', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  logInfo('BOT', `Lệnh /any từ ${ctx.from.id} với query: "${args}"`);

  if (!args || !args.toLowerCase().endsWith('.apk')) {
    return ctx.reply('Vui lòng nhập từ khoá đúng cú pháp có đuôi .apk ở cuối! (VD: /any zarchiver.apk)');
  }

  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const matches = await searchApksInChannel(args);
  await handleSearchResults(ctx, matches);
});

// Lệnh /regex <pattern>.apk
bot.command('regex', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  logInfo('BOT', `Lệnh /regex từ ${ctx.from.id} với query: "${args}"`);

  if (!args || !args.toLowerCase().endsWith('.apk')) {
    return ctx.reply('Vui lòng nhập Regex đúng cú pháp có đuôi .apk ở cuối! (VD: /regex zarchiver.*\\.apk)');
  }

  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const patternStr = args.slice(0, -4).trim();
  const matches = await searchApksInChannel(patternStr);
  let filtered = [];

  try {
    const reg = new RegExp(patternStr, 'i');
    filtered = matches.filter(item => reg.test(item.file_name));
  } catch (e) {
    logError('BOT', 'Regex không hợp lệ', e);
  }

  if (filtered.length === 0) filtered = matches;
  await handleSearchResults(ctx, filtered);
});

// Inline Callback Button
bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
  logInfo('BOT', `Callback show_${mode} cho searchId: ${searchId}`);

  const results = global.searchCache.get(searchId);
  await ctx.answerCbQuery();

  if (!results) return ctx.reply('Kết quả đã hết hạn!');

  await ctx.sendChatAction('upload_document');
  const itemsToSend = mode === '1' ? [results[0]] : results;

  for (const item of itemsToSend) {
    await sendApkViaCopy(ctx, item);
  }
  global.searchCache.delete(searchId);
});

// Nhận APK trực tiếp trong Chat riêng
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith('.apk')) return;

  logInfo('BOT', `Nhận file APK từ Chat riêng: ${doc.file_name}`);
  const parsedData = parseStandardApkName(doc.file_name);

  if (parsedData) {
    await ctx.reply(
`Tên ứng dụng: ${parsedData.appName}
Phiên bản: ${parsedData.version}
Mods: ${parsedData.mods}`
    );
  }

  await ctx.reply('Bạn có muốn gửi file này vào nhóm lưu trữ không?', Markup.inlineKeyboard([
    [Markup.button.callback('Có', `store_${doc.file_id}`)]
  ]));
});

// Nút lưu file vào nhóm lưu trữ
bot.action(/^store_(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  logInfo('BOT', `Lưu file ${fileId} vào STORAGE_CHANNEL`);
  await ctx.answerCbQuery('Đã gửi!');

  if (STORAGE_CHANNEL) {
    try {
      await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
      await ctx.editMessageText('Đã gửi file vào nhóm lưu trữ thành công!');
    } catch (e) {
      logError('BOT', 'Lỗi gửi file vào STORAGE_CHANNEL', e);
      await ctx.editMessageText('Lỗi: Bot chưa được làm Admin Kênh/Nhóm lưu trữ!');
    }
  }
});

// Xử lý Văn bản thường (Gửi tin nhắn cho Owner hoặc Tự động tìm APK)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const replyToId = ctx.message.reply_to_message?.message_id;

  logInfo('BOT', `Nhận tin nhắn văn bản từ ${userId}: "${text}"`);

  // 1. Xử lý Reply cho /msg
  if (replyToId && global.msgState.get(userId) === replyToId) {
    if (OWNER_ID) {
      await ctx.telegram.sendMessage(
        OWNER_ID, 
        `Tin nhắn từ ${getSenderTag(ctx)}:\n\n${text}`, 
        { parse_mode: 'HTML' }
      );
    }
    try {
      await ctx.deleteMessage(ctx.message.message_id);
      await ctx.telegram.editMessageText(ctx.chat.id, replyToId, null, 'Cảm ơn');
    } catch (e) {
      await ctx.reply('Cảm ơn');
    }
    global.msgState.delete(userId);
    return;
  }

  // 2. Tự động tìm APK nếu người dùng nhập tên file hoặc nhập đúng định dạng
  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const parsed = parseStandardApkName(text);
  const queryStr = parsed ? parsed.appName : text;

  const matches = await searchApksInChannel(queryStr);

  if (matches.length > 0) {
    const item = matches[0];
    const data = parseStandardApkName(item.file_name) || {
      appName: item.file_name.replace(/\.apk$/i, ''),
      version: 'N/A',
      mods: 'N/A'
    };

    await sendApkViaCopy(ctx, item);
    await ctx.reply(
`Tên ứng dụng: ${data.appName}
Phiên bản: ${data.version}
Mods: ${data.mods}`
    );
  } else {
    // Luôn thông báo khi không tìm thấy file
    await ctx.reply('Không tìm thấy APK phù hợp trong kênh!');
  }
});

// Vercel Serverless Export Handler
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      logInfo('WEBHOOK', 'Nhận request Webhook từ Telegram');
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } else {
      res.status(200).send('Bot đang hoạt động...');
    }
  } catch (err) {
    logError('WEBHOOK', 'Lỗi xử lý Handler Webhook', err);
    res.status(500).send('Internal Server Error');
  }
};
