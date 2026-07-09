import Redis from "ioredis";

const kv = new Redis(process.env.REDIS_URL);

kv.on("connect", () => console.log("[Redis] Kết nối thành công!"));
kv.on("error", (err) => console.error("[Redis] Lỗi kết nối:", err));

export default async function handler(req, res) {
    const requestId = Math.random().toString(36).substring(7); // Tạo id ngẫu nhiên để phân biệt các request
    console.log(`\n[${requestId}] --- Nhận Request Mới ---`);
    console.log(`[${requestId}] Method: ${req.method} | IP: ${req.headers["x-forwarded-for"] || req.socket.remoteAddress}`);

    // 1. Kiểm tra Method
    if (req.method !== "POST") {
        console.warn(`[${requestId}] Từ chối: Method không hợp lệ (${req.method})`);
        return res.status(405).send("Method Not Allowed");
    }

    // 2. Kiểm tra Token Authorization
    const clientToken = req.headers["authorization"];
    if (clientToken !== `Bearer ${process.env.ROBLOX_SECRET_TOKEN}`) {
        console.warn(`[${requestId}] Từ chối: Token không chính xác hoặc thiếu`);
        return res.status(401).send("return");
    }

    // 3. Kiểm tra Body Data
    const { username, lastGlobalTime } = req.body;
    console.log(`[${requestId}] Payload nhận được:`, { username, lastGlobalTime });

    if (!username) {
        console.warn(`[${requestId}] Từ chối: Thiếu 'username' trong body`);
        return res.status(400).send("return");
    }

    const lowerUsername = username.toLowerCase();
    const userKey = `script:${lowerUsername}`;

    try {
        // 4. Ping người chơi (Cập nhật thời gian hoạt động)
        const currentTime = Date.now().toString();
        await kv.set(`player:${lowerUsername}`, currentTime);
        console.log(`[${requestId}] Ping thành công cho player:${lowerUsername} tại ${currentTime}`);

        // 5. Kiểm tra Lệnh riêng (Private Script)
        console.log(`[${requestId}] Đang kiểm tra private script với key: ${userKey}`);
        const privateData = await kv.get(userKey);

        if (privateData) {
            console.log(`[${requestId}] Phát hiện private script. Tiến hành xóa key và gửi code...`);
            await kv.del(userKey); // Xóa script sau khi đã lấy để tránh thực thi lại

            const privateScript = JSON.parse(privateData);
            res.setHeader("Content-Type", "text/plain");
            console.log(`[${requestId}] Gửi thành công private script cho [${username}]`);
            return res.status(200).send(privateScript.code);
        }
        console.log(`[${requestId}] Không có private script cho [${username}]`);

        // 6. Kiểm tra Lệnh chung (Global Script)
        console.log(`[${requestId}] Đang kiểm tra global_script...`);
        const globalData = await kv.get("global_script");

        if (globalData) {
            const globalScript = JSON.parse(globalData);
            console.log(`[${requestId}] Global Script Timestamp: ${globalScript.timestamp} | Client Last Global Time: ${lastGlobalTime || 0}`);

            if (globalScript.timestamp > (lastGlobalTime || 0)) {
                console.log(`[${requestId}] Global script mới hơn client. Gửi cập nhật...`);
                res.setHeader("Content-Type", "application/json");
                return res.status(200).json({
                    code: globalScript.code,
                    timestamp: globalScript.timestamp
                });
            } else {
                console.log(`[${requestId}] Global script của client đã là mới nhất.`);
            }
        } else {
            console.log(`[${requestId}] Không tìm thấy global_script trên Redis.`);
        }

        // 7. Không có cập nhật gì mới
        console.log(`[${requestId}] Không có phản hồi đặc biệt. Trả về 'return'`);
        return res.status(200).send("return");

    } catch (error) {
        // Log lỗi chi tiết nếu hệ thống gặp sự cố trong try
        console.error(`[${requestId}] LỖI HỆ THỐNG:`, error.message);
        console.error(error.stack);
        return res.status(500).send("Internal Server Error");
    }
}
