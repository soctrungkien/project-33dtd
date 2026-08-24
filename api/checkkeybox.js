import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import pem from 'pem';
import asn1 from 'asn1.js';
import { X509Certificate } from '@peculiar/x509';

// ============================================================================
// CONFIG & AXIOS CLIENT
// ============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN_CHECK_KEYBOX;
const TELEGRAM_API = 'https://api.telegram.org';
const GOOGLE_REVOCATION_URL = 'https://android.googleapis.com/attestation/status';

// Hạn chế lỗi TLS Socket Disconnect trên Vercel bằng cách tắt Keep-Alive
const httpsAgent = new https.Agent({
  keepAlive: false,
  timeout: 10000,
});

const telegramClient = axios.create({
  baseURL: TELEGRAM_API,
  httpsAgent: httpsAgent,
  timeout: 10000,
});

// Embedded PEM keys
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
// UTILITY & CERT PARSING
// ============================================================================

function parseNumberOfCertificates(xmlString) {
  const match = xmlString.match(/<NumberOfCertificates>(\d+)<\/NumberOfCertificates>/);
  if (!match) throw new Error('No NumberOfCertificates found.');
  return parseInt(match[1], 10);
}

function parseCertificates(xmlString, pemNumber) {
  const certRegex = /<Certificate format="pem">([\s\S]*?)<\/Certificate>/g;
  const certs = [];
  let match;
  while ((match = certRegex.exec(xmlString)) !== null && certs.length < pemNumber) {
    certs.push(match[1].trim());
  }
  if (certs.length === 0) throw new Error('No Certificate found.');
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

/**
 * Sử dụng thư viện `pem` để kiểm tra toàn bộ Certificate Chain
 */
function verifyCertificateChain(certs) {
  return new Promise((resolve) => {
    if (certs.length < 2) return resolve(true);

    let checksCompleted = 0;
    let isChainValid = true;

    for (let i = 0; i < certs.length - 1; i++) {
      pem.verifySigningChain(certs[i], [certs[i + 1]], (err, isValid) => {
        checksCompleted++;
        if (err || !isValid) {
          isChainValid = false;
        }
        if (checksCompleted === certs.length - 1) {
          resolve(isChainValid);
        }
      });
    }
  });
}

/**
 * Sử dụng `@peculiar/x509` để parse thời hạn chứng chỉ
 */
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
    throw new Error(`Failed to parse certificate: ${error.message}`);
  }
}

function identifyRootCert(pemCert) {
  for (const [name, key] of Object.entries(PEM_KEYS)) {
    if (comparePemKeys(pemCert, key)) {
      if (name === 'google') return { name, type: 'Google hardware attestation', icon: '✅' };
      if (name === 'aosp_ec') return { name, type: 'AOSP software attestation (EC)', icon: '🟡' };
      if (name === 'aosp_rsa') return { name, type: 'AOSP software attestation (RSA)', icon: '🟡' };
      if (name === 'knox') return { name, type: 'Samsung Knox attestation', icon: '✅' };
    }
  }
  return { name: 'unknown', type: 'Unknown root certificate', icon: '❌' };
}

// ============================================================================
// MAIN VALIDATION LOGIC
// ============================================================================

