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


/* =========================
   TELEGRAM
========================= */

async function sendMessage(chatId, text) {
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  return r.json();
}


async function editMessage(chatId, messageId, text) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}


async function sendDocument(chatId, contentText, fileName, caption) {
  const formData = new FormData();

  formData.append("chat_id", chatId);

  formData.append(
    "document",
    new Blob([contentText], {
      type: "text/plain"
    }),
    fileName
  );

  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");

  const r = await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: "POST",
    body: formData
  });

  return r.json();
}


/* =========================
   DATE VIỆT NAM
========================= */

function getVietnamDate() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}


/*
  Dùng cho tên file:
  13-09-2026
*/
function getFileDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const day = parts.find(x => x.type === "day")?.value;
  const month = parts.find(x => x.type === "month")?.value;
  const year = parts.find(x => x.type === "year")?.value;

  return `${day}-${month}-${year}`;
}


/* =========================
   PASTEFY
========================= */

async function uploadToPastefy(content, createdAt) {

  const keys = (process.env.PASTEFY_API_KEYS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  if (!keys.length) {
    console.warn("⚠️ PASTEFY_API_KEYS chưa được cấu hình.");
    return null;
  }

  /*
    Thử lần lượt từng API key.
    Nếu một key lỗi thì thử key tiếp theo.
  */
  for (let i = 0; i < keys.length; i++) {

    const apiKey = keys[i];

    try {

      console.log(
        `📤 [PASTEFY] Đang thử API key ${i + 1}/${keys.length}`
      );

      const response = await fetch(
        "https://pastefy.app/api/v2/paste",
        {
          method: "POST",

          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },

          body: JSON.stringify({
            title: `Blocklist ${createdAt}`,
            content
          })
        }
      );

      /*
        QUAN TRỌNG:
        Không dùng response.json() trực tiếp.

        Pastefy đôi khi trả HTML:
        <html>
        ...
      */

      const responseText = await response.text();

      console.log(
        `📥 [PASTEFY] HTTP ${response.status} | ${responseText.length} bytes`
      );

      let json = null;

      try {
        json = JSON.parse(responseText);
      } catch {

        console.error(
          `❌ [PASTEFY] Response không phải JSON:`,
          responseText.slice(0, 500)
        );

        /*
          Nếu server trả HTML / Cloudflare / proxy error
          thì thử API key tiếp theo.
        */
        continue;
      }

      if (
        response.ok &&
        json?.success &&
        json?.paste?.id
      ) {

        const pasteId = json.paste.id;

        const rawUrl =
          `https://pastefy.app/${pasteId}/raw`;

        console.log(
          `✅ [PASTEFY] Thành công: ${rawUrl}`
        );

        return rawUrl;
      }

      console.error(
        `❌ [PASTEFY] API key ${i + 1} lỗi:`,
        json
      );

    } catch (err) {

      console.error(
        `❌ [PASTEFY] Key ${i + 1} lỗi kết nối:`,
        err.message
      );
    }
  }

  console.error(
    "❌ [PASTEFY] Tất cả API key đều thất bại."
  );

  return null;
}


/* =========================
   MAIN HANDLER
========================= */

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(200).send("Bot đang hoạt động!");
  }

  const update = req.body;

  if (!update || !update.message) {
    return res.status(200).send("OK");
  }

  const chatId = update.message.chat.id;
  const text = update.message.text || "";

  if (
    text.startsWith("/start") ||
    text.startsWith("/blocklist")
  ) {

    console.log(
      `\n🚀 [BẮT ĐẦU] Tạo blocklist cho Chat ID: ${chatId}`
    );

    const statusMsg = await sendMessage(
      chatId,
      `🔄 <b>Đang nạp dữ liệu:</b> Đang tải đa luồng ${SOURCES.length} nguồn blocklist...`
    );

    const msgId = statusMsg.result?.message_id;

    const createdAt = getVietnamDate();
    const fileDate = getFileDate();

    try {

      /* =========================
         DOWNLOAD SOURCES
      ========================= */

      const fetchPromises = SOURCES.map(async (url) => {

        try {

          const controller = new AbortController();

          const timeoutId = setTimeout(
            () => controller.abort(),
            7000
          );

          const response = await fetch(url, {
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {

            console.warn(
              `⚠️ [HTTP ${response.status}] ${url}`
            );

            return {
              url,
              content: null,
              success: false
            };
          }

          const textData = await response.text();

          console.log(
            `✅ [TẢI OK] (${textData.length} bytes) ${url}`
          );

          return {
            url,
            content: textData,
            success: true
          };

        } catch (err) {

          console.error(
            `❌ [BỎ QUA] ${url} | ${
              err.name === "AbortError"
                ? "Timeout 7s"
                : err.message
            }`
          );

          return {
            url,
            content: null,
            success: false
          };
        }
      });


      const results = await Promise.all(fetchPromises);


      /* =========================
         MERGE
      ========================= */

      /*
        #hi nằm ở dòng đầu tiên.
      */

      let mergedContent =
`#hi
# Combined Blocklist
# Generated on: ${createdAt} (ICT)
# Total Sources Configured: ${SOURCES.length}

`;

      let successCount = 0;
      let failCount = 0;


      results.forEach(item => {

        if (
          item.success &&
          item.content
        ) {

          mergedContent +=
`\n# --- Source: ${item.url} ---\n${item.content}\n`;

          successCount++;

        } else {

          failCount++;
        }
      });


      console.log(
        `📊 [HOÀN TẤT] Thành công: ${successCount}/${SOURCES.length} | Thất bại: ${failCount}`
      );


      /* =========================
         PASTEFY
      ========================= */

      if (msgId) {

        await editMessage(
          chatId,
          msgId,
          `📤 <b>Đang xử lý:</b> Đã tải ${successCount}/${SOURCES.length} nguồn. Đang đẩy lên Pastefy...`
        );
      }


      const rawUrl = await uploadToPastefy(
        mergedContent,
        createdAt
      );


      /* =========================
         FILE NAME
      ========================= */

      const fileName =
        `blocklist-${fileDate}.txt`;


      const linkText = rawUrl
        ? `<a href="${rawUrl}">${rawUrl}</a>`
        : `<i>Không thể tạo Pastefy.</i>`;


      const caption =
`✅ <b>Hoàn tất tạo Blocklist!</b>
⏰ <b>Ngày tạo:</b> <code>${createdAt}</code>
📦 <b>Nguồn:</b> <code>${successCount}/${SOURCES.length}</code>
📄 <b>File:</b> <code>${fileName}</code>
🔗 <b>Link Raw:</b> ${linkText}`;


      /* =========================
         SEND TELEGRAM FILE
      ========================= */

      const telegramResult = await sendDocument(
        chatId,
        mergedContent,
        fileName,
        caption
      );


      if (!telegramResult.ok) {

        console.error(
          "❌ Telegram sendDocument:",
          telegramResult
        );
      }


      if (msgId) {

        await editMessage(
          chatId,
          msgId,
          rawUrl
            ? "🎉 <b>Thành công!</b> File blocklist và link Raw đã được gửi bên dưới."
            : "⚠️ <b>Đã tạo file!</b> Nhưng Pastefy không phản hồi hợp lệ."
        );
      }

    } catch (err) {

      console.error(
        "💥 [LỖI HỆ THỐNG]:",
        err
      );

      if (msgId) {

        await editMessage(
          chatId,
          msgId,
          `❌ <b>Lỗi:</b> ${String(err.message).slice(0, 500)}`
        );
      }
    }
  }

  return res.status(200).send("OK");
}
