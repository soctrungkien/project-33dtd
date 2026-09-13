const BOT_TOKEN = process.env.BOT_TOKEN_BLOCKLIST;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SOURCES = [
  "https://adaway.org/hosts.txt",
  "https://easylist-downloads.adblockplus.org/antiadblockfilters.txt",
  "https://easylist-downloads.adblockplus.org/easylist.txt",
  "https://easylist-downloads.adblockplus.org/fanboy-social.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
  "https://fanboy.co.nz/fanboy-antifonts.txt",
  "https://filters.adtidy.org/android/filters/10_optimized.txt",
  "https://filters.adtidy.org/android/filters/11_optimized.txt",
  "https://filters.adtidy.org/android/filters/14_optimized.txt",
  "https://filters.adtidy.org/android/filters/15_optimized.txt",
  "https://filters.adtidy.org/android/filters/17_optimized.txt",
  "https://filters.adtidy.org/android/filters/18_optimized.txt",
  "https://filters.adtidy.org/android/filters/19_optimized.txt",
  "https://filters.adtidy.org/android/filters/20_optimized.txt",
  "https://filters.adtidy.org/android/filters/21_optimized.txt",
  "https://filters.adtidy.org/android/filters/22_optimized.txt",
  "https://filters.adtidy.org/android/filters/25_optimized.txt",
  "https://filters.adtidy.org/android/filters/3_optimized.txt",
  "https://filters.adtidy.org/android/filters/4_optimized.txt",
  "https://filters.adtidy.org/android/filters/5_optimized.txt",
  "https://gitlab.com/andryou/block/raw/master/chibi",
  "https://malware-filter.gitlab.io/malware-filter/phishing-filter-ag.txt",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
  "https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareAdGuard.txt",
  "https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt",
  "https://raw.githubusercontent.com/LanikSJ/webannoyances/master/ultralist.txt",
  "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
  "https://raw.githubusercontent.com/deep-bhatt/huawei-block-list/refs/heads/master/huawei-block-host.txt",
  "https://raw.githubusercontent.com/durablenapkin/scamblocklist/master/adguard.txt",
  "https://raw.githubusercontent.com/r-a-y/mobile-hosts/master/AdguardDNS.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
  "https://secure.fanboy.co.nz/fanboy-annoyance_ubo.txt",
  "https://www.fanboy.co.nz/fanboy-antifacebook.txt",
  "https://www.fanboy.co.nz/fanboy-cookiemonster.txt"
];

async function sendMessage(chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  return res.json();
}

async function editMessage(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
}

async function sendDocument(chatId, contentText, fileName, caption) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([contentText], { type: 'text/plain' }), fileName);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');

  await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: formData
  });
}

async function uploadToPastefy(content) {
  const keys = (process.env.PASTEFY_API_KEYS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  if (!keys.length) {
    console.warn("⚠️ PASTEFY_API_KEYS chưa được cấu hình.");
    return null;
  }

  const apiKey = keys[Math.floor(Math.random() * keys.length)];

  try {
    const res = await fetch("https://pastefy.app/api/v2/paste", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: "Blocklist Hosts", content })
    });

    const json = await res.json();
    if (res.ok && json.success && json.paste?.id) {
      return `https://pastefy.app/${json.paste.id}/raw`;
    }
    console.error("❌ Lỗi API Pastefy:", json);
  } catch (err) {
    console.error("❌ Lỗi kết nối Pastefy:", err.message);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot đang hoạt động!');
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).send('OK');
  }

  const chatId = update.message.chat.id;
  const text = update.message.text || '';

  if (text.startsWith('/start') || text.startsWith('/blocklist')) {
    console.log(`\n🚀 [BẮT ĐẦU] Tạo blocklist cho Chat ID: ${chatId}`);

    // 1. Cập nhật trạng thái
    const statusMsg = await sendMessage(chatId, `🔄 <b>Đang nạp dữ liệu:</b> Đang tải đa luồng ${SOURCES.length} nguồn blocklist...`);
    const msgId = statusMsg.result?.message_id;

    const createdAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    try {
      // 2. Tải đa luồng song song (Timeout 7 giây mỗi link)
      const fetchPromises = SOURCES.map(async (url) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 7000);

          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (!response.ok) {
            console.warn(`⚠️ [LINK DIE/LỖI HTTP ${response.status}] ${url}`);
            return { url, content: null, success: false };
          }

          const textData = await response.text();
          console.log(`✅ [TẢI THÀNH CÔNG] (${textData.length} bytes) - ${url}`);
          return { url, content: textData, success: true };

        } catch (err) {
          console.error(`❌ [BỎ QUA LINK DIE] ${url} | Lỗi: ${err.name === 'AbortError' ? 'Timeout 7s' : err.message}`);
          return { url, content: null, success: false };
        }
      });

      const results = await Promise.all(fetchPromises);

      // 3. Ghép file và thống kê kết quả
      let mergedContent = `# Combined Blocklist\n# Generated on: ${createdAt} (ICT)\n# Total Sources Configured: ${SOURCES.length}\n\n`;
      let successCount = 0;
      let failCount = 0;

      results.forEach((item) => {
        if (item.success && item.content) {
          mergedContent += `# --- Source: ${item.url} ---\n${item.content}\n\n`;
          successCount++;
        } else {
          failCount++;
        }
      });

      console.log(`📊 [HOÀN TẤT TẢI] Thành công: ${successCount}/${SOURCES.length} | Thất bại: ${failCount}`);

      // 4. Trạng thái: Uploading
      if (msgId) {
        await editMessage(chatId, msgId, `📤 <b>Đang xử lý:</b> Đã tải ${successCount}/${SOURCES.length} nguồn. Đang đẩy lên Pastefy & gửi Telegram...`);
      }

      // Tạo link raw
      const rawUrl = await uploadToPastefy(mergedContent);

      // 5. Gửi file & link raw cho người dùng
      const linkText = rawUrl ? `<a href="${rawUrl}">${rawUrl}</a>` : '<i>Không thể tạo (Lỗi Pastefy hoặc thiếu API Key)</i>';
      const caption = `✅ <b>Hoàn tất tạo Blocklist!</b>\n⏰ <b>Thời gian tạo:</b> <code>${createdAt}</code>\n🔗 <b>Link Raw:</b> ${linkText}`;

      await sendDocument(chatId, mergedContent, 'blocklist.txt', caption);

      if (msgId) {
        await editMessage(chatId, msgId, '🎉 <b>Thành công!</b> File blocklist và link raw đã được gửi bên dưới.');
      }

    } catch (err) {
      console.error('💥 [LỖI HỆ THỐNG]:', err);
      if (msgId) {
        await editMessage(chatId, msgId, '❌ <b>Lỗi:</b> Có lỗi xảy ra trong quá trình xử lý blocklist.');
      }
    }
  }

  return res.status(200).send('OK');
}
