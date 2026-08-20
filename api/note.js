const BOT_TOKEN = process.env.BOT_TOKEN_NOTE;
const PASTEFY_API_KEYS = process.env.PASTEFY_API_KEYS;
const HIDDEN_MARKER = "　";

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
    return await res.text();
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

// 3. Gửi tin nhắn Telegram (Chuyển sang HTML & Bắt lỗi API Telegram)
async function sendMessage(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
      parse_mode: "HTML", // Mặc định sử dụng HTML thay vì Markdown
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

// Hàm xử lý tạo note và gửi link
async function handleCreateNote(chatId, content) {
  await sendChatAction(chatId, "typing");

  const noteId = await createPastefyNote(content);

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

  // Xử lý /start
  if (text.startsWith("/start")) {
    const args = text.split(" ");
    const noteId = args[1];

    if (noteId) {
      await sendChatAction(chatId, "typing");
      const content = await getNoteContent(noteId);
      
      // Gửi nội dung thô (Plain Text) tránh bị lỗi HTML/Markdown Entity Parse
      await sendMessage(chatId, content, { parse_mode: undefined });
    } else {
      const botUsername = await getBotUsername();
      const helpMessage =
        "📌 <b>Hướng dẫn sử dụng Bot Note</b>\n\n" +
        "1. <b>Tạo note mới:</b>\n" +
        "   • Gửi /notes rồi <b>reply</b> lại câu hỏi của bot.\n" +
        "   • Hoặc reply lệnh /notes vào bất kỳ tin nhắn nào (không hoạt động trong nhóm).\n" +
        "   • Hoặc viết trực tiếp: /notes &lt;nội dung&gt;\n\n" +
        "2. <b>Chia sẻ:</b>\n" +
        "   Bot sẽ trả về link <code>https://t.me/" +
        (botUsername || "your_bot") +
        "?start=&lt;ID&gt;</code>.\n" +
        "   Người dùng ấn vào link sẽ tự động mở bot và nhận lại nội dung note.";
      await sendMessage(chatId, helpMessage);
    }
  }
  // Xử lý /notes
  else if (text.startsWith("/notes")) {
    let content = text.replace(/^\/notes(@\w+)?\s*/i, "").trim();

    // Reply vào tin nhắn có sẵn
    if (!content && message.reply_to_message?.text) {
      content = message.reply_to_message.text;
    }

    // Yêu cầu nhập nội dung
    if (!content) {
      await sendMessage(
        chatId,
        `📝 Vui lòng <b>trả lời</b> tin nhắn này với nội dung bạn muốn lưu thành Note.${HIDDEN_MARKER}`,
        { reply_markup: { force_reply: true, selective: true } }
      );
    } else {
      await handleCreateNote(chatId, content);
    }
  }
  // Trả lời tin nhắn theo yêu cầu của bot
  else if (
    message.reply_to_message?.text &&
    message.reply_to_message.text.includes(HIDDEN_MARKER)
  ) {
    await handleCreateNote(chatId, text);
  }

  return res.status(200).json({ ok: true });
}
