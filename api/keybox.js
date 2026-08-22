import { Telegraf, Markup } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

// Các URL nguồn keybox
const YURI_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const YURI_COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

const KAORIOS_URL = "https://raw.githubusercontent.com/Wuang26/Kaorios-Toolbox/refs/heads/main/Toolbox-data/Keybox.xml";
const KAORIOS_COMMIT_API = "https://api.github.com/repos/Wuang26/Kaorios-Toolbox/commits?path=Toolbox-data/Keybox.xml&page=1&per_page=1";

const EVOKER_URL = "https://evoker.qzz.io/key";

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// 1. Tải và xử lý Keybox từ Yuri (Decode Base64)
async function getYuriKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(YURI_URL),
    fetch(YURI_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể tải file key Yuri");

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

  const filename = `keybox-yuri-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

// 2. Tải và xử lý Keybox từ Kaorios (XML trực tiếp)
async function getKaoriosKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KAORIOS_URL),
    fetch(KAORIOS_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể tải file key Kaorios");

  const xmlText = await fileRes.text();
  const buffer = Buffer.from(xmlText, 'utf-8');

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

  const filename = `keybox-kaorios-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

// 3. Tải và xử lý Keybox từ Evoker (Decode Base64, không có API kiểm tra ngày)
async function getEvokerKeybox() {
  const fileRes = await fetch(EVOKER_URL);
  if (!fileRes.ok) throw new Error("Không thể tải file key Evoker");

  const base64Text = await fileRes.text();
  const cleanBase64 = base64Text.replace(/\s+/g, '').trim();

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) throw new Error("Base64 rỗng");
  } catch (error) {
    throw new Error(`Không thể decode Base64: ${error.message}`);
  }

  const updateDate = "Không có dữ liệu ngày";
  const filename = `keybox-evoker.xml`;
  return { buffer, updateDate, filename };
}

// Lệnh /start
bot.command('start', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "👋 **Keybox Telegram Bot**\n\n" +
    "📖 **Danh sách lệnh:**\n" +
    "• /keybox - Tải file keybox (Yuri / Kaorios / Evoker)\n" +
    "• /start - Hiển thị menu trợ giúp này",
    { parse_mode: 'Markdown' }
  );
});

// Lệnh /keybox - Tạo menu chọn nguồn
bot.command('keybox', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.reply(
    "🔑 Vui lòng chọn nguồn Keybox muốn tải:",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Yuri", `get_keybox:yuri:${userId}`),
        Markup.button.callback("Kaorios", `get_keybox:kaorios:${userId}`),
        Markup.button.callback("Evoker", `get_keybox:evoker:${userId}`)
      ]
    ])
  );
});

// Xử lý nút bấm callback
bot.action(/^get_keybox:(yuri|kaorios|evoker):(\d+)$/, async (ctx) => {
  const source = ctx.match[1];
  const ownerId = Number(ctx.match[2]);
  const clickedUserId = ctx.from.id;

  // Kiểm tra quyền ngay lập tức
  if (clickedUserId !== ownerId) {
    return ctx.answerCbQuery("눈⁠‸⁠눈 Đừng làm phiền người ta", { show_alert: true }).catch(() => {});
  }

  // Phản hồi callback khẩn cấp để tránh lỗi Timeout
  await ctx.answerCbQuery("Đang xử lý tải file...").catch(() => {});

  try {
    await ctx.sendChatAction('upload_document');
    
    let keyData;
    let sourceName = "";

    if (source === 'yuri') {
      keyData = await getYuriKeybox();
      sourceName = "Yuri";
    } else if (source === 'kaorios') {
      keyData = await getKaoriosKeybox();
      sourceName = "Kaorios";
    } else {
      keyData = await getEvokerKeybox();
      sourceName = "Evoker";
    }

    const { buffer, updateDate, filename } = keyData;

    await ctx.replyWithDocument(
      { source: buffer, filename },
      {
        caption: `🔑 **File Keybox (${sourceName})**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
        parse_mode: 'Markdown'
      }
    );

    // Xóa menu chọn sau khi gửi file thành công
    await ctx.deleteMessage().catch(() => {});
  } catch (error) {
    console.error(error);
    await ctx.reply(`❌ Có lỗi xảy ra khi lấy file keybox.`);
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
