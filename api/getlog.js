export default async function handler(req, res) {
    if (req.method !== 'POST') {
        console.warn(`[GetLog API] Method không hợp lệ: ${req.method}`);
        return res.status(405).send('Method Not Allowed');
    }

    const { player, logs } = req.body;

    if (!player || !logs) {
        console.log(`[GetLog API] Nhận request trống hoặc thiếu dữ liệu từ Roblox.`);
        return res.status(400).send('Bad Request');
    }

    console.log(`[GetLog API] Đang nhận log từ tài khoản: [${player}]`);

    const chatId = process.env.TELEGRAM_CHAT_ID;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    // Định dạng lại nội dung log để gửi qua Telegram
    let telegramMsg = `📜 *Console log từ tài khoản:* \`${player}\`\n\n`;
    telegramMsg += `\`\`\`text\n${logs}\n\`\`\``;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: chatId, 
                text: telegramMsg, 
                parse_mode: "Markdown" 
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[GetLog Telegram Error] Gửi log thất bại: ${errText}`);
            return res.status(500).send('Failed to send to Telegram');
        }

        console.log(`[GetLog API Success] Đã chuyển tiếp thành công log của [${player}] qua Telegram.`);
        return res.status(200).send('OK');
    } catch (error) {
        console.error(`[GetLog API Exception] Lỗi hệ thống:`, error);
        return res.status(500).send('Internal Server Error');
    }
}
