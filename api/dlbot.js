const { waitUntil } = require("@vercel/functions");
const ytdlp = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_SIZE = 49 * 1024 * 1024;
const MAX_DURATION = 300;
const JOBS = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function telegram(method, data = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(25000)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || `Telegram ${method} failed`);
  }

  return result.result;
}

async function edit(chatId, messageId, text, keyboard) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

async function status(chatId, messageId, text) {
  try {
    await edit(chatId, messageId, text);
  } catch {}
}

function validUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();

    return [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
      "tiktok.com",
      "www.tiktok.com",
      "m.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com"
    ].includes(host) || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

function extractUrl(text = "") {
  const matches = text.match(/https?:\/\/[^\s<>]+/gi) || [];

  for (const match of matches) {
    const candidate = match.replace(/[),.!?]+$/, "");
    if (validUrl(candidate)) return candidate;
  }

  return null;
}

function html(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getInfo(url) {
  const info = await ytdlp(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    skipDownload: true,
    noCheckCertificates: false,
    socketTimeout: 15,
    retries: 1
  }, {
    timeout: 45000
  });

  if (!info || !info.title || !info.webpage_url) {
    throw new Error("Không tìm thấy video có thể tải.");
  }

  if (info.is_live) {
    throw new Error("Không hỗ trợ tải livestream.");
  }

  if (info.duration > MAX_DURATION) {
    throw new Error("Video dài quá 5 phút.");
  }

  return info;
}

function keyboardFor(id) {
  return {
    inline_keyboard: [
      [
        { text: "Video tốt nhất", callback_data: `dl:${id}:best` },
        { text: "1080p", callback_data: `dl:${id}:1080` }
      ],
      [
        { text: "4K", callback_data: `dl:${id}:4k` },
        { text: "Âm thanh MP3", callback_data: `dl:${id}:mp3` }
      ],
      [
        { text: "Mở link gốc", url: JOBS.get(id)?.url || "https://youtube.com" }
      ]
    ]
  };
}

async function downloadVideo(url, quality, dir) {
  const output = path.join(dir, "%(id)s.%(ext)s");

  const format = {
    best: "best[ext=mp4][filesize<49000000]/best[filesize<49000000]",
    "1080": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]",
    "4k": "bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/best[height<=2160][ext=mp4]/best[height<=2160]",
    mp3: "bestaudio/best"
  }[quality];

  const args = [
    url,
    "-o", output,
    "-f", format,
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--max-filesize", "49M",
    "--socket-timeout", "15",
    "--retries", "1",
    "--no-part"
  ];

  if (quality === "mp3") {
    args.push("--extract-audio", "--audio-format", "mp3");
  }

  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(ytdlp.exec ? ytdlp.execPath || "yt-dlp" : "yt-dlp", args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let error = "";

    child.stderr.on("data", chunk => {
      error += chunk.toString();
      if (error.length > 5000) error = error.slice(-5000);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Quá thời gian tải."));
    }, 210000);

    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", code => {
      clearTimeout(timer);

      if (code === 0) resolve();
      else reject(new Error(error.slice(-1200) || "yt-dlp không tải được video."));
    });
  });

  const files = fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).isFile());

  const media = files.find(file =>
    /\.(mp4|m4v|webm|mp3|m4a|opus|ogg)$/i.test(file)
  );

  if (!media) throw new Error("Không tìm thấy tệp đầu ra.");
  if (fs.statSync(media).size > MAX_SIZE) {
    throw new Error("Tệp lớn hơn 49 MB, không thể gửi bằng cách này.");
  }

  return media;
}

async function uploadMedia(chatId, messageId, file, title, url, quality) {
  const isAudio = quality === "mp3";
  const method = isAudio ? "sendAudio" : "sendVideo";
  const field = isAudio ? "audio" : "video";
  const boundary = `----TG${randomUUID().replace(/-/g, "")}`;
  const filename = path.basename(file);
  const fileData = fs.readFileSync(file);

  const fields = {
    chat_id: String(chatId),
    reply_to_message_id: String(messageId),
    caption: `${title}\n\nNguồn: ${url}`.slice(0, 1024),
    supports_streaming: "true"
  };

  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }

  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  chunks.push(fileData);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(90000)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram gửi tệp thất bại.");
  }

  return result.result;
}

