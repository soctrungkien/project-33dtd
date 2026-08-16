const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

// Bộ nhớ tạm
global.apkStore = global.apkStore || [];
global.msgState = global.msgState || new Map();
global.searchCache = global.searchCache || new Map();

// Hàm tính khoảng cách Levenshtein để so khớp mờ (Fuzzy Search - chấp nhận sai chữ)
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

// Hàm tìm kiếm mờ (Fuzzy Search) tự động sửa lỗi chính tả
function searchApkFuzzy(query) {
  const cleanQuery = query.toLowerCase().replace(/\.apk$/i, '').trim();
  if (!cleanQuery) return [];

  // 1. Tìm chính xác hoặc chứa từ khoá (Exact Substring Match)
  let matches = global.apkStore.filter(item => 
    item.file_name.toLowerCase().includes(cleanQuery)
  );

  // 2. Nếu không có kết quả chính xác, tự động bật Fuzzy Match (Cho phép gõ sai vài chữ)
  if (matches.length === 0) {
    const scored = global.apkStore.map(item => {
      const cleanName = item.file_name.toLowerCase().replace(/\.apk$/i, '');
      const dist = levenshteinDistance(cleanQuery, cleanName);

      // So sánh từng từ trong tên file với từ khoá
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

    // Ngưỡng dung lỗi: Cho phép sai 1-3 ký tự tuỳ độ dài từ khoá
    const maxAllowed = Math.max(2, Math.floor(cleanQuery.length / 3));
    matches = scored
      .filter(s => s.score <= maxAllowed)
      .sort((a, b) => a.score - b.score)
      .map(s => s.item);
  }

  return matches;
}

// Hàm parse tên đúng định dạng: Tên app_Phiên bản 1.0(Các mod trong apk).apk (Đã bỏ emoji 😴)
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

// Hàm lấy định dạng người gửi
function getSenderTag(ctx) {
  const user = ctx.from;
  if (!user) return '';
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || 'Người dùng'}</a>`;
}

// Xử lý gửi trả kết quả tìm kiếm cho /any và /regex
async function handleSearchResults(ctx, matches) {
  if (matches.length === 0) {
    return ctx.reply('Không tìm thấy APK phù hợp!');
  }

  if (matches.length <= 3) {
    for (const item of matches) {
      await ctx.sendDocument(item.file_id);
      if (item.sender) {
        await ctx.reply(`Apk đc gửi bởi: ${item.sender}`, { parse_mode: 'HTML' });
      }
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

// Middleware ngăn lệnh trong Nhóm
bot.use(async (ctx, next) => {
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) {
    if (ctx.message?.document?.file_name?.endsWith('.apk')) {
      const doc = ctx.message.document;
      global.apkStore.push({
        file_id: doc.file_id,
        file_name: doc.file_name,
        sender: getSenderTag(ctx),
        chat_id: ctx.chat.id
      });
    }
    return;
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

// Lệnh /apk
bot.command('apk', async (ctx) => {
  const statusMsg = await ctx.reply('Đang đếm số lượng...');
  const total = global.apkStore.length;
  await ctx.telegram.editMessageText(
    ctx.chat.id, 
    statusMsg.message_id, 
    null, 
    `Total APK có sẵn trong hệ thống: ${total}`
  );
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
    // Regex sai cú pháp sẽ bỏ qua và chuyển sang fuzzy search
  }

  // Nếu Regex không ra kết quả nào, tự động fallback sang Fuzzy Search
  if (matches.length === 0) {
    matches = searchApkFuzzy(patternStr);
  }

  await handleSearchResults(ctx, matches);
});

// Callback inline button
bot.action(/^show_(1|all)_(.+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const searchId = ctx.match[2];
  const results = global.searchCache.get(searchId);

  await ctx.answerCbQuery();
  if (!results) return ctx.reply('Kết quả đã hết hạn!');

  await ctx.sendChatAction('upload_document');
  const itemsToSend = mode === '1' ? [results[0]] : results;

  for (const item of itemsToSend) {
    await ctx.sendDocument(item.file_id);
    if (item.sender) {
      await ctx.reply(`Apk đc gửi bởi: ${item.sender}`, { parse_mode: 'HTML' });
    }
  }
  global.searchCache.delete(searchId);
});

// Nhận APK trực tiếp
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith('.apk')) return;

  const senderTag = getSenderTag(ctx);
  const parsedData = parseStandardApkName(doc.file_name);

  global.apkStore.push({
    file_id: doc.file_id,
    file_name: doc.file_name,
    sender: senderTag,
    chat_id: ctx.chat.id
  });

  if (parsedData) {
    await ctx.sendChatAction('upload_document');
    await ctx.sendDocument(doc.file_id);
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

// Bấm nút lưu vào Nhóm lưu trữ
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

// Xử lý text (Reply /msg hoặc Tự động tìm kiếm APK mới nhất)
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

  // Tìm tự động khi người dùng gõ tên chuẩn
  const text = ctx.message.text.trim();
  const parsed = parseStandardApkName(text);

  if (parsed) {
    await ctx.reply('Đang tìm apk...');
    await ctx.sendChatAction('upload_document');

    // Tìm exact match hoặc dung lỗi nếu gõ sai chữ
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
      await ctx.sendDocument(matched.file_id);
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
