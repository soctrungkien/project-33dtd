import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import { X509Certificate } from '@peculiar/x509';

// ============================================================================
// CẤU HÌNH & CLIENT HTTP
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN_CHECK_KEYBOX;
const TELEGRAM_API = 'https://api.telegram.org';
const GOOGLE_REVOCATION_URL = 'https://android.googleapis.com/attestation/status';

const httpsAgent = new https.Agent({
  keepAlive: false,
  timeout: 10000,
});

const telegramClient = axios.create({
  baseURL: TELEGRAM_API,
  httpsAgent: httpsAgent,
  timeout: 10000,
});

const PEM_KEYS = {
  google: `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xU
FmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5j
lRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y
//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73X
pXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYI
mQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB
+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7q
uvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgp
Zrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7
gLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82
ixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+
NpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==
-----END PUBLIC KEY-----`,
  aosp_ec: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7l1ex+HA220Dpn7mthvsTWpdamgu
D/9/SQ59dx9EIm29sa/6FsvHrcV30lacqrewLVQBXT5DKyqO107sSHVBpA==
-----END PUBLIC KEY-----`,
  aosp_rsa: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCia63rbi5EYe/VDoLmt5TRdSMf
d5tjkWP/96r/C3JHTsAsQ+wzfNes7UA+jCigZtX3hwszl94OuE4TQKuvpSe/lWmg
MdsGUmX4RFlXYfC78hdLt0GAZMAoDo9Sd47b0ke2RekZyOmLw9vCkT/X11DEHTVm
+Vfkl5YLCazOkjWFmwIDAQAB
-----END PUBLIC KEY-----`,
  knox: `-----BEGIN PUBLIC KEY-----
MIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBhbGuLrpql5I2WJmrE5kEVZOo+dgA
46mKrVJf/sgzfzs2u7M9c1Y9ZkCEiiYkhTFE9vPbasmUfXybwgZ2EM30A1ABPd12
4n3JbEDfsB/wnMH1AcgsJyJFPbETZiy42Fhwi+2BCA5bcHe7SrdkRIYSsdBRaKBo
ZsapxB0gAOs0jSPRX5M=
-----END PUBLIC KEY-----`,
};

// ============================================================================
// HÀM XỬ LÝ & BÓC TÁCH CHỨNG CHỈ (LÀM SẠCH VÀ SỬA LỖI FORMAT)
// ============================================================================

