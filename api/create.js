export const config = {
  api: {
    bodyParser: true
  }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const keys = (process.env.PASTEFY_API_KEYS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  if (!keys.length) {
    return res.status(500).send("Missing PASTEFY_API_KEYS");
  }

  let content = "";

  if (typeof req.body === "string") {
    content = req.body;
  } else if (req.body && typeof req.body.content === "string") {
    content = req.body.content;
  } else if (req.body) {
    content = JSON.stringify(req.body);
  }

  if (!content.trim()) {
    return res.status(400).send("No content");
  }

  const apiKey = keys[Math.floor(Math.random() * keys.length)];

  try {
    const r = await fetch("https://pastefy.app/api/v2/paste", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content
      })
    });

    const text = await r.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(500).send(text);
    }

    if (!r.ok || !json.success) {
      return res.status(r.status).send(json.message || "Pastefy Error");
    }

    res.setHeader("Content-Type", "text/plain");
    return res.status(200).send(
      `https://pastefy.app/${json.paste.id}/raw`
    );

  } catch (err) {
    console.error(err);
    return res.status(500).send(err.message);
  }
  }
