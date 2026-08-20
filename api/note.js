const BOT_TOKEN = process.env.BOT_TOKEN_NOTE;
const PASTEFY_API_KEYS = process.env.PASTEFY_API_KEYS;
const HIDDEN_MARKER = "　";

// 1. Gọi trực tiếp API Pastefy v2 (Xoay vòng API key nếu có)
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

    const response = await fetch("https://pastefy.app/api/v2/paste", {
      method: "POST",
      headers,
      body: JSON.stringify({ content }),
    });

    const json = await response.json();
    if (json.success && json.paste?.id) {
      return json.paste.id;
    }
    return "FETCH_ERROR";
  } catch (err) {
    console.error("Pastefy API Error:", err);
    return "FETCH_ERROR";
  }
}

async function getNoteContent(id) {
  try {
    const cleanId = id
      .replace(/https?:\/\/pastefy\.app\//, "")
      .replace(/\/raw.*/, "")
      .trim();
    const res = await fetch(`https://pastefy.app/${cleanId}/raw`);
    if (!res.ok) return "❌ Không tìm thấy nội dung note.";
    return await res.text();
  } catch {
    return "❌ Đã xảy ra lỗi khi tải dữ liệu note.";
  }
}

async function getBotUsername() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    return data.ok ? data.result.username : null;
  } catch {
    return null;
  }
}

// 2. Trạng thái "Đang nhập..." (typing)
async function sendChatAction(chatId, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // Bỏ qua lỗi phụ khi gửi status
  }
}

// 3. Gửi tin nhắn hỗ trợ Markdown (parse_mode: Markdown)
async function sendMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...extra,
    }),
  });
}

// Hàm xử lý tạo note và gửi link
async function handleCreateNote(chatId, content) {
  await sendChatAction(chatId, "typing");

  const noteId = await createPastefyNote(content);

  if (!noteId || noteId === "FETCH_ERROR") {
    await sendMessage(
      chatId,
      "❌ *Lỗi hệ thống:* Không thể tải note lên hệ thống lưu trữ. Vui lòng thử lại!"
    );
    return;
  }

  const botUsername = await getBotUsername();
  if (!botUsername) {
    await sendMessage(chatId, "❌ *Lỗi:* Không thể xác thực `BOT_TOKEN`.");
    return;
  }

  const shareLink = `https://t.me/${botUsername}?start=${noteId}`;
  await sendMessage(
    chatId,
    `✅ *Tạo Note thành công!*\n\n🔗 *Link lấy note:*\n${shareLink}`
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot server is running.");
  }

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
      await sendMessage(chatId, content);
    } else {
      const botUsername = await getBotUsername();
      const helpMessage =
        "📌 *Hướng dẫn sử dụng Bot Note*\n\n" +
        "1. *Tạo note mới:*\n" +
        "   • Gửi `/notes` rồi **reply** lại câu hỏi của bot.\n" +
        "   • Hoặc **reply** lệnh `/notes` vào bất kỳ tin nhắn nào.\n" +
        "   • Hoặc viết trực tiếp: `/notes <nội dung>`\n\n" +
        "2. *Chia sẻ:*\n" +
        "   Bot sẽ trả về link `https://t.me/" +
        (botUsername || "your_bot") +
        "?start=<ID>`.\n" +
        "   Người dùng ấn vào link sẽ tự động mở bot và nhận lại nội dung note.";
      await sendMessage(chatId, helpMessage);
    }
  }
  // Xử lý /notes
  else if (text.startsWith("/notes")) {
    let content = text.replace(/^\/notes\s*/, "").trim();

    // Trường hợp 1: Reply lệnh /notes vào một tin nhắn có sẵn
    if (!content && message.reply_to_message?.text) {
      content = message.reply_to_message.text;
    }

    // Trường hợp 2: Chỉ gửi mỗi /notes -> Yêu cầu người dùng trả lời tin nhắn này
    if (!content) {
      await sendMessage(
        chatId,
        `📝 Vui lòng **trả lời** tin nhắn này với nội dung bạn muốn lưu thành Note.${HIDDEN_MARKER}`,
        { reply_markup: { force_reply: true, selective: true } }
      );
    } else {
      await handleCreateNote(chatId, content);
    }
  }
  // Nhận diện tin nhắn người dùng trả lời lại câu hỏi của bot (thông qua ký tự ẩn)
  else if (
    message.reply_to_message?.text &&
    message.reply_to_message.text.includes(HIDDEN_MARKER)
  ) {
    await handleCreateNote(chatId, text);
  }

  return res.status(200).json({ ok: true });
}
