const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { waitUntil } = require("@vercel/functions");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_FILE_SIZE = 45 * 1024 * 1024;
const MAX_DURATION = 240000;
const WORK_DIR = os.tmpdir();
const YTDLP_PATH = path.join(WORK_DIR, "yt-dlp-linux");

let binaryPromise;
let botUsernamePromise;
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
          return reject(
            new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`)
          );
        }

        resolve(data);
      });
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);

    if (options.body) req.write(options.body);
    req.end();
  });
}

function api(method, body = {}) {
  return request(`${API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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
  if (!messageId) return;

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

async function getBotUsername() {
  if (!botUsernamePromise) {
    botUsernamePromise = api("getMe").then(result => {
      if (!result.ok || !result.result?.username) {
        throw new Error("Không lấy được username bot");
      }

      return result.result.username.toLowerCase();
    }).catch(error => {
      botUsernamePromise = null;
      throw error;
    });
  }

  return botUsernamePromise;
}

async function isOwnCommand(text, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp("^/" + escaped + "(?:@([a-zA-Z0-9_]+))?(?=\\s|$)", "i")
  );

  if (!match) return false;
  if (!match[1]) return true;

  try {
    return (await getBotUsername()) === match[1].toLowerCase();
  } catch (error) {
    console.error("[getMe]", error);
    return false;
  }
}

function validateUrl(value) {
  try {
    const url = new URL(value);

    if (!["https:", "http:"].includes(url.protocol)) {
      return false;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    return [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com",
      "youtube-nocookie.com",
      "tiktok.com",
      "m.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com"
    ].includes(host) ||
      host.endsWith(".tiktok.com") ||
      host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  if (!match) return null;

  const url = match[0].replace(/[),.!?]+$/, "");
  return validateUrl(url) ? url : null;
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  if (binaryPromise) return binaryPromise;

  binaryPromise = (async () => {
    const temp = `${YTDLP_PATH}.download`;
    const url =
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(temp);
      let settled = false;

      const fail = error => {
        if (settled) return;
        settled = true;
        file.destroy();
        fs.rm(temp, { force: true }, () => {});
        reject(error);
      };

      file.on("error", fail);

      function get(target, redirects = 0) {
        if (redirects > 10) {
          return fail(new Error("Quá nhiều redirect khi tải yt-dlp"));
        }

        const req = https.get(target, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();

            if (!res.headers.location) {
              return fail(new Error("Thiếu redirect URL"));
            }

            return get(
              new URL(res.headers.location, target).href,
              redirects + 1
            );
          }

          if (res.statusCode !== 200) {
            res.resume();
            return fail(
              new Error(`Không tải được yt-dlp: HTTP ${res.statusCode}`)
            );
          }

          res.pipe(file);

          file.on("finish", () => {
            file.close(error => {
              if (error) return fail(error);
              if (settled) return;

              settled = true;

              try {
                fs.chmodSync(temp, 0o755);
                fs.renameSync(temp, YTDLP_PATH);
                resolve();
              } catch (err) {
                fs.rm(temp, { force: true }, () => {});
                reject(err);
              }
            });
          });
        });

        req.setTimeout(30000, () => {
          req.destroy(new Error("Timeout khi tải yt-dlp"));
        });

        req.on("error", fail);
      }

      get(url);
    });

    return YTDLP_PATH;
  })();

  try {
    return await binaryPromise;
  } catch (error) {
    binaryPromise = null;
    throw error;
  }
}

function parseCommandArguments(input) {
  const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];

  return tokens.map(token => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }

    return token;
  });
}

function validateCliArgs(args) {
  const blocked = new Set([
    "--exec",
    "--exec-before-download",
    "--config-location",
    "--plugin-dirs",
    "--cookies",
    "--cookies-from-browser",
    "--proxy",
    "--external-downloader",
    "--external-downloader-args",
    "--postprocessor-args",
    "--alias",
    "--use-postprocessor",
    "--load-info-json",
    "--batch-file",
    "--netrc-location",
    "--ffmpeg-location",
    "--cache-dir",
    "--download-archive",
    "--print",
    "--progress-template",
    "--parse-metadata",
    "--replace-in-metadata",
    "--embed-from-url",
    "--ppa",
    "--remux-video",
    "--recode-video",
    "--extract-audio",
    "--audio-format",
    "--audio-quality",
    "--paths",
    "-o",
    "-P"
  ]);

  for (const arg of args) {
    const name = arg.split("=")[0];

    if (blocked.has(name)) {
      throw new Error(`Tuỳ chọn CLI không được hỗ trợ: ${name}`);
    }

    if (
      !arg.startsWith("-") &&
      !/^\d+(?:\.\d+)?$/.test(arg)
    ) {
      throw new Error(`Tham số không hợp lệ: ${arg}`);
    }
  }
}

