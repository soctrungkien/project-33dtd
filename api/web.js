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

    const response = await fetch(rawUrl);

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const content = await response.text();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");

    return res.status(200).send(content);
  } catch (error) {
    console.error("WEB ERROR:", error);

    return res.status(500).send("Failed to fetch content");
  }
};
