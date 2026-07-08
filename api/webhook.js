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
    // LỆNH: XEM DANH SÁCH TÊN NGƯỜI CHƠI ĐANG KẾT NỐI
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
            
            // Quá 15 giây không lấy script coi như acc bị ngắt kết nối (Disconnected)
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
    // LỆNH MỚI: CHẠY LUA CHO TẤT CẢ (/runall)
    // Cú pháp: /runall <đoạn_code_lua>
    // ==========================================
    if (command === '/runall') {
        const luaCode = args.slice(1).join(' ');
        if (!luaCode) {
            await sendTelegramMessage(chatId, "⚠️ Thiếu đoạn code Lua cần chạy cho tất cả.");
            return res.status(200).send('OK');
        }

        await kv.set(
            "global_script",
            JSON.stringify({
                code: luaCode,
                timestamp: Date.now()
            })
        );
        await sendTelegramMessage(chatId, `🚀 Gửi code trực tiếp đến TẤT CẢ tài khoản...`);
        return res.status(200).send('OK');
    }

    // ==========================================
    // LỆNH MỚI: CHẠY LUA CHO 1 ACC CỤ THỂ (/run)
    // Cú pháp: /run <tên_acc> <đoạn_code_lua>
    // ==========================================
    if (command === '/run' && args.length >= 3) {
        const target = args[1].toLowerCase();
        const luaCode = args.slice(2).join(' ');

        await kv.set(
            `script:${target}`,
            JSON.stringify({
                code: luaCode,
                timestamp: Date.now()
            })
        );
        await sendTelegramMessage(chatId, `🎯 Gửi code trực tiếp đến acc: [${target}]`);
        return res.status(200).send('OK');
    }

    // ==========================================
    // LỆNH QUẢN LÝ CUSTOM COMMANDS
    // ==========================================
    
    // Thêm lệnh tùy chỉnh: /addcmd <tên_lệnh> <đoạn_code_lua>
    if (command === '/addcmd' && args.length >= 3) {
        const cmdName = args[1].toLowerCase();
        const cmdCode = args.slice(2).join(' ');
        
        await kv.hset("custom_commands", cmdName, cmdCode);
        await sendTelegramMessage(chatId, `✅ Đã thêm lệnh tùy chỉnh: [${cmdName}]`);
        return res.status(200).send('OK');
    }

    // Xem danh sách lệnh: /listcmd
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

    // Xóa lệnh tùy chỉnh: /delcmd <tên_lệnh>
    if (command === '/delcmd' && args.length >= 2) {
        await kv.hdel('custom_commands', args[1].toLowerCase());
        await sendTelegramMessage(chatId, `🗑️ Đã xóa lệnh: [${args[1]}]`);
        return res.status(200).send('OK');
    }

    // ==========================================
    // LỆNH ĐIỀU KHIỂN MULTI-ACC QUA /r
    // ==========================================
    if (command === '/r' && args.length >= 2) {
        const customCmds = await kv.hgetall('custom_commands') || {};

        // Trường hợp 1: /r <tên_lệnh> -> Gửi tới TẤT CẢ (All)
        if (args.length === 2) {
            const action = args[1].toLowerCase();
            const luaCode = customCmds[action];

            if (luaCode) {
                await kv.set(
                    "global_script",
                    JSON.stringify({
                        code: luaCode,
                        timestamp: Date.now()
                    })
                );
                await sendTelegramMessage(chatId, `🚀 Đang gửi lệnh [${action}] tới TẤT CẢ tài khoản...`);
            } else {
                await sendTelegramMessage(chatId, `⚠️ Không tìm thấy lệnh tùy chỉnh: [${action}]`);
            }
            return res.status(200).send('OK');
        }

        // Trường hợp 2: /r <tên_acc> <tên_lệnh> -> Gửi tới 1 tài khoản cụ thể
        if (args.length >= 3) {
            const targetAcc = args[1].toLowerCase();
            const action = args[2].toLowerCase();
            const luaCode = customCmds[action];

            if (luaCode) {
                await kv.set(
                    `script:${targetAcc}`,
                    JSON.stringify({
                        code: luaCode,
                        timestamp: Date.now()
                    })
                );
                await sendTelegramMessage(chatId, `🎯 Đang gửi lệnh [${action}] tới tài khoản: [${targetAcc}]`);
            } else {
                await sendTelegramMessage(chatId, `⚠️ Không tìm thấy lệnh tùy chỉnh: [${action}]`);
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
