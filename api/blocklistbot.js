const BOT_TOKEN = process.env.BOT_TOKEN_BLOCKLIST;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* =========================================================
   AUTO GET BOT USERNAME
========================================================= */

let cachedBotUsername = null;

async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;

  try {
    const res = await fetch(`${TELEGRAM_API}/getMe`);
    const data = await res.json();
    if (data.ok && data.result?.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch (err) {
    console.error("❌ Lỗi lấy bot username:", err.message);
  }
  return null;
}

/* =========================================================
   BLOCKLIST SOURCES
========================================================= */

const SOURCES = [
  "https://adaway.org/hosts.txt",
  "https://gitlab.com/andryou/block/raw/master/chibi",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
  "https://raw.githubusercontent.com/r-a-y/mobile-hosts/master/AdguardDNS.txt",
  "https://raw.githubusercontent.com/Turtlecute33/adblocktest/refs/heads/master/src/d3host.txt"
];

/* =========================================================
   TELEGRAM
========================================================= */

async function sendMessage(chatId, text) {
  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    return await response.json();
  } catch (err) {
    console.error("❌ Telegram sendMessage:", err.message);
    return { ok: false, description: err.message };
  }
}

async function editMessage(chatId, messageId, text) {
  try {
    const response = await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    return await response.json();
  } catch (err) {
    console.error("❌ Telegram editMessage:", err.message);
    return { ok: false, description: err.message };
  }
}

async function deleteMessage(chatId, messageId) {
  try {
    const response = await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });
    return await response.json();
  } catch (err) {
    console.error("❌ Telegram deleteMessage:", err.message);
    return { ok: false, description: err.message };
  }
}

async function sendDocument(chatId, contentText, fileName, caption) {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append(
      "document",
      new Blob([contentText], { type: "text/plain; charset=utf-8" }),
      fileName
    );
    formData.append("caption", caption);
    formData.append("parse_mode", "HTML");

    const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
      method: "POST",
      body: formData
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return {
        ok: false,
        description: `Telegram trả về dữ liệu không hợp lệ: ${text.slice(0, 300)}`
      };
    }
  } catch (err) {
    console.error("❌ Telegram sendDocument:", err.message);
    return { ok: false, description: err.message };
  }
}

/* =========================================================
   VIETNAM TIME
========================================================= */

function getVietnamDate() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
}

function getFileDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const get = type => parts.find(item => item.type === type)?.value;

  const day = get("day");
  const month = get("month");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  return [day, month, year, hour, minute, second].join("-");
}

/* =========================================================
   DOWNLOAD SOURCE
========================================================= */

async function fetchSource(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "BlocklistBot/1.0" }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`⚠️ [HTTP ${response.status}] ${url}`);
      return { url, content: null, success: false };
    }

    const content = await response.text();
    if (!content.trim()) {
      console.warn(`⚠️ [EMPTY] ${url}`);
      return { url, content: null, success: false };
    }

    console.log(`✅ [TẢI OK] ${content.length} bytes - ${url}`);
    return { url, content, success: true };
  } catch (err) {
    const reason = err.name === "AbortError" ? "Timeout 7s" : err.message;
    console.error(`❌ [BỎ QUA] ${url} | ${reason}`);
    return { url, content: null, success: false };
  }
}

/* =========================================================
   BLOCKLIST CLEANER & PARSER (ADAWAY STYLE)
========================================================= */

function isValidDomain(domain) {
  if (!domain) return false;
  domain = domain.replace(/\.+$/, "").trim();
/*  if (
    domain === "localhost" ||
    domain === "localhost"
  ) {
    return false;
  }*/
  // Kiểm tra tên miền hợp lệ cơ bản
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

function extractDomainFromLine(line) {
  line = line.trim();

  // Bỏ qua dòng trống, comment (#, !), rule ẩn phần tử HTML (##)
  if (
    !line ||
    line.startsWith("#") ||
    line.startsWith("!") ||
    line.startsWith("[") ||
    line.includes("##") ||
    line.includes("#@#")
  ) {
    return null;
  }

  // Cắt bỏ phần comment inline phía sau dòng nếu có
  const hashIdx = line.indexOf("#");
  if (hashIdx !== -1) line = line.slice(0, hashIdx).trim();
  const exclIdx = line.indexOf("!");
  if (exclIdx !== -1) line = line.slice(0, exclIdx).trim();

  if (!line) return null;

  // 1. Dạng AdBlock Plus / uBlock: ||example.com^
if (line.startsWith("||")) {
  let domain = line.slice(2);

  // Có path => bỏ hoàn toàn
  if (/[\/]/.test(domain)) {
    return null;
  }

  const endIdx = domain.search(/[\^\$\:]/);
  if (endIdx !== -1) {
    domain = domain.slice(0, endIdx);
  }

  return isValidDomain(domain)
    ? domain.toLowerCase()
    : null;
}

  // 2. Dạng Hosts File: 127.0.0.1 domain.com hoặc 0.0.0.0 domain.com
  const parts = line.split(/\s+/);
  if (parts.length >= 2) {
    const ip = parts[0];
    const domain = parts[1];
    if ((ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "::1") && isValidDomain(domain)) {
      return domain.toLowerCase();
    }
  }

  // 3. Dạng Domain thuần: example.com
  if (parts.length === 1 && isValidDomain(parts[0])) {
    return parts[0].toLowerCase();
  }

  return null;
}

function processAndCleanSources(rawContents) {
  const uniqueDomains = new Set();

  for (const content of rawContents) {
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const domain = extractDomainFromLine(line);
      if (domain) {
        uniqueDomains.add(domain);
      }
    }
  }

  return uniqueDomains;
}

