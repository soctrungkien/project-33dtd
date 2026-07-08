import { Redis } from "@upstash/redis";

const kv = Redis.fromEnv();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const clientToken = req.headers['authorization'];
    if (clientToken !== `Bearer ${process.env.ROBLOX_SECRET_TOKEN}`) {
        return res.status(401).send('return');
    }

    const { username, lastGlobalTime } = req.body;
    if (!username) return res.status(400).send('-- Missing Username');

    const userKey = `script:${username.toLowerCase()}`;
    
    // Ghi nhận mốc thời gian hoạt động (Ping) của người chơi này
    await kv.set(`player:${username.toLowerCase()}`, Date.now());

    // 1. Kiểm tra lệnh riêng cho acc này
    const privateScript = await kv.get(userKey);
    if (privateScript) {
        await kv.del(userKey); 
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(privateScript.code);
    }

    // 2. Kiểm tra lệnh chung (all)
    const globalScript = await kv.get('global_script');
    if (globalScript && globalScript.timestamp > (lastGlobalTime || 0)) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({ code: globalScript.code, timestamp: globalScript.timestamp });
    }

    return res.status(200).send('return');
}