function runYtDlp(args, onProgress, timeout = MAX_DURATION) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stderr = "";
    let stdout = "";

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      if (child) child.kill("SIGKILL");
      finish(new Error("Đã vượt quá thời gian xử lý"));
    }, timeout);

    try {
      child = spawn(YTDLP_PATH, args, {
        cwd: WORK_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: WORK_DIR,
          LANG: "C.UTF-8"
        }
      });
    } catch (error) {
      return finish(error);
    }

    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk.toString()).slice(-12000);
    });

    child.stderr.on("data", chunk => {
      const line = chunk.toString();
      stderr = (stderr + line).slice(-5000);

      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        onProgress(Math.min(100, Math.floor(Number(match[1]))));
      }
    });

    child.on("error", error => finish(error));

    child.on("close", code => {
      if (code === 0) {
        finish(null, {
          stdout,
          stderr
        });
      } else {
        finish(
          new Error(
            stderr.slice(-1500) || `yt-dlp kết thúc với mã ${code}`
          )
        );
      }
    });
  });
}

async function getVideoInfo(url) {
  await ensureYtDlp();

  const result = await runYtDlp([
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "--print",
    "%(title).200B",
    url
  ], () => {}, 45000);

  return result.stdout.trim().split("\n")[0] || "Video đã tải";
}

async function listFormats(chatId, url) {
  const status = await sendMessage(chatId, "Đang lấy danh sách định dạng...");
  const messageId = status.result?.message_id;

  try {
    await ensureYtDlp();

    const result = await runYtDlp([
      "--no-playlist",
      "--no-warnings",
      "--list-formats",
      url
    ], () => {}, 45000);

    const output = (result.stdout || result.stderr).slice(-3500);

    await editMessage(
      chatId,
      messageId,
      output || "Không tìm thấy định dạng."
    );
  } catch (error) {
    await editMessage(
      chatId,
      messageId,
      `Không lấy được định dạng:\n${String(error.message).slice(0, 1000)}`
    );
  }
}

async function sendVideoFile(chatId, filePath, title, statusId) {
  const stat = fs.statSync(filePath);

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      "Video lớn hơn giới hạn 45 MB. Hãy chọn định dạng nhỏ hơn."
    );
  }

  await editMessage(chatId, statusId, "Đang gửi video lên Telegram...");
  await action(chatId, "upload_video");

  const boundary = `----TelegramBoundary${Date.now()}`;
  const filename = path.basename(filePath).replace(/["\r\n]/g, "_");

  const fields = {
    chat_id: String(chatId),
    caption: String(title || "Video đã tải").slice(0, 900)
  };

  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  chunks.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="video"; filename="${filename}"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`
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

  if (!result.ok) {
    throw new Error(result.description || "Telegram không gửi được video");
  }
}

async function processLink(chatId, url, cliArgs = []) {
  if (jobs.has(chatId)) {
    return sendMessage(
      chatId,
      "Bạn đang có một tác vụ tải. Vui lòng chờ tác vụ đó hoàn tất."
    );
  }

  if (!validateUrl(url)) {
    return sendMessage(chatId, "Link TikTok hoặc YouTube không hợp lệ.");
  }

  try {
    validateCliArgs(cliArgs);
  } catch (error) {
    return sendMessage(chatId, error.message);
  }

  jobs.add(chatId);

  let statusId;
  let prefix;
  let output;

  try {
    const status = await sendMessage(chatId, "Đang khởi tạo yt-dlp...");
    statusId = status.result?.message_id;

    prefix = path.join(
      WORK_DIR,
      `video_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );

    output = `${prefix}.%(ext)s`;

    await action(chatId);
    await ensureYtDlp();

    await editMessage(chatId, statusId, "Đang phân tích video...");
    const title = await getVideoInfo(url);

    await editMessage(chatId, statusId, "Đang tải video: 0%");

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "-f",
      "best[ext=mp4]/best",
      "-o",
      output,
      ...cliArgs,
      url
    ];

    await runYtDlp(args, percent => {
      editMessage(
        chatId,
        statusId,
        `Đang tải video: ${percent}%`
      ).catch(() => {});
    });

    const files = fs.readdirSync(WORK_DIR)
      .filter(name => name.startsWith(path.basename(prefix) + "."))
      .map(name => path.join(WORK_DIR, name))
      .filter(file => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      });

    if (!files.length) {
      throw new Error("yt-dlp không tạo ra file video.");
    }

    const file = files[0];

    await sendVideoFile(chatId, file, title, statusId);
    await editMessage(chatId, statusId, "Tải và gửi video thành công.");
  } catch (error) {
    console.error("[yt-dlp]", error);

    await editMessage(
      chatId,
      statusId,
      `Tải thất bại:\n${String(error.message || error).slice(0, 1200)}`
    );
  } finally {
    if (prefix) {
      for (const name of fs.readdirSync(WORK_DIR)) {
        if (name.startsWith(path.basename(prefix) + ".")) {
          fs.rmSync(path.join(WORK_DIR, name), { force: true });
        }
      }
    }

    jobs.delete(chatId);
  }
}

