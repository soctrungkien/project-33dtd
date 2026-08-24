import { Telegraf } from 'telegraf';
import axios from 'axios';
import https from 'https';
import pem from 'pem';
import { X509Certificate } from '@peculiar/x509';

// ============================================================================
// CẤU HÌNH & KHỞI TẠO BOT TELEGRAF
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN_CHECK_KEYBOX;
const GOOGLE_REVOCATION_URL = 'https://android.googleapis.com/attestation/status';

if (!TELEGRAM_TOKEN) {
  console.error('LỖI: Chưa cấu hình biến môi trường TELEGRAM_BOT_TOKEN_CHECK_KEYBOX!');
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// Tắt Keep-Alive để tránh lỗi TLS Socket Disconnect trên môi trường Serverless (Vercel)
const httpsAgent = new https.Agent({
  keepAlive: false,
  timeout: 10000,
});

// Danh sách Public Key gốc (Root Certificates) chuẩn Google & Samsung Knox
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
// HÀM XỬ LÝ & LÀM SẠCH CHỨNG CHỈ (CERTIFICATE CLEANER)
// ============================================================================

/**
 * Làm sạch chuỗi PEM để tránh lỗi định dạng của `@peculiar/x509`
 */
function cleanAndFormatPem(rawPem) {
  if (!rawPem) return null;

  let base64 = rawPem
    .replace(/&#13;/g, '')
    .replace(/&#10;/g, '')
    .replace(/-----BEGIN CERTIFICATE-----/gi, '')
    .replace(/-----END CERTIFICATE-----/gi, '')
    .replace(/\s+/g, '');

  if (!base64) return null;

  while (base64.length % 4 !== 0) {
    base64 += '=';
  }

  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Trích xuất chứng chỉ từ XML, đồng thời TỰ ĐỘNG XÓA BỎ các thẻ chú thích <!-- Nội dung -->
 */
function parseCertificatesFromXml(xmlString) {
  // Loại bỏ hoàn toàn các đoạn chú thích dạng <!-- Nội dung --> để tránh lỗi phân tích
  const cleanXml = xmlString.replace(/<!--[\s\S]*?-->/g, '');

  const certs = [];
  const certRegex = /<Certificate[\s\S]*?>([\s\S]*?)<\/Certificate>/gi;
  let match;

  while ((match = certRegex.exec(cleanXml)) !== null) {
    const formatted = cleanAndFormatPem(match[1]);
    if (formatted) {
      certs.push(formatted);
    }
  }

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

/**
 * Xác minh tính hợp lệ chuỗi chứng chỉ bằng thư viện `pem`
 */
function verifyCertificateChain(certs) {
  return new Promise((resolve) => {
    if (certs.length < 2) return resolve(true);

    let completed = 0;
    let isValidChain = true;

    for (let i = 0; i < certs.length - 1; i++) {
      pem.verifySigningChain(certs[i], [certs[i + 1]], (err, isValid) => {
        completed++;
        if (err || !isValid) {
          isValidChain = false;
        }
        if (completed === certs.length - 1) {
          resolve(isValidChain);
        }
      });
    }
  });
}

function checkCertificateValidity(pemCert) {
  try {
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
  } catch (error) {
    throw new Error(`Không thể phân tích chứng chỉ: ${error.message}`);
  }
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
  } catch (e) {
    // Bỏ qua lỗi
  }

  return { name: 'unknown', type: 'Chứng chỉ gốc không xác định', icon: '❌' };
}

// ============================================================================
// HÀM KIỂM TRA KEYBOX TỔNG THỂ
// ============================================================================
async function validateKeybox(xmlContent) {
  const result = { success: false, report: [], status: [] };

  try {
    const pemCerts = parseCertificatesFromXml(xmlContent);

    if (pemCerts.length === 0) {
      throw new Error('Không tìm thấy chứng chỉ hợp lệ trong file XML');
    }

    const firstCertValidity = checkCertificateValidity(pemCerts[0]);
    const cert = new X509Certificate(pemCerts[0]);
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

    const chainValid = await verifyCertificateChain(pemCerts);
    if (chainValid) {
      result.report.push('✅ Chuỗi xác thực (Keychain) hợp lệ');
      result.status.push('chain_valid');
    } else {
      result.report.push('❌ Chuỗi xác thực (Keychain) KHÔNG hợp lệ');
      result.status.push('chain_invalid');
    }

    const rootCertInfo = identifyRootCert(pemCerts[pemCerts.length - 1]);
    result.report.push(`${rootCertInfo.icon} ${rootCertInfo.type}`);
    result.status.push(`root_${rootCertInfo.name}`);

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
// CÁC TRÌNH XỬ LÝ SỰ KIỆN TELEGRAF BOT
// ============================================================================

bot.start((ctx) => {
  if (ctx.chat.type === 'private') {
    ctx.reply('Chào bạn! Hãy gửi file `keybox.xml` trực tiếp cho tôi hoặc dùng lệnh /check để kiểm tra tính hợp lệ.');
  }
});

bot.help((ctx) => {
  ctx.reply('Gửi hoặc phản hồi (reply) file XML chứa keybox để hệ thống tiến hành kiểm tra chứng chỉ phần cứng.');
});

// Xử lý khi người dùng gửi file trực tiếp
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;

  if (doc.file_size > 50 * 1024) {
    return ctx.reply('Dung lượng file quá lớn (Giới hạn tối đa là 50KB).');
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'text' });
    const xmlContent = response.data;

    const validation = await validateKeybox(xmlContent);
    await ctx.reply(validation.report.join('\n'), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Lỗi xử lý tệp:', error.message);
    await ctx.reply(`Lỗi khi phân tích tệp: ${error.message}`);
  }
});

// Xử lý lệnh /check khi reply vào file
bot.command('check', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.document) {
    return ctx.reply('Vui lòng phản hồi (reply) vào file keybox.xml và gõ lệnh /check');
  }

  const doc = replyTo.document;
  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'text' });
    const xmlContent = response.data;

    const validation = await validateKeybox(xmlContent);
    await ctx.reply(validation.report.join('\n'), { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Lỗi xử lý tệp qua lệnh /check:', error.message);
    await ctx.reply(`Lỗi khi phân tích tệp: ${error.message}`);
  }
});

// ============================================================================
// VERCEL SERVERLESS HANDLER (Dùng Telegraf Webhook)
// ============================================================================
export default async function handler(req, res) {
  if (req.method === 'POST') {
    // Hỗ trợ cả kiểm tra qua API Body JSON trực tiếp
    if (req.body && req.body.xml) {
      try {
        const result = await validateKeybox(req.body.xml);
        return res.status(200).json(result);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    // Xử lý Webhook chuẩn của Telegraf
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Lỗi Webhook Telegraf:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Keybox Checker Bot (Telegraf) đang hoạt động ổn định!' });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
