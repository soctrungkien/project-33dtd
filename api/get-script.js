import Redis from "ioredis";

const kv = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const clientToken = req.headers["authorization"];
    if (clientToken !== `Bearer ${process.env.ROBLOX_SECRET_TOKEN}`) {
        return res.status(401).send("return");
    }

    const { username, lastGlobalTime } = req.body;
    if (!username) return res.status(400).send("return");

    const userKey = `script:${username.toLowerCase()}`;

    // Ping người chơi
    await kv.set(`player:${username.toLowerCase()}`, Date.now().toString());

    // Lệnh riêng
    const privateData = await kv.get(userKey);
    if (privateData) {
        await kv.del(userKey);

        const privateScript = JSON.parse(privateData);

        res.setHeader("Content-Type", "text/plain");
        return res.status(200).send(privateScript.code);
    }

    // Lệnh chung
    const globalData = await kv.get("global_script");
    if (globalData) {
        const globalScript = JSON.parse(globalData);

        if (globalScript.timestamp > (lastGlobalTime || 0)) {
            res.setHeader("Content-Type", "application/json");
            return res.status(200).json({
                code: globalScript.code,
                timestamp: globalScript.timestamp
            });
        }
    }

    return res.status(200).send("return");
}
