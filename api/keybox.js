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

// Khóa chống spam & Quản lý trạng thái nút
const activeLocks = new Set();
const processedMessages = new Set();

function getRandomUserAgent() {
  return new UserAgent().toString();
}

const SOURCE_TIMEOUT = 10000;

async function safeFetch(
  url,
  extraHeaders = {},
  timeout = SOURCE_TIMEOUT
) {
  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': '*/*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    ...extraHeaders
  };

  const config = {
    headers,
    timeout,
    responseType: 'arraybuffer',
    validateStatus: () => true
  };

  if (proxyAgent) {
    config.httpsAgent = proxyAgent;
    config.httpAgent = proxyAgent;
  } else {
    config.httpsAgent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true
    });
  }

  const response = await axios.get(url, config);
  const buffer = Buffer.from(response.data);

  return {
    ok: response.status >= 200 &&
        response.status < 300,
    status: response.status,
    buffer,
    text: () => buffer.toString('utf8'),
    json: () =>
      JSON.parse(buffer.toString('utf8'))
  };
}

// Hàm gửi menu tự động xóa sau 1 phút (60000 ms)
async function sendTemporaryMenu(ctx, text, extra, timeoutMs = 60000) {
  const sentMsg = await ctx.reply(text, {
    reply_parameters: { message_id: ctx.message.message_id },
    ...extra
  });

  const chatId = sentMsg.chat.id;
  const messageId = sentMsg.message_id;

  setTimeout(async () => {
    if (!processedMessages.has(messageId)) {
      processedMessages.add(messageId);
      try {
        await ctx.telegram.deleteMessage(chatId, messageId);
      } catch (e) {}
    }
  }, timeoutMs);

  return sentMsg;
}

// Cache trạng thái Keybox giúp load nút chọn nhanh
const statusCache = new Map();

const STATUS_CACHE_TTL = 300000;

function getCachedSourceStatus(sourceId) {
  const cached = statusCache.get(sourceId);

  if (!cached) return null;

  if (Date.now() - cached.time > STATUS_CACHE_TTL) {
    statusCache.delete(sourceId);
    return null;
  }

  return cached;
}

function setCachedSourceStatus(sourceId, value) {
  statusCache.set(sourceId, {
    ...value,
    time: Date.now()
  });
}

const CHECK_CONCURRENCY = 8;

async function runWithConcurrency(items, worker, concurrency = 8) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          error,
          item: items[index],
          index
        };
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, concurrency),
    Math.max(1, items.length)
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => runner())
  );

  return results;
}

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

const PEM_KEYS = {
  google: `-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xU\nFmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5j\nlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y\n//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73X\npXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYI\nmQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB\n+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7q\nuvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgp\nZrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7\ngLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82\nixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+\nNpUFgNPN9PvQi8WEg5UmAGMCAwEAAQ==\n-----END PUBLIC KEY-----`,
  aosp_ec: `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7l1ex+HA220Dpn7mthvsTWpdamgu\nD/9/SQ59dx9EIm29sa/6FsvHrcV30lacqrewLVQBXT5DKyqO107sSHVBpA==\n-----END PUBLIC KEY-----`,
  aosp_rsa: `-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCia63rbi5EYe/VDoLmt5TRdSMf\nd5tjkWP/96r/C3JHTsAsQ+wzfNes7UA+jCigZtX3hwszl94OuE4TQKuvpSe/lWmg\nMdsGUmX4RFlXYfC78hdLt0GAZMAoDo9Sd47b0ke2RekZyOmLw9vCkT/X11DEHTVm\n+Vfkl5YLCazOkjWFmwIDAQAB\n-----END PUBLIC KEY-----`,
  knox: `-----BEGIN PUBLIC KEY-----\nMIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBhbGuLrpql5I2WJmrE5kEVZOo+dgA\n46mKrVJf/sgzfzs2u7M9c1Y9ZkCEiiYkhTFE9vPbasmUfXybwgZ2EM30A1ABPd12\n4n3JbEDfsB/wnMH1AcgsJyJFPbETZiy42Fhwi+2BCA5bcHe7SrdkRIYSsdBRaKBo\nZsapxB0gAOs0jSPRX5M=\n-----END PUBLIC KEY-----`
};

// ==========================================================
// MODULE TRUST MANAGER, DECODER, PARSER & ANALYZER
// ==========================================================

class TrustManager {
  constructor() {
    this.trustData = null;
    this.lastRefreshTime = 0;
    this.refreshPromise = null;

    this.cacheTtl = 15000;
  }

  async refreshTrustData(force = false) {
    const now = Date.now();

    if (
      !force &&
      this.trustData &&
      this.lastRefreshTime &&
      now - this.lastRefreshTime < this.cacheTtl
    ) {
      return this.trustData;
    }

    if (!force && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const res = await safeFetch(
          'https://android.googleapis.com/attestation/status'
        );

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        this.trustData = {
          status: res.json(),
          fetchedAt: new Date().toISOString()
        };

        this.lastRefreshTime = Date.now();

        return this.trustData;
      } catch (err) {
        console.error(
          '[TrustManager] Cập nhật status thất bại:',
          err.message
        );

        return this.trustData || {
          status: {
            entries: {}
          }
        };
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
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

      const numCertsMatch = chain.match(/<NumberOfCertificates\b[^>]*>(\d+)<\/NumberOfCertificates>/i);
      const numCertsTag = numCertsMatch ? parseInt(numCertsMatch[1], 10) : 0;

      const certs = [];
      const certRe = /<Certificate\b[^>]*format\s*=\s*(["'])pem\1[^>]*>([\s\S]*?)<\/Certificate>/gi;
      let certMatch;

      while ((certMatch = certRe.exec(chain))) {
        certs.push(certMatch[2].trim());
      }

      if (numCertsTag === 4 || certs.length === 4) {
        certs.pop();
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
    keyboxes: [],
    rootTypes: [],
    checks: {
      structure: true,
      privateKey: true,
      certificate: true,
      certificateValidity: true,
      revocation: true,
      chain: true,
      hardwareRoot: true
    }
  };

  if (!parsed.keyboxes?.length) {
    analysis.overall = 'banned';

    analysis.checks.structure = false;
    analysis.errors.push(
      'Không tìm thấy dữ liệu Keybox hợp lệ.'
    );

    return analysis;
  }

  let hasSoftwareRoot = false;
  let hasUnknownRoot = false;
  let hasHardwareRoot = false;

  const revocationList =
    trustData?.status?.entries || {};

  for (const keybox of parsed.keyboxes) {
    for (const key of keybox.keys) {
      const keyResult = {
        deviceId: keybox.deviceId,
        algorithm: key.algorithm,
        serial: null,
        root: null,
        chainValid: false,
        valid: false,
        revoked: false
      };

      if (!key.privateKeyPem) {
        analysis.checks.privateKey = false;
        analysis.errors.push(
          `Thiếu Private Key (${keybox.deviceId})`
        );
      }

      if (!key.certificatesPem?.length) {
        analysis.checks.certificate = false;
        analysis.errors.push(
          `Thiếu chuỗi chứng chỉ (${keybox.deviceId})`
        );
        continue;
      }

      const stdCerts = key.certificatesPem
        .map(standardizeCertPem)
        .filter(Boolean);

      if (!stdCerts.length) {
        analysis.checks.certificate = false;
        analysis.errors.push(
          `Không đọc được certificate (${keybox.deviceId})`
        );
        continue;
      }

      let leafCert;

      try {
        leafCert = new X509Certificate(stdCerts[0]);

        const serialNumber = leafCert.serialNumber
          .replace(/^0x/i, '')
          .toLowerCase();

        keyResult.serial = serialNumber;

        analysis.serials.push(serialNumber);

        const now = new Date();

        if (
          now < leafCert.notBefore ||
          now > leafCert.notAfter
        ) {
          analysis.checks.certificateValidity = false;

          analysis.errors.push(
            `Chứng chỉ hết hạn/chưa có hiệu lực (${serialNumber})`
          );
        }

        if (revocationList[serialNumber]) {
          keyResult.revoked = true;

          analysis.checks.revocation = false;

          const reason =
            revocationList[serialNumber]?.reason ||
            'Revoked by Google';

          analysis.errors.push(
            `Serial <code>${serialNumber}</code> bị thu hồi (${reason})`
          );
        }
      } catch (error) {
        analysis.checks.certificate = false;

        analysis.errors.push(
          `Lỗi đọc chứng chỉ: ${error.message}`
        );

        continue;
      }

      const chainValid =
        await verifyCertificateChain(stdCerts);

      keyResult.chainValid = chainValid;

      if (!chainValid) {
        analysis.checks.chain = false;

        analysis.errors.push(
          `Chuỗi chứng chỉ không hợp lệ (${keybox.deviceId})`
        );
      }

      let rootInfo;

      try {
        rootInfo = identifyRootCert(
          stdCerts[stdCerts.length - 1]
        );
      } catch {
        rootInfo = {
          name: 'unknown',
          type: 'Root không xác định',
          isHardware: false
        };
      }

      keyResult.root = rootInfo;

      analysis.rootTypes.push(rootInfo);

      if (rootInfo.isHardware) {
        hasHardwareRoot = true;
      } else if (rootInfo.name === 'unknown') {
        hasUnknownRoot = true;
      } else {
        hasSoftwareRoot = true;
      }

      keyResult.valid =
        Boolean(key.privateKeyPem) &&
        Boolean(stdCerts.length) &&
        chainValid &&
        !keyResult.revoked &&
        leafCert &&
        new Date() >= leafCert.notBefore &&
        new Date() <= leafCert.notAfter;

      analysis.keyboxes.push(keyResult);
    }
  }

  /*
   * CLASSIFICATION
   */

  const hardFailures =
    !analysis.checks.structure ||
    !analysis.checks.privateKey ||
    !analysis.checks.certificate ||
    !analysis.checks.certificateValidity ||
    !analysis.checks.revocation ||
    !analysis.checks.chain;

  if (hardFailures) {
    analysis.overall = 'banned';
    return analysis;
  }

  if (hasHardwareRoot && !hasSoftwareRoot && !hasUnknownRoot) {
    analysis.overall = 'strong';

    analysis.warnings = [];
    return analysis;
  }

  if (hasSoftwareRoot) {
    analysis.overall = 'device';

    analysis.warnings.push(
      'Certificate chain hợp lệ nhưng sử dụng Software Attestation/AOSP root.'
    );

    return analysis;
  }

  if (hasUnknownRoot) {
    analysis.overall = 'device';

    analysis.warnings.push(
      'Certificate chain hợp lệ nhưng root certificate chưa được nhận diện.'
    );

    return analysis;
  }

  analysis.overall = 'device';

  return analysis;
}

