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

    console.log(`[GetLog API] Đang nhận log từ tài khoản: [${player}]`);

    const chatId = process.env.TELEGRAM_CHAT_ID;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const sanitize = (text) =>
        String(text)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const safePlayer = sanitize(player);
    const lines = sanitize(logs).split(/\r?\n/);
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
