
const { waitUntil } = require("@vercel/functions");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const API = `https://api.telegram.org/bot${TOKEN || ""}`;
const MAX_SIZE = 45 * 1024 * 1024;
const MAX_DURATION = 300;
const MAX_ACTIVE = 2;
const JOB_TTL = 10 * 60 * 1000;
const INFO_TTL = 2 * 60 * 1000;
const YTDLP_PATH = path.join(os.tmpdir(), "yt-dlp");
const FFMPEG_PATH = require("ffmpeg-static");

const JOBS = new Map();
const INFO_CACHE = new Map();

let binaryPromise = null;
let activeJobs = 0;
const queue = [];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function telegram(method, data = {}, timeout = 25000) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeout)
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram API ${method} failed`);
  }

  return result.result;
}

function html(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractUrl(text = "") {
  const matches = text.match(/https?:\/\/[^\s<>]+/gi) || [];

  for (const match of matches) {
    const candidate = match.replace(/[),.!?]+$/, "");

    if (validUrl(candidate)) return candidate;
  }

  return null;
}

function validUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();

    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com") ||
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com")
    );
  } catch {
    return false;
  }
}

async function getYtdlpPath() {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      if (fs.existsSync(YTDLP_PATH)) {
        await fs.promises.chmod(YTDLP_PATH, 0o755);
        return YTDLP_PATH;
      }

      const arch = process.arch;
      let filename;

      if (process.platform !== "linux") {
        throw new Error("yt-dlp standalone chỉ được cấu hình cho Linux.");
      }

      if (arch === "x64") {
        filename = "yt-dlp_linux";
      } else if (arch === "arm64") {
        filename = "yt-dlp_linux_aarch64";
      } else {
        throw new Error(`Kiến trúc chưa hỗ trợ: ${arch}`);
      }

      const response = await fetch(
        `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`,
        { signal: AbortSignal.timeout(60000) }
      );

      if (!response.ok) {
        throw new Error(`Không tải được yt-dlp: HTTP ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.length < 1024) {
        throw new Error("Binary yt-dlp tải về không hợp lệ.");
      }

      await fs.promises.writeFile(YTDLP_PATH, buffer, { mode: 0o755 });
      await fs.promises.chmod(YTDLP_PATH, 0o755);

      return YTDLP_PATH;
    })().catch(error => {
      binaryPromise = null;
      throw error;
    });
  }

  return binaryPromise;
}

async function runYtdlp(args, timeout = 60000) {
  const binary = await getYtdlpPath();

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("yt-dlp hết thời gian xử lý."));
    }, timeout);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();

      if (stdout.length > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Dữ liệu đầu ra yt-dlp quá lớn."));
      }
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();

      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", error => finish(error));

    child.on("close", code => {
      if (code === 0) {
        finish(null, stdout);
      } else {
        finish(
          new Error(stderr.slice(-1600) || `yt-dlp thoát với mã ${code}`)
        );
      }
    });
  });
}

async function getInfo(url) {
  const cached = INFO_CACHE.get(url);

  if (cached && Date.now() - cached.time < INFO_TTL) {
    return cached.info;
  }

  const output = await runYtdlp([
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--socket-timeout", "12",
    "--retries", "1",
    url
  ]);

  let info;

  try {
    info = JSON.parse(output);
  } catch {
    throw new Error("Không thể đọc thông tin video.");
  }

  if (!info?.title || !info?.webpage_url) {
    throw new Error("Không tìm thấy video có thể tải.");
  }

  if (info.is_live) {
    throw new Error("Không hỗ trợ tải livestream.");
  }

  if (info.duration != null && info.duration > MAX_DURATION) {
    throw new Error("Video dài quá 5 phút.");
  }

  INFO_CACHE.set(url, { info, time: Date.now() });

  if (INFO_CACHE.size > 200) {
    const oldest = INFO_CACHE.keys().next().value;
    INFO_CACHE.delete(oldest);
  }

  return info;
}

function menuKeyboard(id, url) {
  return {
    inline_keyboard: [
      [
        { text: "Video tốt nhất", callback_data: `dl:${id}:best` },
        { text: "1080p", callback_data: `dl:${id}:1080` }
      ],
      [
        { text: "4K", callback_data: `dl:${id}:4k` },
        { text: "MP3", callback_data: `dl:${id}:mp3` }
      ],
      [{ text: "Mở video gốc", url }]
    ]
  };
}

