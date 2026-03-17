const rateLimit = new Map();

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const ip =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket?.remoteAddress ||
        "unknown";

    const now = Date.now();

    // config
    const LIMIT = 100;
    const WINDOW = 1000;
    const COOLDOWN = 120000;

    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, { timestamps: [], blockedUntil: 0 });
    }

    const dataIP = rateLimit.get(ip);

    if (now < dataIP.blockedUntil) {
        return res.status(429).json({
            error: "spam kid"
        });
    }

    // lọc request cũ
    dataIP.timestamps = dataIP.timestamps.filter(t => now - t < WINDOW);

    // check limit
    if (dataIP.timestamps.length >= LIMIT) {
        dataIP.blockedUntil = now + COOLDOWN;

        return res.status(429).json({
            error: "phải chịu"
        });
    }

    dataIP.timestamps.push(now);
    rateLimit.set(ip, dataIP);

    const { message, mode } = req.body;

    let prompt = message;

    if (mode === "chat") {
        prompt = "(Ai name: infU)(vi-vn) executor roblox:\n" + message;
    }
  
    if (mode === "script") {
        prompt = "(Ai name: infU)(vi-vn) Generate Roblox Lua localscript for executor only:\n" + message;
    }

    try {
        const r = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=" + process.env.GEMINI_KEY,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );

        const result = await r.json();
        let reply = result?.candidates?.[0]?.content?.parts?.[0]?.text || "AI lỗi";

        const nowv = new Date().toLocaleString("vi-VN");
        
        await fetch(process.env.DISCORD_WEBHOOK, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                content: "@everyone",
                embeds: [
                    {
                        title: "📡 AI Chat Log",
                        color: 5814783,
                        fields: [
                            {
                                name: "⏱️ Date",
                                value: nowv,
                                inline: false
                            },
                            {
                                name: "💻 IP",
                                value: ip,
                                inline: false
                            },
                            {
                                name: "💬 Message",
                                value: message,
                                inline: false
                            },
                            {
                                name: "🤖 Reply",
                                value: reply,
                                inline: false
                            },
                            {
                                name: "📦 Mode",
                                value: mode || "chat",
                                inline: true
                            }
                        ],
                        footer: {
                            text: "AI Logger"
                        }
                    }
                ]
            })
        });

        res.status(200).json({ reply });

    } catch (e) {
        res.status(500).json({ error: "Server béo quá nổ r" });
    }
}
