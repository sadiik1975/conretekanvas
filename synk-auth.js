"use strict";

const { createHmac, randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const deriveKey = promisify(scrypt);
const COOKIE = "synk_admin_session";
const MAX_AGE = 60 * 60 * 24;

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" || typeof password !== "string") {
    return false;
  }
  try {
    const salt = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(parts[2], "base64url");
    const actual = await deriveKey(password, salt, 64);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cookieValue(req) {
  for (const entry of String(req.headers.cookie || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === COOKIE) {
      try {
        return decodeURIComponent(entry.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function tokenHash(token, secret) {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function sessionCookie(token, secure) {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE}`,
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

function expiredCookie(secure) {
  return [
    `${COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

function createSynkAuth(config, repository) {
  async function login(email, password) {
    if (!config.adminEmail || !config.adminPasswordHash || config.sessionSecret.length < 32) {
      const error = new Error("SYNK admin authentication is not configured.");
      error.code = "AUTH_NOT_CONFIGURED";
      throw error;
    }
    const validEmail = normalizeEmail(email) === normalizeEmail(config.adminEmail);
    const validPassword = await verifyPassword(password, config.adminPasswordHash);
    if (!validEmail || !validPassword) return null;
    repository.cleanExpiredSessions();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + MAX_AGE * 1000).toISOString();
    repository.createSession(
      tokenHash(token, config.sessionSecret),
      normalizeEmail(config.adminEmail),
      expiresAt
    );
    return { token, email: normalizeEmail(config.adminEmail), expiresAt };
  }

  function sessionFromRequest(req) {
    const token = cookieValue(req);
    if (!token || config.sessionSecret.length < 32) return null;
    return repository.getSession(tokenHash(token, config.sessionSecret));
  }

  function logout(req) {
    const token = cookieValue(req);
    if (token && config.sessionSecret.length >= 32) {
      repository.deleteSession(tokenHash(token, config.sessionSecret));
    }
  }

  return { login, logout, sessionFromRequest };
}

module.exports = {
  createSynkAuth,
  expiredCookie,
  hashPassword,
  sessionCookie,
  verifyPassword
};
