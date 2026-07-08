export default async function handler(req, res) {
    // 1. IN LOG METHOD ĐỂ KIỂM TRA ĐƯỜNG TRUYỀN
    console.log("Method:", req.method);
    console.log("Headers:", JSON.stringify(req.headers));

    if (req.method !== 'POST') {
        console.log("❌ Lỗi: Yêu cầu không phải là POST");
        return res.status(405).send('Method Not Allowed');
    }

    // 2. IN LOG TOÀN BỘ NỘI DUNG TIN NHẮN TỪ TELEGRAM
    console.log("Body nhận được từ Telegram:", JSON.stringify(req.body, null, 2));

    const { message } = req.body;
    if (!message || !message.text) {
        console.log("⚠️ Cảnh báo: Không tìm thấy nội dung chữ (text) trong message");
        return res.status(200).send('OK');
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    
    console.log(`💬 Người dùng gửi: "${text}" | Chat ID: ${chatId}`);

    // XỬ LÝ LỆNH /START
    if (text.toLowerCase() === '/start') {
        console.log("🤖 Đang xử lý lệnh /start...");
        
        let welcomeMsg = process.env.START_MESSAGE || "🤖 Vercel đã nhận lệnh thành công!\n\nID Chat của bạn là: " + chatId;
        welcomeMsg = welcomeMsg.replace(/\\n/g, '\n');

        const token = process.env.TELEGRAM_BOT_TOKEN;
        
        try {
            console.log(`📤 Đang gọi API Telegram để phản hồi tới Chat ID: ${chatId}...`);
            const telegramRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: welcomeMsg, parse_mode: "Markdown" })
            });
            
            const telegramData = await telegramRes.json();
            console.log("Kết quả phản hồi từ API Telegram:", JSON.stringify(telegramData));
        } catch (fetchErr) {
            console.error("❌ Lỗi nghiêm trọng khi gửi tin nhắn ngược lại Telegram:", fetchErr);
        }
        
        return res.status(200).send('OK');
    }

    // CHUYỂN TIẾP SANG WEBHOOK NẾU KHÔNG PHẢI /START
    try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['host'];
        const webhookUrl = `${protocol}://${host}/api/webhook`;
        
        console.log(`🔀 Đang chuyển tiếp lệnh sang: ${webhookUrl}`);
        
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
    } catch (err) {
        console.error("❌ Lỗi khi chuyển tiếp sang webhook.js:", err);
    }

    return res.status(200).send('OK');
}