/* =========================================================
   CREATE BLOCKLIST
========================================================= */

async function createBlocklist(chatId, msgId) {
  const createdAt = getVietnamDate();
  const fileDate = getFileDate();

  console.log(`🚀 [DOWNLOAD] ${SOURCES.length} nguồn`);
  const results = await Promise.all(SOURCES.map(url => fetchSource(url)));

  let successCount = 0;
  let failCount = 0;
  const rawContents = [];

  for (const item of results) {
    if (item.success && item.content) {
      rawContents.push(item.content);
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log(`📊 [DOWNLOAD RESULT] ${successCount}/${SOURCES.length} OK | ${failCount} lỗi`);

  if (msgId) {
    await editMessage(
      chatId,
      msgId,
      `🔄 <b>Đang lọc bỏ và làm sạch...</b>`
    );
  }

  // Xử lý làm sạch và lọc trùng bằng Set
  const uniqueDomains = processAndCleanSources(rawContents);
  const totalDomains = uniqueDomains.size;

  console.log(`✨ [CLEAN RESULT] Thu được ${totalDomains} domain duy nhất.`);

  // Tạo nội dung file Hosts chuẩn AdAway
  let mergedContent = `# Hihi (realknoname)\n`;
  mergedContent += `# Created: ${createdAt}\n`;
  mergedContent += `# Total Domains: ${totalDomains.toLocaleString("vi-VN")}\n\n`;

  for (const domain of uniqueDomains) {
    mergedContent += `0.0.0.0 ${domain}\n`;
  }

  if (msgId) {
    await editMessage(
      chatId,
      msgId,
      `📦 <b>Đã xử lý xong ${totalDomains.toLocaleString("vi-VN")} domain!</b>\n📤 <b>Đang gửi file...</b>`
    );
  }

  const fileName = `blocklist-${fileDate}.txt`;
  const caption = `✅ <b>Hoàn tất tạo Blocklist!</b>\n\n⏰ <b>Thời gian:</b>\n<code>${createdAt}</code>\n🎯 <b>Tổng Domain sạch:</b> <code>${totalDomains.toLocaleString("vi-VN")}</code>\n📄 <b>File:</b>\n<code>${fileName}</code>`;

  const telegramResult = await sendDocument(
    chatId,
    mergedContent,
    fileName,
    caption
  );

  if (!telegramResult.ok) {
    console.error("❌ [TELEGRAM]", telegramResult);
    throw new Error(telegramResult.description || "Không thể gửi file Telegram");
  }

  if (msgId) {
    await deleteMessage(chatId, msgId);
  }
}

/* =========================================================
   WEBHOOK
========================================================= */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Blocklist Bot đang hoạt động!");
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).send("OK");
  }

  const chatId = update.message.chat.id;
  const text = (update.message.text || "").trim();

  const botUsername = await getBotUsername();
  const usernamePattern = botUsername ? `(@${botUsername})?` : "(@\\w+)?";

  const isStartCmd = new RegExp(`^\\/start${usernamePattern}(\\s+|$)`, "i").test(text);
  const isCreateCmd = new RegExp(`^\\/create${usernamePattern}(\\s+|$)`, "i").test(text);

  if (isStartCmd) {
    await sendMessage(
      chatId,
      `👋 <b>Xin chào!</b>\nBot dùng để tạo blocklist.\n📦 <b>Tạo blocklist:</b>\n/create`
    );
    return res.status(200).send("OK");
  }

  if (isCreateCmd) {
    console.log(`\n🚀 [CREATE] Chat ID: ${chatId}`);

    const statusMsg = await sendMessage(
      chatId,
      `🔄 <b>Đang tải các danh sách blocklist...</b>\n⏳ Vui lòng chờ.`
    );

    const msgId = statusMsg.result?.message_id;

    try {
      await createBlocklist(chatId, msgId);
    } catch (err) {
      console.error("💥 [CREATE ERROR]", err);
      if (msgId) {
        await editMessage(
          chatId,
          msgId,
          `❌ <b>Tạo Blocklist thất bại!</b>\n\n<code>${String(err.message).slice(0, 800)}</code>`
        );
      }
    }

    return res.status(200).send("OK");
  }

  return res.status(200).send("OK");
};
