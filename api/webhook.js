import Redis from "ioredis";

const kv = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        console.warn(`[Warning] Nhận request với method không hợp lệ: ${req.method}`);
        return res.status(405).send('Method Not Allowed');
    }

    const { message } = req.body;
    if (!message || !message.text) {
        console.log(`[Info] Nhận webhook trống hoặc không chứa text (có thể là event update khác của Telegram).`);
        return res.status(200).send('OK');
    }

    const chatId = message.chat.id;
    const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

    console.log(`[Incoming] Tin nhắn từ ChatID: ${chatId} | Nội dung: "${message.text}"`);

    if (chatId !== allowedChatId) {
        console.error(`[Auth Failed] ChatID ${chatId} không khớp với TELEGRAM_CHAT_ID (${allowedChatId}). Từ chối xử lý.`);
        return res.status(200).send('No Auth');
    }

    const text = message.text.trim();
    const args = text.split(' ');
    const command = args[0].toLowerCase();

    // ==========================================
    // LỆNH: XEM DANH SÁCH TÊN NGƯỜI CHƠI ĐANG KẾT NỐI
    // ==========================================
    if (command === '/players') {
        console.log(`[Command] Thực thi lệnh /players`);
        try {
            const keys = await kv.keys('player:*') || [];
            console.log(`[Redis] Tìm thấy ${keys.length} keys player trong database.`);
            
            let msg = "🎮 *Danh sách acc:*\n\n";
            let hasPlayers = false;
            const now = Date.now();

            for (const key of keys) {
                const lastPing = await kv.get(key);
                const playerName = key.replace('player:', '');
                const secondsAgo = Math.floor((now - Number(lastPing)) / 1000);
                
                // Quá 15 giây không lấy script coi như acc bị ngắt kết nối (Disconnected)
                if (secondsAgo < 60) {
                    msg += `🟢 *${playerName}* (Trực tuyến - ${secondsAgo}s)\n`;
                } else {
                    msg += `🔴 *${playerName}* (Mất kết nối - ${secondsAgo}s)\n`;
                }
                hasPlayers = true;
            }

            if (!hasPlayers) {
                msg += "⚠️ Hệ thống chưa ghi nhận tài khoản nào đang chạy.";
                console.log(`[Status] Không có player nào trong hệ thống.`);
            }
            
            await sendTelegramMessage(chatId, msg);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi xử lý lệnh /players:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // ==========================================
    // LỆNH MỚI: CHẠY LUA CHO TẤT CẢ (/runall)
    // Cú pháp: /runall <đoạn_code_lua>
    // ==========================================
    if (command === '/runall') {
        console.log(`[Command] Thực thi lệnh /runall`);
        const luaCode = args.slice(1).join(' ');
        if (!luaCode) {
            console.log(`[Validation] Lệnh /runall thất bại do thiếu code Lua.`);
            await sendTelegramMessage(chatId, "⚠️ Thiếu đoạn code Lua cần chạy cho tất cả.");
            return res.status(200).send('OK');
        }

        try {
            const payload = JSON.stringify({ code: luaCode, timestamp: Date.now() });
            await kv.set("global_script", payload);
            console.log(`[Redis] Đã set global_script thành công.`);
            
            await sendTelegramMessage(chatId, `🚀 Gửi code trực tiếp đến TẤT CẢ tài khoản...`);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi lưu global_script trong lệnh /runall:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // ==========================================
    // LỆNH MỚI: CHẠY LUA CHO 1 ACC CỤ THỂ (/run)
    // Cú pháp: /run <tên_acc> <đoạn_code_lua>
    // ==========================================
    if (command === '/run') {
        console.log(`[Command] Thực thi lệnh /run`);
        if (args.length < 3) {
            console.log(`[Validation] Lệnh /run sai cú pháp hoặc thiếu tham số.`);
            await sendTelegramMessage(chatId, "⚠️ Cú pháp đúng: /run <tên_acc> <đoạn_code_lua>");
            return res.status(200).send('OK');
        }

        const target = args[1].toLowerCase();
        const luaCode = args.slice(2).join(' ');

        try {
            const payload = JSON.stringify({ code: luaCode, timestamp: Date.now() });
            await kv.set(`script:${target}`, payload);
            console.log(`[Redis] Đã set script riêng cho acc [${target}] thành công.`);

            await sendTelegramMessage(chatId, `🎯 Gửi code trực tiếp đến acc: [${target}]`);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi lưu script cho acc [${target}] trong lệnh /run:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // ==========================================
    // LỆNH QUẢN LÝ CUSTOM COMMANDS
    // ==========================================
    
    // Thêm lệnh tùy chỉnh: /addcmd <tên_lệnh> <đoạn_code_lua>
    if (command === '/addcmd') {
        console.log(`[Command] Thực thi lệnh /addcmd`);
        if (args.length < 3) {
            console.log(`[Validation] Lệnh /addcmd thiếu tham số.`);
            await sendTelegramMessage(chatId, "⚠️ Cú pháp đúng: /addcmd <tên_lệnh> <đoạn_code_lua>");
            return res.status(200).send('OK');
        }

        const cmdName = args[1].toLowerCase();
        const cmdCode = args.slice(2).join(' ');
        
        try {
            await kv.hset("custom_commands", cmdName, cmdCode);
            console.log(`[Redis] Đã thêm/cập nhật custom command: [${cmdName}]`);
            
            await sendTelegramMessage(chatId, `✅ Đã thêm lệnh tùy chỉnh: [${cmdName}]`);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi thêm custom command [${cmdName}]:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // Xem danh sách lệnh: /listcmd
    if (command === '/listcmd') {
        console.log(`[Command] Thực thi lệnh /listcmd`);
        try {
            const cmds = await kv.hgetall('custom_commands') || {};
            console.log(`[Redis] Lấy thành công hash custom_commands. Có ${Object.keys(cmds).length} lệnh.`);
            
            let msg = "📜 *Danh sách lệnh tùy chỉnh:*\n";
            let hasCmd = false;
            for (const [name, code] of Object.entries(cmds)) {
                msg += `• *${name}*: \`${code}\`\n`;
                hasCmd = true;
            }
            if (!hasCmd) msg += "Chưa có lệnh nào được lưu.";
            
            await sendTelegramMessage(chatId, msg);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi lấy danh sách custom commands:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // Xóa lệnh tùy chỉnh: /delcmd <tên_lệnh>
    if (command === '/delcmd') {
        console.log(`[Command] Thực thi lệnh /delcmd`);
        if (args.length < 2) {
            console.log(`[Validation] Lệnh /delcmd thiếu tên lệnh cần xóa.`);
            await sendTelegramMessage(chatId, "⚠️ Cú pháp đúng: /delcmd <tên_lệnh>");
            return res.status(200).send('OK');
        }

        const targetCmd = args[1].toLowerCase();
        try {
            const deletedCount = await kv.hdel('custom_commands', targetCmd);
            console.log(`[Redis] Xóa custom command [${targetCmd}]. Trạng thái xóa: ${deletedCount > 0 ? "Thành công" : "Không tìm thấy lệnh để xóa"}`);
            
            await sendTelegramMessage(chatId, `🗑️ Đã xóa lệnh: [${targetCmd}]`);
            return res.status(200).send('OK');
        } catch (error) {
            console.error(`[Error] Lỗi khi xóa custom command [${targetCmd}]:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    // ==========================================
    // LỆNH ĐIỀU KHIỂN MULTI-ACC QUA /r
    // ==========================================
    if (command === '/r') {
        console.log(`[Command] Thực thi lệnh /r`);
        if (args.length < 2) {
            console.log(`[Validation] Lệnh /r thiếu tham số lệnh hành động.`);
            await sendTelegramMessage(chatId, "⚠️ Cú pháp đúng: \n• /r <tên_lệnh> (Tất cả acc)\n• /r <tên_acc> <tên_lệnh> (1 acc cụ thể)");
            return res.status(200).send('OK');
        }

        try {
            const customCmds = await kv.hgetall('custom_commands') || {};

            // Trường hợp 1: /r <tên_lệnh> -> Gửi tới TẤT CẢ (All)
            if (args.length === 2) {
                const action = args[1].toLowerCase();
                const luaCode = customCmds[action];
                console.log(`[Logic] Nhận diện /r gửi tới tất cả acc. Lệnh cần tìm: [${action}]`);

                if (luaCode) {
                    await kv.set(
                        "global_script",
                        JSON.stringify({ code: luaCode, timestamp: Date.now() })
                    );
                    console.log(`[Redis] Đã gửi lệnh [${action}] qua global_script thành công.`);
                    await sendTelegramMessage(chatId, `🚀 Đang gửi lệnh [${action}] tới TẤT CẢ tài khoản...`);
                } else {
                    console.log(`[Warning] Không tìm thấy code của lệnh [${action}] trong custom_commands.`);
                    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy lệnh tùy chỉnh: [${action}]`);
                }
                return res.status(200).send('OK');
            }

            // Trường hợp 2: /r <tên_acc> <tên_lệnh> -> Gửi tới 1 tài khoản cụ thể
            if (args.length >= 3) {
                const targetAcc = args[1].toLowerCase();
                const action = args[2].toLowerCase();
                const luaCode = customCmds[action];
                console.log(`[Logic] Nhận diện /r gửi tới acc riêng biệt [${targetAcc}]. Lệnh cần tìm: [${action}]`);

                if (luaCode) {
                    await kv.set(
                        `script:${targetAcc}`,
                        JSON.stringify({ code: luaCode, timestamp: Date.now() })
                    );
                    console.log(`[Redis] Đã gửi lệnh [${action}] đến acc [${targetAcc}] qua key script:${targetAcc} thành công.`);
                    await sendTelegramMessage(chatId, `🎯 Đang gửi lệnh [${action}] tới tài khoản: [${targetAcc}]`);
                } else {
                    console.log(`[Warning] Không tìm thấy code của lệnh [${action}] trong custom_commands để gửi cho [${targetAcc}].`);
                    await sendTelegramMessage(chatId, `⚠️ Không tìm thấy lệnh tùy chỉnh: [${action}]`);
                }
                return res.status(200).send('OK');
            }
        } catch (error) {
            console.error(`[Error] Lỗi khi xử lý lệnh /r:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

// ==========================================
    // LỆNH MỚI: LẤY LOG F9 TỪ GAME (/getlog)
    // Cú pháp: 
    // • /getlog (Lấy của tất cả acc)
    // • /getlog <tên_acc> (Lấy của 1 acc cụ thể)
    // ==========================================
    if (command === '/getlog') {
        console.log(`[Command] Thực thi lệnh /getlog`);
        
        // Bạn hãy thay URL này bằng URL endpoint getlog.js thật của bạn
        const GETLOG_ENDPOINT = "https://project-33dtd.vercel.app/api/getlog"; 

        // Đoạn script Lua tự động thu thập dữ liệu từ LogService của Roblox và gửi đi
        const generateLuaLogScript = (playerName) => {
            return `
                local LogService = game:GetService("LogService")
                local HttpService = game:GetService("HttpService")
                local Players = game:GetService("Players")
                
                local localPlayer = Players.LocalPlayer and Players.LocalPlayer.Name or "Unknown"
                local logsTable = {}
                
                -- Thu thập toàn bộ log hiện tại trong F9 Console
                for _, log in ipairs(LogService:GetLogHistory()) do
                    table.insert(logsTable, string.format("[%s] %s", log.messageType.Name, log.message))
                end
                
                local fullLogs = table.concat(logsTable, "\\n")
                if #fullLogs == 0 then fullLogs = "Không có log nào trong bộ nhớ." end
                
                -- Cắt ngắn log nếu quá dài để tránh lỗi payload lớn (Giới hạn khoảng 3000 ký tự)
                if #fullLogs > 3000 then
                    fullLogs = string.sub(fullLogs, #fullLogs - 3000)
                end
                
                -- POST dữ liệu lên getlog.js
local req = (syn and syn.request) or (http and http.request) or http_request or request

if req then
    local res = req({
        Url = "https://project-33dtd.vercel.app/api/getlog",
        Method = "POST",
        Headers = {
            ["Content-Type"] = "application/json"
        },
        Body = HttpService:JSONEncode({
            player = localPlayer,
            logs = fullLogs,
            authorization = ${process.env.ROBLOX_SECRET_TOKEN}
        })
    })

    print(res.StatusCode, res.Body)
else
    warn("Không có request")
end
            `.trim();
        };

        try {
            // TRƯỜNG HỢP 1: /getlog -> Lấy log của TẤT CẢ các acc đang kết nối
            if (args.length === 1) {
                console.log(`[Logic] Yêu cầu lấy log F9 từ TẤT CẢ tài khoản.`);
                const luaCode = generateLuaLogScript("All");
                
                await kv.set(
                    "global_script",
                    JSON.stringify({ code: luaCode, timestamp: Date.now() })
                );
                
                console.log(`[Redis] Đã nạp script lấy log vào global_script.`);
                await sendTelegramMessage(chatId, `🛰️ Đang yêu cầu lấy log F9 từ *TẤT CẢ* tài khoản... Vui lòng đợi log phản hồi.`);
                return res.status(200).send('OK');
            }

            // TRƯỜNG HỢP 2: /getlog <tên_acc> -> Chỉ lấy log của 1 tài khoản cụ thể
            if (args.length >= 2) {
                const targetAcc = args[1].toLowerCase();
                console.log(`[Logic] Yêu cầu lấy log F9 từ tài khoản cụ thể: [${targetAcc}]`);
                const luaCode = generateLuaLogScript(targetAcc);

                await kv.set(
                    `script:${targetAcc}`,
                    JSON.stringify({ code: luaCode, timestamp: Date.now() })
                );

                console.log(`[Redis] Đã nạp script lấy log vào key script:${targetAcc}.`);
                await sendTelegramMessage(chatId, `🎯 Đang yêu cầu lấy log F9 từ tài khoản: [${targetAcc}]...`);
                return res.status(200).send('OK');
            }
        } catch (error) {
            console.error(`[Error] Lỗi khi thực thi lệnh /getlog:`, error);
            return res.status(500).send('Internal Server Error');
        }
    }

    console.log(`[Info] Tin nhắn không khớp với bất kỳ command nào đã cấu hình.`);
    return res.status(200).send('OK');
}

async function sendTelegramMessage(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    console.log(`[Telegram API] Đang gửi tin nhắn phản hồi tới ChatID ${chatId}...`);
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            console.error(`[Telegram API Error] Gửi tin nhắn thất bại. Trạng thái: ${response.status}. Chi tiết: ${errText}`);
        } else {
            console.log(`[Telegram API Success] Đã gửi tin nhắn thành công.`);
        }
    } catch (fetchError) {
        console.error(`[Telegram API Fetch Error] Lỗi kết nối mạng khi gọi Telegram API:`, fetchError);
    }
}
