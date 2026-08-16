const { Telegraf, Markup } = require('telegraf');
const Redis = require('ioredis');

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

// Tối ưu kết nối Redis trên môi trường Serverless (Vercel)
if (!global.redisClient) {
  global.redisClient = new Redis(process.env.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
}
const redis = global.redisClient;

// Bắt toàn bộ lỗi không xác định
bot.catch((err, ctx) => {
  console.error(`[TELEGRAF_ERROR] Lỗi xử lý update ${ctx.update?.update_id}:`, err);
  ctx.reply('Đã xảy ra lỗi trong quá trình xử lý yêu cầu, vui lòng thử lại sau!').catch(() => {});
});

function logError(tag, message, error) {
  console.error(`[${new Date().toISOString()}] [ERROR:${tag}] ${message}`, error);
}

function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || 'Người dùng'}</a>`;
}

// Hàm đẩy thông tin APK vào Redis
async function saveApkToRedis(msg, chat, doc, sender) {
  const fileName = doc?.file_name || '';
  if (!fileName.toLowerCase().endsWith('.apk')) return;

  const newApk = {
    message_id: msg.message_id,
    file_name: fileName,
    chat_id: chat.id,
    sender: sender || ''
  };

  try {
    await redis.lpush('apk_list', JSON.stringify(newApk));
    console.log('Đã lưu APK mới vào Redis:', fileName);
  } catch (err) {
    logError('REDIS', 'Lỗi khi lưu APK vào Redis', err);
  }
}

// -------------------------------------------------------------
// TỰ ĐỘNG LƯU APK MỚI TỪ CẢ KÊNH VÀ NHÓM VÀO REDIS
// -------------------------------------------------------------
bot.on('channel_post', async (ctx) => {
  const msg = ctx.channelPost;
  if (msg?.document) {
    await saveApkToRedis(msg, msg.chat, msg.document, msg.author_signature);
  }
});

// Lắng nghe file APK gửi trực tiếp vào Nhóm lưu trữ
bot.use(async (ctx, next) => {
  if (ctx.message?.document && STORAGE_CHANNEL && String(ctx.chat?.id) === String(STORAGE_CHANNEL)) {
    await saveApkToRedis(ctx.message, ctx.chat, ctx.message.document, getSenderTag(ctx));
  }
  return next();
});

// Lấy toàn bộ APK đã lưu từ Redis
async function getRecentApksFromChannel() {
  try {
    const rawList = await redis.lrange('apk_list', 0, -1);
    if (!rawList || rawList.length === 0) return [];
    return rawList
      .map(item => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logError('REDIS', 'Lỗi khi đọc dữ liệu từ Redis', err);
    return [];
  }
}

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

function parseStandardApkName(fileName) {
  if (!fileName || !fileName.toLowerCase().endsWith('.apk')) return null;
  const clean = fileName.replace(/\.apk$/i, '');

  const matchFull = clean.match(/^(.+)_(.+)\((.+)\)$/);
  if (matchFull) {
    return {
      appName: matchFull[1].trim(),
      version: matchFull[2].trim(),
      mods: matchFull[3].trim()
    };
  }

  const matchVer = clean.match(/^(.+)_(.+)$/);
  if (matchVer) {
    return {
      appName: matchVer[1].trim(),
      version: matchVer[2].trim(),
      mods: 'N/A'
    };
  }

  return {
    appName: clean.trim(),
    version: 'N/A',
    mods: 'N/A'
  };
}

async function searchApksInChannel(queryStr) {
  const allApks = await getRecentApksFromChannel();
  if (allApks.length === 0) return [];

  const cleanQuery = queryStr.toLowerCase().replace(/\.apk$/i, '').trim();

  let matches = allApks.filter(item => {
    const data = parseStandardApkName(item.file_name);
    const appName = data ? data.appName.toLowerCase() : item.file_name.toLowerCase();
    return appName.includes(cleanQuery);
  });

  if (matches.length === 0) {
    const scored = allApks.map(item => {
      const data = parseStandardApkName(item.file_name);
      const cleanAppName = data ? data.appName.toLowerCase() : item.file_name.toLowerCase();

      const dist = levenshteinDistance(cleanQuery, cleanAppName);
      const words = cleanAppName.split(/[\s_\-\(\)\.]+/);
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
}

async function sendApkViaCopy(ctx, item) {
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, { caption: '' });
  } catch (e) {
    logError('SEND', 'Lỗi copyMessage', e);
  }

  const data = parseStandardApkName(item.file_name);
  let text = '';
  if (data) {
    text += `Tên ứng dụng: ${data.appName}\nPhiên bản: ${data.version}\nMods: ${data.mods}\n`;
  }
  if (item.sender) {
    text += `Apk đc gửi bởi: ${item.sender}`;
  }

  if (text.trim()) {
    await ctx.reply(text.trim(), { parse_mode: 'HTML' });
  }
}

async function handleSearchResults(ctx, matches) {
  if (matches.length === 0) {
    return ctx.reply('Không tìm thấy APK!');
  }

  if (matches.length < 3) {
    for (const item of matches) {
      await sendApkViaCopy(ctx, item);
    }
  } else {
    const searchId = Date.now().toString();
    await redis.set(`search:${searchId}`, JSON.stringify(matches), 'EX', 900);

    await ctx.reply(`Tìm thấy ${matches.length} kết quả. Bạn muốn hiển thị như thế nào?`, Markup.inlineKeyboard([
      [
        Markup.button.callback('Chỉ 1 apk thui 😅', `show_1_${searchId}`),
        Markup.button.callback('Toàn bộ đê 😈', `show_all_${searchId}`)
      ]
    ]));
  }
}

// Bỏ qua tương tác từ Nhóm ngoại trừ chat riêng Private Chat
bot.use(async (ctx, next) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) return;
  return next();
});

bot.command('start', async (ctx) => {
  await ctx.reply('Chào bạn! Vui lòng nhập /help để xem hướng dẫn sử dụng.');
});

bot.command('help', async (ctx) => {
  const helpText = 
`Danh sách lệnh hỗ trợ:
/ping - Kiểm tra tốc độ
/apk - Kiểm tra số lượng APK đã lưu
/any <từ khoá> - Tìm kiếm nhiều APK
/many <từ khoá> - Tìm kiếm nhiều APK
/regex <pattern> - Tìm kiếm bằng Regex
/msg - Gửi tin nhắn tới Owner`;
  await ctx.reply(helpText);
});

bot.command('ping', async (ctx) => {
  const start = Date.now();
  await ctx.sendChatAction('typing');
  const latency = Date.now() - start;
  await ctx.reply(`🏓 Pong: ${latency}ms`);
});

bot.command('apk', async (ctx) => {
  try {
    const count = await redis.llen('apk_list');
    await ctx.reply(`Đã lưu:\n${count} APK`);
  } catch (e) {
    logError('COMMAND', 'Lỗi đếm APK', e);
    await ctx.reply('Lỗi kết nối cơ sở dữ liệu Redis!');
  }
});

bot.command('msg', async (ctx) => {
  const prompt = await ctx.reply('Hãy trả lời tin nhắn này với nội dung bạn muốn nói:', {
    reply_markup: { force_reply: true }
  });
  await redis.set(`msgState:${ctx.from.id}`, prompt.message_id, 'EX', 600);
});

bot.command('any', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.reply('Vui lòng nhập từ khoá! (VD: /any zarchiver)');

  const queryStr = args.replace(/\.apk$/i, '').trim();
  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const matches = await searchApksInChannel(queryStr);
  await handleSearchResults(ctx, matches);
});

bot.command('many', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.reply('Vui lòng nhập từ khoá! (VD: /many zarchiver)');

  const queryStr = args.replace(/\.apk$/i, '').trim();
  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const matches = await searchApksInChannel(queryStr);
  await handleSearchResults(ctx, matches);
});

bot.command('regex', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.reply('Vui lòng nhập mẫu Regex! (VD: /regex zarchiver.*)');

  const patternStr = args.replace(/\.apk$/i, '').trim();
  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const allApks = await getRecentApksFromChannel();
  let matched = [];

  try {
    const reg = new RegExp(patternStr, 'i');
    matched = allApks.filter(item => {
      const data = parseStandardApkName(item.file_name);
      const appName = data ? data.appName : item.file_name;
      return reg.test(appName);
    });
  } catch (e) {
    return ctx.reply('Cú pháp Regex không hợp lệ!');
  }

  await handleSearchResults(ctx, matched);
});

bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];

  await ctx.answerCbQuery();

  const rawResults = await redis.get(`search:${searchId}`);
  if (!rawResults) return ctx.reply('Kết quả đã hết hạn!');

  const results = JSON.parse(rawResults);
  await ctx.sendChatAction('upload_document');
  const itemsToSend = mode === '1' ? [results[0]] : results;

  for (const item of itemsToSend) {
    await sendApkViaCopy(ctx, item);
  }
  await redis.del(`search:${searchId}`);
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.toLowerCase().endsWith('.apk')) return;

  const parsedData = parseStandardApkName(doc.file_name);

  if (parsedData) {
    await ctx.reply(
`Tên ứng dụng: ${parsedData.appName}
Phiên bản: ${parsedData.version}
Mods: ${parsedData.mods}`
    );
  }

  await ctx.reply('Bạn có muốn gửi file này vào bộ nhớ lưu trữ apk không?', Markup.inlineKeyboard([
    [Markup.button.callback('Có', `store_${doc.file_id}`)]
  ]));
});

bot.action(/^store_(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery('Đã gửi!');

  if (STORAGE_CHANNEL) {
    try {
      await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
      await ctx.editMessageText('Đã gửi file vào bộ nhớ lưu trữ thành công!');
    } catch (e) {
      await ctx.editMessageText('Lỗi: Bot chưa được phong quyền Admin trong Kênh/Nhóm lưu trữ!');
    }
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const replyToId = ctx.message.reply_to_message?.message_id;

  const savedMsgId = await redis.get(`msgState:${userId}`);

  if (replyToId && savedMsgId && Number(savedMsgId) === replyToId) {
    if (OWNER_ID) {
      await ctx.telegram.sendMessage(
        OWNER_ID, 
        `Tin nhắn từ ${getSenderTag(ctx)}:\n${text}`, 
        { parse_mode: 'HTML' }
      );
    }
    try {
      await ctx.deleteMessage(ctx.message.message_id);
      await ctx.telegram.editMessageText(ctx.chat.id, replyToId, null, 'Cảm ơn');
    } catch (e) {
      await ctx.reply('Cảm ơn');
    }
    await redis.del(`msgState:${userId}`);
    return;
  }

  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const queryStr = text.replace(/\.apk$/i, '').trim();
  const matches = await searchApksInChannel(queryStr);

  if (matches.length > 0) {
    await sendApkViaCopy(ctx, matches[0]);
  } else {
    await ctx.reply('Không tìm thấy APK!');
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } else {
      res.status(200).send('Bot đang hoạt động...');
    }
  } catch (err) {
    logError('WEBHOOK', 'Lỗi xử lý Webhook', err);
    res.status(500).send('Internal Server Error');
  }
};
