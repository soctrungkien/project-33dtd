const BOT_TOKEN = process.env.BOT_TOKEN_NOTE;

async function pastefy_app(data) {
  try {
    const response = await fetch(
      "https://project-33dtd.vercel.app/api/create",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: data }),
      },
    );
    const result = (await response.text()).trim();
    const match = result.match(/pastefy\.app\/([^\/]+)/);
    return match ? match[1] : result;
  } catch {
    return "FETCH_ERROR";
  }
}

async function getNoteContent(id) {
  try {
    const cleanId = id.replace(/https?:\/\/pastefy\.app\//, "").replace(/\/raw.*/, "").trim();
    const res = await fetch(`https://pastefy.app/${cleanId}/raw`);
    if (!res.ok) return "❌ Không tìm thấy nội dung note";
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

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
    }),
  });
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

  // Xử lý lệnh /start
  if (text.startsWith("/start")) {
    const args = text.split(" ");
    const noteId = args[1];

    if (noteId) {
      const content = await getNoteContent(noteId);
      await sendMessage(chatId, content);
    } else {
      const botUsername = await getBotUsername();
      const helpMessage = 
        "📌 *Hướng dẫn sử dụng Bot Note*\n\n" +
        "1. Tạo note mới:\n" +
        "   Gửi lệnh: `/notes <nội dung note>`\n" +
        "   _Ví dụ:_ `/notes Đây là nội dung ghi chú của tôi`\n\n" +
        "2. Chia sẻ:\n" +
        "   Bot sẽ trả về link `https://t.me/" + (botUsername || "your_bot") + "?start=<ID>`.\n" +
        "   Người dùng ấn vào link sẽ tự mở bot và nhận lại nội dung note.";
      await sendMessage(chatId, helpMessage);
    }
  } 
  // Xử lý lệnh /notes
  else if (text.startsWith("/notes")) {
    const content = text.replace(/^\/notes\s*/, "").trim();

    if (!content) {
      await sendMessage(
        chatId, 
        "⚠️ Vui lòng nhập nội dung sau lệnh `/notes`.\nVí dụ: `/notes Nội dung cần lưu`"
      );
    } else {
      const noteId = await pastefy_app(content);

      if (!noteId || noteId === "FETCH_ERROR") {
        await sendMessage(chatId, "❌ Lỗi hệ thống khi tải note lên server. Vui lòng thử lại!");
      } else {
        const botUsername = await getBotUsername();
        if (!botUsername) {
          await sendMessage(chatId, "❌ Lỗi: Không thể xác thực BOT_TOKEN.");
          return res.status(200).json({ ok: true });
        }
        
        const shareLink = `https://t.me/${botUsername}?start=${noteId}`;
        await sendMessage(
          chatId, 
          `✅ **Tạo Note thành công!**\n\n🔗 Link lấy note:\n${shareLink}`
        );
      }
    }
  }

  return res.status(200).json({ ok: true });
}
