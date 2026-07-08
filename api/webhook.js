import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { message } = req.body;
    if (!message || !message.text) return res.status(200).send('OK');

    const chatId = message.chat.id;
    const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

    if (chatId !== allowedChatId) {
        return res.status(200).send('No Auth');
    }

    const text = message.text.trim();
    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // 1. THÊM LỆNH TÙY CHỈNH: /addcmd <tên_lệnh> <đoạn_code_lua>
    if (command === '/addcmd' && args.length >= 3) {
        const cmdName = args[1].toLowerCase();
        const cmdCode = args.slice(2).join(' ');
        
        await kv.hset('custom_commands', { [cmdName]: cmdCode });
        await sendTelegramMessage(chatId, `✅ Đã thêm lệnh tùy chỉnh: [${cmdName}]`);
        return res.status(200).send('OK');
    }

    // 2. XEM DANH SÁCH LỆNH: /listcmd
    if (command === '/listcmd') {
        const cmds = await kv.hgetall('custom_commands') || {};
        let msg = "📜 *Danh sách lệnh tùy chỉnh:*\n";
        let hasCmd = false;
        for (const [name, code] of Object.entries(cmds)) {
            msg += `• *${name}*: \`${code}\`\n`;
            hasCmd = true;
        }
        if (!hasCmd) msg += "Chưa có lệnh nào được lưu.";
        await sendTelegramMessage(chatId, msg);
        return res.status(200).send('OK');
    }

    // 3. XÓA LỆNH TÙY CHỈNH: /delcmd <tên_lệnh>
    if (command === '/delcmd' && args.length >= 2) {
        await kv.hdel('custom_commands', args[1].toLowerCase());
        await sendTelegramMessage(chatId, `🗑️ Đã xóa lệnh: [${args[1]}]`);
        return res.status(200).send('OK');
    }

    // 4. RA LỆNH ĐIỀU KHIỂN MULTI-ACC: <tên_acc hoặc all> <lệnh hoặc /run code>
    if (args.length >= 2) {
        const targetAcc = args[0];
        const action = args[1].toLowerCase();
        let luaCode = "";

        const customCmds = await kv.hgetall('custom_commands') || {};
        if (customCmds[action]) {
            luaCode = customCmds[action];
        } else if (text.includes(' /run ')) {
            luaCode = text.substring(text.indexOf(' /run ') + 6);
        }

        if (luaCode) {
            if (targetAcc.toLowerCase() === 'all') {
                await kv.set('global_script', { code: luaCode, timestamp: Date.now() });
                await sendTelegramMessage(chatId, `🚀 Đang gửi lệnh tới TẤT CẢ tài khoản...`);
            } else {
                await kv.set(`script:${targetAcc.toLowerCase()}`, { code: luaCode, timestamp: Date.now() });
                await sendTelegramMessage(chatId, `🎯 Đang gửi lệnh tới tài khoản: [${targetAcc}]`);
            }
            return res.status(200).send('OK');
        }
    }

    return res.status(200).send('OK');
}

async function sendTelegramMessage(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
    });
}
