const BOT_TOKEN = process.env.BOT_TOKEN_NOTE;
const PASTEFY_API_KEYS = process.env.PASTEFY_API_KEYS;
const HIDDEN_MARKER = "　";
const MAX_CHAR_LIMIT = 3600; // Giới hạn số ký tự

// Hàm bóc tách ID / URL linh hoạt từ văn bản
function extractNoteId(input) {
  if (!input) return "";
  
  // 1. Tìm param start=ID trong link Telegram
  const startMatch = input.match(/start=([A-Za-z0-9_-]+)/i);
  if (startMatch) return startMatch[1];

  // 2. Tìm link HTTP/HTTPS bất kỳ trong câu văn (khi reply tin nhắn dài)
  const urlMatch = input.match(/(https?:\/\/[^\s]+)/i);
  if (urlMatch) return urlMatch[1];

  // 3. Nếu không match link, dùng chuỗi gốc đã trim
  return input.trim();
}

// 1. Gọi trực tiếp API v2
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

    console.log("[SERVER] Đang tạo note mới...");
    const response = await fetch("https://pastefy.app/api/v2/paste", {
      method: "POST",
      headers,
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(8000) // Timeout 8 giây tránh kẹt
    });

    const json = await response.json();

    if (json.success && json.paste?.id) {
      return json.paste.id;
    }
    return "FETCH_ERROR";
  } catch (err) {
    console.error("[SERVER_ERROR]", err);
    return "FETCH_ERROR";
  }
}

async function getNoteContent(input) {
  try {
    const cleanId = extractNoteId(input);
    if (!cleanId) return "❌ Không tìm thấy link hoặc ID hợp lệ.";

    const fetchUrl = /^https?:\/\//i.test(cleanId)
      ? cleanId
      : `https://pastefy.app/${cleanId}/raw`;

    console.log(`[SERVER] Đang lấy nội dung từ: ${fetchUrl}`);
    
    // Thêm Timeout 8 giây để ngắt request nếu link bị treo
    const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
    
    if (!res.ok) {
      return `❌ Không tìm thấy nội dung note (Lỗi HTTP ${res.status}).`;
    }
    const rawText = await res.text();
    return rawText;
  } catch (err) {
    console.error("[FETCH_CONTENT_ERROR]", err);
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "❌ Thời gian tải note quá lâu (Timeout). Vui lòng thử lại!";
    }
    return "❌ Đã xảy ra lỗi khi tải dữ liệu note (Link không hợp lệ hoặc bị lỗi).";
  }
}

async function getBotUsername() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.ok) return data.result.username;
    return null;
  } catch (err) {
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
      signal: AbortSignal.timeout(3000)
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
      signal: AbortSignal.timeout(8000)
    });

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("[TELEGRAM_SEND_ERROR]", err);
  }
}

async function isCommandForThisBot(text, commandName) {
  const match = text.match(new RegExp(`^\\/${commandName}(?:@([A-Za-z0-9_]+))?(?:\\s|$)`, "i"));

  if (!match) return false;
  if (!match[1]) return true;

  const botUsername = await getBotUsername();
  return botUsername && match[1].toLowerCase() === botUsername.toLowerCase();
}