async function processDownload(chatId, replyTo, url, quality, statusId) {
  const dir = path.join(os.tmpdir(), `tgdl-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });

  try {
    await status(chatId, statusId, "🔎 <b>Đang phân tích video...</b>");

    const info = await getInfo(url);

    await status(
      chatId,
      statusId,
      `⏬ <b>Đang tải:</b> ${html(info.title)}\n` +
      `🎞 Chất lượng: ${html(quality)}\n` +
      `⏳ Vui lòng chờ...`
    );

    const file = await downloadVideo(info.webpage_url || url, quality, dir);

    await status(chatId, statusId, "📤 <b>Đang gửi tệp lên Telegram...</b>");

    await uploadMedia(
      chatId,
      replyTo,
      file,
      info.title,
      info.webpage_url || url,
      quality
    );

    await status(chatId, statusId, "✅ <b>Tải xong!</b>");
  } catch (error) {
    await status(
      chatId,
      statusId,
      `❌ <b>Không tải được</b>\n${html(error.message).slice(0, 1500)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const q = update.callback_query;
    const match = /^dl:([a-f0-9-]+):(best|1080|4k|mp3)$/.exec(q.data || "");

    await telegram("answerCallbackQuery", {
      callback_query_id: q.id
    });

    if (!match) return;

    const [, id, quality] = match;
    const job = JOBS.get(id);

    if (!job || job.busy) return;

    job.busy = true;

    const msg = await telegram("sendMessage", {
      chat_id: job.chatId,
      reply_to_message_id: job.replyTo,
      text: "⏳ Đang chuẩn bị tải..."
    });

    waitUntil(
      processDownload(
        job.chatId,
        job.replyTo,
        job.url,
        quality,
        msg.message_id
      ).finally(() => {
        job.busy = false;
      })
    );

    return;
  }

  const message = update.message;
  if (!message?.chat || !message.from || message.from.is_bot) return;

  const chatId = message.chat.id;
  const text = message.text || "";
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text:
        "🎬 <b>Bot tải video TikTok & YouTube</b>\n\n" +
        "• Dán link video để tải nhanh.\n" +
        "• Dùng /dl + link để chọn chất lượng.\n\n" +
        "Hỗ trợ video, 1080p, 4K và MP3.",
      parse_mode: "HTML"
    });
    return;
  }

  if (command === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text: "/dl https://youtu.be/VIDEO_ID\n\nDán link video để tải nhanh.",
      disable_web_page_preview: true
    });
    return;
  }

  const isDl = command === "/dl";
  const url = extractUrl(isDl ? text.replace(/^\/dl(?:@\S+)?/i, "") : text);

  if (!url) {
    if (isDl) {
      await telegram("sendMessage", {
        chat_id: chatId,
        reply_to_message_id: message.message_id,
        text: "❌ Hãy dùng /dl + link hợp lệ."
      });
    }
    return;
  }

  const id = randomUUID();
  JOBS.set(id, {
    chatId,
    replyTo: message.message_id,
    url,
    busy: false
  });

  if (JOBS.size > 300) {
    for (const [key] of JOBS) {
      JOBS.delete(key);
      if (JOBS.size <= 200) break;
    }
  }

  if (isDl) {
    const statusMessage = await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text: "🔎 Đang kiểm tra link..."
    });

    waitUntil((async () => {
      try {
        const info = await getInfo(url);
        await edit(
          chatId,
          statusMessage.message_id,
          `🎬 <b>${html(info.title)}</b>\n\n` +
          `⏱ Thời lượng: ${info.duration || "Không rõ"} giây\n` +
          `👤 Kênh: ${html(info.uploader || "Không rõ")}\n\n` +
          "Chọn định dạng muốn tải:",
          keyboardFor(id)
        );
      } catch (error) {
        await status(
          chatId,
          statusMessage.message_id,
          `❌ Không thể lấy thông tin video.\n${html(error.message).slice(0, 1200)}`
        );
      }
    })());
  } else {
    const statusMessage = await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text: "Đang kiểm tra link..."
    });

    waitUntil(
      processDownload(
        chatId,
        message.message_id,
        url,
        "best",
        statusMessage.message_id
      )
    );
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram download bot is running.");
  }

  if (!TOKEN) {
    return res.status(500).json({ ok: false, error: "Missing BOT_TOKEN" });
  }

  res.status(200).json({ ok: true });

  if (req.body) {
    waitUntil(
      handleUpdate(req.body).catch(error => {
        console.error("[BOT ERROR]", error);
      })
    );
  }
};
      