function sourceKeyboard(url) {
  return {
    inline_keyboard: [
      [{ text: "Mở video gốc", url }]
    ]
  };
}

async function editStatus(chatId, messageId, text, keyboard) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {})
    });
  } catch (error) {
    console.error("[STATUS]", error.message);
  }
}

async function downloadVideo(url, quality, dir) {
  const output = path.join(dir, "%(id)s.%(ext)s");

  const formats = {
    best: "bv*+ba/b",
    "1080": "bv*[height<=1080]+ba/b[height<=1080]",
    "4k": "bv*[height<=2160][height>1080]+ba/b[height<=2160][height>1080]",
    mp3: "ba/b"
  };

  const args = [
    url,
    "--output", output,
    "--format", formats[quality],
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--socket-timeout", "15",
    "--retries", "2",
    "--fragment-retries", "2",
    "--concurrent-fragments", "4",
    "--max-filesize", "45M",
    "--no-part"
  ];

  if (quality === "mp3") {
    args.push("--extract-audio", "--audio-format", "mp3");
  } else {
    args.push("--merge-output-format", "mp4");
  }

  if (FFMPEG_PATH && fs.existsSync(FFMPEG_PATH)) {
    args.push("--ffmpeg-location", FFMPEG_PATH);
  }

  await runYtdlp(args, 180000);

  const files = await fs.promises.readdir(dir);
  const media = [];

  for (const name of files) {
    const fullPath = path.join(dir, name);
    const stat = await fs.promises.stat(fullPath);

    if (
      stat.isFile() &&
      /\.(mp4|m4v|webm|mov|mp3|m4a|opus|ogg|wav)$/i.test(name)
    ) {
      media.push({ path: fullPath, size: stat.size });
    }
  }

  media.sort((a, b) => b.size - a.size);

  if (!media.length) {
    throw new Error("Không tìm thấy tệp video hoặc âm thanh đầu ra.");
  }

  if (media[0].size > MAX_SIZE) {
    throw new Error("Tệp vượt quá giới hạn gửi 45 MB.");
  }

  return media[0].path;
}

async function uploadMedia(chatId, replyTo, file, title, url, quality) {
  const isAudio = quality === "mp3";
  const ext = path.extname(file).toLowerCase();
  const isMp4 = ext === ".mp4" || ext === ".m4v";

  const method = isAudio
    ? "sendAudio"
    : isMp4
      ? "sendVideo"
      : "sendDocument";

  const field = isAudio
    ? "audio"
    : isMp4
      ? "video"
      : "document";

  const filename = path.basename(file);
  const buffer = await fs.promises.readFile(file);

  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append("reply_to_message_id", String(replyTo));
  form.append(
    "caption",
    `${String(title).slice(0, 650)}\n\nNguồn: ${url}`.slice(0, 1000)
  );
  form.append("reply_markup", JSON.stringify(sourceKeyboard(url)));

  if (isMp4) form.append("supports_streaming", "true");
  if (isAudio) form.append("title", String(title).slice(0, 200));

  form.append(
    field,
    new Blob([buffer]),
    filename
  );

  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(90000)
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || "Telegram không gửi được tệp.");
  }

  return result.result;
}

async function withSlot(task) {
  if (activeJobs >= MAX_ACTIVE) {
    await new Promise(resolve => queue.push(resolve));
  }

  activeJobs++;

  try {
    return await task();
  } finally {
    activeJobs--;
    const next = queue.shift();
    if (next) next();
  }
}

