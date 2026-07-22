import Redis from "ioredis";

const kv = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
    if (req.method !== "POST") {
        console.warn(`[GetLog API] Method không hợp lệ: ${req.method}`);
        return res.status(405).send("Method Not Allowed");
    }

    const { player, logs } = req.body;

    if (!player || logs == null) {
        console.log("[GetLog API] Nhận request trống hoặc thiếu dữ liệu từ Roblox.");
        return res.status(400).send("Bad Request");
    }

    // ==========================================
    // 1. XÁC THỰC TOKEN
    // ==========================================
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

    if (!token) {
        console.warn(`[GetLog API] Từ chối: Thiếu Authorization Token`);
        return res.status(401).send("Unauthorized");
    }

    // Kiểm tra Temp Token (hết hạn sau 10p từ Redis)
    const isTempTokenValid = await kv.get(`temp_token:${token}`);
    if (!isTempTokenValid) {
        console.warn(`[GetLog API] Từ chối: Token không hợp lệ hoặc đã hết hạn`);
        return res.status(403).send("Forbidden");
    }

    // ==========================================
    // 2. CHẶN NGƯỜI CHƠI KHÔNG CÓ TRONG DANH SÁCH (REDIS)
    // ==========================================
    // Kiểm tra Redis xem key player:<tên_acc> có tồn tại không
    const playerKey = `player:${player.toLowerCase()}`;
    const isPlayerInList = await kv.exists(playerKey);

    if (!isPlayerInList) {
        console.warn(`[GetLog API] Từ chối: Player [${player}] không có trong danh sách Redis (${playerKey}).`);
        return res.status(403).send("Player Not In List");
    }

    console.log(`[GetLog API] Đang nhận log từ tài khoản hợp lệ: [${player}]`);

    // ==========================================
    // 3. XỬ LÝ VÀ GỬI LOG VỀ TELEGRAM
    // ==========================================
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const sanitize = (text) =>
        String(text)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const safePlayer = sanitize(player);
    let formattedLogs = sanitize(logs)
        .replace(/\[MessageOutput\]/g, "⚪️")
        .replace(/\[MessageWarning\]/g, "🟠")
        .replace(/\[MessageError\]/g, "🔴");

    const lines = formattedLogs.split(/\r?\n/);
    const maxLines = 200;

    let safeLogs = lines.slice(-maxLines).join("\n");

    if (safeLogs.length > 3500) {
        safeLogs = "...\n" + safeLogs.slice(-3496);
    }

    if (lines.length > maxLines) {
        safeLogs = `... (${lines.length - maxLines} dòng đã bị cắt)\n\n${safeLogs}`;
    }

    const telegramMsg = `
📜 <b>Console log từ tài khoản:</b> <code>${safePlayer}</code>

<pre>${safeLogs}</pre>
`.trim();

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: telegramMsg,
                parse_mode: "HTML",
                disable_web_page_preview: true
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[GetLog Telegram Error] Gửi log thất bại: ${errText}`);
            return res.status(500).send("Failed to send to Telegram");
        }

        console.log(`[GetLog API Success] Đã chuyển tiếp thành công log của [${player}] qua Telegram.`);
        return res.status(200).send("OK");
    } catch (error) {
        console.error("[GetLog API Exception]", error);
        return res.status(500).send("Internal Server Error");
    }
}
