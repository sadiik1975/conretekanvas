"use strict";

const http = require("node:http");
const { createReadStream, statSync } = require("node:fs");
const { randomUUID, createHash, createHmac, timingSafeEqual } = require("node:crypto");
const { join, extname } = require("node:path");
const { createSynkAuth, expiredCookie, sessionCookie } = require("./synk-auth");
const { createSynkRepository } = require("./synk-db");
const {
  HttpError: CommerceHttpError,
  createCheckout,
  fulfillStripeEvent,
  productsFromDisk
} = require("./commerce");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getConfig(overrides = {}) {
  return {
    databasePath: process.env.SYNK_DATABASE_PATH || join(__dirname, "data", "synk.db"),
    adminEmail: process.env.SYNK_ADMIN_EMAIL || "",
    adminPasswordHash: process.env.SYNK_ADMIN_PASSWORD_HASH || "",
    sessionSecret: process.env.SYNK_SESSION_SECRET || "",
    secureCookies: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    resendKey: process.env.RESEND_API_KEY || "",
    resendFrom: process.env.RESEND_FROM || "",
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    shopUrl: process.env.SHOP_URL || "",
    unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || "",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    printfulToken: process.env.PRINTFUL_API_TOKEN || "",
    printfulStoreId: process.env.PRINTFUL_STORE_ID || "",
    printfulAutoConfirm: process.env.PRINTFUL_AUTO_CONFIRM === "true",
    storeCurrency: process.env.STORE_CURRENCY || "usd",
    storeShippingCents: process.env.STORE_SHIPPING_CENTS || "",
    storeAllowedCountries: process.env.STORE_ALLOWED_COUNTRIES || "US",
    ...overrides
  };
}

function required(config, ...names) {
  for (const name of names) {
    if (!config[name]) throw new HttpError(503, "This service is not configured.");
  }
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(body);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 32768) throw new HttpError(413, "Request is too large.");
  }
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid object");
    return data;
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

async function readRawBody(req, maxBytes = 65536) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanSource(value) {
  if (typeof value !== "string") return "direct";
  return value.trim().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) || "direct";
}