async function getSourceStatus(source, trustData = null) {
  const cached = getCachedSourceStatus(source.id);

  if (cached) {
    return cached.status;
  }

  try {
    const result = await fetchKeyboxFromSource(
      source,
      trustData || await trustManager.refreshTrustData()
    );

    const status = {
      icon: getStatusIcon(result.analysis.overall),
      overall: result.analysis.overall,
      analysis: result.analysis
    };

    setCachedSourceStatus(source.id, {
      status
    });

    return status;
  } catch (error) {
    const status = {
      icon: '❌',
      overall: 'error',
      error: error.message
    };

    setCachedSourceStatus(source.id, {
      status
    });

    return status;
  }
}

async function fetchKeyboxFromSource(source, trustData = null) {
  const promises = [
    safeFetch(source.url, source.extraHeaders || {})
  ];

  if (source.commitApi) {
    promises.push(
      safeFetch(source.commitApi, {
        Accept: 'application/vnd.github+json'
      })
    );
  }

  const results = await Promise.all(promises);

  const fileRes = results[0];
  const commitRes = results[1];

  if (!fileRes?.ok) {
    throw new Error(
      `Không thể kết nối đến nguồn ${source.name} (HTTP ${fileRes?.status || 0})`
    );
  }

  let rawBuffer = fileRes.buffer;

  if (source.type === 'base64') {
    const cleanBase64 = rawBuffer
      .toString('utf8')
      .replace(/\s+/g, '')
      .trim();

    rawBuffer = Buffer.from(cleanBase64, 'base64');
  }

  else if (source.type === 'hex-base64') {
    const cleanHex = rawBuffer
      .toString('utf8')
      .replace(/[^0-9a-fA-F]/g, '');

    const base64Text = Buffer
      .from(cleanHex, 'hex')
      .toString('utf8')
      .trim();

    rawBuffer = Buffer.from(base64Text, 'base64');
  }

  if (!rawBuffer.length) {
    throw new Error(
      `Nguồn ${source.name} trả về file rỗng`
    );
  }

  if (!trustData) {
    trustData = await trustManager.refreshTrustData();
  }

  const xmlString = decodeKeyboxBytes(rawBuffer);

  const analysis = await analyzeKeybox(
    xmlString,
    trustData
  );

  let updateDate = 'Không xác định';
  let fileDate = new Date()
    .toISOString()
    .slice(0, 10);

  if (commitRes?.ok) {
    try {
      const commits = commitRes.json();

      const commitDate =
        commits?.[0]?.commit?.committer?.date;

      if (commitDate) {
        const date = new Date(commitDate);

        updateDate = date.toLocaleString(
          'vi-VN',
          {
            timeZone: 'Asia/Ho_Chi_Minh'
          }
        );

        fileDate =
          `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;
      }
    } catch {}
  }

  return {
    buffer: rawBuffer,
    updateDate,
    filename: `keybox-${source.id}-${fileDate}.xml`,
    analysis
  };
}

function formatAnalysisReport(analysis) {
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

  if (analysis.errors.length > 0) {
    report += `\n\n❌ <b>Lỗi phát hiện:</b>\n` + analysis.errors.map(e => `• ${e}`).join('\n');
  }

  return report;
}

// ==========================================================
// PIF & FLASHSTATION UTILS (CÀO TRỰC TIẾP TỪ GOOGLE)
// ==========================================================

async function fetchPixelDeviceList() {
  try {
    const versionsRes = await safeFetch('https://developer.android.com/about/versions');

    if (!versionsRes.ok) {
      throw new Error('Không thể tải danh sách Android versions');
    }

    const versionsHtml = versionsRes.text();

    let latestBeta = versionsHtml.match(
      /href="(\/about\/versions\/[^"]*[0-9])"[^>]*>[\s\S]*?data-icon="preview"/i
    )?.[1];

    if (!latestBeta) {
      const matches = [
        ...versionsHtml.matchAll(
          /href="(\/about\/versions\/[0-9]{2})"/g
        )
      ];

      if (matches.length > 0) {
        latestBeta = matches
          .map(m => m[1])
          .sort()
          .reverse()[0];
      }
    }

    if (!latestBeta) {
      throw new Error('Không tìm thấy Android Preview mới nhất');
    }

    const latestRes = await safeFetch(
      `https://developer.android.com${latestBeta}`
    );

    if (!latestRes.ok) {
      throw new Error('Không thể tải trang Android Preview');
    }

    const latestHtml = latestRes.text();

    const downloadLinks = [
      ...latestHtml.matchAll(/href="([^"]*download[^"]*)"/gi)
    ].map(m => m[1]);

    const fiUrl = downloadLinks.find(url =>
      !/download-ota/i.test(url)
    );

    const otaUrl = downloadLinks.find(url =>
      /download-ota/i.test(url)
    );

    const fiRes = fiUrl
      ? await safeFetch(
          fiUrl.startsWith('http')
            ? fiUrl
            : `https://developer.android.com${fiUrl}`
        )
      : null;

    const otaRes = otaUrl
      ? await safeFetch(
          otaUrl.startsWith('http')
            ? otaUrl
            : `https://developer.android.com${otaUrl}`
        )
      : null;

    const fiHtml = fiRes?.ok ? fiRes.text() : '';
    const otaHtml = otaRes?.ok ? otaRes.text() : '';

    function extractDevices(html) {
      if (!html) return [];

      const rows = [
        ...html.matchAll(
          /<tr[^>]*id="([^"]+)"[^>]*>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi
        )
      ];

      return rows
        .map(match => {
          const product = match[1]
            .trim()
            .replace(/^"+|"+$/g, '');

          const model = match[2]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();

          if (!product || !model) return null;

          return {
            product: `${product}_beta`,
            model
          };
        })
        .filter(Boolean);
    }

    const fiDevices = extractDevices(fiHtml);
    const otaDevices = extractDevices(otaHtml);

    const devices =
      fiDevices.length >= otaDevices.length
        ? fiDevices
        : otaDevices;

    if (devices.length > 0) {
      return devices;
    }

    throw new Error('Không lấy được danh sách Pixel từ FI/OTA');
  } catch (e) {
    console.error(
      '[PIF] Lỗi khi lấy danh sách Pixel:',
      e.message
    );

    return [];
  }
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
      Markup.button.callback(`📄 ${pageDevices[i].model}`, `get_pif:${pageDevices[i].product}:${userId}`)
    ];
    if (pageDevices[i + 1]) {
      row.push(Markup.button.callback(`📄 ${pageDevices[i + 1].model}`, `get_pif:${pageDevices[i + 1].product}:${userId}`));
    }
    buttons.push(row);
  }

  const navRow = [];
  if (currentPage > 0) {
    navRow.push(Markup.button.callback('⬅️ Trước', `pif_page:${currentPage - 1}:${userId}`));
  } else {
    navRow.push(Markup.button.callback('⏹', 'noop'));
  }

  // Nút hiển thị số trang 📄 1/3 - Bấm vào sẽ tắt/xóa bảng chọn
  navRow.push(Markup.button.callback(`📄 ${currentPage + 1}/${totalPages}`, `close_menu:${userId}`));

  if (currentPage < totalPages - 1) {
    navRow.push(Markup.button.callback('▶️ Sau', `pif_page:${currentPage + 1}:${userId}`));
  } else {
    navRow.push(Markup.button.callback('⏹', 'noop'));
  }

  buttons.push(navRow);
  return Markup.inlineKeyboard(buttons);
}

