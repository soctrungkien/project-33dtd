const https = require("https");

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";

        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return fetchRaw(res.headers.location).then(resolve).catch(reject);
          }

          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP Error: ${res.statusCode}`));
          }

          resolve(data);
        });
      })
      .on("error", reject);
  });
}

module.exports = async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();

    if (!id) {
      return res.status(400).send("Missing id parameter");
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return res.status(400).send("Invalid id format");
    }

    const rawUrl = `https://pastefy.app/${encodeURIComponent(id)}/raw`;

    const content = await fetchRaw(rawUrl);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");

    return res.status(200).send(content);
  } catch (error) {
    console.error("WEB ERROR:", error);

    return res.status(500).send("Failed to fetch content");
  }
};