async function handleCommand(message, command) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!(await isOwnCommand(text, command))) return false;

  if (command === "start") {
    await sendMessage(
      chatId,
      "Bot tải video TikTok và YouTube bằng yt-dlp.\n\n" +
      "Cách sử dụng:\n" +
      "• Gửi link video trong chat riêng để tải nhanh.\n" +
      "• /yt-dlp URL\n" +
      "• /yt-dlp -f best URL\n" +
      "• /yt-dlp --list-formats URL\n" +
      "• /help — Trợ giúp\n\n" +
      "Lệnh có thể nhận trong nhóm, nhưng tải video chỉ hoạt động trong chat riêng."
    );

    return true;
  }

  if (command === "help") {
    await sendMessage(
      chatId,
      "Lệnh bot:\n" +
      "/start — Bắt đầu\n" +
      "/help — Trợ giúp\n" +
      "/yt-dlp URL — Tải video\n" +
      "/yt-dlp -f best URL — Chọn định dạng\n" +
      "/yt-dlp --list-formats URL — Danh sách định dạng\n\n" +
      "Gửi link trực tiếp trong chat riêng để tải nhanh."
    );

    return true;
  }

  if (command === "yt-dlp") {
    if (message.chat.type !== "private") {
      await sendMessage(chatId, "Vui lòng dùng lệnh tải video trong chat riêng với bot.");
      return true;
    }

    const input = text.replace(/^\/yt-dlp(?:@[a-zA-Z0-9_]+)?\s*/i, "");
    const tokens = parseCommandArguments(input);
    const url = tokens.find(token => validateUrl(token));

    if (!url) {
      await sendMessage(
        chatId,
        "Cách dùng:\n" +
        "/yt-dlp URL\n" +
        "/yt-dlp -f best URL\n" +
        "/yt-dlp --list-formats URL"
      );

      return true;
    }

    const cliArgs = tokens.filter(token => token !== url);

    if (cliArgs.includes("--list-formats")) {
      await listFormats(chatId, url);
      return true;
    }

    await processLink(chatId, url, cliArgs);
    return true;
  }

  return false;
}

async function handleUpdate(update) {
  const message = update.message;

  if (!message?.chat || !message.text) return;

  const text = message.text.trim();
  const chatId = message.chat.id;
  const isCommand = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(text);

  if (isCommand) {
    const command = text.match(/^\/([a-zA-Z0-9_]+)/)[1].toLowerCase();

    if (["start", "help", "yt-dlp"].includes(command)) {
      await handleCommand(message, command);
    }

    return;
  }

  if (message.chat.type !== "private") return;

  const url = extractUrl(text);

  if (url) {
    await processLink(chatId, url);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Telegram video bot is running.");
  }

  if (!TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing BOT_TOKEN"
    });
  }

  const update = req.body;

  res.status(200).json({ ok: true });

  waitUntil(
    Promise.resolve()
      .then(() => handleUpdate(update))
      .catch(error => console.error("[Update]", error))
  );
};
                                           
