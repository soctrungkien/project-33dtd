export const config = {
  runtime: "nodejs"
};
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Lấy chuỗi chứa nhiều API Key
  const keysEnv = process.env.PASTEFY_API_KEYS;
  if (!keysEnv) {
    return res.status(500).send("Missing PASTEFY_API_KEYS env");
  }

  // Chuyển chuỗi thành mảng các key và lọc bỏ khoảng trắng
  const apiKeys = keysEnv.split(',').map(key => key.trim()).filter(Boolean);
  if (apiKeys.length === 0) {
    return res.status(500).send("No valid API keys found");
  }

  // Chọn ngẫu nhiên một API Key từ danh sách để phân phối tải (Load Balancing)
  const randomIndex = Math.floor(Math.random() * apiKeys.length);
  const selectedApiKey = apiKeys[randomIndex];

  // Lấy nội dung cần paste (Chấp nhận cả JSON hoặc Text thô)
  const content = typeof req.body === "string"
  ? req.body
  : String(req.body ?? "");

  if (!content) {
    return res.status(400).send("Error: No content provided.");
  }

  try {
    const response = await fetch('https://pastefy.app/api/v2/paste', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${selectedApiKey}` // Sử dụng key được chọn ngẫu nhiên
      },
      body: JSON.stringify({ content })
    });

    const data = await response.json();

    console.log(response.body);
    console.log(typeof response.body);
    console.log(response.headers["content-type"]);

    if (!response.ok || !data.success) {
      // In ra console log của Vercel để bạn tiện theo dõi nếu key đó bị lỗi/hết hạn
      console.error(`Key index ${randomIndex} failed: ${data.message || 'Unknown error'}`);
      return res.status(response.status).send(data.message || 'Pastefy Error');
    }

    // Trả về duy nhất link RAW dạng text thuần
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(`https://pastefy.app/${data.paste.id}/raw`);

  } catch (error) {
    return res.status(500).send(error.message);
  }
}
