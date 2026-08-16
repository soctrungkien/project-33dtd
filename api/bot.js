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

// Khởi tạo Telegram Client (GramJS) để tìm file có sẵn trong Kênh
async function getGramClient() {
  if (clientInstance && clientInstance.connected) {
    return clientInstance;
  }
  if (!API_ID || !API_HASH) return null;
  clientInstance = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 3,
  });
  await clientInstance.start({ botAuthToken: process.env.BOT_TOKEN });
  return clientInstance;
}

// Tính khoảng cách Levenshtein (Xử lý gõ sai từ)
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

// Tìm kiếm file APK sẵn có trong Kênh
async function searchApksInChannel(queryStr) {
  const client = await getGramClient();
  if (!client || !STORAGE_CHANNEL) return [];

  const cleanQuery = queryStr.toLowerCase().replace(/\.apk$/i, '').trim();

  try {
    const res = await client.getMessages(STORAGE_CHANNEL, {
      search: cleanQuery,
      filter: new Api.InputMessagesFilterDocument(),
      limit: 50,
    });

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

    // Nếu không tìm thấy kết quả chính xác -> Quét lấy file gần nhất để Fuzzy Search (Sửa lỗi gõ sai)
    if (matches.length === 0) {
      const recentRes = await client.getMessages(STORAGE_CHANNEL, {
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

    return matches;
  } catch (err) {
    console.error('Lỗi tìm kiếm Kênh:', err);
    return [];
  }
}

// Parse tên ứng dụng chuẩn: Tên app_Phiên bản 1.0(Các mod trong apk).apk
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

// Định dạng Tag người gửi
function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || 'Người dùng'}</a>`;
}

// Chuyển tiếp file APK sang người dùng (Không chuyển tiếp tên hay nội dung gốc)
async function sendApkViaCopy(ctx, item) {
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, { caption: '' });
  } catch (e) {
    console.error('Lỗi copyMessage:', e);
  }

  // Chỉ gửi nếu có thông tin người gửi
  if (item.sender) {
    await ctx.reply(`Apk đc gửi bởi: ${item.sender}`, { parse_mode: 'HTML' });
  }
}

// Xử lý gửi trả kết quả
async function handleSearchResults(ctx, matches) {
  if (matches.length === 0) {
    return ctx.reply('Không tìm thấy APK phù hợp!');
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

// Ngăn bot thực hiện lệnh tìm kiếm trong nhóm
bot.use(async (ctx, next) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) return; // Bỏ qua tất cả tương tác lệnh trong nhóm
  return next();
});

// Lệnh /start
bot.command('start', async (ctx) => {
  await ctx.reply('Chào bạn! Vui lòng nhập /help để xem hướng dẫn sử dụng.');
});

// Lệnh /help
bot.command('help', async (ctx) => {
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
  const start = Date.now();
  const latency = Date.now() - start;
  await ctx.reply(`⚡ Tốc độ phản hồi: ${latency}ms`);
});

// Lệnh /apk (Đếm tổng số APK sẵn có trong kênh)
bot.command('apk', async (ctx) => {
  const statusMsg = await ctx.reply('Đang đếm số lượng...');
  const client = await getGramClient();

  let total = 0;
  if (client && STORAGE_CHANNEL) {
    try {
      const res = await client.getMessages(STORAGE_CHANNEL, {
        filter: new Api.InputMessagesFilterDocument(),
        limit: 1,
      });
      total = res.total || 0;
    } catch (e) {}
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
  const prompt = await ctx.reply('Hãy trả lời (reply) tin nhắn này với nội dung bạn muốn nói:', {
    reply_markup: { force_reply: true }
  });
  global.msgState.set(ctx.from.id, prompt.message_id);
});

// Lệnh /any <từ khoá>.apk
bot.command('any', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  if (!args || !args.toLowerCase().endsWith('.apk')) {
    return ctx.reply('Vui lòng nhập từ khoá đúng cú pháp có đuôi .apk ở cuối! (VD: /any zarchiver.apk)');
  }

  await ctx.reply('Đang tìm apk...');
  const matches = await searchApksInChannel(args);
  await handleSearchResults(ctx, matches);
});

// Lệnh /regex <pattern>.apk
bot.command('regex', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  if (!args || !args.toLowerCase().endsWith('.apk')) {
    return ctx.reply('Vui lòng nhập Regex đúng cú pháp có đuôi .apk ở cuối! (VD: /regex zarchiver.*\\.apk)');
  }

  await ctx.reply('Đang tìm apk...');
  const patternStr = args.slice(0, -4).trim();
  
  // Tìm danh sách file trong kênh
  const matches = await searchApksInChannel(patternStr);
  let filtered = [];

  try {
    const reg = new RegExp(patternStr, 'i');
    filtered = matches.filter(item => reg.test(item.file_name));
  } catch (e) {}

  if (filtered.length === 0) filtered = matches;
  await handleSearchResults(ctx, filtered);
});

// Callback nút Inline
bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
  const results = global.searchCache.get(searchId);

  await ctx.answerCbQuery();
  if (!results) return ctx.reply('Kết quả đã hết hạn!');

  const itemsToSend = mode === '1' ? [results[0]] : results;
  for (const item of itemsToSend) {
    await sendApkViaCopy(ctx, item);
  }
  global.searchCache.delete(searchId);
});

// Nhận file APK trực tiếp từ Chat riêng
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith('.apk')) return;

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

// Nút bấm lưu file vào Nhóm lưu trữ
bot.action(/^store_(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery('Đã gửi!');
  if (STORAGE_CHANNEL) {
    await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
    await ctx.editMessageText('Đã gửi file vào nhóm lưu trữ thành công!');
  }
});

// Xử lý tin nhắn văn bản chung (Lệnh /msg reply & Tự động tìm kiếm)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const replyToId = ctx.message.reply_to_message?.message_id;

  // Xử lý reply cho lệnh /msg
  if (replyToId && global.msgState.get(userId) === replyToId) {
    const userText = ctx.message.text;
    if (OWNER_ID) {
      await ctx.telegram.sendMessage(
        OWNER_ID, 
        `Tin nhắn từ ${getSenderTag(ctx)}:\n\n${userText}`, 
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

  // Tự động tìm kiếm file mới nhất khi nhập chuẩn định dạng
  const text = ctx.message.text.trim();
  const parsed = parseStandardApkName(text);

  if (parsed) {
    await ctx.reply('Đang tìm apk...');
    const matches = await searchApksInChannel(parsed.appName);

    if (matches.length > 0) {
      const item = matches[0];
      const data = parseStandardApkName(item.file_name) || parsed;
      await sendApkViaCopy(ctx, item);
      await ctx.reply(
`Tên ứng dụng: ${data.appName}
Phiên bản: ${data.version}
Mods: ${data.mods}`
      );
    } else {
      await ctx.reply('Không tìm thấy APK phù hợp!');
    }
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } else {
      res.status(200).send('Bot đang chạy...');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
};
