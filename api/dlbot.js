const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { waitUntil } = require("@vercel/functions");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET_DL || "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const MAX_FILE_SIZE = 45 * 1024 * 1024;
const MAX_DURATION = 240000;
const WORK_DIR = os.tmpdir();
const YTDLP_PATH = path.join(WORK_DIR, "yt-dlp-linux");

let binaryPromise;
const jobs = new Set();

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          data = body;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }

        resolve(data);
      });
    });

    req.setTimeout(30000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function api(method, body = {}) {
  return request(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return api("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function editMessage(chatId, messageId, text) {
  try {
    await api("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text
    });
  } catch {}
}

async function action(chatId, type = "typing") {
  try {
    await api("sendChatAction", {
      chat_id: chatId,
      action: type
    });
  } catch {}
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        fs.rm(destination, { force: true }, () => {});
        return reject(new Error(`Download HTTP ${res.statusCode}`));
      }

      const length = Number(res.headers["content-length"] || 0);
      if (length > MAX_FILE_SIZE) {
        req.destroy(new Error("File quá lớn"));
        return;
      }

      let total = 0;
      res.on("data", chunk => {
        total += chunk.length;
        if (total > MAX_FILE_SIZE) {
          req.destroy(new Error("File vượt giới hạn 45 MB"));
        }
      });

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });

    req.setTimeout(30000, () => req.destroy(new Error("Download timeout")));
    req.on("error", err => {
      file.destroy();
      fs.rm(destination, { force: true }, () => {});
      reject(err);
    });
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  if (binaryPromise) return binaryPromise;

  binaryPromise = (async () => {
    const temp = `${YTDLP_PATH}.download`;
    const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(temp);

      function get(target, redirects = 0) {
        if (redirects > 10) return reject(new Error("Quá nhiều redirect"));

        https.get(target, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (!res.headers.location) return reject(new Error("Thiếu redirect URL"));
            return get(new URL(res.headers.location, target).href, redirects + 1);
          }

          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Không tải được yt-dlp: ${res.statusCode}`));
          }

          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        }).on("error", reject);
      }

      file.on("error", reject);
      get(url);
    });

    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, YTDLP_PATH);
    return YTDLP_PATH;
  })();

  try {
    return await binaryPromise;
  } catch (error) {
    binaryPromise = null;
    throw error;
  }
}

function validateUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com",
      "tiktok.com",
      "m.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com"
    ].includes(host) || host.endsWith(".tiktok.com") || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  const command = parts.shift();
  const args = [];

  for (const part of parts) {
    if (part.startsWith("-")) {
      if (/^--?(exec|exec-before-download|output|paths|config-location|plugin-dirs|cookies|cookies-from-browser|proxy|external-downloader|external-downloader-args|postprocessor-args|alias|use-postprocessor|load-info-json|batch-file|netrc-location|ffmpeg-location|cache-dir|paths|download-archive|print|progress-template|parse-metadata|replace-in-metadata|embed-from-url|sponsorblock-mark|sponsorblock-remove|xattr-set-filesize|ppa|remux-video|recode-video|extract-audio|audio-format|audio-quality)$/i.test(part)) {
        throw new Error(`Không cho phép tuỳ chọn: ${part}`);
      }
      args.push(part);
    } else {
      args.push(part);
    }
  }

  return { command, args };
}

function runYtDlp(args, output, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Quá thời gian tải video"));
    }, MAX_DURATION);

    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };

    const child = spawn(YTDLP_PATH, args, {
      cwd: WORK_DIR,
      stdio: ["ignore", "ignore", "pipe"]
    });

    child.stderr.on("data", chunk => {
      const line = chunk.toString();
      stderr = (stderr + line).slice(-5000);

      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match) onProgress(Math.min(100, Math.floor(Number(match[1]))));
    });

    child.on("error", error => finish(error));
    child.on("close", code => {
      if (code === 0) finish(null, true);
      else finish(new Error(stderr.slice(-1200) || `yt-dlp exit ${code}`));
    });
  });
}

async function sendVideoFile(chatId, filePath, title, statusId) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error("Video lớn hơn giới hạn bot hỗ trợ (45 MB). Hãy chọn chất lượng thấp hơn.");
  }

  await editMessage(chatId, statusId, "Đang gửi video lên Telegram...");

  const boundary = `----BotBoundary${Date.now()}`;
  const fields = {
    chat_id: String(chatId),
    caption: String(title || "Video đã tải").slice(0, 900)
  };

  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    ));
  }

  const filename = path.basename(filePath).replace(/["\r\n]/g, "_");
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
  ));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);
  const result = await request(`${API}/sendVideo`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length
    },
    body
  });

  if (!result.ok) throw new Error(result.description || "Telegram không gửi được video");
}

async function processLink(chatId, url, cliArgs = []) {
  if (jobs.has(chatId)) {
    await sendMessage(chatId, "Bạn đang có một tác vụ tải. Vui lòng chờ tác vụ đó hoàn tất.");
    return;
  }

  if (!validateUrl(url)) {
    await sendMessage(chatId, "Link không hợp lệ hoặc chưa được hỗ trợ.");
    return;
  }

  jobs.add(chatId);
  const status = await sendMessage(chatId, "Đang khởi tạo yt-dlp...");
  const statusId = status.result?.message_id;
  const prefix = path.join(WORK_DIR, `video_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const output = `${prefix}.%(ext)s`;

  try {
    await action(chatId);
    await ensureYtDlp();
    await editMessage(chatId, statusId, "Đang phân tích video...");

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--no-progress",
      "-f", "best[ext=mp4]/best",
      "-o", output,
      ...cliArgs,
      url
    ];

    await runYtDlp(args, output, percent => {
      editMessage(chatId, statusId, `Đang tải video: ${percent}%`).catch(() => {});
    });

    const files = fs.readdirSync(WORK_DIR)
      .filter(name => name.startsWith(path.basename(prefix) + "."))
      .map(name => path.join(WORK_DIR, name))
      .filter(name => fs.statSync(name).isFile());

    if (!files.length) throw new Error("yt-dlp không tạo ra file video.");

    const file = files[0];
    await sendVideoFile(chatId, file, path.basename(file), statusId);
    await editMessage(chatId, statusId, "Tải và gửi video thành công.");
  } catch (error) {
    console.error("[yt-dlp]", error);
    await editMessage(
      chatId,
      statusId,
      `Tải thất bại:\n${String(error.message || error).slice(0, 1000)}`
    );
  } finally {
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (name.startsWith(path.basename(prefix) + ".")) {
        fs.rmSync(path.join(WORK_DIR, name), { force: true });
      }
    }
    jobs.delete(chatId);
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.chat || message.chat.type !== "private" || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    return sendMessage(chatId,
      "Bot tải video TikTok và YouTube bằng yt-dlp.\n\n" +
      "Cách dùng:\n" +
      "• Gửi link video để tải nhanh.\n" +
      "• /yt-dlp URL\n" +
      "• /yt-dlp -f best URL\n" +
      "• /yt-dlp --list-formats URL\n\n" +
      "Chỉ hoạt động trong chat riêng. Giới hạn video 45 MB và thời gian tải khoảng 4 phút.\n" +
      "Lưu ý: các tuỳ chọn CLI bị hạn chế để bảo vệ bot."
    );
  }

  if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
    return sendMessage(chatId,
      "Lệnh:\n/start — Hướng dẫn\n/help — Trợ giúp\n" +
      "/yt-dlp URL — Tải video\n/yt-dlp -f best URL — Chọn định dạng\n" +
      "/yt-dlp --list-formats URL — Liệt kê định dạng\n\n" +
      "Gửi link TikTok hoặc YouTube để tải nhanh."
    );
  }

  if (/^\/yt-dlp(?:@\w+)?(?:\s|$)/i.test(text)) {
    try {
      const input = text.replace(/^\/yt-dlp(?:@\w+)?\s*/i, "");
      const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const url = tokens.find(token => validateUrl(token.replace(/^"|"$/g, "")));

      if (!url) {
        return sendMessage(chatId, "Cách dùng:\n/yt-dlp URL\n/yt-dlp -f best URL");
      }

      const cleanUrl = url.replace(/^"|"$/g, "");
      const cliArgs = tokens
        .filter(token => token !== url)
        .map(token => token.replace(/^"|"$/g, ""));

      if (cliArgs.includes("--list-formats")) {
        const result = await sendMessage(chatId, "Đang lấy danh sách định dạng...");
        const bin = await ensureYtDlp();
        const child = spawn(bin, ["--no-playlist", "--list-formats", cleanUrl]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", d => stdout = (stdout + d.toString()).slice(-3500));
        child.stderr.on("data", d => stderr = (stderr + d.toString()).slice(-1500));
        child.on("close", async code => {
          await editMessage(chatId, result.result.message_id,
            code === 0 ? stdout.slice(-3500) || "Không có định dạng." : stderr.slice(-1500) || "Không lấy được định dạng."
          );
        });
        return;
      }

      return processLink(chatId, cleanUrl, cliArgs);
    } catch (error) {
      return sendMessage(chatId, `Lỗi lệnh: ${error.message}`);
    }
  }

  const url = text.match(/https?:\/\/\S+/i)?.[0]?.replace(/[),.!?]+$/, "");
  if (url && validateUrl(url)) return processLink(chatId, url);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram video bot is running.");
  }

  if (!TOKEN) return res.status(500).json({ ok: false, error: "Missing BOT_TOKEN" });

  if (WEBHOOK_SECRET &&
      req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }

  const update = req.body;
  res.status(200).json({ ok: true });

  waitUntil(
    Promise.resolve()
      .then(() => handleUpdate(update))
      .catch(error => console.error("[Update]", error))
  );
};