function getStatusIcon(status) {
  switch (status) {
    case 'strong':
      return '✅';

    case 'device':
      return '⚠️';

    case 'banned':
      return '❌';

    default:
      return '❌';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================================================
// TELEGRAM BOT COMMANDS & ACTIONS
// ==========================================================

bot.command('start', async (ctx) => {
  await ctx.reply(
    "👋 <b>Hệ Thống Keybox & Play Integrity Fix (PIF)</b>\n\n" +
    "📖 <b>Danh sách lệnh:</b>\n" +
    "• /keybox - Tải Keybox\n" +
    "• /pif - Tải file PIF (<code>pif.json</code>) chọn dòng máy Pixel\n" +
    "• /check - Kiểm tra trạng thái toàn bộ nguồn Keybox",
    {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message.message_id }
    }
  );
});

// Lệnh /keybox
bot.command('keybox', async (ctx) => {
  await ctx.sendChatAction('typing');

const trustData =
  await trustManager.refreshTrustData();

const sourceStatuses =
  await runWithConcurrency(
    SOURCES,
    async (src) => {
      const st = await getSourceStatus(
        src,
        trustData
      );

      return {
        ...src,
        icon: st.icon,
        status: st.overall
      };
    },
    CHECK_CONCURRENCY
  );

  const buttons = [];
  for (let i = 0; i < sourceStatuses.length; i += 2) {
    const s1 = sourceStatuses[i];
    const s2 = sourceStatuses[i + 1];
    const row = [Markup.button.callback(`${s1.icon} ${s1.name}`, `get_keybox:${s1.id}:${ctx.from.id}`)];
    if (s2) {
      row.push(Markup.button.callback(`${s2.icon} ${s2.name}`, `get_keybox:${s2.id}:${ctx.from.id}`));
    }
    buttons.push(row);
  }

  await sendTemporaryMenu(ctx, '🔑 <b>Vui lòng chọn nguồn Keybox:</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  });
});

bot.action(/^get_keybox:([a-z0-9_-]+):(\d+)$/, async (ctx) => {
  const sourceId = ctx.match[1];
  const ownerId = Number(ctx.match[2]);
  const msgId = ctx.callbackQuery.message?.message_id;

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 SAO LẠI QUẤY RỐI NG TA', { show_alert: true }).catch(() => {});
  }

  if (processedMessages.has(msgId)) {
    return ctx.answerCbQuery('⚠️ Thao tác đã thực hiện hoặc menu đã hết hạn!', { show_alert: true }).catch(() => {});
  }

  if (activeLocks.has(msgId)) {
    return ctx.answerCbQuery('🥶SPAM!', { show_alert: true }).catch(() => {});
  }

  activeLocks.add(msgId);
  processedMessages.add(msgId);

  await ctx.answerCbQuery('⏳ Đang lấy file Keybox...').catch(() => {});

  const targetChatId = ctx.chat?.id;
  const replyToMsgId = ctx.callbackQuery.message?.reply_to_message?.message_id;

  if (msgId && targetChatId) {
    await ctx.telegram.deleteMessage(targetChatId, msgId).catch(() => {});
  }

  try {
    await ctx.sendChatAction('typing');
    const source = SOURCES.find(s => s.id === sourceId);
    if (!source) throw new Error('Không tìm thấy nguồn Keybox này');

    const { buffer, updateDate, filename, analysis } = await fetchKeyboxFromSource(source);
    const reportText = formatAnalysisReport(analysis);

    await ctx.sendChatAction('upload_document');
    await ctx.replyWithDocument(
      { source: buffer, filename },
      {
        caption:
          `🔑 <b>File Keybox (${source.name})</b>\n` +
          `📅 Cập nhật: <code>${updateDate}</code>\n\n` +
          `${reportText}`,
        parse_mode: 'HTML',
        ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {})
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Lỗi khi xử lý Keybox: ${error.message}`, {
      ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {})
    });
  } finally {
    activeLocks.delete(msgId);
  }
});

// Lệnh /pif
bot.command('pif', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');

  const devices = await fetchPixelDeviceList();

  if (!devices.length) {
    return ctx.reply('❌ Không thể lấy danh sách Pixel Canary từ Google.', {
      reply_parameters: { message_id: ctx.message.message_id }
    });
  }

  const keyboard = renderPixelKeyboard(devices, 0, userId);

  await sendTemporaryMenu(ctx, '📱 <b>Chọn dòng máy Pixel:</b>', {
    parse_mode: 'HTML',
    ...keyboard
  });
});

bot.action(/^pif_page:(\d+):(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const ownerId = Number(ctx.match[2]);
  const msgId = ctx.callbackQuery.message?.message_id;

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  if (processedMessages.has(msgId)) {
    return ctx.answerCbQuery('⚠️ Menu đã hết hạn hoặc đã được chọn!', { show_alert: true }).catch(() => {});
  }

  if (activeLocks.has(msgId)) {
    return ctx.answerCbQuery('⏳ Đang chuyển trang, vui lòng chờ...').catch(() => {});
  }

  activeLocks.add(msgId);
  await ctx.answerCbQuery().catch(() => {});

  try {
    await ctx.sendChatAction('typing');
    const devices = await fetchPixelDeviceList();
    const keyboard = renderPixelKeyboard(devices, page, ownerId);

    await ctx.editMessageText('📱 <b>Chọn dòng máy Pixel:</b>', {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (e) {
  } finally {
    activeLocks.delete(msgId);
  }
});

// Đóng/xóa bảng khi ấn nút 📄 1/3
bot.action(/^close_menu:(\d+)$/, async (ctx) => {
  const ownerId = Number(ctx.match[1]);
  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('❌ Đã đóng menu').catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});

bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

bot.action(/^get_pif:([a-z0-9_]+):(\d+)$/, async (ctx) => {
  const product = ctx.match[1];
  const ownerId = Number(ctx.match[2]);
  const msgId = ctx.callbackQuery.message?.message_id;

  if (ctx.from.id !== ownerId) {
    return ctx.answerCbQuery('눈⁠‸⁠눈 Bạn không thể bấm nút của người khác', { show_alert: true }).catch(() => {});
  }

  if (processedMessages.has(msgId)) {
    return ctx.answerCbQuery('⚠️ Thao tác đã thực hiện hoặc menu đã hết hạn!', { show_alert: true }).catch(() => {});
  }

  if (activeLocks.has(msgId)) {
    return ctx.answerCbQuery('⏳ Đang xử lý, vui lòng không ấn liên tục!', { show_alert: true }).catch(() => {});
  }

  activeLocks.add(msgId);
  processedMessages.add(msgId);

  await ctx.answerCbQuery('⏳ Đang lấy thông tin Build...').catch(() => {});

  const targetChatId = ctx.chat?.id;
  const replyToMsgId = ctx.callbackQuery.message?.reply_to_message?.message_id;

  if (msgId && targetChatId) {
    await ctx.telegram.deleteMessage(targetChatId, msgId).catch(() => {});
  }

  try {
    await ctx.sendChatAction('typing');
    const devices = await fetchPixelDeviceList();
    const devInfo = devices.find(d => d.product === product) || { model: 'Pixel Device', product };

    const deviceName = product.replace(/_beta$/, '');
    const build = await getFlashStationBuild(product);
    const securityPatch = await getSecurityPatchLevel(build.canaryId);

    const fingerprint = `google/${deviceName}/${deviceName}:17/${build.id}/${build.incremental}:user/release-keys`;

    const pifJsonData = {
      BRAND: "google",
      DEVICE: deviceName,
      FINGERPRINT: fingerprint,
      ID: build.id,
      MANUFACTURER: "Google",
      MODEL: devInfo.model,
      PRODUCT: deviceName,
      DEVICE_INITIAL_SDK_INT: "32",
      SECURITY_PATCH: securityPatch
    };

    const jsonBuffer = Buffer.from(JSON.stringify(pifJsonData, null, 2), 'utf-8');

    const caption =
      `✅ <b>ĐÃ TẠO THÀNH CÔNG</b>\n\n` +
      `📱 <b>Model:</b> <code>${devInfo.model}</code> (<code>${deviceName}</code>)\n` +
      `🛡 <b>Security Patch:</b> <code>${securityPatch}</code>\n` +
      `📦 <b>ID Build:</b> <code>${build.id}</code> | Incremental: <code>${build.incremental}</code>\n` +
      `🔏 <b>Fingerprint:</b>\n<code>${fingerprint}</code>`;

    await ctx.sendChatAction('upload_document');
    await ctx.replyWithDocument(
      { source: jsonBuffer, filename: `pif_${deviceName}.json` },
      {
        caption,
        parse_mode: 'HTML',
        ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {})
      }
    );
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi khởi tạo PIF: ${err.message}`, {
      ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {})
    });
  } finally {
    activeLocks.delete(msgId);
  }
});

