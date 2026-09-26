"use strict";

const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

const cors = require("cors");
const { http: followHttp, https: followHttps } = require("follow-redirects");
const httpProxy = require("http-proxy");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { request: undiciRequest, Agent: UndiciAgent } = require("undici");

dns.setServers(["1.1.1.1", "1.0.0.1"]);

const TIMEOUT = 30000;
const MAX_REDIRECTS = 10;
const BODY_LIMIT = 1024 * 1024 * 1024; // 1 GB

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);

const forwardedHeaders = new Set([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded"
]);

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  rejectUnauthorized: true
});

const proxyServer = httpProxy.createProxyServer({
  changeOrigin: false,
  secure: true,
  followRedirects: true,
  selfHandleResponse: true
});

function log(id, type, message, data) {
  const time = new Date().toISOString();

  if (data !== undefined) {
    console.log(
      `[${time}] [${id}] [${type}] ${message}`,
      data
    );
  } else {
    console.log(
      `[${time}] [${id}] [${type}] ${message}`
    );
  }
}

function privateIPv4(ip) {
  const p = ip.split(".").map(Number);

  if (
    p.length !== 4 ||
    p.some(x => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = p;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateIPv6(ip) {
  const x = ip.toLowerCase().split("%")[0];

  return (
    x === "::" ||
    x === "::1" ||
    x.startsWith("fc") ||
    x.startsWith("fd") ||
    x.startsWith("fe8") ||
    x.startsWith("fe9") ||
    x.startsWith("fea") ||
    x.startsWith("feb")
  );
}

function privateIP(ip) {
  const family = net.isIP(ip);

  if (family === 4) return privateIPv4(ip);
  if (family === 6) return privateIPv6(ip);

  return false;
}

async function resolveHost(hostname, id) {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  log(id, "DNS", `Resolving ${host} using Cloudflare DNS`);

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Blocked hostname");
  }

  if (net.isIP(host)) {
    if (privateIP(host)) {
      throw new Error("Private IP is not allowed");
    }

    log(id, "DNS", `Target is already IP: ${host}`);
    return host;
  }

  const records = await new Promise((resolve, reject) => {
    dns.lookup(
      host,
      {
        all: true,
        verbatim: true
      },
      (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      }
    );
  });

  if (!records.length) {
    throw new Error("DNS resolution failed");
  }

  log(id, "DNS", "Resolved addresses", records);

  for (const record of records) {
    if (privateIP(record.address)) {
      throw new Error(
        `Hostname resolves to private IP: ${record.address}`
      );
    }
  }

  const ipv4 = records.find(x => x.family === 4);
  const selected = ipv4
    ? ipv4.address
    : records[0].address;

  log(id, "DNS", `Selected IP: ${selected}`);

  return selected;
}

function readBody(req, id) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on("data", chunk => {
      if (rejected) return;

      size += chunk.length;

      if (size > BODY_LIMIT) {
        rejected = true;

        const error = new Error(
          "Request body exceeds 1 GB"
        );

        reject(error);

        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;

      const body = chunks.length
        ? Buffer.concat(chunks)
        : null;

      log(
        id,
        "BODY",
        `Received ${body ? body.length : 0} bytes`
      );

      resolve(body);
    });

    req.on("error", error => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function getHeaders(req) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();

    if (hopHeaders.has(lower)) continue;
    if (forwardedHeaders.has(lower)) continue;
    if (value == null) continue;

    headers[key] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }

  return headers;
}

function setResponseHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    if (hopHeaders.has(lower)) continue;
    if (lower.startsWith("access-control-")) continue;

    if (value !== undefined && value !== null) {
      res.setHeader(key, value);
    }
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

function sendJSON(res, status, data) {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  setResponseHeaders(res, {});

  res.end(JSON.stringify(data));
}

function streamNode(res, stream, id) {
  return new Promise((resolve, reject) => {
    let bytes = 0;

    stream.on("data", chunk => {
      bytes += chunk.length;

      if (!res.write(chunk)) {
        stream.pause();

        res.once("drain", () => {
          stream.resume();
        });
      }
    });

    stream.on("end", () => {
      log(id, "RESPONSE", `Streamed ${bytes} bytes`);

      res.end();
      resolve();
    });

    stream.on("error", error => {
      log(
        id,
        "ERROR",
        "Response stream error",
        error.message
      );

      try {
        res.end();
      } catch {}

      reject(error);
    });
  });
}

async function streamUndici(res, body, id) {
  if (!body) {
    res.end();
    return;
  }

  let bytes = 0;

  try {
    for await (const chunk of body) {
      bytes += chunk.length;

      if (!res.write(chunk)) {
        await new Promise(resolve =>
          res.once("drain", resolve)
        );
      }
    }
  } finally {
    log(
      id,
      "RESPONSE",
      `Streamed ${bytes} bytes`
    );

    res.end();
  }
}

async function engineUndici(
  target,
  method,
  headers,
  body,
  resolvedIP,
  id
) {
  log(id, "ENGINE", "Trying UNDICI");

  const dispatcher = new UndiciAgent({
    connect: {
      lookup(hostname, options, callback) {
        callback(
          null,
          resolvedIP,
          net.isIP(resolvedIP)
        );
      }
    },
    connections: 50,
    pipelining: 1,
    keepAliveTimeout: 10000,
    keepAliveMaxTimeout: 30000
  });

  try {
    const response = await undiciRequest(
      target.toString(),
      {
        method,
        headers: {
          ...headers,
          host: target.host
        },
        body: body || undefined,
        dispatcher,
        maxRedirections: MAX_REDIRECTS,
        headersTimeout: TIMEOUT,
        bodyTimeout: TIMEOUT
      }
    );

    log(
      id,
      "UPSTREAM",
      `UNDICI ${response.statusCode}`
    );

    return response;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

function engineFollow(
  target,
  method,
  headers,
  body,
  id
) {
  log(id, "ENGINE", "Trying follow-redirects");

  return new Promise((resolve, reject) => {
    const transport =
      target.protocol === "https:"
        ? followHttps
        : followHttp;

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port:
        target.port ||
        (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      agent:
        target.protocol === "https:"
          ? httpsAgent
          : httpAgent,
      maxRedirects: MAX_REDIRECTS,
      timeout: TIMEOUT
    };

    const request = transport.request(
      options,
      response => {
        log(
          id,
          "UPSTREAM",
          `follow-redirects ${response.statusCode}`
        );

        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: response
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("Request timeout")
      );
    });

    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

function engineHttpProxy(
  req,
  res,
  target,
  id
) {
  log(id, "ENGINE", "Trying http-proxy");

  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      proxyServer.removeAllListeners("proxyRes");
      proxyServer.removeAllListeners("error");
    };

    const finish = error => {
      if (finished) return;

      finished = true;
      cleanup();

      if (error) reject(error);
      else resolve();
    };

    proxyServer.once(
      "proxyRes",
      proxyRes => {
        log(
          id,
          "UPSTREAM",
          `http-proxy ${proxyRes.statusCode}`
        );

        res.statusCode =
          proxyRes.statusCode || 502;

        setResponseHeaders(
          res,
          proxyRes.headers
        );

        proxyRes.on("data", chunk => {
          res.write(chunk);
        });

        proxyRes.on("end", () => {
          res.end();
          finish();
        });

        proxyRes.on("error", finish);
      }
    );

    proxyServer.once(
      "error",
      finish
    );

    try {
      proxyServer.web(
        req,
        res,
        {
          target: target.toString(),
          changeOrigin: false,
          secure: target.protocol === "https:",
          followRedirects: true,
          selfHandleResponse: true
        }
      );
    } catch (error) {
      finish(error);
    }
  });
}

function getHttpsProxyAgent() {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY;

  if (!proxy) return null;

  try {
    return new HttpsProxyAgent(proxy);
  } catch (error) {
    console.error(
      "[HTTPS-PROXY-AGENT]",
      error.message
    );

    return null;
  }
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  const id =
    `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  log(
    id,
    "REQUEST",
    `${req.method} ${req.url}`
  );

  await new Promise(resolve => {
    cors(
      {
        origin: "*",
        methods:
          "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
        allowedHeaders: "*",
        exposedHeaders: "*"
      }
    )(req, res, resolve);
  });

  if (req.method === "OPTIONS") {
    log(
      id,
      "CORS",
      "Preflight request"
    );

    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    let rawURL = req.query?.url;

    if (!rawURL) {
      const current = new URL(
        req.url,
        `https://${req.headers.host}`
      );

      rawURL =
        current.searchParams.get("url");
    }

    if (!rawURL) {
      sendJSON(res, 400, {
        ok: false,
        error: "Missing ?url="
      });

      return;
    }

    const target = new URL(rawURL);

    log(
      id,
      "TARGET",
      target.toString()
    );

    if (
      target.protocol !== "http:" &&
      target.protocol !== "https:"
    ) {
      sendJSON(res, 400, {
        ok: false,
        error:
          "Only HTTP and HTTPS are supported"
      });

      return;
    }

    log(
      id,
      "TARGET",
      `Protocol: ${target.protocol}`
    );

    log(
      id,
      "TARGET",
      `Host: ${target.host}`
    );

    const resolvedIP =
      await resolveHost(
        target.hostname,
        id
      );

    const headers =
      getHeaders(req);

    log(
      id,
      "HEADERS",
      `Forwarding ${Object.keys(headers).length} headers`
    );

    log(
      id,
      "HEADERS",
      headers
    );

    let body = null;

    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS"
    ) {
      body =
        await readBody(
          req,
          id
        );
    }

    let upstream;

    try {
      upstream =
        await engineUndici(
          target,
          req.method,
          headers,
          body,
          resolvedIP,
          id
        );

      res.statusCode =
        upstream.statusCode;

      setResponseHeaders(
        res,
        upstream.headers
      );

      await streamUndici(
        res,
        upstream.body,
        id
      );

      log(
        id,
        "DONE",
        `${Date.now() - started}ms`
      );

      return;
    } catch (error) {
      log(
        id,
        "FALLBACK",
        `UNDICI failed: ${error.message}`
      );
    }

    try {
      upstream =
        await engineFollow(
          target,
          req.method,
          headers,
          body,
          id
        );

      res.statusCode =
        upstream.statusCode;

      setResponseHeaders(
        res,
        upstream.headers
      );

      await streamNode(
        res,
        upstream.body,
        id
      );

      log(
        id,
        "DONE",
        `${Date.now() - started}ms`
      );

      return;
    } catch (error) {
      log(
        id,
        "FALLBACK",
        `follow-redirects failed: ${error.message}`
      );
    }

    try {
      await engineHttpProxy(
        req,
        res,
        target,
        id
      );

      log(
        id,
        "DONE",
        `${Date.now() - started}ms`
      );

      return;
    } catch (error) {
      log(
        id,
        "FALLBACK",
        `http-proxy failed: ${error.message}`
      );
    }

    sendJSON(res, 502, {
      ok: false,
      error:
        "All proxy engines failed"
    });

    log(
      id,
      "DONE",
      `${Date.now() - started}ms`
    );
  } catch (error) {
    log(
      id,
      "ERROR",
      error.stack || error.message
    );

    const status =
      error.message ===
      "Request body exceeds 1 GB"
        ? 413
        : error.message.includes(
            "Private IP"
          )
        ? 403
        : 502;

    sendJSON(res, status, {
      ok: false,
      error:
        error.message ||
        "Proxy request failed"
    });
  }
};