async function processDownload(chatId, replyTo, url, quality, statusId) {
  return withSlot(async () => {
    const dir = path.join(os.tmpdir(), `tgdl-${crypto.randomUUID()}`);

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      await editStatus(
        chatId,
        statusId,
        "🔎 <b>Đang phân tích video...</b>"
      );

      const info = await getInfo(url);

      await editStatus(
        chatId,
        statusId,
        `⏬ <b>Đang tải video</b>\n` +
        `🎬 ${html(info.title)}\n` +
        `🎞 Chất lượng: ${html(quality)}\n` +
        `⏳ Đang xử lý, vui lòng chờ...`
      );

      const file = await downloadVideo(
        info.webpage_url || url,
        quality,
        dir
      );

      await editStatus(
        chatId,
        statusId,
        "📤 <b>Đang gửi tệp lên Telegram...</b>"
      );

      await uploadMedia(
        chatId,
        replyTo,
        file,
        info.title,
        info.webpage_url || url,
        quality
      );

      await editStatus(
        chatId,
        statusId,
        "✅ <b>Đã tải và gửi tệp thành công.</b>"
      );
    } catch (error) {
      console.error("[DOWNLOAD]", error);

      await editStatus(
        chatId,
        statusId,
        `❌ <b>Tải thất bại</b>\n${html(error.message).slice(0, 1300)}`
      );
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
}

function cleanJobs() {
  const now = Date.now();

  for (const [id, job] of JOBS) {
    if (job.expires < now) JOBS.delete(id);
  }

  while (JOBS.size > 300) {
    JOBS.delete(JOBS.keys().next().value);
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const query = update.callback_query;
    const match = /^dl:([a-f0-9-]+):(best|1080|4k|mp3)$/.exec(
      query.data || ""
    );

    if (!match) {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Nút không hợp lệ."
      });
      return;
    }

    const [, id, quality] = match;
    const job = JOBS.get(id);

    if (!job || job.expires < Date.now()) {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Link đã hết hạn. Hãy gửi lại /dl + link."
      });
      return;
    }

    if (job.busy) {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Tác vụ này đang được xử lý."
      });
      return;
    }

    job.busy = true;

    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Đã nhận lựa chọn."
    });

    const statusMessage = await telegram("sendMessage", {
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
        statusMessage.message_id
      ).finally(() => {
        job.busy = false;
      })
    );

    return;
  }

  const message = update.message;
  if (!message?.chat || !message.from || message.from.is_bot) return;

  const chatId = message.chat.id;
  const messageText = message.text || message.caption || "";
  const first = messageText.trim().split(/\s+/)[0] || "";
  const command = first.split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text:
        "🎬 Bot tải video TikTok & YouTube\n\n" +
        "• Dán link video để tải nhanh.\n" +
        "• /dl + link để chọn định dạng.\n\n" +
        "Các lựa chọn: Video tốt nhất, 1080p, 4K và MP3.\n" +
        "Giới hạn: video tối đa 5 phút, tệp tối đa 45 MB."
    });
    return;
  }

  const isDl = command === "/dl";
  const url = extractUrl(
    isDl
      ? messageText.replace(/^\/dl(?:@\S+)?/i, "")
      : messageText
  );

  if (!url) {
    if (isDl) {
      await telegram("sendMessage", {
        chat_id: chatId,
        reply_to_message_id: message.message_id,
        text: "❌ Hãy dùng /dl + link TikTok hoặc YouTube hợp lệ."
      });
    }
    return;
  }

  cleanJobs();

  if (isDl) {
    const id = crypto.randomUUID();

    JOBS.set(id, {
      chatId,
      replyTo: message.message_id,
      url,
      busy: false,
      expires: Date.now() + JOB_TTL
    });

    const statusMessage = await telegram("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: message.message_id,
      text: "🔎 Đang lấy thông tin video..."
    });

    waitUntil((async () => {
      try {
        const info = await getInfo(url);

        await editStatus(
          chatId,
          statusMessage.message_id,
          `🎬 <b>${html(info.title)}</b>\n\n` +
          `⏱ Thời lượng: ${info.duration ?? "Không rõ"} giây\n` +
          `👤 Kênh: ${html(info.uploader || "Không rõ")}\n\n` +
          "Chọn định dạng muốn tải:",
          menuKeyboard(id, info.webpage_url || url)
        );
      } catch (error) {
        await editStatus(
          chatId,
          statusMessage.message_id,
          `❌ <b>Không thể lấy thông tin video.</b>\n${html(error.message).slice(0, 1200)}`
        );
      }
    })());

    return;
  }

  const statusMessage = await telegram("sendMessage", {
    chat_id: chatId,
    reply_to_message_id: message.message_id,
    text: "🔎 Đang kiểm tra link video..."
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram downloader is running.");
  }

  if (!TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing BOT_TOKEN"
    });
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