// Lệnh /check
bot.command('check', async (ctx) => {
  const replyTo = ctx.message?.reply_to_message;

  if (replyTo?.document) {
    return handleDocumentValidation(
      ctx,
      replyTo.document
    );
  }

  await ctx.sendChatAction('typing');

  const startedAt = Date.now();

  const trustData =
    await trustManager.refreshTrustData();

  const results = await runWithConcurrency(
    SOURCES,
    async (src) => {
      const sourceStarted = Date.now();

      try {
        const result =
          await fetchKeyboxFromSource(
            src,
            trustData
          );

        return {
          name: src.name,
          status: result.analysis.overall,
          icon: getStatusIcon(
            result.analysis.overall
          ),
          analysis: result.analysis,
          ms: Date.now() - sourceStarted
        };
      } catch (error) {
        return {
          name: src.name,
          status: 'error',
          icon: '❌',
          analysis: null,
          error: error.message,
          ms: Date.now() - sourceStarted
        };
      }
    },
    CHECK_CONCURRENCY
  );

  let message =
    '📊 <b>KẾT QUẢ KIỂM TRA KEYBOX</b>\n\n';

  for (const item of results) {
    if (item.status === 'error') {
      message +=
        `<code>${item.icon} ${escapeHtml(item.name)}: ERROR</code>\n` +
        `   └ <i>${escapeHtml(item.error || 'Unknown error')}</i>\n`;

      continue;
    }

    message +=
      `<code>${item.icon} ${escapeHtml(item.name)}: ${item.status.toUpperCase()}</code>\n`;
  }

  const elapsed = Date.now() - startedAt;

  if (USERNAME_BOT_CHECK) {
    message += `\n\n@${escapeHtml(USERNAME_BOT_CHECK)}`;
  }

  await ctx.reply(message, {
    parse_mode: 'HTML',
    reply_parameters: {
      message_id: ctx.message.message_id
    }
  });
});

