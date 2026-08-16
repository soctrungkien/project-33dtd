const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

// Bộ nhớ tạm
global.apkStore = global.apkStore || [];
global.msgState = global.msgState || new Map();
global.searchCache = global.searchCache || new Map();

// Hàm tính khoảng cách Levenshtein (Fuzzy Search - Hỗ trợ gõ sai)
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

// Tìm kiếm APK mờ (Cho phép sai chữ)
function searchApkFuzzy(query) {
  const cleanQuery = query.toLowerCase().replace(/\.apk$/i, '').trim();
  if (!cleanQuery) return [];

  let matches = global.apkStore.filter(item => 
    item.file_name.toLowerCase().includes(cleanQuery)
  );

  if (matches.length === 0) {
    const scored = global.apkStore.map(item => {
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
}

// Parse định dạng: Tên app_Phiên bản 1.0(Các mod trong apk).apk
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

// Hàm gửi APK bằng phương thức Chuyển tiếp sạch (copyMessage)
async function sendApkViaCopy(ctx, item) {
  try {
    // copyMessage giúp gửi đúng tin nhắn chứa file từ nhóm mà KO bị dính nhãn "Forwarded from" hay Caption cũ
    await ctx.telegram.copyMessage(ctx.chat.id, item.chat_id, item.message_id, { caption: '' });
  } catch (err) {
    // Dự phòng gửi bằng file_id nếu tin nhắn gốc bị xóa
    await ctx.sendDocument(item.file_id);
  }

  // Gửi thông tin người đóng góp (nếu có)
  if (item.sender) {
    await ctx.reply(`Apk đc gửi bởi: ${item.sender}`, { parse_mode: 'HTML' });
  }
}

// Xử lý gửi trả kết quả tìm kiếm cho /any và /regex
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

// Lắng nghe file APK trong KÊNH (Channel)
bot.on('channel_post', async (ctx) => {
  const doc = ctx.channelPost?.document;
  if (doc && doc.file_name?.endsWith('.apk')) {
    const sender = ctx.channelPost.chat.username 
      ? `@${ctx.channelPost.chat.username}` 
      : ctx.channelPost.chat.title;

    global.apkStore.push({
      file_id: doc.file_id,
      file_name: doc.file_name,
      chat_id: ctx.channelPost.chat.id,
      message_id: ctx.channelPost.message_id,
      sender: sender
    });
  }
});

// Lắng nghe file APK trong NHÓM & CHAT RIÊNG
bot.use(async (ctx, next) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) {
    if (ctx.message?.document?.file_name?.endsWith('.apk')) {
      const doc = ctx.message.document;
      global.apkStore.push({
        file_id: doc.file_id,
        file_name: doc.file_name,
        chat_id: ctx.chat.id,
        message_id: ctx.message.message_id,
        sender: getSenderTag(ctx)
      });
    }
    return; // Ngăn bot phản hồi các lệnh tìm kiếm ở trong nhóm
  }
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
/ping - Kiểm tra tốc độ phản hồi
/apk - Đếm số lượng APK hiện có
/any <từ khoá>.apk - Tìm kiếm APK (hỗ trợ gõ sai)
/regex <pattern>.apk - Tìm kiếm APK bằng Regex
/msg - Gửi tin nhắn tới Owner`;
  await ctx.reply(helpText);
});

// Lệnh /ping
bot.command('ping', async (ctx) => {
  const start = Date.now();
  await ctx.sendChatAction('typing');
  const latency = Date.now() - start;
  await ctx.reply(`⚡ Độ trễ: ${latency}ms`);
});

// Lệnh /apk (Đếm số lượng APK trong hệ thống)
bot.command('apk', async (ctx) => {
  await ctx.sendChatAction('typing');
  const total = global.apkStore.length;
  await ctx.reply(`Total APK có sẵn trong hệ thống: ${total}`);
});

// Lệnh /msg
bot.command('msg', async (ctx) => {
  const prompt = await ctx.reply('Hãy trả lời (reply) tin nhắn này với nội dung bạn muốn gửi tới Owner:', {
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
  await ctx.sendChatAction('upload_document');

  const matches = searchApkFuzzy(args);
  await handleSearchResults(ctx, matches);
});

// Lệnh /regex <pattern>.apk
bot.command('regex', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1).join(' ');
  if (!args || !args.toLowerCase().endsWith('.apk')) {
    return ctx.reply('Vui lòng nhập Regex đúng cú pháp có đuôi .apk ở cuối! (VD: /regex zarchiver.*\\.apk)');
  }

  await ctx.reply('Đang tìm apk...');
  await ctx.sendChatAction('upload_document');

  const patternStr = args.slice(0, -4).trim();
  let matches = [];

  try {
    const reg = new RegExp(patternStr, 'i');
    matches = global.apkStore.filter(item => reg.test(item.file_name));
  } catch (e) {
    // Regex lỗi sẽ tự chuyển sang fuzzy search
  }

  if (matches.length === 0) {
    matches = searchApkFuzzy(patternStr);
  }

  await handleSearchResults(ctx, matches);
});

// Callback nút Inline
bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
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

// Nhận APK trực tiếp từ Chat riêng
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith('.apk')) return;

  const senderTag = getSenderTag(ctx);
  const parsedData = parseStandardApkName(doc.file_name);

  const apkRecord = {
    file_id: doc.file_id,
    file_name: doc.file_name,
    chat_id: ctx.chat.id,
    message_id: ctx.message.message_id,
    sender: senderTag
  };

  global.apkStore.push(apkRecord);

  if (parsedData) {
    await ctx.sendChatAction('upload_document');
    await sendApkViaCopy(ctx, apkRecord);
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

// Nút lưu vào Nhóm/Kênh lưu trữ
bot.action(/^store_(.+)$/, async (ctx) => {
  const fileId = ctx.match[1];
  await ctx.answerCbQuery('Đã lưu!');
  if (STORAGE_CHANNEL) {
    await ctx.telegram.sendDocument(STORAGE_CHANNEL, fileId);
    await ctx.editMessageText('Đã gửi file vào nhóm lưu trữ thành công!');
  } else {
    await ctx.editMessageText('Chưa cấu hình STORAGE_CHANNEL_ID trong env!');
  }
});

// Xử lý Tin nhắn Text (Reply /msg hoặc Tự động tìm tên chuẩn)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const replyToId = ctx.message.reply_to_message?.message_id;

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
    await ctx.sendChatAction('upload_document');

    let matched = global.apkStore.slice().reverse().find(item => {
      const p = parseStandardApkName(item.file_name);
      return p && p.appName.toLowerCase() === parsed.appName.toLowerCase();
    });

    if (!matched) {
      const fuzzyResults = searchApkFuzzy(parsed.appName);
      matched = fuzzyResults.find(item => parseStandardApkName(item.file_name));
    }

    if (matched) {
      const data = parseStandardApkName(matched.file_name);
      await sendApkViaCopy(ctx, matched);
      await ctx.reply(
`Tên ứng dụng: ${data.appName}
Phiên bản: ${data.version}
Mods: ${data.mods}`
      );
    } else {
      await ctx.reply('Không tìm thấy APK chuẩn định dạng phù hợp!');
    }
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).send('OK');
    } else {
      res.status(200).send('Bot is running...');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
};
