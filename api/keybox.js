import { Telegraf } from 'telegraf';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

// Cấu hình ID Admin/Owner dạng danh sách cách nhau bởi dấu phẩy (Ví dụ: "123456789,987654321")
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Kiểm tra quyền Admin/Owner (Từ cấu hình ID hoặc danh sách Admin của nhóm)
async function isAdmin(ctx) {
  const userId = String(ctx.from?.id);
  if (ADMIN_IDS.includes(userId)) return true;

  // Nếu là chat nhóm/kênh, kiểm tra quyền Admin trực tiếp trong Telegram
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
        fileDate = new Date(commitDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      }
    }
  }

  const filename = `keybox-${fileDate}.xml`;
  return { buffer, updateDate, sha, filename };
}

// Lệnh /start
bot.command('start', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "👋 **Keybox Telegram Bot**\n" +
    "Bot hỗ trợ lấy file keybox Yuri mới nhất và tự động cập nhật vào nhóm.\n\n" +
    "Gõ /help để xem danh sách lệnh.",
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /help
bot.command('help', async (ctx) => {
  await ctx.sendChatAction('typing');
  const adminHelp = (await isAdmin(ctx)) 
    ? "\n\n🛠 **Lệnh quản trị (Admin):**\n• `/testauto` - Kiểm tra và kích hoạt auto-update thủ công\n• `/resetauto` - Xóa cache Redis để ép gửi lại thông báo bản mới"
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

// Lệnh /testauto (Chỉ Admin/Owner)
bot.command('testauto', async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ Lệnh này chỉ dành cho Admin/Owner!");
  }

  await ctx.reply("🔄 Đang chạy thử nghiệm luồng Auto-Update...");
  try {
    const result = await handleCron();
    if (result.updated) {
      await ctx.reply(`✅ Đã gửi bản cập nhật mới vào nhóm!\nSHA: \`${result.sha}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`ℹ️ Không có bản mới (SHA không đổi).\nSHA hiện tại: \`${result.sha}\``, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi test auto: ${error.message}`);
  }
});

// Lệnh /resetauto (Chỉ Admin/Owner)
bot.command('resetauto', async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("⚠️ Lệnh này chỉ dành cho Admin/Owner!");
  }

  try {
    await redis.del('CRON_KEYBOX_SHA');
    await ctx.reply("✅ Đã xóa SHA lưu trữ trong Redis! Lần chạy Cron tiếp theo sẽ tự động gửi lại file vào nhóm.");
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Lỗi khi xóa Redis: ${error.message}`);
  }
});

// Hàm xử lý Cron Auto-Update riêng biệt
async function handleCron() {
  const { buffer, updateDate, sha, filename } = await getKeyboxData();

  if (!sha) throw new Error("Không thể lấy commit SHA");

  // Dùng key riêng CRON_KEYBOX_SHA cho tiến trình tự động
  const lastSha = await redis.get('CRON_KEYBOX_SHA');

  if (sha !== lastSha) {
    const groupId = process.env.GROUP_CHAT_ID;

    if (groupId) {
      await bot.telegram.sendChatAction(groupId, 'upload_document');
      await bot.telegram.sendDocument(groupId, { source: buffer, filename }, {
        caption: `🎉 **Phát hiện file Keybox mới!**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
        parse_mode: 'Markdown'
      });

      await redis.set('CRON_KEYBOX_SHA', sha);
      return { updated: true, sha, updateDate, filename };
    }
  }

  return { updated: false, sha, filename };
}

// Handler cho Vercel Serverless
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