// Hàm xử lý tạo note
async function handleCreateNote(chatId, content, user) {
  if (content.length > MAX_CHAR_LIMIT) {
    await sendMessage(
      chatId,
      `❌ <b>Lỗi:</b> Nội dung quá dài! Giới hạn tối đa là <b>${MAX_CHAR_LIMIT}</b> ký tự (Hiện tại: ${content.length} ký tự).`
    );
    return;
  }

  await sendChatAction(chatId, "typing");

  const rawHeader = `[UID: ${user.id}]\n\n`;
  const fullContent = rawHeader + content;

  const noteId = await createPastefyNote(fullContent);

  if (!noteId || noteId === "FETCH_ERROR") {
    await sendMessage(
      chatId,
      "❌ <b>Lỗi hệ thống:</b> Không thể lưu trữ note. Vui lòng thử lại sau!"
    );
    return;
  }

  const botUsername = await getBotUsername();
  if (!botUsername) {
    await sendMessage(chatId, "❌ <b>Lỗi:</b> Không thể xác thực Bot.");
    return;
  }

  const shareLink = `https://t.me/${botUsername}?start=${noteId}`;

  await sendMessage(
    chatId,
    `✅ <b>Tạo Note thành công!</b>\n\n🔗 <b>Link lấy note:</b>\n${shareLink}`
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
  const isGroup = message.chat.type !== "private";
  const text = message.text.trim();
  const user = message.from;

  const isWho = await isCommandForThisBot(text, "who");
  const isStart = await isCommandForThisBot(text, "start");
  const isNotes = await isCommandForThisBot(text, "newnote");
  const isClone = await isCommandForThisBot(text, "clone");

  // Xử lý lệnh /who
  if (isWho) {
    const args = text.split(/\s+/);
    const inputParam = args[1];

    let targetUser = message.reply_to_message?.from || user;

    if (inputParam) {
      const cleanId = extractNoteId(inputParam);
      const rawContent = await getNoteContent(cleanId);
      const uidMatch = rawContent.match(/^\[UID:\s*(\d+)\]/);

      if (uidMatch) {
        const extractedUid = uidMatch[1];
        
        try {
          const chatRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${extractedUid}`, { signal: AbortSignal.timeout(5000) });
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
  // Xử lý /clone (Bọc Try/Catch hoàn chỉnh)
  else if (isClone) {
    try {
      const args = text.split(/\s+/);
      let targetLink = args[1];

      if (!targetLink && message.reply_to_message?.text) {
        targetLink = message.reply_to_message.text;
      }

      if (!targetLink) {
        await sendMessage(
          chatId,
          "❌ <b>Lỗi:</b> Vui lòng nhập link Telegram hoặc ID raw/reply tin nhắn chứa link note để clone.\nVí dụ: <code>/clone https://t.me/bot?start=abcxyz</code>"
        );
        return res.status(200).json({ ok: true });
      }

      await sendChatAction(chatId, "typing");
      const rawContent = await getNoteContent(targetLink);

      if (rawContent.startsWith("❌")) {
        await sendMessage(chatId, rawContent);
        return res.status(200).json({ ok: true });
      }

      // Tách bỏ UID cũ và thay bằng UID người clone
      const cleanContent = rawContent.replace(/^\[UID:\s*\d+\]\n\n?/, "");
      await handleCreateNote(chatId, cleanContent, user);
    } catch (err) {
      console.error("[CLONE_FATAL_ERROR]", err);
      await sendMessage(chatId, "❌ <b>Lỗi:</b> Không thể clone note. Vui lòng kiểm tra lại link/ID.");
    }
  }
  // Xử lý /start
  else if (isStart) {
    const args = text.split(" ");
    const noteId = args[1];

    if (noteId) {
      await sendChatAction(chatId, "typing");
      const cleanId = extractNoteId(noteId);
      const rawContent = await getNoteContent(cleanId);
      const cleanContent = rawContent.replace(/^\[UID:\s*\d+\]\n\n?/, "");
      await sendMessage(chatId, cleanContent, { parse_mode: undefined });
    } else {
      const botUsername = await getBotUsername();
      const helpMessage =
        "📌 <b>Hướng dẫn sử dụng Bot Note</b>\n\n" +
        "1. <b>Tạo note mới:</b>\n" +
        "   • Viết trực tiếp: <code>/newnote &lt;nội dung&gt;</code>\n" +
        "   • Hoặc <b>reply</b> lệnh /newnote vào bất kỳ tin nhắn nào.\n" +
        `   • Giới hạn: Tối đa <b>${MAX_CHAR_LIMIT}</b> ký tự.\n\n` +
        "2. <b>Clone Note:</b>\n" +
        "   • Cú pháp: <code>/clone &lt;link_tele|id|raw_link&gt;</code>\n" +
        "   • Hoặc reply tin nhắn chứa link note bằng lệnh /clone.\n\n" +
        "3. <b>Xem thông tin người dùng:</b>\n" +
        "   • Gửi /who để xem thông tin của bạn.\n" +
        "   • Reply người khác hoặc dùng <code>/who &lt;link_tele|id&gt;</code> để xem thông tin người tạo note.\n\n" +
        "4. <b>Chia sẻ:</b>\n" +
        "   Bot sẽ trả về link <code>https://t.me/" +
        (botUsername || "your_bot") +
        "?start=&lt;ID&gt;</code>.";
      await sendMessage(chatId, helpMessage);
    }
  }
  // Xử lý /newnote
  else if (isNotes) {
    let content = text.replace(/^\/newnote(@\w+)?\s*/i, "").trim();

    if (!content && message.reply_to_message?.text) {
      content = message.reply_to_message.text;
    }

    if (!content) {
      if (isGroup) {
        await sendMessage(
          chatId,
          "📝 <b>Cú pháp tạo Note trong nhóm:</b>\n\n• Nhập: <code>/newnote &lt;nội dung&gt;</code>"
        );
      } else {
        await sendMessage(
          chatId,
          `📝 Vui lòng <b>trả lời</b> tin nhắn này với nội dung bạn muốn lưu thành Note.${HIDDEN_MARKER}`,
          { reply_markup: { force_reply: true, selective: true } }
        );
      }
    } else {
      await handleCreateNote(chatId, content, user);
    }
  }
  // Trả lời tin nhắn theo yêu cầu force_reply (Chỉ hoạt động trong Chat cá nhân)
  else if (
    !isGroup &&
    message.reply_to_message?.text &&
    message.reply_to_message.text.includes(HIDDEN_MARKER)
  ) {
    await handleCreateNote(chatId, text, user);
  }

  return res.status(200).json({ ok: true });
}
