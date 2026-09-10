import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import https from 'https';
import { X509Certificate } from '@peculiar/x509';

const bot = new Telegraf(process.env.BOT_TOKEN_KEYBOX);
const checkkeyboz = process.env.USERNAME_BOT_CHECK_KEYBOX;

// Configuration & Keys
const GOOGLE_REVOCATION_URL = 'https://android.googleapis.com/attestation/status';
const YURI_URL = "https://raw.githubusercontent.com/Yurii0307/yurikey/main/key";
const YURI_COMMIT_API = "https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1";

const KAORIOS_URL = "https://raw.githubusercontent.com/Wuang26/Kaorios-Toolbox/refs/heads/main/Toolbox-data/Keybox.xml";
const KAORIOS_COMMIT_API = "https://api.github.com/repos/Wuang26/Kaorios-Toolbox/commits?path=Toolbox-data/Keybox.xml&page=1&per_page=1";

const EVOKER_URL = "https://evoker.qzz.io/key";

const KOW_URL = "https://raw.githubusercontent.com/KOWX712/Tricky-Addon-Update-Target-List/keybox/.extra";
const KOW_COMMIT_API = "https://api.github.com/repos/KOWX712/Tricky-Addon-Update-Target-List/commits?path=.extra&ref=keybox&page=1&per_page=1";

const HIHI_URL = "https://raw.githubusercontent.com/soctrungkien/1HzH9Axaj/main/kezz";
const HIHI_COMMIT_API = "https://api.github.com/repos/soctrungkien/1HzH9Axaj/commits?path=kezz&page=1&per_page=1";

const httpsAgent = new https.Agent({ keepAlive: false, timeout: 10000 });

const PEM_KEYS = {
  google: `-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xU\nFmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5j\nlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y\n//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73X\npXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYI\nmQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB\n+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7q\nuvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgp\nZrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7\ngLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82\nixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+\nNpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==\n-----END PUBLIC KEY-----`,
  aosp_ec: `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7l1ex+HA220Dpn7mthvsTWpdamgu\nD/9/SQ59dx9EIm29sa/6FsvHrcV30lacqrewLVQBXT5DKyqO107sSHVBpA==\n-----END PUBLIC KEY-----`,
  aosp_rsa: `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCia63rbi5EYe/VDoLmt5TRdSMf\nd5tjkWP/96r/C3JHTsAsQ+wzfNes7UA+jCigZtX3hwszl94OuE4TQKuvpSe/lWmg\nMdsGUmX4RFlXYfC78hdLt0GAZMAoDo9Sd47b0ke2RekZyOmLw9vCkT/X11DEHTVm\n+Vfkl5YLCazOkjWFmwIDAQAB\n-----END PUBLIC KEY-----`,
  knox: `-----BEGIN PUBLIC KEY-----\nMIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBhbGuLrpql5I2WJmrE5kEVZOo+dgA\n46mKrVJf/sgzfzs2u7M9c1Y9ZkCEiiYkhTFE9vPbasmUfXybwgZ2EM30A1ABPd12\n4n3JbEDfsB/wnMH1AcgsJyJFPbETZiy42Fhwi+2BCA5bcHe7SrdkRIYSsdBRaKBo\nZsapxB0gAOs0jSPRX5M=\n-----END PUBLIC KEY-----`,
};