function tokenFor(id, config) {
  required(config, "unsubscribeSecret");
  return createHmac("sha256", config.unsubscribeSecret).update(id).digest("base64url");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (
      url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function isSecureRequest(req, config) {
  return config.secureCookies ||
    req.headers["x-forwarded-proto"] === "https" ||
    req.socket.encrypted === true;
}

async function signup(data, config, repository) {
  const email = normalizeEmail(data.email);
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  if (repository.hasEmail(email)) {
    return { message: "You're already on the list." };
  }
  const id = randomUUID();
  try {
    repository.addSignup({
      id,
      email,
      source: cleanSource(data.source),
      unsubscribeTokenHash: tokenHash(tokenFor(id, config))
    });
  } catch (error) {
    if (error.code === "ERR_SQLITE_ERROR" && /unique/i.test(error.message)) {
      return { message: "You're already on the list." };
    }
    throw error;
  }
  return { message: "You're in. Watch your inbox — Drop 01 opens for you first." };
}

async function sendCampaign(data, config, repository) {
  required(
    config,
    "resendKey",
    "resendFrom",
    "publicBaseUrl",
    "shopUrl",
    "unsubscribeSecret"
  );
  if (!validUrl(config.publicBaseUrl) || !validUrl(config.shopUrl)) {
    throw new HttpError(503, "Email links are not configured.");
  }
  if (
    typeof data.subject !== "string" ||
    !data.subject.trim() ||
    data.subject.length > 200 ||
    /[\r\n]/.test(data.subject) ||
    typeof data.body !== "string" ||
    !data.body.trim() ||
    data.body.length > 20000
  ) {
    throw new HttpError(400, "Enter a valid subject and message.");
  }
  const recipients = repository.listActiveRecipients();
  if (!recipients.length) throw new HttpError(400, "There are no active subscribers.");
  const id = randomUUID();
  const subject = data.subject.trim();
  try {
    repository.createSend(id, subject);
  } catch (error) {
    if (error.code === "ERR_SQLITE_ERROR" && /unique/i.test(error.message)) {
      throw new HttpError(409, "A send is already in progress or needs review.");
    }
    throw error;
  }
  processCampaign(id, subject, data.body, recipients, config, repository).catch(error => {
    console.error("Campaign interrupted:", error.message);
    try {
      const current = repository.getSend(id);
      if (current) {
        repository.finishSend(id, {
          status: "unknown",
          recipientCount: current.recipient_count,
          attemptedCount: current.attempted_count,
          failedCount: current.failed_count
        });
      }
    } catch (updateError) {
      console.error("Could not update campaign status:", updateError.message);
    }
  });
  return { status: "sending" };
}

async function processCampaign(id, subject, body, recipients, config, repository) {
  let attempted = 0;
  let accepted = 0;
  let failed = 0;
  let uncertain = false;
  for (const recipient of recipients) {
    if (!repository.isSubscribed(recipient.id)) continue;
    const unsubscribe = new URL("/synk-unsubscribe.html", config.publicBaseUrl);
    unsubscribe.searchParams.set("id", recipient.id);
    unsubscribe.searchParams.set("token", tokenFor(recipient.id, config));
    attempted++;
    repository.updateSendProgress(id, {
      recipientCount: accepted,
      attemptedCount: attempted,
      failedCount: failed
    });
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `synk-${id}-${recipient.id}`
        },
        body: JSON.stringify({
          from: config.resendFrom,
          to: [recipient.email],
          subject,
          text: `${body.trim()}\n\nShop Drop 01: ${config.shopUrl}\n\nUnsubscribe: ${unsubscribe.toString()}`
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (response.ok) accepted++;
      else if (response.status >= 500) {
        uncertain = true;
        console.error(`Resend request outcome unknown (${response.status})`);
      } else {
        failed++;
        console.error(`Resend request failed (${response.status})`);
      }
    } catch (error) {
      uncertain = true;
      console.error("Resend request outcome unknown:", error.message);
    }
    repository.updateSendProgress(id, {
      recipientCount: accepted,
      attemptedCount: attempted,
      failedCount: failed
    });
    if (uncertain) break;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  const status = uncertain
    ? "unknown"
    : (failed ? (accepted ? "partial" : "failed") : "succeeded");
  repository.finishSend(id, {
    status,
    recipientCount: accepted,
    attemptedCount: attempted,
    failedCount: failed
  });
}

function unsubscribe(data, config, repository) {
  if (
    typeof data.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id) ||
    typeof data.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.token)
  ) {
    throw new HttpError(400, "This unsubscribe link is invalid.");
  }
  const expected = Buffer.from(tokenFor(data.id, config));
  const supplied = Buffer.from(data.token);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied) ||
    !repository.unsubscribe(data.id, tokenHash(data.token))
  ) {
    throw new HttpError(400, "This unsubscribe link is invalid.");
  }
  return { message: "You have been unsubscribed from SYNK emails." };
}

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/script.js", "script.js"],
  ["/products.json", "products.json"],
  ["/synk.html", "synk.html"],
  ["/synk-admin.html", "synk-admin.html"],
  ["/synk-unsubscribe.html", "synk-unsubscribe.html"],
  ["/synk.css", "synk.css"],
  ["/synk.js", "synk.js"],
  ["/synk-admin.js", "synk-admin.js"],
  ["/synk-unsubscribe.js", "synk-unsubscribe.js"]
]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp4": "video/mp4"
};

