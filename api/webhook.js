import Redis from "ioredis";

const kv = new Redis(process.env.REDIS_URL);

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

    // ==========================================
    // LỆNH MỚI: XEM DANH SÁCH TÊN NGƯỜI CHƠI ĐANG KẾT NỐI
    // ==========================================
    if (command === '/players') {
        const keys = await kv.keys('player:*') || [];
        let msg = "🎮 *DANH SÁCH ACC ROBLOX ĐANG KẾT NỐI:*\n\n";
        let hasPlayers = false;
        const now = Date.now();

        for (const key of keys) {
            const lastPing = await kv.get(key);
            const playerName = key.replace('player:', '');
            const secondsAgo = Math.floor((now - Number(lastPing)) / 1000);
            
            // Quá 15 giây không lấy script coi như acc bị ngắt kết nối (Disconnnected)
            if (secondsAgo < 15) {
                msg += `🟢 *${playerName}* (Đang treo - cách đây ${secondsAgo}s)\n`;
            } else {
                msg += `🔴 *${playerName}* (Mất kết nối - cách đây ${secondsAgo}s)\n`;
            }
            hasPlayers = true;
        }

        if (!hasPlayers) msg += "⚠️ Hệ thống chưa ghi nhận tài khoản nào đang chạy.";
        await sendTelegramMessage(chatId, msg);
        return res.status(200).send('OK');
    }

    // ==========================================
    // LỆNH MỚI: CHẠY LỤA TRỰC TIẾP TỪ TELEGRAM (/run)
    // ==========================================
    if (command === '/run' && args.length >= 2) {
        let target = args[1].toLowerCase();
        let luaCode = "";

        const keys = await kv.keys('player:*') || [];
        const activePlayers = keys.map(k => k.replace('player:', '').toLowerCase());

        // Kiểm tra xem tham số tiếp theo là tên riêng của 1 acc đang online hay không
        if (activePlayers.includes(target)) {
            luaCode = args.slice(2).join(' ');
            if (!luaCode) {
                await sendTelegramMessage(chatId, "⚠️ Thiếu đoạn code Lua cần chạy.");
                return res.status(200).send('OK');
            }
            await kv.set(
                `script:${target}`,
                JSON.stringify({
                    code: luaCode,
                    timestamp: Date.now()
                })
            );
            await sendTelegramMessage(chatId, `🎯 Gửi code trực tiếp đến acc: [${target}]`);
        } else {
            // Nếu không phải tên acc, coi như chạy cho TẤT CẢ (All)
            luaCode = args.slice(1).join(' ');
            await kv.set(
                "global_script",
                JSON.stringify({
                    code: luaCode,
                    timestamp: Date.now()
                })
            );
            await sendTelegramMessage(chatId, `🚀 Gửi code trực tiếp đến TẤT CẢ tài khoản...`);
        }
        return res.status(200).send('OK');
    }

    // 1. THÊM LỆNH TÙY CHỈNH: /addcmd <tên_lệnh> <đoạn_code_lua>
    if (command === '/addcmd' && args.length >= 3) {
        const cmdName = args[1].toLowerCase();
        const cmdCode = args.slice(2).join(' ');
        
        await kv.hset("custom_commands", cmdName, cmdCode);
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
