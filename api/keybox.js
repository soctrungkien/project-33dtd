import { Telegraf } from 'telegraf';
import Redis from 'ioredis';

// Biến môi trường
const redis = new Redis(process.env.REDIS_URL);
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Kiểm tra quyền Admin/Owner
async function isAdmin(ctx) {
  if (ctx.chat?.type === 'private') return true;

  if (['group', 'supergroup', 'channel'].includes(ctx.chat?.type)) {
    try {
      const member = await ctx.getChatMember(ctx.from.id);
      return ['creator', 'administrator'].includes(member.status);
    } catch (err) {
      console.error("Lỗi kiểm tra quyền Admin:", err);
      return false;
    }
  }

  return false;
}

// Tự động lưu ID của Nhóm/Kênh/User vào Redis
async function saveGroupId(ctx) {
  if (ctx.chat?.id) {
    await redis.set('KEYBOX_TARGET_GROUP_ID', ctx.chat.id);
  }
}

async function getKeyboxData() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KEYBOX_URL),
    fetch(COMMIT_API, { headers: { 'User-Agent': 'Vercel-Cron-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể tải file key");

  const base64Text = await fileRes.text();
  const cleanBase64 = base64Text.replace(/\s+/g, '').trim();

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) throw new Error("Base64 rỗng");
  } catch (error) {
    throw new Error(`Không thể decode Base64: ${error.message}`);
  }

  let updateDate = "Không xác định";
  let fileDate = new Date().toISOString().slice(0, 10);
  let sha = null;

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]) {
      sha = commits[0].sha;
      const commitDate = commits[0].commit?.committer?.date;
      if (commitDate) {
        updateDate = formatDate(commitDate);
        
        // Định dạng ngày dạng D-M-YYYY an toàn cho tên file
        const d = new Date(commitDate);
        fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
      }
    }
  }

  const filename = `keybox-${fileDate}.xml`;
  return { buffer, updateDate, sha, filename };
}