bot.on('document', async (ctx) => {
  if (ctx.chat.type === 'private') {
    await handleDocumentValidation(ctx, ctx.message.document);
  }
});

async function handleDocumentValidation(ctx, doc) {
  const fileName = doc.file_name || '';
  if (!fileName.endsWith('.xml') && doc.mime_type !== 'text/xml' && doc.mime_type !== 'application/xml') {
    return ctx.reply('❌ Vui lòng gửi file định dạng XML (<code>.xml</code>).', {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message.message_id }
    });
  }

  await ctx.sendChatAction('typing');

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const rawBuffer = Buffer.from(res.data);

    const trustData = await trustManager.refreshTrustData();
    const xmlContent = decodeKeyboxBytes(rawBuffer);
    const analysis = await analyzeKeybox(xmlContent, trustData);

    const reportText = formatAnalysisReport(analysis);

    await ctx.reply(`📋 <b>Kết quả phân tích file Keybox (<code>${fileName}</code>):</b>\n\n${reportText}`, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message.message_id }
    });
  } catch (err) {
    await ctx.reply(`❌ Lỗi khi xử lý file: ${err.message}`, {
      reply_parameters: { message_id: ctx.message.message_id }
    });
  }
}

// Handler cho Vercel / Express
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      status: 'Keybox & PIF Bot API đang hoạt động',
      time: new Date().toISOString()
    });
  }

  try {
    let update = req.body;

    if (typeof update === 'string') {
      try {
        update = JSON.parse(update);
      } catch {
        return res.status(400).send('Invalid JSON');
      }
    }

    if (!update || typeof update !== 'object') {
      return res.status(400).send('Invalid Telegram update');
    }

    /*
     * Không để lỗi Telegram làm webhook trả 500.
     */
    await bot.handleUpdate(update);

    return res.status(200).send('OK');
  } catch (error) {
    console.error(
      '[Telegram Webhook]',
      error?.stack || error
    );

    /*
     * Telegram webhook nên nhận 200 để tránh retry
     * liên tục khi bot gặp lỗi xử lý nội bộ.
     */
    return res.status(200).send('OK');
  }
}