async function validateKeybox(xmlContent) {
  const result = { success: false, report: [], status: [] };

  try {
    const numCerts = parseNumberOfCertificates(xmlContent);
    const pemCerts = parseCertificates(xmlContent, numCerts);

    if (pemCerts.length === 0) {
      throw new Error('No certificates found in keybox');
    }

    // Đọc thông tin chi tiết bằng @peculiar/x509
    const firstCertValidity = checkCertificateValidity(pemCerts[0]);
    const cert = new X509Certificate(pemCerts[0]);
    const serialNumber = cert.serialNumber.toLowerCase();

    result.report.push(`🔐 *Serial number:* \`${serialNumber}\``);
    result.report.push(`ℹ️ *Subject:* \`${cert.subject}\``);

    if (firstCertValidity.isValid) {
      result.report.push('✅ Certificate within validity period');
      result.status.push('valid_period');
    } else if (firstCertValidity.expired) {
      result.report.push('❌ Expired certificate');
      result.status.push('expired');
    } else {
      result.report.push('❌ Invalid certificate (not yet valid)');
      result.status.push('not_yet_valid');
    }

    // Verify Certificate Chain bằng thư viện `pem`
    const chainValid = await verifyCertificateChain(pemCerts);
    if (chainValid) {
      result.report.push('✅ Valid keychain');
      result.status.push('chain_valid');
    } else {
      result.report.push('❌ Invalid keychain');
      result.status.push('chain_invalid');
    }

    // Check Root Certificate
    const rootCertInfo = identifyRootCert(pemCerts[pemCerts.length - 1]);
    result.report.push(`${rootCertInfo.icon} ${rootCertInfo.type}`);
    result.status.push(`root_${rootCertInfo.name}`);

    // Check Revocation List
    const revocationList = await loadRevocationList();
    const isRevoked = revocationList.entries?.[serialNumber];
    if (isRevoked) {
      result.report.push(`❌ Serial number found in Google's revoked list`);
      result.report.push(`🔍 *Reason:* \`${isRevoked.reason}\``);
      result.status.push('revoked');
    } else {
      result.report.push("✅ Serial number not found in Google's revoked list");
      result.status.push('not_revoked');
    }

    result.report.push(`⏱ *Check Time (UTC):* ${new Date().toISOString().split('T')[0]}`);
    result.success = true;
  } catch (error) {
    result.report = [`❌ Validation Error: ${error.message}`];
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
    console.error('Failed to send Telegram message:', error.response?.data || error.message);
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
        'Please send me a keybox.xml, and I will check if it is valid.'
      );
    }
    return;
  }

  if (message.document) {
    const doc = message.document;

    if (doc.mime_type !== 'application/xml' && doc.mime_type !== 'text/xml') {
      await sendTelegramMessage(chatId, 'File format error. Please send an XML file.');
      return;
    }

    if (doc.file_size > 20 * 1024) {
      await sendTelegramMessage(chatId, 'File size is too large (max 20KB).');
      return;
    }

    try {
      const fileInfo = await telegramClient.get(`/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileInfo.data.result.file_path;
      const xmlContent = await downloadFromTelegram(filePath);

      const validation = await validateKeybox(xmlContent);
      await sendTelegramMessage(chatId, validation.report.join('\n'));
    } catch (error) {
      console.error('Validation error:', error.message);
      await sendTelegramMessage(chatId, `Error processing file: ${error.message}`);
    }
    return;
  }

  if (message.text === '/check') {
    const replyTo = message.reply_to_message;
    if (!replyTo?.document) {
      await sendTelegramMessage(chatId, 'Please reply to a keybox.xml file with /check');
      return;
    }

    const doc = replyTo.document;
    if (doc.mime_type !== 'application/xml' && doc.mime_type !== 'text/xml') {
      await sendTelegramMessage(chatId, 'File format error.');
      return;
    }

    if (doc.file_size > 20 * 1024) {
      await sendTelegramMessage(chatId, 'File size is too large.');
      return;
    }

    try {
      const fileInfo = await telegramClient.get(`/bot${TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileInfo.data.result.file_path;
      const xmlContent = await downloadFromTelegram(filePath);

      const validation = await validateKeybox(xmlContent);
      await sendTelegramMessage(chatId, validation.report.join('\n'));
    } catch (error) {
      console.error('Validation error:', error.message);
      await sendTelegramMessage(chatId, `Error processing file: ${error.message}`);
    }
  }
}

// ============================================================================
// VERCEL SERVERLESS HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method === 'POST') {
    // API trực tiếp
    if (req.body.xml) {
      try {
        const result = await validateKeybox(req.body.xml);
        return res.status(200).json(result);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }

    // Telegram Webhook (Thêm await để không bị ngắt kết nối Socket giữa chừng)
    try {
      if (req.body && req.body.update_id) {
        await handleTelegramUpdate(req.body);
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Handler error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'KeyboxChecker API is running',
      endpoints: {
        telegram: 'POST /api with Telegram webhook',
        direct: 'POST /api with { xml: "<keybox>...</keybox>" }',
      },
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
