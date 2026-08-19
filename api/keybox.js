import { Telegraf } from 'telegraf';
import Redis from 'ioredis';

// Chỉ sử dụng 2 biến môi trường bắt buộc
const redis = new Redis(process.env.REDIS_URL);
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
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

// Tự động lưu ID của Nhóm/Kênh vào Redis mỗi khi có tin nhắn/lệnh trong nhóm
async function saveGroupId(ctx) {
  if (['group', 'supergroup', 'channel'].includes(ctx.chat?.type)) {
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
        fileDate = new Date(commitDate).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
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
  await ctx.sendChatAction('typing');
  const message = await ctx.reply("🏓 Pong!");
  const ms = Date.now() - start;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    message.message_id,
    null,
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
    const result = await handleCron();
    if (result.updated) {
      await ctx.reply(`✅ Đã phát hiện bản mới và tự động gửi vào nhóm!\nMã nhận dạng: \`${result.sha}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`ℹ️ Chưa có bản mới.\nMã nhận dạng hiện tại: \`${result.sha}\``, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi test auto: ${error.message}`);
  }
});

// Lệnh /resetauto (Xóa SHA riêng cho cá nhân hoặc nhóm này)
bot.command('resetauto', async (ctx) => {
  await saveGroupId(ctx);
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ Bạn phải là Admin của nhóm/kênh hoặc nhắn riêng với bot!");
  }

  // Tạo Redis key riêng biệt theo ID của Chat (Private / Group / Channel)
  const chatId = ctx.chat.id;
  const redisKey = `CRON_KEYBOX_SHA_${chatId}`;

  try {
    await redis.del(redisKey);
    await ctx.reply("✅ Đã xóa mã nhận dạng lưu trữ của nhóm/chat này! Lần chạy Cron hoặc `/testauto` tiếp theo sẽ tự động gửi lại file.");
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi xóa: ${error.message}`);
  }
});

// Hàm xử lý Cron Auto-Update
async function handleCron() {
  const { buffer, updateDate, sha, filename } = await getKeyboxData();

  if (!sha) throw new Error("Không thể lấy commit SHA");

  // Lấy Group ID đã được lưu tự động trong Redis từ trước
  const groupId = await redis.get('KEYBOX_TARGET_GROUP_ID');
  if (!groupId) {
    throw new Error("Chưa xác định được Nhóm nhận file! Hãy gõ một lệnh bất kỳ (ví dụ /ping) trong Nhóm để bot tự ghi nhớ ID.");
  }

  const lastSha = await redis.get('CRON_KEYBOX_SHA');

  if (sha !== lastSha) {
    await bot.telegram.sendChatAction(groupId, 'upload_document');
    await bot.telegram.sendDocument(groupId, { source: buffer, filename }, {
      caption: `🎉 **Phát hiện file Keybox mới!**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
      parse_mode: 'Markdown'
    });

    await redis.set('CRON_KEYBOX_SHA', sha);
    return { updated: true, sha, updateDate, filename };
  }

  return { updated: false, sha, filename };
}

// Handler cho Vercel
export default async function handler(req, res) {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  if (req.method === 'GET' && (req.query.cron === 'true' || req.headers['x-vercel-cron'])) {
    try {
      const result = await handleCron();
      return res.status(200).json({ status: "Success", ...result });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(200).send('Bot đang hoạt động.');
}
