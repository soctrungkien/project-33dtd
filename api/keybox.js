import { Telegraf } from 'telegraf';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);

const KEYBOX_URL =
  'https://raw.githubusercontent.com/Yurii0307/yurikey/main/key';

const COMMIT_API =
  'https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1';

// ============================================================
// CONFIG
// ============================================================

const REDIS_PREFIX = 'keybox:auto';
const LOCK_KEY = `${REDIS_PREFIX}:cron-lock`;
const LOCK_TTL = 60;

// Admin Telegram user IDs
// Ví dụ:
// ADMIN_IDS=123456789,987654321
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

// Group IDs
//
// Có thể dùng:
// GROUP_CHAT_ID=-100123456789
//
// Hoặc nhiều group:
// GROUP_CHAT_IDS=-100111111111,-100222222222
function getGroupIds() {
  const ids = [];

  if (process.env.GROUP_CHAT_IDS) {
    ids.push(
      ...String(process.env.GROUP_CHAT_IDS)
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
    );
  }

  if (process.env.GROUP_CHAT_ID) {
    const id = String(process.env.GROUP_CHAT_ID).trim();

    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return [...new Set(ids)];
}

// ============================================================
// REDIS KEY
// ============================================================

function groupRedisKey(groupId) {
  return `${REDIS_PREFIX}:group:${groupId}:sha`;
}

function userRedisKey(userId) {
  return `${REDIS_PREFIX}:user:${userId}`;
}

// ============================================================
// DATE
// ============================================================

function formatDate(isoString) {
  if (!isoString) {
    return 'Không xác định';
  }

  return new Date(isoString).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh'
  });
}

// ============================================================
// GET KEYBOX
// ============================================================

async function getKeyboxData() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KEYBOX_URL, {
      headers: {
        'Cache-Control': 'no-cache'
      }
    }),

    fetch(COMMIT_API, {
      headers: {
        'User-Agent': 'Vercel-Cron-Bot',
        'Accept': 'application/vnd.github+json',
        'Cache-Control': 'no-cache'
      }
    })
  ]);

  if (!fileRes.ok) {
    throw new Error(
      `Không thể tải file key. HTTP ${fileRes.status}`
    );
  }

  // File trên repository đang chứa Base64
  const base64Text = await fileRes.text();

  const cleanBase64 = base64Text
    .replace(/\s+/g, '')
    .trim();

  if (!cleanBase64) {
    throw new Error('Base64 rỗng');
  }

  let buffer;

  try {
    buffer = Buffer.from(cleanBase64, 'base64');

    if (!buffer.length) {
      throw new Error('Base64 decode ra dữ liệu rỗng');
    }
  } catch (error) {
    throw new Error(
      `Không thể decode Base64: ${error.message}`
    );
  }

  let updateDate = 'Không xác định';
  let fileDate = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh'
  });

  let sha = null;

  if (commitRes.ok) {
    const commits = await commitRes.json();

    if (Array.isArray(commits) && commits[0]) {
      sha = commits[0].sha;

      const commitDate =
        commits[0].commit?.committer?.date ||
        commits[0].commit?.author?.date;

      if (commitDate) {
        updateDate = formatDate(commitDate);

        fileDate = new Date(commitDate).toLocaleDateString(
          'en-CA',
          {
            timeZone: 'Asia/Ho_Chi_Minh'
          }
        );
      }
    }
  } else {
    console.error(
      `[GITHUB] Commit API lỗi: ${commitRes.status}`
    );
  }

  if (!sha) {
    throw new Error('Không thể lấy commit SHA');
  }

  const filename = `keybox-${fileDate}.xml`;

  return {
    buffer,
    updateDate,
    sha,
    filename
  };
}

// ============================================================
// ADMIN CHECK
// ============================================================

function isAdmin(userId) {
  if (!userId) {
    return false;
  }

  return ADMIN_IDS.has(String(userId));
}

// ============================================================
// /START
// ============================================================

bot.command('start', async ctx => {
  await ctx.sendChatAction('typing');

  await ctx.reply(
    '**Keybox Telegram Bot**\n' +
    'Bot hỗ trợ lấy file keybox Yuri mới nhất và tự động cập nhật vào nhóm.\n\n' +
    'Gõ /help để xem danh sách lệnh.',
    {
      parse_mode: 'Markdown'
    }
  );
});