// Lệnh /start
bot.command('start', async (ctx) => {
  await saveGroupId(ctx);
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "👋 **Keybox Telegram Bot**\n" +
    "Bot hỗ trợ lấy file keybox Yuri mới nhất và tự động cập nhật vào nhóm.\n" +
    "Gõ /help để xem danh sách lệnh.",
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /help
bot.command('help', async (ctx) => {
  await saveGroupId(ctx);
  await ctx.sendChatAction('typing');
  const isUserAdmin = await isAdmin(ctx);
  const adminHelp = isUserAdmin 
    ? "\n\n🛠 **Lệnh quản trị (Admin/Private):**\n• `/testauto` - Kích hoạt kiểm tra auto-update ngay lập tức\n• `/resetauto` - Xóa mã nhận dạng lưu trữ để ép gửi lại thông báo bản mới"
    : "";

  await ctx.reply(
    "📖 **Danh sách lệnh:**\n" +
    "• `/keybox` - Tải file keybox mới nhất\n" +
    "• `/ping` - Kiểm tra độ trễ phản hồi của bot\n" +
    "• `/help` - Hiển thị hướng dẫn này" + adminHelp,
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /ping
bot.command('ping', async (ctx) => {
  await saveGroupId(ctx);
  const start = Date.now();
  const message = await ctx.reply("🏓 Đang đo độ trễ...");
  const ms = Date.now() - start;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    message.message_id,
    undefined,
    `🏓 **Pong!**\n⚡ Độ trễ: \`${ms}ms\``,
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /keybox
bot.command('keybox', async (ctx) => {
  await saveGroupId(ctx);
  try {
    await ctx.sendChatAction('typing');
    const { buffer, updateDate, filename } = await getKeyboxData();
    
    await ctx.sendChatAction('upload_document');
    await ctx.replyWithDocument({ source: buffer, filename }, {
      caption: `🔑 **File Keybox Yuri**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Có lỗi xảy ra khi lấy file key.");
  }
});

// Lệnh /testauto
bot.command('testauto', async (ctx) => {
  await saveGroupId(ctx);
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ Bạn phải là Admin của nhóm/kênh hoặc nhắn riêng với bot!");
  }

  await ctx.reply("🔄 Đang chạy thử nghiệm luồng Auto-Update...");
  try {
    const result = await handleCronForChat(ctx.chat.id, false); // false: chỉ gửi khi có SHA mới
    if (result.updated) {
      await ctx.reply(`✅ Đã phát hiện bản mới và tự động gửi file!\nMã nhận dạng: \`${result.sha}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`ℹ️ Chưa có bản mới.\nMã nhận dạng hiện tại: \`${result.sha}\``, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi test auto: ${error.message}`);
  }
});

// Lệnh /resetauto
bot.command('resetauto', async (ctx) => {
  await saveGroupId(ctx);
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ Bạn phải là Admin của nhóm/kênh hoặc nhắn riêng với bot!");
  }

  const redisKey = `CRON_KEYBOX_SHA_${ctx.chat.id}`;
  try {
    await redis.del(redisKey);
    await ctx.reply("✅ Đã xóa mã nhận dạng lưu trữ của nhóm/chat này!");
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi xóa: ${error.message}`);
  }
});

// Hàm gửi file tới Chat
async function handleCronForChat(targetChatId, forceSend = false) {
  const { buffer, updateDate, sha, filename } = await getKeyboxData();
  if (!sha) throw new Error("Không thể lấy commit SHA");

  const redisKey = `CRON_KEYBOX_SHA_${targetChatId}`;
  const lastSha = await redis.get(redisKey);

  // Gửi file nếu forceSend = true HOẶC nếu phát hiện commit SHA mới
  if (forceSend || sha !== lastSha) {
    await bot.telegram.sendChatAction(targetChatId, 'upload_document');
    await bot.telegram.sendDocument(targetChatId, { source: buffer, filename }, {
      caption: `🎉 **Cập nhật Keybox mới!**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
      parse_mode: 'Markdown'
    });

    await redis.set(redisKey, sha);
    return { updated: true, sha, updateDate, filename };
  }

  return { updated: false, sha, filename };
}

// Hàm Cron
async function handleCron(forceSend = false) {
  const groupId = await redis.get('KEYBOX_TARGET_GROUP_ID');
  if (!groupId) {
    throw new Error("Chưa xác định được Nhóm nhận file! Hãy tương tác trong Nhóm để bot ghi nhớ ID.");
  }
  return await handleCronForChat(groupId, forceSend);
}

// Entrypoint cho Vercel Serverless
export default async function handler(req, res) {
  const { url, method } = req;

  // 1. Webhook chính nhận tin nhắn Telegram từ Bot
  if (method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  // 2. Webhook URL MỚI dành riêng để Trigger 1 tiếng 1 lần:
  // URL truy cập: https://domain-cua-ban.vercel.app/api/cron-hourly
  // Hoặc dùng Tham số URL: https://domain-cua-ban.vercel.app/?cron_hourly=true
  if (method === 'GET' && (req.query.cron_hourly === 'true')) {
    try {
      // Đặt forceSend = true để ÉP GỬI MỖI 1 TIẾNG (bất chấp file có đổi hay không)
      // Nếu chỉ muốn gửi KHI CÓ FILE MỚI mỗi tiếng, đổi true thành false.
      const result = await handleCron(true); 
      return res.status(200).json({ status: "Success", message: "Đã gửi Keybox định kỳ 1 tiếng 1 lần", ...result });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  }

  // 3. Giữ lại route Cron kiểm tra SHA cũ của Vercel (nếu dùng)
  if (method === 'GET' && (req.query.cron === 'true' || req.headers['x-vercel-cron'])) {
    try {
      const result = await handleCron(false);
      return res.status(200).json({ status: "Success", ...result });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(200).send('Bot đang hoạt động.');
}
