const BOT_TOKEN = process.env.BOT_TOKEN_NOTE;
const PASTEFY_API_KEYS = process.env.PASTEFY_API_KEYS;
const HIDDEN_MARKER = "　";
const MAX_CHAR_LIMIT = 3600; // Giới hạn số ký tự

// 1. Gọi trực tiếp API Pastefy v2
async function createPastefyNote(content) {
  try {
    const keys = (PASTEFY_API_KEYS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const headers = { "Content-Type": "application/json" };
    if (keys.length > 0) {
      const apiKey = keys[Math.floor(Math.random() * keys.length)];
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    console.log("[PASTEFY] Đang tạo note mới...");
    const response = await fetch("https://pastefy.app/api/v2/paste", {
      method: "POST",
      headers,
      body: JSON.stringify({ content }),
    });

    const json = await response.json();
    console.log("[PASTEFY_RESPONSE]", JSON.stringify(json));

    if (json.success && json.paste?.id) {
      return json.paste.id;
    }
    return "FETCH_ERROR";
  } catch (err) {
    console.error("[PASTEFY_ERROR]", err);
    return "FETCH_ERROR";
  }
}

async function getNoteContent(id) {
  try {
    const cleanId = id
      .replace(/https?:\/\/pastefy\.app\//, "")
      .replace(/\/raw.*/, "")
      .trim();

    console.log(`[PASTEFY] Đang lấy nội dung Note ID: ${cleanId}`);
    const res = await fetch(`https://pastefy.app/${cleanId}/raw`);
    
    if (!res.ok) {
      console.error(`[PASTEFY] Lỗi HTTP status: ${res.status}`);
      return "❌ Không tìm thấy nội dung note.";
    }
    const rawText = await res.text();
    return rawText;
  } catch (err) {
    console.error("[PASTEFY_FETCH_CONTENT_ERROR]", err);
    return "❌ Đã xảy ra lỗi khi tải dữ liệu note.";
  }
}

async function getBotUsername() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok) return data.result.username;
    console.error("[TELEGRAM_GETME_ERROR]", data);
    return null;
  } catch (err) {
    console.error("[TELEGRAM_GETME_FETCH_ERROR]", err);
    return null;
  }
}

// 2. Trạng thái Typing
async function sendChatAction(chatId, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (err) {
    console.error("[CHAT_ACTION_ERROR]", err);
  }
}

// 3. Gửi tin nhắn Telegram
async function sendMessage(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
      parse_mode: "HTML",
      ...extra,
    };

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("[TELEGRAM_SEND_FAILED]", JSON.stringify(data));
    } else {
      console.log(`[TELEGRAM_SUCCESS] Đã gửi tin nhắn tới ${chatId}`);
    }
    return data;
  } catch (err) {
    console.error("[TELEGRAM_SEND_ERROR]", err);
  }
}