// ============================================================
// /HELP
// ============================================================

bot.command('help', async ctx => {
  await ctx.sendChatAction('typing');

  let text =
    '📖 **Danh sách lệnh:**\n' +
    '• /keybox - Tải file keybox mới nhất\n' +
    '• /ping - Kiểm tra độ trễ phản hồi của bot\n' +
    '• /help - Hiển thị hướng dẫn này';

  if (isAdmin(ctx.from?.id)) {
    text +=
      '\n• /testauto - Reset auto của group và chạy lại ngay';
  }

  await ctx.reply(text, {
    parse_mode: 'Markdown'
  });
});

// ============================================================
// /PING
// ============================================================

bot.command('ping', async ctx => {
  const start = Date.now();

  await ctx.sendChatAction('typing');

  const message = await ctx.reply('🏓 Pong!');

  const ms = Date.now() - start;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    message.message_id,
    null,
    `🏓 **Pong!**\n⚡ Độ trễ: \`${ms}ms\``,
    {
      parse_mode: 'Markdown'
    }
  );
});

// ============================================================
// /KEYBOX
// ============================================================

bot.command('keybox', async ctx => {
  try {
    await ctx.sendChatAction('typing');

    const {
      buffer,
      updateDate,
      filename
    } = await getKeyboxData();

    await ctx.sendChatAction('upload_document');

    await ctx.replyWithDocument(
      {
        source: buffer,
        filename
      },
      {
        caption:
          `🔑 **File Keybox Yuri**\n` +
          `📅 Ngày cập nhật: \`${updateDate}\`\n` +
          `📄 Tên file: \`${filename}\``,
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    console.error('[KEYBOX]', error);

    await ctx.reply(
      '❌ Có lỗi xảy ra khi lấy file key.'
    );
  }
});

// ============================================================
// SEND AUTO UPDATE TO ONE GROUP
// ============================================================

async function updateGroup(groupId, data, options = {}) {
  const {
    buffer,
    updateDate,
    sha,
    filename
  } = data;

  const force = options.force === true;
  const userId = options.userId || null;

  const redisKey = groupRedisKey(groupId);

  const lastSha = await redis.get(redisKey);

  // Không force thì nếu group đã nhận SHA này -> bỏ qua
  if (!force && lastSha === sha) {
    return {
      updated: false,
      groupId,
      sha,
      filename,
      reason: 'already_updated'
    };
  }

  try {
    await bot.telegram.sendChatAction(
      groupId,
      'upload_document'
    );

    await bot.telegram.sendDocument(
      groupId,
      {
        source: buffer,
        filename
      },
      {
        caption:
          `🎉 **Phát hiện file Keybox mới!**\n` +
          `📅 Ngày cập nhật: \`${updateDate}\`\n` +
          `📄 Tên file: \`${filename}\`` +
          (force
            ? '\n🧪 **Đây là lần test auto.**'
            : ''),
        parse_mode: 'Markdown'
      }
    );

    // Chỉ lưu SHA sau khi Telegram gửi thành công
    await redis.set(redisKey, sha);

    // Lưu thông tin user thực hiện test
    if (userId) {
      await redis.hset(
        userRedisKey(userId),
        'lastGroupId',
        String(groupId),
        'lastSha',
        sha,
        'lastFilename',
        filename,
        'lastUpdateDate',
        updateDate,
        'lastAction',
        force ? 'testauto' : 'auto',
        'lastAt',
        new Date().toISOString()
      );

      await redis.expire(
        userRedisKey(userId),
        60 * 60 * 24 * 30
      );
    }

    return {
      updated: true,
      groupId,
      sha,
      updateDate,
      filename
    };
  } catch (error) {
    console.error(
      `[AUTO] Không thể gửi group ${groupId}:`,
      error
    );

    // QUAN TRỌNG:
    // Không set Redis nếu Telegram gửi thất bại.
    throw error;
  }
}

// ============================================================
// CRON AUTO UPDATE
// ============================================================

async function handleCron() {
  // Lock để tránh 2 cron chạy cùng lúc
  const lockValue =
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const lockResult = await redis.set(
    LOCK_KEY,
    lockValue,
    'NX',
    'EX',
    LOCK_TTL
  );

  if (lockResult !== 'OK') {
    return {
      updated: false,
      skipped: true,
      reason: 'cron_locked'
    };
  }

  try {
    const groups = getGroupIds();

    if (!groups.length) {
      throw new Error(
        'Chưa cấu hình GROUP_CHAT_ID hoặc GROUP_CHAT_IDS'
      );
    }

    const data = await getKeyboxData();

    const results = [];

    for (const groupId of groups) {
      try {
        const result = await updateGroup(
          groupId,
          data
        );

        results.push(result);
      } catch (error) {
        results.push({
          updated: false,
          groupId,
          error: error.message
        });
      }
    }

    return {
      updated: results.some(item => item.updated),
      sha: data.sha,
      updateDate: data.updateDate,
      filename: data.filename,
      groups: results
    };
  } finally {
    // Chỉ xóa lock của chính process này
    const currentLock = await redis.get(LOCK_KEY);

    if (currentLock === lockValue) {
      await redis.del(LOCK_KEY);
    }
  }
}

// ============================================================
// /TESTAUTO
// ============================================================
//
// Admin dùng:
//
// /testauto
//
// Lệnh này:
// 1. Kiểm tra user ID có phải admin không
// 2. Lấy group hiện tại
// 3. Xóa SHA Redis của group
// 4. Gửi file hiện tại
// 5. Ghi SHA mới vào Redis
//
// => Có thể test auto mà không cần đợi GitHub có commit mới.
//

bot.command('testauto', async ctx => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAdmin(userId)) {
    await ctx.reply(
      '⛔ Bạn không có quyền sử dụng lệnh này.'
    );

    return;
  }

  // Chỉ nên test trong group/supergroup
  if (
    ctx.chat?.type !== 'group' &&
    ctx.chat?.type !== 'supergroup'
  ) {
    await ctx.reply(
      '⚠️ Hãy sử dụng /testauto trực tiếp trong group cần test.'
    );

    return;
  }

  if (!chatId) {
    await ctx.reply(
      '❌ Không xác định được ID group.'
    );

    return;
  }

  const groupId = String(chatId);
  const redisKey = groupRedisKey(groupId);

  try {
    await ctx.sendChatAction('typing');

    // Xóa SHA của RIÊNG group này
    await redis.del(redisKey);

    const data = await getKeyboxData();

    const result = await updateGroup(
      groupId,
      data,
      {
        force: true,
        userId
      }
    );

    await ctx.reply(
      `✅ **Test auto thành công!**\n\n` +
      `👤 Admin ID: \`${userId}\`\n` +
      `👥 Group ID: \`${groupId}\`\n` +
      `🔑 SHA: \`${data.sha.slice(0, 12)}...\`\n` +
      `📄 File: \`${data.filename}\`\n` +
      `📅 Cập nhật: \`${data.updateDate}\``,
      {
        parse_mode: 'Markdown'
      }
    );

    console.log(
      `[TESTAUTO] user=${userId} group=${groupId} sha=${data.sha}`
    );

    return result;
  } catch (error) {
    console.error(
      '[TESTAUTO]',
      error
    );

    await ctx.reply(
      `❌ Test auto thất bại:\n\`${error.message}\``,
      {
        parse_mode: 'Markdown'
      }
    );
  }
});

// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch((error, ctx) => {
  console.error(
    `[TELEGRAF_ERROR] update=${ctx.update?.update_id}`,
    error
  );
});

// ============================================================
// VERCEL HANDLER
// ============================================================

export default async function handler(req, res) {
  // Telegram webhook
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);

      return res.status(200).send('OK');
    } catch (error) {
      console.error(
        '[WEBHOOK]',
        error
      );

      return res.status(500).send('Webhook error');
    }
  }

  // Vercel Cron
  if (
    req.method === 'GET' &&
    (
      req.query?.cron === 'true' ||
      req.headers['x-vercel-cron']
    )
  ) {
    try {
      const result = await handleCron();

      return res.status(200).json({
        status: 'Success',
        ...result
      });
    } catch (error) {
      console.error(
        '[CRON]',
        error
      );

      return res.status(500).json({
        status: 'Error',
        error: error.message
      });
    }
  }

  return res.status(200).send(
    'Bot đang hoạt động.'
  );
}
