const https = require("https");
const { YtdlCore } = require("@ybd-project/ytdl-core/serverless");
const { waitUntil } = require("@vercel/functions");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_SIZE = 45 * 1024 * 1024;
const TIMEOUT = 200000;
const VERSION = "1.0.0";

const ytdl = new YtdlCore({});
const jobs = new Set();
let usernamePromise;

function api(method, data = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(`${API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 30000
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return reject(new Error("Phản hồi Telegram không hợp lệ"));
        }
        if (!result.ok) {
          return reject(new Error(result.description || "Telegram API error"));
        }
        resolve(result);
      });
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Telegram request timeout")));
    req.end(body);
  });
}

async function send(chatId, text, extra = {}) {
  return api("sendMessage", { chat_id: chatId, text, ...extra });
}

async function edit(chatId, messageId, text) {
  if (!messageId) return;
  try {
    await api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, 3900)
    });
  } catch {}
}

async function typing(chatId, type = "typing") {
  try {
    await api("sendChatAction", { chat_id: chatId, action: type });
  } catch {}
}

async function getUsername() {
  if (!usernamePromise) {
    usernamePromise = api("getMe")
      .then(r => r.result.username.toLowerCase())
      .catch(e => {
        usernamePromise = null;
        throw e;
      });
  }
  return usernamePromise;
}

async function ownCommand(text, name) {
  const m = text.match(
    new RegExp("^/" + name + "(?:@([a-zA-Z0-9_]+))?(?=\\s|$)", "i")
  );
  if (!m) return false;
  if (!m[1]) return true;

  try {
    return m[1].toLowerCase() === await getUsername();
  } catch {
    return false;
  }
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>]+/i);
  if (!m) return null;

  const value = m[0].replace(/[),.!?]+$/, "");

  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");

    if (u.protocol !== "https:" && u.protocol !== "http:") return null;

    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    ) {
      return { url: value, platform: "youtube" };
    }

    if (
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com")
    ) {
      return { url: value, platform: "tiktok" };
    }
  } catch {}

  return null;
}

function tokenize(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;

  while ((m = re.exec(input))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }

  return out;
}

function parseArgs(tokens) {
  const opts = {
    format: "best",
    listFormats: false,
    dumpJson: false,
    getTitle: false,
    getId: false,
    getDuration: false,
    getThumbnail: false,
    simulate: false,
    noPlaylist: false,
    noWarnings: false,
    maxFileSize: MAX_SIZE
  };

  const positional = [];

  const needsValue = new Set([
    "-f", "--format",
    "--max-filesize"
  ]);

  const supportedFlags = new Set([
    "-h", "--help",
    "--version",
    "-U", "--update",
    "--no-update",
    "-i", "--ignore-errors",
    "--no-abort-on-error",
    "--abort-on-error",
    "--no-playlist",
    "--yes-playlist",
    "--no-warnings",
    "--dump-json",
    "--dump-single-json",
    "--get-title",
    "--get-id",
    "--get-duration",
    "--get-thumbnail",
    "--list-formats",
    "--simulate",
    "--skip-download",
    "--no-progress",
    "--ignore-config",
    "--no-config",
    "--no-mark-watched"
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i];

    if (needsValue.has(arg)) {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`Thiếu giá trị cho ${arg}`);
      }

      if (arg === "-f" || arg === "--format") {
        opts.format = value;
      } else {
        opts.maxFileSize = parseSize(value);
      }
      continue;
    }

    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const value = eq < 0 ? null : arg.slice(eq + 1);

      if (name === "-f" || name === "--format") {
        if (!value) throw new Error(`Thiếu giá trị cho ${name}`);
        opts.format = value;
      } else if (name === "--max-filesize") {
        if (!value) throw new Error(`Thiếu giá trị cho ${name}`);
        opts.maxFileSize = parseSize(value);
      } else if (!supportedFlags.has(name)) {
        throw new Error(`Tùy chọn chưa hỗ trợ: ${name}`);
      } else {
        switch (name) {
          case "-h":
          case "--help":
            opts.help = true;
            break;
          case "--version":
            opts.version = true;
            break;
          case "-U":
          case "--update":
            opts.update = true;
            break;
          case "--dump-json":
          case "--dump-single-json":
            opts.dumpJson = true;
            break;
          case "--get-title":
            opts.getTitle = true;
            break;
          case "--get-id":
            opts.getId = true;
            break;
          case "--get-duration":
            opts.getDuration = true;
            break;
          case "--get-thumbnail":
            opts.getThumbnail = true;
            break;
          case "--list-formats":
            opts.listFormats = true;
            break;
          case "--simulate":
          case "--skip-download":
            opts.simulate = true;
            break;
          case "--no-playlist":
            opts.noPlaylist = true;
            break;
          case "--yes-playlist":
            throw new Error("Playlist chưa được hỗ trợ.");
          case "--no-warnings":
            opts.noWarnings = true;
            break;
        }
      }
      continue;
    }

    positional.push(arg);
  }

  opts.url = positional.find(x => /^https?:\/\//i.test(x)) || null;
  return opts;
}

function parseSize(value) {
  const m = String(value).match(/^(\d+(?:\.\d+)?)\s*(B|K|KB|M|MB|G|GB)?$/i);
  if (!m) throw new Error("Dung lượng không hợp lệ. Ví dụ: 20M");

  const unit = (m[2] || "B").toUpperCase();
  const factor = {
    B: 1,
    K: 1024,
    KB: 1024,
    M: 1024 ** 2,
    MB: 1024 ** 2,
    G: 1024 ** 3,
    GB: 1024 ** 3
  }[unit];

  return Math.floor(Number(m[1]) * factor);
}

function helpText() {
  return [
    "yt-dlp-compatible bot",
    "",
    "Cách dùng:",
    "/yt-dlp URL",
    "/yt-dlp -f best URL",
    "/yt-dlp -f 18 URL",
    "/yt-dlp --list-formats URL",
    "/yt-dlp --dump-json URL",
    "/yt-dlp --get-title URL",
    "/yt-dlp --get-id URL",
    "/yt-dlp --get-duration URL",
    "/yt-dlp --get-thumbnail URL",
    "/yt-dlp --simulate URL",
    "/yt-dlp --max-filesize 20M URL",
    "/yt-dlp --version",
    "/yt-dlp --help",
    "",
    "Tùy chọn hỗ trợ:",
    "-f, --format FORMAT",
    "-h, --help",
    "--version",
    "--list-formats",
    "--dump-json",
    "--get-title / --get-id",
    "--get-duration / --get-thumbnail",
    "--simulate / --skip-download",
    "--no-playlist",
    "--max-filesize SIZE",
    "--no-warnings",
    "--ignore-config / --no-config",
    "--no-update / --update",
    "",
    "Lưu ý:",
    "• Tải video chỉ dùng trong chat riêng.",
    "• Chỉ hỗ trợ YouTube bằng ytdl-core.",
    "• TikTok chưa được thư viện này hỗ trợ.",
    "• Các lệnh chưa hỗ trợ sẽ báo lỗi."
  ].join("\n");
}

function formatList(info) {
  const formats = info.formats || [];
  const lines = [
    `Video: ${info.videoDetails?.title || "Unknown"}`,
    "",
    "itag | định dạng | độ phân giải | audio | dung lượng"
  ];

  for (const f of formats.slice(0, 35)) {
    lines.push([
      f.itag,
      f.container || "?",
      f.qualityLabel || f.quality || "?",
      f.hasAudio ? "có" : "không",
      f.contentLength
        ? `${(Number(f.contentLength) / 1048576).toFixed(1)} MB`
        : "?"
    ].join(" | "));
  }

  return lines.join("\n").slice(0, 3800);
}

function chooseFormat(info, selector, maxSize) {
  const formats = (info.formats || []).filter(f =>
    f.url &&
    f.hasVideo &&
    f.hasAudio &&
    (!f.contentLength || Number(f.contentLength) <= maxSize)
  );

  if (!formats.length) {
    throw new Error(
      "Không tìm thấy định dạng MP4 có cả hình và tiếng trong giới hạn dung lượng."
    );
  }

  if (/^\d+$/.test(selector)) {
    const chosen = formats.find(f => String(f.itag) === selector);
    if (!chosen) {
      throw new Error(
        "itag không tồn tại hoặc không phải định dạng video có cả hình và tiếng. Dùng --list-formats."
      );
    }
    return chosen;
  }

  if (selector !== "best" && selector !== "best[ext=mp4]/best") {
    const height = selector.match(/height\s*<=\s*(\d+)/i);
    if (height) {
      const maxHeight = Number(height[1]);
      const selected = formats
        .filter(f => Number.parseInt(f.qualityLabel, 10) <= maxHeight)
        .sort((a, b) =>
          Number.parseInt(b.qualityLabel, 10) -
          Number.parseInt(a.qualityLabel, 10)
        )[0];

      if (selected) return selected;
    } else {
      throw new Error(
        "Bộ chọn format này chưa hỗ trợ. Dùng -f best, -f 18 hoặc -f 'best[height<=720]'."
      );
    }
  }

  return formats.sort((a, b) =>
    (Number.parseInt(b.qualityLabel, 10) || 0) -
    (Number.parseInt(a.qualityLabel, 10) || 0)
  )[0];
}

async function fetchBuffer(url, maxSize) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(`Tải video thất bại: HTTP ${response.status}`);
    }

    const length = Number(response.headers.get("content-length") || 0);

    if (length > maxSize) {
      throw new Error("Video vượt giới hạn dung lượng.");
    }

    const data = Buffer.from(await response.arrayBuffer());

    if (data.length > maxSize) {
      throw new Error("Video vượt giới hạn dung lượng.");
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadVideo(chatId, buffer, title, messageId) {
  await edit(chatId, messageId, "Đang gửi video lên Telegram...");
  await typing(chatId, "upload_video");

  const boundary = `----TG${Date.now()}`;
  const caption = String(title || "Video").slice(0, 900);
  const parts = [];

  function field(name, value) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  field("chat_id", chatId);
  field("caption", caption);

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="video"; filename="video.mp4"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  await new Promise((resolve, reject) => {
    const req = https.request(`${API}/sendVideo`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length
      },
      timeout: 60000
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return reject(new Error("Phản hồi gửi video không hợp lệ"));
        }

        if (!result.ok) {
          return reject(new Error(result.description || "Không gửi được video"));
        }
        resolve();
      });
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Gửi video timeout")));
    req.end(body);
  });
}

async function runCommand(chatId, input, quickLink = null) {
  const tokens = tokenize(input);
  const opts = parseArgs(tokens);

  if (opts.help) return send(chatId, helpText());
  if (opts.version) return send(chatId, `yt-dlp-compatible bot v${VERSION}\n@ybd-project/ytdl-core`);

  if (opts.update) {
    return send(chatId, "Đây là bot JavaScript, không phải executable yt-dlp. Không có binary để tự cập nhật.");
  }

  const target = quickLink || opts.url;

  if (!target) {
    return send(chatId, "Thiếu URL.\nCách dùng: /yt-dlp URL\nGửi /yt-dlp --help để xem hướng dẫn.");
  }

  const parsed = extractUrl(target);

  if (!parsed) return send(chatId, "URL không hợp lệ hoặc chưa được hỗ trợ.");
  if (parsed.platform !== "youtube") {
    return send(chatId, "Thư viện @ybd-project/ytdl-core chỉ tải YouTube. TikTok chưa được hỗ trợ.");
  }

  if (jobs.has(chatId)) {
    return send(chatId, "Bạn đang có tác vụ khác. Hãy chờ hoàn tất.");
  }

  jobs.add(chatId);
  let statusId;

  try {
    const status = await send(chatId, "Đang phân tích video YouTube...");
    statusId = status.result.message_id;

    await typing(chatId);

    const info = await ytdl.getBasicInfo(parsed.url);
    const details = info.videoDetails || {};
    const title = details.title || "YouTube video";

    if (opts.getTitle) {
      return await edit(chatId, statusId, title);
    }

    if (opts.getId) {
      return await edit(chatId, statusId, details.videoId || "");
    }

    if (opts.getDuration) {
      return await edit(chatId, statusId, String(details.lengthSeconds || "Unknown"));
    }

    if (opts.getThumbnail) {
      const thumb = details.thumbnails?.at(-1)?.url;
      return await edit(chatId, statusId, thumb || "Không có thumbnail.");
    }

    if (opts.dumpJson) {
      return await edit(
        chatId,
        statusId,
        JSON.stringify({
          id: details.videoId,
          title,
          duration: details.lengthSeconds,
          author: details.author?.name,
          views: details.viewCount,
          url: parsed.url,
          thumbnails: details.thumbnails
        }, null, 2).slice(0, 3900)
      );
    }

    if (opts.listFormats) {
      return await edit(chatId, statusId, formatList(info));
    }

    if (opts.simulate) {
      return await edit(
        chatId,
        statusId,
        `Mô phỏng thành công.\nTiêu đề: ${title}\nVideo ID: ${details.videoId || "?"}\nThời lượng: ${details.lengthSeconds || "?"} giây`
      );
    }

    const format = chooseFormat(info, opts.format, opts.maxFileSize);

    if (format.contentLength && Number(format.contentLength) > opts.maxFileSize) {
      throw new Error("Định dạng vượt giới hạn dung lượng.");
    }

    await edit(
      chatId,
      statusId,
      `Đã phân tích: ${title}\nĐịnh dạng: ${format.itag}\nĐộ phân giải: ${format.qualityLabel || "?"}\nĐang tải video...`
    );

    const buffer = await fetchBuffer(format.url, opts.maxFileSize);
    await uploadVideo(chatId, buffer, title, statusId);
    await edit(chatId, statusId, "Tải và gửi video thành công.");
  } catch (error) {
    console.error("[Downloader]", error);
    await edit(
      chatId,
      statusId,
      `Lỗi: ${String(error.message || error).slice(0, 1200)}`
    );
  } finally {
    jobs.delete(chatId);
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text || !msg.chat) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const privateChat = msg.chat.type === "private";

  const command = text.match(/^\/([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9_]+))?(?=\s|$)/);

  if (command) {
    const name = command[1].toLowerCase();

    if (command[2] && !(await ownCommand(text, name))) return;

    if (name === "start") {
      return send(chatId,
        "Bot tải video YouTube bằng @ybd-project/ytdl-core.\n\n" +
        "Gửi link YouTube trong chat riêng để tải nhanh.\n\n" +
        "/yt-dlp URL\n" +
        "/yt-dlp -f best URL\n" +
        "/yt-dlp --list-formats URL\n" +
        "/yt-dlp --dump-json URL\n" +
        "/yt-dlp --help\n\n" +
        "Lệnh /start vẫn phản hồi trong nhóm; tải video chỉ chạy trong chat riêng."
      );
    }

    if (name === "help") {
      return send(chatId, helpText());
    }

    if (name === "version") {
      return send(chatId, `Bot version ${VERSION}\n@ybd-project/ytdl-core`);
    }

    if (name === "yt-dlp") {
      if (!privateChat) {
        return send(chatId, "Vui lòng dùng lệnh tải video trong chat riêng với bot.");
      }

      const input = text.replace(/^\/yt-dlp(?:@[a-zA-Z0-9_]+)?\s*/i, "");
      return runCommand(chatId, input);
    }

    return;
  }

  if (!privateChat) return;

  const parsed = extractUrl(text);
  if (parsed) {
    return runCommand(chatId, "", parsed.url);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram downloader is running.");
  }

  if (!TOKEN) {
    return res.status(500).json({ ok: false, error: "Missing BOT_TOKEN" });
  }

  const update = req.body;
  res.status(200).json({ ok: true });

  waitUntil(
    Promise.resolve()
      .then(() => handleUpdate(update))
      .catch(error => console.error("[Webhook]", error))
  );
};
    