// Hàm xử lý tạo note (Đặt UID lên đầu raw text)
async function handleCreateNote(chatId, content, user) {
  // Kiểm tra giới hạn ký tự
  if (content.length > MAX_CHAR_LIMIT) {
    await sendMessage(
      chatId,
      `❌ <b>Lỗi:</b> Nội dung quá dài! Giới hạn tối đa là <b>${MAX_CHAR_LIMIT}</b> ký tự (Hiện tại: ${content.length} ký tự).`
    );
    return;
  }

  await sendChatAction(chatId, "typing");

  // Đặt UID ngay dòng đầu tiên của Raw Text
  const rawHeader = `[UID: ${user.id}]\n\n`;
  const fullContent = rawHeader + content;

  const noteId = await createPastefyNote(fullContent);

  if (!noteId || noteId === "FETCH_ERROR") {
    await sendMessage(
      chatId,
      "❌ <b>Lỗi hệ thống:</b> Không thể tải note lên hệ thống lưu trữ. Vui lòng thử lại!"
    );
    return;
  }

  const botUsername = await getBotUsername();
  if (!botUsername) {
    await sendMessage(chatId, "❌ <b>Lỗi:</b> Không thể xác thực <code>BOT_TOKEN</code>.");
    return;
  }

  const shareLink = `https://t.me/${botUsername}?start=${noteId}`;
  console.log(`[SUCCESS] Đã tạo link thành công: ${shareLink}`);

  await sendMessage(
    chatId,
    `✅ <b>Tạo Note thành công!</b>\n\n🔗 <b>Link lấy note:</b>\n${shareLink}`
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot server is running.");
  }

  console.log("[INCOMING_WEBHOOK]", JSON.stringify(req.body));

  const message = req.body?.message;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const user = message.from;

  // Xử lý lệnh /who
  if (text.startsWith("/who")) {
    const args = text.split(/\s+/);
    const inputParam = args[1];

    let targetUser = message.reply_to_message?.from || user;

    if (inputParam) {
      // Tách lấy Note ID từ Pastefy link, Telegram link hoặc ID thuần
      const cleanId = inputParam
        .replace(/https?:\/\/(t\.me\/[^\?]+\?start=|pastefy\.app\/)/gi, "")
        .replace(/\/raw.*/, "")
        .trim();

      const rawContent = await getNoteContent(cleanId);
      const uidMatch = rawContent.match(/^\[UID:\s*(\d+)\]/);

      if (uidMatch) {
        const extractedUid = uidMatch[1];
        
        try {
          const chatRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${extractedUid}`);
          const chatData = await chatRes.json();
          if (chatData.ok) {
            targetUser = chatData.result;
          } else {
            targetUser = { id: extractedUid, first_name: "User", username: null };
          }
        } catch (e) {
          targetUser = { id: extractedUid, first_name: "User", username: null };
        }
      }
    }

    const fullName = `${targetUser.first_name || ""} ${targetUser.last_name || ""}`.trim();
    const username = targetUser.username ? `${targetUser.username}` : "Không có";
    const userTag = targetUser.username 
      ? `@${targetUser.username}` 
      : `<a href="tg://user?id=${targetUser.id}">${fullName || "User"}</a>`;

    const whoMessage = 
      `👤 <b>Thông tin người dùng:</b>\n\n` +
      `🆔 <b>UID:</b> <code>${targetUser.id}</code>\n` +
      `📛 <b>Tên:</b> <code>${fullName || "Không có"}</code>\n` +
      `🌐 <b>Username:</b> <code>${username}</code>\n` +
      `🏷️ <b>Tag:</b> ${userTag}`;

    await sendMessage(chatId, whoMessage);
  }
  // Xử lý /start
  else if (text.startsWith("/start")) {
    const args = text.split(" ");
    const noteId = args[1];

    if (noteId) {
      await sendChatAction(chatId, "typing");
      const rawContent = await getNoteContent(noteId);
      // Xóa header UID trước khi hiển thị cho người xem
      const cleanContent = rawContent.replace(/^\[UID:\s*\d+\]\n\n?/, "");
      await sendMessage(chatId, cleanContent, { parse_mode: undefined });
    } else {
      const botUsername = await getBotUsername();
      const helpMessage =
        "📌 <b>Hướng dẫn sử dụng Bot Note</b>\n\n" +
        "1. <b>Tạo note mới:</b>\n" +
        "   • Gửi /notes rồi <b>reply</b> lại câu hỏi của bot.\n" +
        "   • Hoặc reply lệnh /notes vào bất kỳ tin nhắn nào.\n" +
        "   • Hoặc viết trực tiếp: /notes &lt;nội dung&gt;\n" +
        `   • Giới hạn: Tối đa <b>${MAX_CHAR_LIMIT}</b> ký tự.\n\n` +
        "2. <b>Xem thông tin người dùng:</b>\n" +
        "   • Gửi /who để xem UID, Tên, Username và Tag của bạn hoặc reply người khác để xem thông tin của họ hay là dùng /who link note để xem thông tin ng đăng note.\n\n" +
        "3. <b>Chia sẻ:</b>\n" +
        "   Bot sẽ trả về link <code>https://t.me/" +
        (botUsername || "your_bot") +
        "?start=&lt;ID&gt;</code>.";
      await sendMessage(chatId, helpMessage);
    }
  }
  // Xử lý /notes
  else if (text.startsWith("/notes")) {
    let content = text.replace(/^\/notes(@\w+)?\s*/i, "").trim();

    if (!content && message.reply_to_message?.text) {
      content = message.reply_to_message.text;
    }

    if (!content) {
      await sendMessage(
        chatId,
        `📝 Vui lòng <b>trả lời</b> tin nhắn này với nội dung bạn muốn lưu thành Note.${HIDDEN_MARKER}`,
        { reply_markup: { force_reply: true, selective: true } }
      );
    } else {
      await handleCreateNote(chatId, content, user);
    }
  }
  // Trả lời tin nhắn theo yêu cầu của bot
  else if (
    message.reply_to_message?.text &&
    message.reply_to_message.text.includes(HIDDEN_MARKER)
  ) {
    await handleCreateNote(chatId, text, user);
  }

  return res.status(200).json({ ok: true });
}
