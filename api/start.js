export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const chatId = message.chat.id;
    const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

    

    const text = message.text.trim();

    // NẾU LÀ LỆNH /START -> LẤY TIN NHẮN TỪ ENV VÀ GỬI ĐI
    if (text.toLowerCase() === '/start') {
        // Lấy tin nhắn từ biến môi trường, nếu trống thì dùng tin nhắn mặc định
        let welcomeMsg = process.env.START_MESSAGE || "🤖 Hệ thống đang hoạt động. Vui lòng cấu hình START_MESSAGE trong Env Vercel.";
        
        // Xử lý các ký tự xuống dòng \n nếu có trong chuỗi Env
        welcomeMsg = welcomeMsg.replace(/\\n/g, '\n');

        const token = process.env.TELEGRAM_BOT_TOKEN;
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: welcomeMsg, parse_mode: "Markdown" })
        });
        
        return res.status(200).send('OK');
    }

    // NẾU KHÔNG PHẢI /START -> CHUYỂN TIẾP SANG FILE WEBHOOK CHÍNH
    try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['host'];
        
        await fetch(`${protocol}://${host}/api/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
    } catch (err) {
        console.error("Lỗi chuyển tiếp lệnh:", err);
    }

    return res.status(200).send('OK');
}