function createSynkServer(options = {}) {
  const config = getConfig(options);
  const repository = options.repository || createSynkRepository(config.databasePath);
  const auth = createSynkAuth(config, repository);

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (path === "/api/checkout" && req.method === "POST") {
      try {
        return sendJson(
          res,
          200,
          await createCheckout(await readJson(req), config, productsFromDisk())
        );
      } catch (error) {
        if (error instanceof CommerceHttpError) {
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
    }
    if (path === "/api/stripe/webhook" && req.method === "POST") {
      try {
        const rawBody = await readRawBody(req);
        return sendJson(
          res,
          200,
          await fulfillStripeEvent(
            rawBody,
            req.headers["stripe-signature"],
            config,
            repository
          )
        );
      } catch (error) {
        if (error instanceof CommerceHttpError) {
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
    }
    if (path === "/api/synk/signup" && req.method === "POST") {
      return sendJson(res, 200, await signup(await readJson(req), config, repository));
    }
    if (path === "/api/synk/unsubscribe" && req.method === "POST") {
      return sendJson(res, 200, unsubscribe(await readJson(req), config, repository));
    }
    if (path === "/api/synk/login" && req.method === "POST") {
      const body = await readJson(req);
      const session = await auth.login(body.email, body.password);
      if (!session) throw new HttpError(401, "Invalid email or password.");
      return sendJson(
        res,
        200,
        { authenticated: true, email: session.email, expiresAt: session.expiresAt },
        { "Set-Cookie": sessionCookie(session.token, isSecureRequest(req, config)) }
      );
    }
    if (path === "/api/synk/logout" && req.method === "POST") {
      auth.logout(req);
      return sendJson(
        res,
        200,
        { authenticated: false },
        { "Set-Cookie": expiredCookie(isSecureRequest(req, config)) }
      );
    }
    if (path.startsWith("/api/synk/admin/")) {
      if (!auth.sessionFromRequest(req)) throw new HttpError(401, "Please sign in.");
      if (path === "/api/synk/admin/signups" && req.method === "GET") {
        const rows = repository.listSignups();
        const sources = Object.create(null);
        for (const row of rows) sources[row.source] = (sources[row.source] || 0) + 1;
        return sendJson(res, 200, { rows, sources });
      }
      if (path === "/api/synk/admin/export" && req.method === "GET") {
        const rows = repository.listSignups();
        const csv = [
          ["email", "source", "date", "subscribed"],
          ...rows.map(row => [row.email, row.source, row.created_at, row.is_subscribed])
        ].map(row => row.map(csvCell).join(",")).join("\r\n");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="synk-early-access.csv"',
          "Cache-Control": "no-store"
        });
        return res.end(csv);
      }
      if (path === "/api/synk/admin/sends" && req.method === "GET") {
        return sendJson(res, 200, repository.listSends());
      }
      if (path === "/api/synk/admin/send" && req.method === "POST") {
        return sendJson(
          res,
          200,
          await sendCampaign(await readJson(req), config, repository)
        );
      }
      throw new HttpError(404, "Not found.");
    }

    let file = staticFiles.get(path);
    if (!file && /^\/(img|videos)\/[a-zA-Z0-9_-]+\.(png|mp4)$/.test(path)) {
      file = path.slice(1);
    }
    if (req.method !== "GET" || !file) throw new HttpError(404, "Not found.");
    const filePath = join(__dirname, file);
    const headers = {
      "Content-Type": mime[extname(file)],
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    };
    if (extname(file) === ".mp4") headers["Accept-Ranges"] = "bytes";
    let streamOptions;
    let status = 200;
    if (extname(file) === ".mp4" && req.headers.range) {
      const size = statSync(filePath).size;
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) throw new HttpError(416, "Invalid range.");
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) throw new HttpError(416, "Invalid range.");
      Object.assign(headers, {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": end - start + 1
      });
      status = 206;
      streamOptions = { start, end };
    }
    res.writeHead(status, headers);
    const stream = createReadStream(filePath, streamOptions);
    stream.on("error", error => {
      console.error("Static file read failed:", error.message);
      res.destroy(error);
    });
    stream.pipe(res);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!(error instanceof HttpError)) console.error("Request failed:", error.message);
      if (!res.headersSent) {
        const status = error.code === "AUTH_NOT_CONFIGURED" ? 503 : (error.status || 500);
        const message = error.code === "AUTH_NOT_CONFIGURED"
          ? "SYNK admin authentication is not configured."
          : (error instanceof HttpError ? error.message : "Something went wrong. Please try again.");
        sendJson(res, status, { message });
      } else {
        res.destroy();
      }
    });
  });
  server.repository = repository;
  server.closeWithDatabase = () => new Promise((resolveClose, reject) => {
    server.close(error => {
      repository.close();
      if (error) reject(error);
      else resolveClose();
    });
  });
  return server;
}

const server = createSynkServer();

if (require.main === module) {
  server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log(`SYNK server listening on port ${process.env.PORT || 3000}`);
  });
}

module.exports = {
  server,
  createSynkServer,
  normalizeEmail,
  cleanSource,
  csvCell
};
