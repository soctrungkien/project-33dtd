import { Telegraf } from 'telegraf';
import { Redis } from '@upstash/redis';

// Sử dụng biến môi trường BOT_TOKEN_KEYBOX theo yêu cầu
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);
const redis = Redis.fromEnv();

const KEYBOX_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Lấy file key trực tiếp dạng Buffer (không qua decode base64)
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

// Xử lý lệnh /keybox
bot.command('keybox', async (ctx) => {
  try {
    await ctx.reply("⏳ Đang tải file key...");
    const { buffer, updateDate } = await getKeyboxData();
    
    await ctx.replyWithDocument({
      source: buffer,
      filename: 'keybox'
    }, {
      caption: `🔑 **File Keybox gốc**\n📅 Ngày cập nhật: \`${updateDate}\``,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Có lỗi xảy ra khi lấy file key.");
  }
});

// Cron Job tự động kiểm tra bản mới
async function handleCron() {
  const { buffer, updateDate, sha } = await getKeyboxData();
  if (!sha) throw new Error("Không thể lấy commit SHA");

  const lastSha = await redis.get('LAST_KEYBOX_SHA');

  if (sha !== lastSha) {
    const groupId = process.env.GROUP_CHAT_ID;

    if (groupId) {
      await bot.telegram.sendDocument(groupId, {
        source: buffer,
        filename: 'keybox'
      }, {
        caption: `🎉 **Phát hiện file Key mới!**\n📅 Ngày cập nhật: \`${updateDate}\``,
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
