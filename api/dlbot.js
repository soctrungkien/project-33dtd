const { waitUntil } = require("@vercel/functions");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.BOT_TOKEN_VIDEO;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_BYTES = 49 * 1024 * 1024;
const JOB_BUDGET_MS = 3 * 60 * 1000;
const BIN_CACHE = "/tmp/bin-cache";
const YTDLP_PATH = path.join(BIN_CACHE, "yt-dlp");
let binaryPromise = null;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const CMD_RE = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/;

let ffmpegSrc = null;
try { ffmpegSrc = require("ffmpeg-static"); } catch {}

/* ------------------------------ Helpers ------------------------------ */

function prepareBin(src, name) {
  fs.mkdirSync(BIN_CACHE, { recursive: true });

  const dst = path.join(BIN_CACHE, name);

  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
    return dst;
  }

  const tmp = `${dst}.${process.pid}.${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dst);

  return dst;
}

async function getYtdlpPath() {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      await fs.promises.mkdir(BIN_CACHE, { recursive: true });

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

      const tmp = `${YTDLP_PATH}.${process.pid}.${Date.now()}`;
      await fs.promises.writeFile(tmp, buffer, { mode: 0o755 });
      await fs.promises.chmod(tmp, 0o755);
      await fs.promises.rename(tmp, YTDLP_PATH);

      return YTDLP_PATH;
    })().catch((error) => {
      binaryPromise = null;
      throw error;
    });
  }

  return binaryPromise;
}

function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function toBlob(p) {
  return fs.openAsBlob ? await fs.openAsBlob(p) : new Blob([fs.readFileSync(p)]);
}

async function tg(method, params = {}, files = {}, signal) {
  let body, headers;
  if (Object.keys(files).length) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    for (const [k, f] of Object.entries(files)) body.append(k, await toBlob(f.path), f.name);
  } else {
    body = JSON.stringify(params);
    headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(`${API}/${method}`, { method: "POST", headers, body, signal });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

// Giữ trạng thái native của Telegram (lặp lại mỗi 4 giây vì telegram tự tắt sau 5s)
function keepAction(chat_id, first = "typing") {
  let action = first;
  const send = () => tg("sendChatAction", { chat_id, action }).catch(() => {});
  send();
  const timer = setInterval(send, 4000);
  return {
    set(a) { action = a; send(); },
    stop() { clearInterval(timer); },
  };
}

let cachedUsername = process.env.BOT_USERNAME || null;
async function getBotUsername() {
  if (!cachedUsername) cachedUsername = (await tg("getMe")).username;
  return cachedUsername;
}

function extractUrl(s) {
  const m = (s || "").match(URL_RE);
  return m ? m[0].replace(/[)\].,;!?]+$/, "") : null;
}

function run(bin, args, signal, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        signal,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, HOME: "/tmp", XDG_CACHE_HOME: "/tmp/.cache" },
      },
      (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; return reject(err); }
        resolve({ stdout, stderr });
      }
    );
  });
}

function shortError(e) {
  const lines = String(e.stderr || e.message || "").split("\n").filter((l) => /ERROR/i.test(l));
  const msg = (lines.pop() || e.message || "Lỗi không xác định").replace(/^ERROR:\s*/i, "");
  return msg.slice(0, 300);
}

const safeName = (s) => (s || "file").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 100) || "file";

/* ------------------------------ Tải media ------------------------------ */

async function download({ url, mode, dir, deadline, signal }) {
  const ytdlp = await withSignal(getYtdlpPath(), signal);
  const ffmpeg = ffmpegSrc ? prepareBin(ffmpegSrc, "ffmpeg") : null;

  const base = [
    "--no-playlist", "--no-warnings", "--no-progress", "--no-mtime", "--restrict-filenames",
    "--socket-timeout", "20", "--retries", "3",
    "--cache-dir", "/tmp/.cache/yt-dlp",
    "--js-runtimes", `node:${process.execPath}`,
    "--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg",
    "-o", path.join(dir, "%(id)s.%(ext)s"),
  ];
  if (ffmpeg) base.push("--ffmpeg-location", ffmpeg);

  if (process.env.YT_COOKIES) {
    const cf = path.join(dir, "cookies.txt");
    fs.writeFileSync(cf, process.env.YT_COOKIES.replace(/\\n/g, "\n"));
    base.push("--cookies", cf);
  }

  const clean = () => {
    for (const f of fs.readdirSync(dir)) if (f !== "cookies.txt") fs.rmSync(path.join(dir, f), { force: true });
  };
  const caps = mode === "music" ? [null] : [720, 480, 360, 240];

  for (const cap of caps) {
    const remaining = deadline - Date.now();
    if (remaining < 10000) throw new Error("Hết thời gian xử lý (video quá dài/nặng)");
    clean();

    const args =
      mode === "music"
        ? ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "128K", "--embed-metadata", "--max-filesize", "80M"]
        : [
            "-f", `bv*[height<=${cap}]+ba/b[height<=${cap}]/b`,
            "-S", "vcodec:h264,res,acodec:m4a",
            "--merge-output-format", "mp4",
            "--max-filesize", "49M",
          ];

    await run(ytdlp, [...base, ...args, url], signal);

    const files = fs.readdirSync(dir);
    const mediaRe = mode === "music" ? /\.mp3$/i : /\.(mp4|mkv|webm|mov|m4v)$/i;
    const media = files.find((f) => mediaRe.test(f));
    if (!media) continue;
    const mediaPath = path.join(dir, media);
    if (fs.statSync(mediaPath).size > MAX_BYTES) continue;

    const infoFile = files.find((f) => f.endsWith(".info.json"));
    const info = infoFile ? JSON.parse(fs.readFileSync(path.join(dir, infoFile), "utf8")) : {};
    let thumb = files.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    thumb = thumb ? path.join(dir, thumb) : null;

    if (thumb && ffmpeg) {
      const out = path.join(dir, "thumb_small.jpg");
      try {
        await run(ffmpeg, ["-y", "-i", thumb, "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-q:v", "6", out], signal, 20000);
        thumb = out;
      } catch { thumb = null; }
    }
    return { mediaPath, info, thumb };
  }
  throw new Error("File vượt quá 50MB ngay cả ở chất lượng thấp nhất (giới hạn của Telegram Bot API)");
}

/* ------------------------------ Xử lý job ------------------------------ */

async function processJob({ chatId, messageId, url, mode }) {
  const deadline = Date.now() + JOB_BUDGET_MS;
  const reply_parameters = { message_id: messageId, allow_sending_without_reply: true };
  const dir = fs.mkdtempSync("/tmp/job-");
  const isMusic = mode === "music";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JOB_BUDGET_MS);
  const signal = ac.signal;

  // Bật trạng thái native "Đang nhập/gõ..." khi bắt đầu xử lý
  const action = keepAction(chatId, "typing");

  try {
    // Chuyển sang trạng thái native "Đang tải video/audio"
    action.set(isMusic ? "upload_voice" : "upload_video");

    const { mediaPath, info, thumb } = await download({ url, mode, dir, deadline, signal });

    // Khi tải xong, chuyển sang trạng thái native "Đang gửi video/audio"
    action.set(isMusic ? "upload_voice" : "upload_video");

    const title = isMusic
      ? info.title || info.fulltitle || info.track || "Audio"
      : info.title || info.fulltitle || info.track || "Video";
    const link = info.webpage_url || url;
    const duration = info.duration ? Math.round(info.duration) : undefined;
    const thumbFile = thumb ? { thumbnail: { path: thumb, name: "thumb.jpg" } } : {};

    if (isMusic) {
      await tg(
        "sendAudio",
        {
          chat_id: chatId,
          title: title.slice(0, 200),
          performer: (info.artist || info.creator || info.uploader || info.channel || "").slice(0, 200) || undefined,
          duration,
          reply_parameters,
        },
        { audio: { path: mediaPath, name: `${safeName(title)}.mp3` }, ...thumbFile },
        signal
      );
    } else {
      const common = {
        chat_id: chatId,
        caption: title.slice(0, 1024),
        reply_markup: { inline_keyboard: [[{ text: "Link video", url: link }]] },
        reply_parameters,
      };
      const file = { path: mediaPath, name: `${safeName(title)}.mp4` };
      try {
        await tg(
          "sendVideo",
          {
            ...common,
            duration,
            width: info.width || info.requested_downloads?.[0]?.width,
            height: info.height || info.requested_downloads?.[0]?.height,
            supports_streaming: true,
          },
          { video: file, ...thumbFile },
          signal
        );
      } catch (e) {
        console.error("sendVideo failed, fallback sendDocument:", e.message);
        if (signal.aborted) throw e;
        await tg("sendDocument", common, { document: file, ...thumbFile }, signal);
      }
    }
  } catch (e) {
    console.error("job error:", e.message, e.stderr || "");
    // Nếu lỗi xảy ra, gửi một tin nhắn báo lỗi gọn gàng cho người dùng biết
    const errText = signal.aborted ? "Quá 3 phút nên đã huỷ tác vụ." : `Không tải được.\n${shortError(e)}`;
    await tg("sendMessage", { chat_id: chatId, text: errText, reply_parameters }).catch(() => {});
  } finally {
    clearTimeout(timer);
    action.stop(); // Tắt trạng thái native ngay khi hoàn thành hoặc lỗi
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------ Điều phối ------------------------------ */

const HELP = [
  "Xin chào, tôi là bot tải video",
  "",
  "Gửi thẳng link video (chỉ chat riêng) -> bot gửi lại video",
  "/dl <link> -> tải video",
  "/music <link> -> tải âm thanh dạng MP3",
  "/start -> xem hướng dẫn này",
].join("\n");

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  let cmd = null;
  let args = text;

  if (text.startsWith("/")) {
    const m = text.match(CMD_RE);
    if (!m) return;
    if (m[2] && m[2].toLowerCase() !== (await getBotUsername()).toLowerCase()) return;
    cmd = m[1].toLowerCase();
    args = m[3] || "";
  } else if (!isPrivate) {
    return;
  }

  if (cmd === "start" || cmd === "help") {
    await tg("sendMessage", { chat_id: chatId, text: HELP });
    return;
  }
  if (cmd && cmd !== "dl" && cmd !== "music") return;

  const url = extractUrl(args) || extractUrl(msg.reply_to_message?.text || msg.reply_to_message?.caption);
  if (!url) {
    if (cmd) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Thiếu link. Ví dụ: /${cmd} https://...`,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
    }
    return;
  }

  await processJob({
    chatId,
    messageId: msg.message_id,
    url,
    mode: cmd === "music" ? "music" : "video",
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");
  waitUntil(handleUpdate(req.body).catch((e) => console.error("handleUpdate:", e)));
  res.status(200).json({ ok: true });
};
