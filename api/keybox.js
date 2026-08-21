import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Lấy file Keybox và thông tin commit từ GitHub
async function getKeyboxData() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KEYBOX_URL),
    fetch(COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
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

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = formatDate(commitDate);
      
      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  const filename = `keybox-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

// Lệnh /start (Gộp cả thông tin hướng dẫn)
bot.command('start', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "👋 **Keybox Telegram Bot**\n\n" +
    "📖 **Danh sách lệnh:**\n" +
    "• `/keybox` - Tải file keybox Yuri mới nhất\n" +
    "• `/start` - Hiển thị menu trợ giúp này",
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

// Entrypoint cho Vercel Serverless
export default async function handler(req, res) {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  return res.status(200).send('Bot đang hoạt động.');
}
