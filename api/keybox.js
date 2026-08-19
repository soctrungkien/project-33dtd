import { Telegraf } from 'telegraf';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

async function getKeyboxData() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KEYBOX_URL),
    fetch(COMMIT_API, { headers: { 'User-Agent': 'Vercel-Cron-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể tải file key");
  
  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let updateDate = "Không xác định";
  let sha = null;

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]) {
      sha = commits[0].sha;
      updateDate = formatDate(commits[0].commit?.committer?.date);
    }
  }

  return { buffer, updateDate, sha };
}

// Lệnh /start
bot.command('start', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "**Keybox Telegram Bot**\n" +
    "Bot hỗ trợ lấy file keybox yuri mới nhất và tự động cập nhật vào nhóm.\n\n" +
    "Gõ /help để xem danh sách lệnh.",
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /help
bot.command('help', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "📖 **Danh sách lệnh:**\n" +
    "• /keybox - Tải file keybox mới nhất\n" +
    "• /ping - Kiểm tra độ trễ phản hồi của bot\n" +
    "• /help - Hiển thị hướng dẫn này",
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
    const { buffer, updateDate } = await getKeyboxData();
    
    // Đổi sang trạng thái gửi file
    await ctx.sendChatAction('upload_document');
    await ctx.replyWithDocument({
      source: buffer,
      filename: 'keybox.xml'
    }, {
      caption: `🔑 **File Keybox Yuri**\n📅 Ngày cập nhật: \`${updateDate}\``,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Có lỗi xảy ra khi lấy file key.");
  }
});

// Cron Job kiểm tra bản mới
async function handleCron() {
  const { buffer, updateDate, sha } = await getKeyboxData();
  if (!sha) throw new Error("Không thể lấy commit SHA");

  const lastSha = await redis.get('LAST_KEYBOX_SHA');

  if (sha !== lastSha) {
    const groupId = process.env.GROUP_CHAT_ID;

    if (groupId) {
      await bot.telegram.sendChatAction(groupId, 'upload_document');
      await bot.telegram.sendDocument(groupId, {
        source: buffer,
        filename: 'keybox.xml'
      }, {
        caption: `🎉 **Phát hiện file Keybox mới!**\n📅 Ngày cập nhật: \`${updateDate}\``,
        parse_mode: 'Markdown'
      });

      await redis.set('LAST_KEYBOX_SHA', sha);
      return { updated: true, sha, updateDate };
    }
  }

  return { updated: false, sha };
}

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