function formatPem(rawPem) {
  if (!rawPem) return '';
  
  // Loại bỏ các thẻ HTML Entity, khoảng trắng, xuống dòng rác
  let base64 = rawPem
    .replace(/-----BEGIN CERTIFICATE-----/gi, '')
    .replace(/-----END CERTIFICATE-----/gi, '')
    .replace(/&#13;/g, '')
    .replace(/&#10;/g, '')
    .replace(/[\r\n\t]/g, '')
    .replace(/\s+/g, '');

  if (!base64) return '';

  // Đảm bảo đủ độ dài chuỗi Base64 (Padding với dấu =)
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }

  // Cắt dòng 64 ký tự theo chuẩn RFC 1421
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Hàm bóc tách chứng chỉ an toàn: Tự động loại bỏ chú thích <!-- Nội dung --> và dính chùm
 */
function extractCertificatesFromXml(xmlString) {
  const certs = [];
  
  // Tự động xóa sạch mọi thẻ chú thích XML/HTML <!-- ... --> trước khi match
  const cleanXml = xmlString.replace(/<!--[\s\S]*?-->/g, '');
  
  const certBlocks = cleanXml.match(/<Certificate[\s\S]*?>([\s\S]*?)<\/Certificate>/gi) || [];

  for (const block of certBlocks) {
    const contentMatch = block.match(/<Certificate[\s\S]*?>([\s\S]*?)<\/Certificate>/i);
    if (contentMatch && contentMatch[1]) {
      const formatted = formatPem(contentMatch[1]);
      if (formatted) {
        certs.push(formatted);
      }
    }
  }

  return certs;
}

function comparePemKeys(pem1, pem2) {
  return pem1.replace(/\s/g, '') === pem2.replace(/\s/g, '');
}

async function downloadFromTelegram(filePath) {
  const response = await telegramClient.get(`/file/bot${TELEGRAM_TOKEN}/${filePath}`, {
    responseType: 'arraybuffer',
  });
  return response.data.toString('utf-8');
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

      if (child.issuer !== parent.subject) {
        return false;
      }

      const isValidSignature = await child.verify({
        publicKey: await parent.publicKey.export(),
      });

      if (!isValidSignature) {
        return false;
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

function checkCertificateValidity(pemCert) {
  const cert = new X509Certificate(pemCert);
  const now = new Date();
  const notBefore = cert.notBefore;
  const notAfter = cert.notAfter;

  return {
    isValid: notBefore <= now && now <= notAfter,
    notBefore,
    notAfter,
    expired: now > notAfter,
  };
}

function identifyRootCert(pemCert) {
  try {
    const cert = new X509Certificate(pemCert);
    const rootPublicKeyPem = cert.publicKey.toString('pem');

    for (const [name, key] of Object.entries(PEM_KEYS)) {
      if (comparePemKeys(rootPublicKeyPem, key)) {
        if (name === 'google') return { name, type: 'Xác thực phần cứng Google (Google hardware attestation)', icon: '✅' };
        if (name === 'aosp_ec') return { name, type: 'Xác thực phần mềm AOSP (EC)', icon: '🟡' };
        if (name === 'aosp_rsa') return { name, type: 'Xác thực phần mềm AOSP (RSA)', icon: '🟡' };
        if (name === 'knox') return { name, type: 'Xác thực Samsung Knox', icon: '✅' };
      }
    }
  } catch (e) {}

  return { name: 'unknown', type: 'Chứng chỉ gốc không xác định', icon: '❌' };
}

// ============================================================================
// LOGIC KIỂM TRA KEYBOX TỔNG THỂ
// ============================================================================

async function validateKeybox(xmlContent) {
  const result = { success: false, report: [], status: [] };

  try {
    const pemCerts = extractCertificatesFromXml(xmlContent);

    if (pemCerts.length === 0) {
      throw new Error('Không tìm thấy chứng chỉ hợp lệ trong file XML');
    }

    const firstCertValidity = checkCertificateValidity(pemCerts[0]);
    const cert = new X509Certificate(pemCerts[0]);
    
    // Tách lấy Serial Number chuẩn Hex không bị tràn chuỗi
    const serialNumber = cert.serialNumber.replace(/^0x/i, '').toLowerCase();

    result.report.push(`🔐 *Số Serial:* \`${serialNumber}\``);
    result.report.push(`ℹ️ *Chủ thể (Subject):* \`${cert.subject}\``);

    if (firstCertValidity.isValid) {
      result.report.push('✅ Chứng chỉ đang trong thời hạn sử dụng');
      result.status.push('valid_period');
    } else if (firstCertValidity.expired) {
      result.report.push('❌ Chứng chỉ đã hết hạn');
      result.status.push('expired');
    } else {
      result.report.push('❌ Chứng chỉ chưa đến thời gian hiệu lực');
      result.status.push('not_yet_valid');
    }

    // Kiểm tra chuỗi xác thực (Keychain)
    const chainValid = await verifyCertificateChain(pemCerts);
    if (chainValid) {
      result.report.push('✅ Chuỗi xác thực (Keychain) hợp lệ');
      result.status.push('chain_valid');
    } else {
      result.report.push('❌ Chuỗi xác thực (Keychain) KHÔNG hợp lệ');
      result.status.push('chain_invalid');
    }

    // Kiểm tra chứng chỉ Root
    const rootCertInfo = identifyRootCert(pemCerts[pemCerts.length - 1]);
    result.report.push(`${rootCertInfo.icon} ${rootCertInfo.type}`);
    result.status.push(`root_${rootCertInfo.name}`);

    // Tra cứu danh sách thu hồi của Google
    const revocationList = await loadRevocationList();
    const isRevoked = revocationList.entries?.[serialNumber];
    if (isRevoked) {
      result.report.push(`❌ Số Serial có trong danh sách bị Google thu hồi!`);
      result.report.push(`🔍 *Lý do:* \`${isRevoked.reason}\``);
      result.status.push('revoked');
    } else {
      result.report.push("✅ Số Serial KHÔNG có trong danh sách thu hồi của Google");
      result.status.push('not_revoked');
    }

    result.report.push(`⏱ *Thời gian kiểm tra (UTC):* ${new Date().toISOString().split('T')[0]}`);
    result.success = true;
  } catch (error) {
    result.report = [`❌ Lỗi kiểm tra Keybox: ${error.message}`];
  }

  return result;
}

// ============================================================================
// TELEGRAM HANDLERS
// ============================================================================

async function sendTelegramMessage(chatId, text, parseMode = 'Markdown') {
  try {
    await telegramClient.post(`/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  } catch (error) {
    console.error('Lỗi gửi tin nhắn Telegram:', error.response?.data || error.message);
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const isPrivate = message.chat.type === 'private';

  if (message.text === '/start' || message.text === '/help') {
    if (isPrivate) {
      await sendTelegramMessage(
        chatId,
        'Chào bạn! Hãy gửi cho tôi file `keybox.xml` để kiểm tra tính hợp lệ.'
      );
    }
    return;
  }

  if (message.document) {
    const doc = message.document;

    if (doc.file_size > 50 * 1024) {
      await sendTelegramMessage(chatId, 'Dung lượng file quá lớn (Tối đa 50KB).');
      return;
    }

    try {
      const fileInfo = await telegramClient.get(`/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileInfo.data.result.file_path;
      const xmlContent = await downloadFromTelegram(filePath);

      const validation = await validateKeybox(xmlContent);
      await sendTelegramMessage(chatId, validation.report.join('\n'));
    } catch (error) {
      console.error('Lỗi xử lý file:', error.message);
      await sendTelegramMessage(chatId, `Lỗi khi phân tích file: ${error.message}`);
    }
    return;
  }

  if (message.text === '/check') {
    const replyTo = message.reply_to_message;
    if (!replyTo?.document) {
      await sendTelegramMessage(chatId, 'Vui lòng reply (trả lời) vào file keybox.xml với lệnh /check');
      return;
    }

    const doc = replyTo.document;
    try {
      const fileInfo = await telegramClient.get(`/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileInfo.data.result.file_path;
      const xmlContent = await downloadFromTelegram(filePath);

      const validation = await validateKeybox(xmlContent);
      await sendTelegramMessage(chatId, validation.report.join('\n'));
    } catch (error) {
      console.error('Lỗi xử lý file:', error.message);
      await sendTelegramMessage(chatId, `Lỗi khi phân tích file: ${error.message}`);
    }
  }
}

// ============================================================================
// VERCEL HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method === 'POST') {
    if (req.body.xml) {
      try {
        const result = await validateKeybox(req.body.xml);
        return res.status(200).json(result);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    try {
      if (req.body && req.body.update_id) {
        await handleTelegramUpdate(req.body);
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Lỗi Webhook Handler:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'KeyboxChecker API đang hoạt động bình thường' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