function formatDate(isoString) {
  if (!isoString) return "Không xác định";
  return new Date(isoString).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function sanitizeXmlContent(xmlString) {
  if (!xmlString) return '';
  return xmlString.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function formatPem(rawPem) {
  if (!rawPem) return '';
  let base64 = rawPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  if (!base64) return '';
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function parseNumberOfCertificates(xmlString) {
  const match = xmlString.match(/<NumberOfCertificates>(\d+)<\/NumberOfCertificates>/);
  if (!match) throw new Error('Không tìm thấy thẻ NumberOfCertificates');
  return parseInt(match[1], 10);
}

function parseCertificates(xmlString, pemNumber) {
  const certRegex = /<Certificate format="pem">([\s\S]*?)<\/Certificate>/g;
  const certs = [];
  let match;
  while ((match = certRegex.exec(xmlString)) !== null && certs.length < pemNumber) {
    const cleanPem = formatPem(match[1]);
    if (cleanPem) certs.push(cleanPem);
  }
  if (certs.length === 0) throw new Error('Không tìm thấy Certificate hợp lệ');
  return certs;
}

function comparePemKeys(pem1, pem2) {
  return pem1.replace(/\s/g, '') === pem2.replace(/\s/g, '');
}

async function loadRevocationList() {
  try {
    const response = await axios.get(GOOGLE_REVOCATION_URL, {
      headers: { 'Cache-Control': 'max-age=0, no-cache, no-store, must-revalidate' },
      timeout: 5000,
      httpsAgent,
    });
    return response.data;
  } catch (error) {
    return { entries: {} };
  }
}

async function verifyCertificateChain(certs) {
  if (certs.length < 2) return true;
  try {
    for (let i = 0; i < certs.length - 1; i++) {
      const child = new X509Certificate(certs[i]);
      const parent = new X509Certificate(certs[i + 1]);

      if (child.issuer !== parent.subject) return false;

      const isValidSignature = await child.verify({
        publicKey: await parent.publicKey.export(),
      });
      if (!isValidSignature) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function identifyRootCert(pemCert) {
  try {
    const cert = new X509Certificate(pemCert);
    const rootPublicKeyPem = cert.publicKey.toString('pem');

    for (const [name, key] of Object.entries(PEM_KEYS)) {
      if (comparePemKeys(rootPublicKeyPem, key)) {
        if (name === 'google') return { name, type: 'Google Hardware', isHardware: true };
        if (name === 'aosp_ec') return { name, type: 'AOSP EC', isHardware: false };
        if (name === 'aosp_rsa') return { name, type: 'AOSP RSA', isHardware: false };
        if (name === 'knox') return { name, type: 'Samsung Knox', isHardware: true };
      }
    }
  } catch (e) {}
  return { name: 'unknown', type: 'Unknown Root', isHardware: false };
}

async function validateKeyboxXml(rawXmlContent) {
  try {
    const xmlContent = sanitizeXmlContent(rawXmlContent);
    const numCerts = parseNumberOfCertificates(xmlContent);
    const pemCerts = parseCertificates(xmlContent, numCerts);

    if (pemCerts.length === 0) return false;

    const cert = new X509Certificate(pemCerts[0]);
    const now = new Date();
    const isValidPeriod = cert.notBefore <= now && now <= cert.notAfter;
    if (!isValidPeriod) return false;

    const chainValid = await verifyCertificateChain(pemCerts);
    if (!chainValid) return false;

    const rootCertInfo = identifyRootCert(pemCerts[pemCerts.length - 1]);
    if (rootCertInfo.name === 'unknown') return false;

    const serialNumber = cert.serialNumber.replace(/^0x/i, '').toLowerCase();
    const revocationList = await loadRevocationList();
    const isRevoked = !!revocationList.entries?.[serialNumber];

    return !isRevoked;
  } catch (error) {
    return false;
  }
}

async function getYuriKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(YURI_URL),
    fetch(YURI_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể kết nối đến nguồn Yuri");

  const base64Text = await fileRes.text();
  const cleanBase64 = base64Text.replace(/\s+/g, '').trim();

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) throw new Error("Base64 rỗng");
  } catch (error) {
    throw new Error(`Không thể decode Base64: ${error.message}`);
  }

  let updateDate = "Không xác định";
  let fileDate = new Date().toISOString().slice(0, 10);

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = formatDate(commitDate);
      
      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  const filename = `keybox-yuri-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

async function getKaoriosKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KAORIOS_URL),
    fetch(KAORIOS_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể kết nối đến nguồn Kaorios");

  const xmlText = await fileRes.text();
  const buffer = Buffer.from(xmlText, 'utf-8');

  let updateDate = "Không xác định";
  let fileDate = new Date().toISOString().slice(0, 10);

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = formatDate(commitDate);

      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  const filename = `keybox-kaorios-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

async function getEvokerKeybox() {
  const fileRes = await fetch(EVOKER_URL);
  if (!fileRes.ok) throw new Error("Không thể kết nối đến nguồn Evoker");

  const base64Text = await fileRes.text();
  const cleanBase64 = base64Text.replace(/\s+/g, '').trim();

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) throw new Error("Base64 rỗng");
  } catch (error) {
    throw new Error(`Không thể decode Base64: ${error.message}`);
  }

  const updateDate = "Không có dữ liệu ngày";
  const filename = `keybox-evoker.xml`;
  return { buffer, updateDate, filename };
}

async function getKowKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(KOW_URL),
    fetch(KOW_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể kết nối đến nguồn KOW");

  const rawText = await fileRes.text();
  const cleanHex = rawText.replace(/[^0-9a-fA-F]/g, '');
  const base64Text = Buffer.from(cleanHex, 'hex').toString('utf-8').trim();
  const buffer = Buffer.from(base64Text, 'base64');
  if (!buffer.length) throw new Error("File keybox KOW bị rỗng sau khi giải mã");

  let updateDate = "Không xác định";
  let fileDate = new Date().toISOString().slice(0, 10);

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = formatDate(commitDate);

      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  const filename = `keybox-kow-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

async function getHihiKeybox() {
  const [fileRes, commitRes] = await Promise.all([
    fetch(HIHI_URL),
    fetch(HIHI_COMMIT_API, { headers: { 'User-Agent': 'Telegram-Bot' } })
  ]);

  if (!fileRes.ok) throw new Error("Không thể kết nối đến nguồn HihiKeybox");

  const base64Text = await fileRes.text();
  const cleanBase64 = base64Text.replace(/\s+/g, '').trim();

  let buffer;
  try {
    buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) throw new Error("Base64 rỗng");
  } catch (error) {
    throw new Error(`Không thể decode Base64 HihiKeybox: ${error.message}`);
  }

  let updateDate = "Không xác định";
  let fileDate = new Date().toISOString().slice(0, 10);

  if (commitRes.ok) {
    const commits = await commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = formatDate(commitDate);

      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  const filename = `keybox-hihi-${fileDate}.xml`;
  return { buffer, updateDate, filename };
}

bot.command('start', async (ctx) => {
  await ctx.sendChatAction('typing');
  await ctx.reply(
    "👋 **Keybox Telegram Bot**\n\n" +
    "📖 **Danh sách lệnh:**\n" +
    "• /keybox - Tải file keybox (Yuri / Kaorios / Evoker / KOW / HihiKeybox)\n" +
    "• /check - Kiểm tra trạng thái Keybox\n" +
    "• /start - Hiển thị menu trợ giúp",
    { parse_mode: 'Markdown' }
  );
});

bot.command('check', async (ctx) => {
  await ctx.sendChatAction('typing');

  const sources = [
    { name: "Yuri", fetcher: getYuriKeybox },
    { name: "Kaorios", fetcher: getKaoriosKeybox },
    { name: "Evoker", fetcher: getEvokerKeybox },
    { name: "KOW", fetcher: getKowKeybox },
    { name: "HihiKeybox", fetcher: getHihiKeybox }
  ];

  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        const { buffer } = await src.fetcher();
        const xmlContent = buffer.toString('utf-8');
        const isPassed = await validateKeyboxXml(xmlContent);
        return { name: src.name, passed: isPassed };
      } catch (err) {
        return { name: src.name, passed: false };
      }
    })
  );

  let message = "Kết quả check keybox:\n";
  results.forEach((item) => {
    const icon = item.passed ? "✅" : "❌";
    message += `${icon} Keybox ${item.name}\n`;
  });
  message += `@${checkkeyboz}`;

  await ctx.reply(message.trim());
});

bot.command('keybox', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.reply(
    "🔑 Vui lòng chọn nguồn Keybox muốn tải:",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Yuri", `get_keybox:yuri:${userId}`),
        Markup.button.callback("Kaorios", `get_keybox:kaorios:${userId}`)
      ],
      [
        Markup.button.callback("Evoker", `get_keybox:evoker:${userId}`),
        Markup.button.callback("KOW", `get_keybox:kow:${userId}`)
      ],
      [
        Markup.button.callback("HihiKeybox", `get_keybox:hihi:${userId}`)
      ]
    ])
  );
});

bot.action(/^get_keybox:(yuri|kaorios|evoker|kow|hihi):(\d+)$/, async (ctx) => {
  const source = ctx.match[1];
  const ownerId = Number(ctx.match[2]);
  const clickedUserId = ctx.from.id;

  if (clickedUserId !== ownerId) {
    return ctx.answerCbQuery("눈⁠‸⁠눈 Đừng làm phiền người ta", { show_alert: true }).catch(() => {});
  }

  // 1. Phản hồi callback ngay lập tức
  await ctx.answerCbQuery("⏳ Đang xử lý...").catch(() => {});

  // 2. Thay đổi giao diện nút bấm ngay lập tức để CHỐNG NHẤN LẠI 2 LẦN
  try {
    await ctx.editMessageText("⏳ *Đang tải file keybox, vui lòng chờ...*", { parse_mode: 'Markdown' });
  } catch (e) {
    // Nếu tin nhắn bị xóa hoặc thay đổi trước đó thì bỏ qua
  }

  try {
    await ctx.sendChatAction('upload_document');
    
    let keyData;
    let sourceName = "";

    if (source === 'yuri') {
      keyData = await getYuriKeybox();
      sourceName = "Yuri";
    } else if (source === 'kaorios') {
      keyData = await getKaoriosKeybox();
      sourceName = "Kaorios";
    } else if (source === 'evoker') {
      keyData = await getEvokerKeybox();
      sourceName = "Evoker";
    } else if (source === 'kow') {
      keyData = await getKowKeybox();
      sourceName = "KOW";
    } else if (source === 'hihi') {
      keyData = await getHihiKeybox();
      sourceName = "HihiKeybox";
    }

    const { buffer, updateDate, filename } = keyData;

    // Gửi file
    await ctx.replyWithDocument(
      { source: buffer, filename },
      {
        caption: `🔑 **File Keybox (${sourceName})**\n📅 Ngày cập nhật: \`${updateDate}\`\n📄 Tên file: \`${filename}\``,
        parse_mode: 'Markdown'
      }
    );

  } catch (error) {
    console.error(`Lỗi tải keybox (${source}):`, error);
    await ctx.reply(`❌ Có lỗi xảy ra khi lấy file keybox: ${error.message || 'Lỗi không xác định'}`);
  } finally {
    // 3. Luôn luôn xóa tin nhắn menu lựa chọn (dù thành công hay có lỗi)
    await ctx.deleteMessage().catch(() => {});
  }
});

export default async function handler(req, res) {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  }

  return res.status(200).send('Bot đang hoạt động.');
}
