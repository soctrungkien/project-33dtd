import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import https from 'https';
import dns from 'dns';
import UserAgent from 'user-agents';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { X509Certificate } from '@peculiar/x509';

// ==========================================================
// CẤU HÌNH & KHỞI TẠO BOT
// ==========================================================

const BOT_TOKEN = process.env.BOT_TOKEN_KEYBOX || process.env.TELEGRAM_BOT_TOKEN_CHECK_KEYBOX;
const USERNAME_BOT_CHECK = process.env.USERNAME_BOT_CHECK_KEYBOX;

const bot = new Telegraf(BOT_TOKEN);

dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']);

const PROXY_URL = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

function getRandomUserAgent() {
  return new UserAgent().toString();
}

async function safeFetch(url, extraHeaders = {}) {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': '*/*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    ...extraHeaders
  };

  const config = {
    headers,
    timeout: 12000,
    responseType: 'arraybuffer',
    validateStatus: () => true
  };

  if (proxyAgent) {
    config.httpsAgent = proxyAgent;
    config.httpAgent = proxyAgent;
  } else {
    config.httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  const response = await axios.get(url, config);
  const buffer = Buffer.from(response.data);

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    buffer,
    text: () => buffer.toString('utf-8'),
    json: () => JSON.parse(buffer.toString('utf-8'))
  };
}

// Cache trạng thái Keybox giúp load nút chọn nhanh
const statusCache = new Map();

// ==========================================================
// DANH SÁCH NGUỒN KEYBOX
// ==========================================================

const SOURCES = [
  {
    id: 'yuri',
    name: 'Yuri',
    type: 'base64',
    url: 'https://raw.githubusercontent.com/Yurii0307/yurikey/main/key',
    commitApi: 'https://api.github.com/repos/Yurii0307/yurikey/commits?path=key&page=1&per_page=1'
  },
  {
    id: 'kaorios',
    name: 'Kaorios',
    type: 'xml',
    url: 'https://raw.githubusercontent.com/Wuang26/Kaorios-Toolbox/refs/heads/main/Toolbox-data/Keybox.xml',
    commitApi: 'https://api.github.com/repos/Wuang26/Kaorios-Toolbox/commits?path=Toolbox-data/Keybox.xml&page=1&per_page=1'
  },
  {
    id: 'evoker',
    name: 'Evoker',
    type: 'base64',
    url: 'https://evoker.qzz.io/key',
    commitApi: null
  },
  {
    id: 'kow',
    name: 'KOW',
    type: 'hex-base64',
    url: 'https://raw.githubusercontent.com/KOWX712/Tricky-Addon-Update-Target-List/keybox/.extra',
    commitApi: 'https://api.github.com/repos/KOWX712/Tricky-Addon-Update-Target-List/commits?path=.extra&ref=keybox&page=1&per_page=1'
  },
  {
    id: 'hihi',
    name: 'HihiKeybox',
    type: 'base64',
    url: 'https://raw.githubusercontent.com/soctrungkien/1HzH9Axaj/main/kezz',
    commitApi: 'https://api.github.com/repos/soctrungkien/1HzH9Axaj/commits?path=kezz&page=1&per_page=1'
  },
  {
    id: 'lonemods',
    name: 'LoneMods',
    type: 'xml',
    url: 'https://raw.githubusercontent.com/dare-devil-ex/keyboxxBot/main/keybox.xml',
    commitApi: 'https://api.github.com/repos/dare-devil-ex/keyboxxBot/commits?path=keybox.xml&page=1&per_page=1'
  },
  {
    id: 'freecamk',
    name: 'FREECAMK',
    type: 'xml',
    url: 'https://raw.githubusercontent.com/FREECAMK/Keybox-Play-Integrity-/main/keybox.xml',
    commitApi: 'https://api.github.com/repos/FREECAMK/Keybox-Play-Integrity-/commits?path=keybox.xml&page=1&per_page=1'
  },
  {
    id: 'davide',
    name: 'DavidePalma',
    type: 'xml',
    url: 'https://www.davidepalma.it/pib/keybox.xml',
    commitApi: null,
    extraHeaders: { 'Upgrade-Insecure-Requests': '1' }
  },
  {
    id: 'tricky',
    name: 'TrickyBox',
    type: 'base64',
    url: 'https://raw.githubusercontent.com/GueRapii/randommodulesfiles/main/file.enc',
    commitApi: 'https://api.github.com/repos/GueRapii/randommodulesfiles/commits?path=file.enc&page=1&per_page=1'
  },
  {
    id: 'zkos',
    name: 'Zkos',
    type: 'xml',
    url: 'https://raw.githubusercontent.com/zuri1503/Toolbox-Database/refs/heads/main/keybox.xml',
    commitApi: 'https://api.github.com/repos/zuri1503/Toolbox-Database/commits?path=keybox.xml&page=1&per_page=1'
  }
];

// DANH SÁCH PIXEL DỰ PHÒNG (FALLBACK)
const FALLBACK_PIXELS = [
  { model: "Pixel 6", product: "oriole_beta" },
  { model: "Pixel 6 Pro", product: "raven_beta" },
  { model: "Pixel 6a", product: "bluejay_beta" },
  { model: "Pixel 7", product: "panther_beta" },
  { model: "Pixel 7 Pro", product: "cheetah_beta" },
  { model: "Pixel 7a", product: "lynx_beta" },
  { model: "Pixel 8", product: "shiba_beta" },
  { model: "Pixel 8 Pro", product: "husky_beta" },
  { model: "Pixel 8a", product: "akita_beta" },
  { model: "Pixel 9", product: "tokay_beta" },
  { model: "Pixel 9 Pro", product: "caiman_beta" },
  { model: "Pixel 9 Pro XL", product: "komodo_beta" },
  { model: "Pixel Fold", product: "felix_beta" }
];

const PEM_KEYS = {
  google: `-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xU\nFmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5j\nlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y\n//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73X\npXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYI\nmQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB\n+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7q\nuvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgp\nZrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7\ngLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82\nixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+\nNpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==\n-----END PUBLIC KEY-----`,
  aosp_ec: `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7l1ex+HA220Dpn7mthvsTWpdamgu\nD/9/SQ59dx9EIm29sa/6FsvHrcV30lacqrewLVQBXT5DKyqO107sSHVBpA==\n-----END PUBLIC KEY-----`,
  aosp_rsa: `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCia63rbi5EYe/VDoLmt5TRdSMf\nd5tjkWP/96r/C3JHTsAsQ+wzfNes7UA+jCigZtX3hwszl94OuE4TQKuvpSe/lWmg\nMdsGUmX4RFlXYfC78hdLt0GAZMAoDo9Sd47b0ke2RekZyOmLw9vCkT/X11DEHTVm\n+Vfkl5YLCazOkjWFmwIDAQAB\n-----END PUBLIC KEY-----`,
  knox: `-----BEGIN PUBLIC KEY-----\nMIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBhbGuLrpql5I2WJmrE5kEVZOo+dgA\n46mKrVJf/sgzfzs2u7M9c1Y9ZkCEiiYkhTFE9vPbasmUfXybwgZ2EM30A1ABPd12\n4n3JbEDfsB/wnMH1AcgsJyJFPbETZiy42Fhwi+2BCA5bcHe7SrdkRIYSsdBRaKBo\nZsapxB0gAOs0jSPRX5M=\n-----END PUBLIC KEY-----`
};

// ==========================================================
// MODULE TRUST MANAGER, DECODER, PARSER, REPAIRER & ANALYZER
// ==========================================================

class TrustManager {
  constructor() {
    this.trustData = null;
    this.lastRefreshTime = 0;
  }

  async refreshTrustData(force = false) {
    const now = Date.now();
    if (!force && this.lastRefreshTime && now - this.lastRefreshTime < 15000) {
      return this.trustData;
    }

    try {
      const res = await safeFetch('https://android.googleapis.com/attestation/status');
      if (res.ok) {
        this.trustData = {
          status: res.json(),
          fetchedAt: new Date().toISOString()
        };
        this.lastRefreshTime = now;
      }
    } catch (err) {
      console.error('[TrustManager] Cập nhật CRL thất bại:', err.message);
    }

    return this.trustData || { status: { entries: {} } };
  }
}

const trustManager = new TrustManager();

export function decodeKeyboxBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));

  let nulEven = 0, nulOdd = 0;
  for (let i = 0; i < Math.min(data.length, 512); i++) {
    if (data[i] === 0) (i % 2 === 0 ? nulEven++ : nulOdd++);
  }

  if (nulOdd > 10 && nulOdd > nulEven * 3) return new TextDecoder('utf-16le').decode(data);
  if (nulEven > 10 && nulEven > nulOdd * 3) return new TextDecoder('utf-16be').decode(data);

  return new TextDecoder('utf-8').decode(data);
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return m ? m[2] : undefined;
}

function firstText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : undefined;
}

export function parseKeyboxXml(xmlText) {
  const xml = xmlText.replace(/^\ufeff/, '').replace(/<!--[\s\S]*?-->/g, '');
  const keyboxes = [];
  const keyboxRe = /<Keybox\b([^>]*)>([\s\S]*?)<\/Keybox>/gi;
  let kbMatch;

  while ((kbMatch = keyboxRe.exec(xml))) {
    const [, attrs, body] = kbMatch;
    const keys = [];
    const keyRe = /<Key\b([^>]*)>([\s\S]*?)<\/Key>/gi;
    let keyMatch;

    while ((keyMatch = keyRe.exec(body))) {
      const [, keyAttrs, keyBody] = keyMatch;
      const chain = firstText(keyBody, 'CertificateChain') || keyBody;
      const certs = [];
      const certRe = /<Certificate\b[^>]*format\s*=\s*(["'])pem\1[^>]*>([\s\S]*?)<\/Certificate>/gi;
      let certMatch;

      while ((certMatch = certRe.exec(chain))) {
        certs.push(certMatch[2].trim());
      }

      keys.push({
        algorithm: attr(keyAttrs, 'algorithm') || 'ECDSA',
        privateKeyPem: firstText(keyBody, 'PrivateKey') || '',
        certificatesPem: certs
      });
    }

    keyboxes.push({
      deviceId: attr(attrs, 'DeviceID') || 'Unknown',
      keys
    });
  }

  return { keyboxes };
}

export function standardizeCertPem(rawPem) {
  if (!rawPem) return '';
  const m = rawPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/i)
    || rawPem.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/i);

  const b64 = m ? m[1] : rawPem;
  const clean = b64.replace(/[\s\r\n]/g, '');
  if (!clean) return '';

  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function rebuildXmlFromParsed(parsed) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<KeyboxMetadata>\n';
  xml += `  <NumberOfKeyboxes>${parsed.keyboxes.length}</NumberOfKeyboxes>\n`;

  for (const keybox of parsed.keyboxes) {
    xml += `  <Keybox DeviceID="${keybox.deviceId}">\n`;
    for (const key of keybox.keys) {
      xml += `    <Key algorithm="${key.algorithm}">\n`;
      xml += `      <PrivateKey>\n${key.privateKeyPem.trim()}\n      </PrivateKey>\n`;
      xml += `      <CertificateChain>\n`;
      xml += `        <NumberOfCertificates>${key.certificatesPem.length}</NumberOfCertificates>\n`;
      for (const cert of key.certificatesPem) {
        xml += `        <Certificate format="pem">\n${cert.trim()}\n        </Certificate>\n`;
      }
      xml += `      </CertificateChain>\n`;
      xml += `    </Key>\n`;
    }
    xml += `  </Keybox>\n`;
  }

  xml += '</KeyboxMetadata>';
  return xml;
}

export async function repairKeybox(rawContent, trustData) {
  let content = typeof rawContent === 'string' ? rawContent : decodeKeyboxBytes(rawContent);
  const fixes = [];

  try {
    let parsed = parseKeyboxXml(content);

    if (!parsed.keyboxes || parsed.keyboxes.length === 0) {
      if (!content.includes('<KeyboxMetadata>')) {
        content = `<?xml version="1.0" encoding="UTF-8"?>\n<KeyboxMetadata>\n${content}\n</KeyboxMetadata>`;
        fixes.push('Tự động bổ sung thẻ bọc <KeyboxMetadata>');
      }
      parsed = parseKeyboxXml(content);
    }

    if (!parsed.keyboxes || parsed.keyboxes.length === 0) {
      throw new Error('Cấu trúc XML không hợp lệ.');
    }

    for (const keybox of parsed.keyboxes) {
      for (const key of keybox.keys) {
        const newCerts = [];
        for (const cert of key.certificatesPem) {
          try {
            const standardized = standardizeCertPem(cert);
            newCerts.push(standardized);
            if (standardized !== cert) {
              fixes.push('Chuẩn hóa PEM (64 ký tự/dòng)');
            }
          } catch (err) {}
        }
        key.certificatesPem = newCerts;
      }
    }

    const repairedXml = rebuildXmlFromParsed(parsed);
    const analysis = await analyzeKeybox(repairedXml, trustData);

    return {
      success: true,
      deviceId: parsed.keyboxes[0]?.deviceId || 'Unknown',
      summary: `Đã sửa ${fixes.length} lỗi`,
      fixesApplied: [...new Set(fixes)],
      repairedXml,
      analysis
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function comparePemKeys(pem1, pem2) {
  return pem1.replace(/\s/g, '') === pem2.replace(/\s/g, '');
}

function identifyRootCert(pemCert) {
  try {
    const cert = new X509Certificate(pemCert);
    const rootPublicKeyPem = cert.publicKey.toString('pem');

    for (const [name, key] of Object.entries(PEM_KEYS)) {
      if (comparePemKeys(rootPublicKeyPem, key)) {
        if (name === 'google') return { name, type: 'Google Hardware Attestation', isHardware: true };
        if (name === 'aosp_ec') return { name, type: 'AOSP Software Attestation (EC)', isHardware: false };
        if (name === 'aosp_rsa') return { name, type: 'AOSP Software Attestation (RSA)', isHardware: false };
        if (name === 'knox') return { name, type: 'Samsung Knox Attestation', isHardware: true };
      }
    }
  } catch (e) {}

  return { name: 'unknown', type: 'Root chứng chỉ không xác định', isHardware: false };
}

async function verifyCertificateChain(certs) {
  if (certs.length < 2) return true;
  try {
    for (let i = 0; i < certs.length - 1; i++) {
      const child = new X509Certificate(certs[i]);
      const parent = new X509Certificate(certs[i + 1]);
      if (child.issuer !== parent.subject) return false;
      const isValid = await child.verify({ publicKey: await parent.publicKey.export() });
      if (!isValid) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

export async function analyzeKeybox(xmlContent, trustData) {
  const parsed = parseKeyboxXml(xmlContent);
  const analysis = {
    overall: 'strong',
    warnings: [],
    errors: [],
    serials: [],
    keyboxes: []
  };

  if (!parsed.keyboxes || parsed.keyboxes.length === 0) {
    analysis.overall = 'banned';
    analysis.errors.push('Không tìm thấy dữ liệu Keybox hợp lệ.');
    return analysis;
  }

  for (const keybox of parsed.keyboxes) {
    for (const key of keybox.keys) {
      if (!key.privateKeyPem) {
        analysis.errors.push('Thiếu Private Key');
        analysis.overall = 'banned';
      }

      if (key.certificatesPem.length === 0) {
        analysis.errors.push('Thiếu chuỗi chứng chỉ');
        analysis.overall = 'banned';
        continue;
      }

      try {
        const leafCert = new X509Certificate(key.certificatesPem[0]);
        const serialNumber = leafCert.serialNumber.replace(/^0x/i, '').toLowerCase();
        analysis.serials.push(serialNumber);

        const now = new Date();
        if (now < leafCert.notBefore || now > leafCert.notAfter) {
          analysis.errors.push(`Chứng chỉ hết hạn (${serialNumber})`);
          analysis.overall = 'banned';
        }

        const revocationList = trustData?.status?.entries || {};
        if (revocationList[serialNumber]) {
          const reason = revocationList[serialNumber].reason || 'Revoked by Google';
          analysis.errors.push(`Serial <code>${serialNumber}</code> bị thu hồi (${reason})`);
          analysis.overall = 'banned';
        }
      } catch (e) {
        analysis.errors.push(`Lỗi đọc chứng chỉ: ${e.message}`);
        analysis.overall = 'banned';
      }

      const chainValid = await verifyCertificateChain(key.certificatesPem);
      if (!chainValid) {
        analysis.errors.push('Chuỗi chữ ký Keychain không hợp lệ');
        analysis.overall = 'banned';
      }

      const rootPem = key.certificatesPem[key.certificatesPem.length - 1];
      const rootInfo = identifyRootCert(rootPem);

      if (!rootInfo.isHardware && analysis.overall !== 'banned') {
        analysis.overall = 'device';
        analysis.warnings.push(`Sử dụng Root Software (${rootInfo.type})`);
      }
    }
  }

  return analysis;
}

async function getSourceStatus(source) {
  if (statusCache.has(source.id)) {
    const cached = statusCache.get(source.id);
    if (Date.now() - cached.time < 300000) return cached.status;
  }
  try {
    const { buffer } = await fetchAndFixKeyboxFromSource(source);
    const trustData = await trustManager.refreshTrustData();
    const analysis = await analyzeKeybox(buffer.toString('utf-8'), trustData);

    let icon = '✅';
    if (analysis.overall === 'device') icon = '⚠️';
    if (analysis.overall === 'banned') icon = '❌';

    const status = { icon, overall: analysis.overall };
    statusCache.set(source.id, { status, time: Date.now() });
    return status;
  } catch (e) {
    const status = { icon: '❌', overall: 'banned' };
    statusCache.set(source.id, { status, time: Date.now() });
    return status;
  }
}

async function fetchAndFixKeyboxFromSource(source) {
  const promises = [safeFetch(source.url, source.extraHeaders || {})];
  if (source.commitApi) promises.push(safeFetch(source.commitApi));

  const [fileRes, commitRes] = await Promise.all(promises);
  if (!fileRes || !fileRes.ok) throw new Error(`Không thể kết nối đến nguồn ${source.name}`);

  let rawBuffer = fileRes.buffer;

  if (source.type === 'base64') {
    const cleanBase64 = rawBuffer.toString('utf-8').replace(/\s+/g, '').trim();
    rawBuffer = Buffer.from(cleanBase64, 'base64');
  } else if (source.type === 'hex-base64') {
    const cleanHex = rawBuffer.toString('utf-8').replace(/[^0-9a-fA-F]/g, '');
    const base64Text = Buffer.from(cleanHex, 'hex').toString('utf-8').trim();
    rawBuffer = Buffer.from(base64Text, 'base64');
  }

  const trustData = await trustManager.refreshTrustData();
  const repairResult = await repairKeybox(rawBuffer, trustData);

  if (!repairResult.success) {
    throw new Error(`Sửa lỗi thất bại: ${repairResult.error}`);
  }

  let updateDate = 'Không xác định';
  let fileDate = new Date().toISOString().slice(0, 10);

  if (commitRes && commitRes.ok) {
    const commits = commitRes.json();
    if (commits[0]?.commit?.committer?.date) {
      const commitDate = commits[0].commit.committer.date;
      updateDate = new Date(commitDate).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      const d = new Date(commitDate);
      fileDate = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    }
  }

  return {
    buffer: Buffer.from(repairResult.repairedXml, 'utf-8'),
    updateDate,
    filename: `keybox-${source.id}-${fileDate}.xml`,
    analysis: repairResult.analysis,
    fixesApplied: repairResult.fixesApplied
  };
}

function formatAnalysisReport(analysis, fixesApplied = []) {
  let statusBadge = '';
  let statusDetail = '';

  if (analysis.overall === 'strong') {
    statusBadge = '✅ <b>[STRONG] - Hoàn toàn hợp lệ</b>';
    statusDetail = '• Chứng chỉ không bị thu hồi\n• Chuỗi chữ ký Keychain hợp lệ\n• Hardware Root Google/Knox';
  } else if (analysis.overall === 'device') {
    statusBadge = '⚠️ <b>[DEVICE] - Soft-ban / Cảnh báo</b>';
    statusDetail = '• Dùng Software Attestation (AOSP)\n• Cần chú ý khi dùng cho app ngân hàng';
  } else {
    statusBadge = '❌ <b>[BANNED] - Không thể sử dụng</b>';
    statusDetail = '• Đã bị Google thu hồi hoặc hỏng cấu trúc';
  }

  let report = `${statusBadge}\n\n📝 <b>Chi tiết đánh giá:</b>\n${statusDetail}\n`;

  if (analysis.serials && analysis.serials.length > 0) {
    report += `\n🔐 <b>Serial Number:</b> <code>${analysis.serials.join(', ')}</code>`;
  }

  if (fixesApplied.length > 0) {
    report += `\n\n🛠 <b>Đã tự động Auto-Fix:</b>\n` + fixesApplied.map(f => `• ${f}`).join('\n');
  }

  if (analysis.errors.length > 0) {
    report += `\n\n❌ <b>Lỗi phát hiện:</b>\n` + analysis.errors.map(e => `• ${e}`).join('\n');
  }

  return report;
}

// ==========================================================
// PIF & FLASHSTATION UTILS (THAY THẾ TOÀN BỘ SHELL SCRIPT)
// ==========================================================

async function fetchPixelDeviceList() {
  try {
    const res = await safeFetch('https://developer.android.com/about/versions');
    if (!res.ok) throw new Error('Failed to fetch version list');
    const html = res.text();

    let betaPath = html.match(/href="(\/about\/versions\/[^"]*preview[^"]*)"/i)?.[1];
    if (!betaPath) {
      const matches = [...html.matchAll(/href="(\/about\/versions\/[0-9]{2})"/g)];
      if (matches.length > 0) betaPath = matches[matches.length - 1][1];
    }

    if (betaPath) {
      const betaRes = await safeFetch(`https://developer.android.com${betaPath}`);
      const betaHtml = betaRes.text();

      const fiUrlMatch = betaHtml.match(/href="([^"]*download[^"]*)"/i)?.[1];
      const otaUrlMatch = betaHtml.match(/href="([^"]*download-ota[^"]*)"/i)?.[1];

      const fiRes = fiUrlMatch ? await safeFetch(`https://developer.android.com${fiUrlMatch}`) : null;
      const otaRes = otaUrlMatch ? await safeFetch(`https://developer.android.com${otaUrlMatch}`) : null;

      const fiHtml = fiRes ? fiRes.text() : '';
      const otaHtml = otaRes ? otaRes.text() : '';

      const fiCount = (fiHtml.match(/tr id=/g) || []).length;
      const otaCount = (otaHtml.match(/tr id=/g) || []).length;
      const targetHtml = fiCount >= otaCount ? fiHtml : otaHtml;

      const matches = [...targetHtml.matchAll(/<tr id="([^"]+)">[\s\S]*?<td>(.*?)<\/td>/g)];
      if (matches.length > 0) {
        return matches.map(m => ({
          product: `${m[1]}_beta`,
          model: m[2].replace(/<[^>]+>/g, '').trim()
        }));
      }
    }
  } catch (e) {
    console.error('Lỗi khi cào danh sách Pixel:', e.message);
  }
  return FALLBACK_PIXELS;
}

async function getFlashStationBuild(product) {
  const flashRes = await safeFetch('https://flash.android.com');
  const flashHtml = flashRes.text();
  const flashKeyMatch = flashHtml.match(/key=([^;&"'\s]+)/i) || flashHtml.match(/client-config=["']?.*?key=([^;&"'\s]+)/i);
  const flashKey = flashKeyMatch ? flashKeyMatch[1] : '';

  const apiUrl = `https://content-flashstation-pa.googleapis.com/v1/builds?product=${product}&key=${flashKey}`;
  const buildRes = await safeFetch(apiUrl, { 'Referer': 'https://flash.android.com' });
  const json = buildRes.json();

  const builds = Array.isArray(json) ? json : (json.builds || []);
  let canaryBuild = builds.find(b => b.canary === true) || builds[0] || {};

  const id = canaryBuild.releaseCandidateName || canaryBuild.id || "UP1A.231005.007";
  const incremental = canaryBuild.buildId || canaryBuild.incremental || "10839000";
  const canaryId = canaryBuild.id || "canary202405";

  return { id, incremental, canaryId };
}

async function getSecurityPatchLevel(canaryId = '') {
  try {
    const secRes = await safeFetch('https://source.android.com/docs/security/bulletin/pixel');
    const secHtml = secRes.text();

    if (canaryId) {
      const formattedCanaryId = canaryId.replace(/^canary-?/, '').replace(/^(\d{4})/, '$1-');
      const match = secHtml.match(new RegExp(`<td>${formattedCanaryId}[\\s\\S]*?<td>(\\d{4}-\\d{2}-\\d{2})<\/td>`, 'i'));
      if (match) return match[1];
    }

    const latestMatch = secHtml.match(/<td>(\d{4}-\d{2}-05)<\/td>/i);
    if (latestMatch) return latestMatch[1];
  } catch (e) {}

  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${m}-05`;
}

function renderPixelKeyboard(devices, page = 0, userId) {
  const ITEMS_PER_PAGE = 6;
  const totalPages = Math.ceil(devices.length / ITEMS_PER_PAGE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = currentPage * ITEMS_PER_PAGE;
  const pageDevices = devices.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const buttons = [];
  for (let i = 0; i < pageDevices.length; i += 2) {
    const row = [
      Markup.button.callback(`📱 ${pageDevices[i].model}`, `get_pif:${pageDevices[i].product}:${userId}`)
    ];
    if (pageDevices[i + 1]) {
      row.push(Markup.button.callback(`📱 ${pageDevices[i + 1].model}`, `get_pif:${pageDevices[i + 1].product}:${userId}`));
    }
    buttons.push(row);
  }

  // Điều hướng bằng 2 mũi tên qua lại
  const navRow = [];
  if (currentPage > 0) {
    navRow.push(Markup.button.callback('⬅️ Trước', `pif_page:${currentPage - 1}:${userId}`));
  } else {
    navRow.push(Markup.button.callback('⏹', 'noop'));
  }

  navRow.push(Markup.button.callback(`📄 ${currentPage + 1}/${totalPages}`, 'noop'));

  if (currentPage < totalPages - 1) {
    navRow.push(Markup.button.callback('▶️ Sau', `pif_page:${currentPage + 1}:${userId}`));
  } else {
    navRow.push(Markup.button.callback('⏹', 'noop'));
  }

  buttons.push(navRow);
  return Markup.inlineKeyboard(buttons);
}

// ==========================================================
// TELEGRAM BOT COMMANDS & ACTIONS
// ==========================================================

bot.command('start', async (ctx) => {
  await ctx.reply(
    "👋 <b>Hệ Thống Phân Tích Keybox & Play Integrity Fix (PIF)</b>\n\n" +
    "📖 <b>Danh sách lệnh:</b>\n" +
    "• /keybox - Tải Keybox (Hiển thị icon trạng thái ${icon}${name} & Auto-Fix)\n" +
    "• /pif - Tải file PIF (<code>pif.json</code> & <code>pif.prop</code>) chọn dòng máy Pixel\n" +
    "• /security_patch - Lấy thông tin bản vá bảo mật mới nhất từ Google\n" +
    "• /check - Kiểm tra trạng thái toàn bộ nguồn Keybox",
    { parse_mode: 'HTML' }
  );
});

// Lệnh /keybox với Icon "${icon}${name}"
bot.command('keybox', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');

  const sourceStatuses = await Promise.all(
    SOURCES.map(async (src) => {
      const st = await getSourceStatus(src);
      return { ...src, icon: st.icon };
    })
  );

  const buttons = [];
  for (let i = 0; i < sourceStatuses.length; i += 2) {
    const s1 = sourceStatuses[i];
    const s2 = sourceStatuses[i + 1];
    const row = [Markup.button.callback(`${s1.icon}${s1.name}`, `get_keybox:${s1.id}:${userId}`)];
    if (s2) {
      row.push(Markup.button.callback(`${s2.icon}${s2.name}`, `get_keybox:${s2.id}:${userId}`));
    }
    buttons.push(row);
  }

  await ctx.reply('🔑 <b>Vui lòng chọn nguồn Keybox (Kèm trạng thái thực tế):</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^get_keybox:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
  const sourceId = ctx.match[1];
  const ownerId = Number(ctx.match[2]);

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('⏳ Đang xử lý và sửa lỗi file Keybox...').catch(() => {});
  try {
    await ctx.editMessageText('⏳ <i>Đang giải mã, sửa lỗi XML/PEM và phân tích...</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  try {
    const source = SOURCES.find(s => s.id === sourceId);
    if (!source) throw new Error('Không tìm thấy nguồn Keybox này');

    const { buffer, updateDate, filename, analysis, fixesApplied } = await fetchAndFixKeyboxFromSource(source);
    const reportText = formatAnalysisReport(analysis, fixesApplied);

    await ctx.replyWithDocument(
      { source: buffer, filename },
      {
        caption:
          `🔑 <b>File Keybox (${source.name})</b>\n` +
          `📅 Cập nhật: <code>${updateDate}</code>\n\n` +
          `${reportText}`,
        parse_mode: 'HTML'
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Lỗi khi xử lý Keybox: ${error.message}`);
  } finally {
    await ctx.deleteMessage().catch(() => {});
  }
});

// Lệnh /pif chọn Pixel có phân trang bằng 2 mũi tên qua lại
bot.command('pif', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');

  const devices = await fetchPixelDeviceList();
  const keyboard = renderPixelKeyboard(devices, 0, userId);

  await ctx.reply('📱 <b>Chọn dòng máy Pixel để tạo file PIF (Play Integrity Fix):</b>', {
    parse_mode: 'HTML',
    ...keyboard
  });
});

bot.action(/^pif_page:(\d+):(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const ownerId = Number(ctx.match[2]);

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  const devices = await fetchPixelDeviceList();
  const keyboard = renderPixelKeyboard(devices, page, ownerId);

  try {
    await ctx.editMessageText('📱 <b>Chọn dòng máy Pixel để tạo file PIF (Play Integrity Fix):</b>', {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (e) {}
});

bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action(/^get_pif:([a-z0-9_]+):(\d+)$/, async (ctx) => {
  const product = ctx.match[1];
  const ownerId = Number(ctx.match[2]);

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('⏳ Đang lấy thông tin Build từ Google FlashStation...').catch(() => {});

  try {
    await ctx.sendChatAction('upload_document');
    const devices = await fetchPixelDeviceList();
    const devInfo = devices.find(d => d.product === product) || { model: 'Pixel Canary', product };

    const deviceName = product.replace(/_beta$/, '');
    const build = await getFlashStationBuild(product);
    const securityPatch = await getSecurityPatchLevel(build.canaryId);

    const fingerprint = `google/${product}/${deviceName}:CANARY/${build.id}/${build.incremental}:user/release-keys`;

    // Tạo pif.json
    const pifJsonData = {
      PRODUCT: product,
      DEVICE: deviceName,
      MANUFACTURER: "Google",
      MODEL: devInfo.model,
      FINGERPRINT: fingerprint,
      SECURITY_PATCH: securityPatch,
      spoofBuild: true,
      spoofProps: true,
      spoofProvider: true,
      spoofSignature: true,
      spoofVendingBuild: true,
      spoofVendingSdk: true
    };

    // Tạo pif.prop
    const pifPropData =
      `FINGERPRINT=${fingerprint}\n` +
      `MANUFACTURER=Google\n` +
      `MODEL=${devInfo.model}\n` +
      `SECURITY_PATCH=${securityPatch}\n` +
      `spoofBuild=true\n` +
      `spoofProps=true\n` +
      `spoofProvider=true\n` +
      `spoofSignature=true\n` +
      `spoofVendingBuild=true\n` +
      `spoofVendingSdk=true\n` +
      `DEBUG=false\n`;

    const jsonBuffer = Buffer.from(JSON.stringify(pifJsonData, null, 2), 'utf-8');
    const propBuffer = Buffer.from(pifPropData, 'utf-8');

    const caption =
      `✅ <b>ĐÃ TẠO THÀNH CÔNG PIF (Play Integrity Fix)</b>\n\n` +
      `📱 <b>Model:</b> <code>${devInfo.model}</code> (<code>${product}</code>)\n` +
      `🛡 <b>Security Patch:</b> <code>${securityPatch}</code>\n` +
      `📦 <b>ID Build:</b> <code>${build.id}</code> | Incremental: <code>${build.incremental}</code>\n` +
      `🔏 <b>Fingerprint:</b>\n<code>${fingerprint}</code>`;

    await ctx.replyWithDocument({ source: jsonBuffer, filename: `pif_${deviceName}.json` });
    await ctx.replyWithDocument(
      { source: propBuffer, filename: `pif_${deviceName}.prop` },
      { caption, parse_mode: 'HTML' }
    );
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi khởi tạo PIF: ${err.message}`);
  }
});

// Lệnh /security_patch
bot.command('security_patch', async (ctx) => {
  await ctx.sendChatAction('typing');

  try {
    const build = await getFlashStationBuild('oriole_beta');
    const patch = await getSecurityPatchLevel(build.canaryId);

    const message =
      `🛡 <b>BẢN VÁ BẢO MẬT (SECURITY PATCH LEVEL)</b>\n\n` +
      `📅 <b>Mới nhất:</b> <code>${patch}</code>\n` +
      `🆔 <b>Canary ID:</b> <code>${build.canaryId}</code>\n` +
      `📦 <b>Build ID:</b> <code>${build.id}</code>\n` +
      `📈 <b>Incremental:</b> <code>${build.incremental}</code>`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`❌ Không thể tra cứu bản vá bảo mật: ${err.message}`);
  }
});

bot.command('check', async (ctx) => {
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.document) return handleDocumentValidation(ctx, replyTo.document);

  await ctx.sendChatAction('typing');
  const trustData = await trustManager.refreshTrustData();

  const results = await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const { buffer } = await fetchAndFixKeyboxFromSource(src);
        const analysis = await analyzeKeybox(buffer.toString('utf-8'), trustData);

        let icon = '✅';
        if (analysis.overall === 'device') icon = '⚠️';
        if (analysis.overall === 'banned') icon = '❌';

        return { name: src.name, status: analysis.overall, icon };
      } catch (err) {
        return { name: src.name, status: 'banned', icon: '❌' };
      }
    })
  );

  let message = '📊 <b>KẾT QUẢ KIỂM TRA TOÀN BỘ NGUỒN KEYBOX:</b>\n\n';
  results.forEach((item) => {
    message += `<blockquote>${item.icon} <b>${item.name}</b>: <code>${item.status.toUpperCase()}</code></blockquote>\n`;
  });

  if (USERNAME_BOT_CHECK) message += `\n@${USERNAME_BOT_CHECK}`;
  await ctx.reply(message.trim(), { parse_mode: 'HTML' });
});

bot.on('document', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await handleDocumentValidation(ctx, ctx.message.document);
  }
});

async function handleDocumentValidation(ctx, doc) {
  const fileName = doc.file_name || '';
  if (!fileName.endsWith('.xml') && doc.mime_type !== 'text/xml' && doc.mime_type !== 'application/xml') {
    return ctx.reply('❌ Vui lòng gửi file định dạng XML (<code>.xml</code>).', { parse_mode: 'HTML' });
  }

  await ctx.sendChatAction('upload_document');

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const rawBuffer = Buffer.from(res.data);

    const trustData = await trustManager.refreshTrustData();
    const repairResult = await repairKeybox(rawBuffer, trustData);

    if (!repairResult.success) {
      return ctx.reply(`❌ <b>Không thể phân tích file XML:</b> ${repairResult.error}`, { parse_mode: 'HTML' });
    }

    const reportText = formatAnalysisReport(repairResult.analysis, repairResult.fixesApplied);
    const fixedBuffer = Buffer.from(repairResult.repairedXml, 'utf-8');

    await ctx.replyWithDocument(
      { source: fixedBuffer, filename: `fixed_${fileName}` },
      {
        caption: `🛠 <b>Đã phân tích & Tự động Auto-Fix File:</b>\n\n${reportText}`,
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi xử lý file: ${err.message}`);
  }
}

// Handler cho Vercel / Express
export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).send('OK');
    } catch (error) {
      console.error('Lỗi Telegram Update:', error);
      return res.status(200).send('OK');
    }
  }

  return res.status(200).json({
    status: 'Keybox & PIF Bot API đang hoạt động',
    time: new Date().toISOString()
  });
}
