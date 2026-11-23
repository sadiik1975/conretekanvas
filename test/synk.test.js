"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword } = require("../synk-auth");
const { createSynkServer } = require("../server");

test("SYNK signup, admin, campaign and unsubscribe flow", async t => {
  const emails = [];
  let resendMode = "ok";
  const realFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "127.0.0.1") return realFetch(input, options);
    assert.equal(url.hostname, "api.resend.com");
    emails.push(JSON.parse(options.body));
    if (resendMode === "reject") return Response.json({}, { status: 400 });
    if (resendMode === "uncertain") return Response.json({}, { status: 500 });
    return Response.json({ id: "email-id" });
  };

  const password = "correct horse battery staple";
  const server = createSynkServer({
    databasePath: ":memory:",
    adminEmail: "admin@example.com",
    adminPasswordHash: await hashPassword(password),
    sessionSecret: "test-session-secret-with-more-than-32-characters",
    secureCookies: false,
    resendKey: "test-resend-key",
    resendFrom: "SYNK <test@example.com>",
    publicBaseUrl: "https://synk.example",
    shopUrl: "https://synk.example/#shop",
    unsubscribeSecret: "test-unsubscribe-secret"
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => realFetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });

  t.after(async () => {
    global.fetch = realFetch;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.repository.close();
  });

  let cookie;

  await t.test("signup validates, normalizes and handles duplicates", async () => {
    assert.equal((await post("/api/synk/signup", { email: "not-an-email" })).status, 400);
    const created = await post("/api/synk/signup", {
      email: "  Person@Example.com  ",
      source: "=campaign"
    });
    assert.equal(
      (await created.json()).message,
      "You're in. Watch your inbox — Drop 01 opens for you first."
    );
    const rows = server.repository.listSignups();
    assert.equal(rows[0].email, "person@example.com");
    assert.equal(rows[0].source, "=campaign");
    const duplicate = await post("/api/synk/signup", { email: "PERSON@example.com" });
    assert.equal((await duplicate.json()).message, "You're already on the list.");
    assert.equal(server.repository.listSignups().length, 1);
  });

  await t.test("admin data and send require a database-backed session", async () => {
    assert.equal((await realFetch(base + "/api/synk/admin/signups")).status, 401);
    assert.equal((await post("/api/synk/admin/send", { subject: "x", body: "x" })).status, 401);
    assert.equal((await post("/api/synk/login", {
      email: "admin@example.com",
      password: "wrong"
    })).status, 401);

    const login = await post("/api/synk/login", {
      email: " Admin@Example.com ",
      password
    });
    const session = await login.json();
    assert.equal(session.authenticated, true);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(";")[0];

    const response = await realFetch(base + "/api/synk/admin/signups", {
      headers: { Cookie: cookie }
    });
    assert.equal((await response.json()).sources["=campaign"], 1);
    const csv = await realFetch(base + "/api/synk/admin/export", {
      headers: { Cookie: cookie }
    });
    assert.match(await csv.text(), /"'=campaign"/);
  });

  await t.test("campaign sends individually and records unsubscribe suppression", async () => {
    const response = await post(
      "/api/synk/admin/send",
      { subject: "Drop 01", body: "Welcome." },
      cookie
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "sending");
    for (let i = 0; i < 100; i++) {
      const send = server.repository.listSends()[0];
      if (send.status !== "sending") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const send = server.repository.listSends()[0];
    assert.equal(send.status, "succeeded");
    assert.equal(send.recipient_count, 1);
    assert.deepEqual(emails[0].to, ["person@example.com"]);
    assert.match(emails[0].text, /Shop Drop 01: https:\/\/synk\.example\/#shop/);
    const link = new URL(emails[0].text.match(/Unsubscribe: (.+)/)[1]);
    const bad = await post("/api/synk/unsubscribe", {
      id: link.searchParams.get("id"),
      token: "x".repeat(43)
    });
    assert.equal(bad.status, 400);
    const unsubscribed = await post("/api/synk/unsubscribe", {
      id: link.searchParams.get("id"),
      token: link.searchParams.get("token")
    });
    assert.equal(unsubscribed.status, 200);
    assert.equal(server.repository.listSignups()[0].is_subscribed, false);
    assert.equal((await post(
      "/api/synk/admin/send",
      { subject: "Again", body: "Hello" },
      cookie
    )).status, 400);
    assert.equal((await (await post(
      "/api/synk/signup",
      { email: "person@example.com" }
    )).json()).message, "You're already on the list.");
    assert.equal(server.repository.listSignups()[0].is_subscribed, false);
  });

  await t.test("records provider rejections and uncertain provider outcomes", async () => {
    await post("/api/synk/signup", { email: "second@example.com" });
    for (const [mode, expected] of [["reject", "failed"], ["uncertain", "unknown"]]) {
      resendMode = mode;
      const response = await post(
        "/api/synk/admin/send",
        { subject: mode, body: "Hello" },
        cookie
      );
      assert.equal(response.status, 200);
      for (let i = 0; i < 100; i++) {
        const current = server.repository.listSends()[0];
        if (current.status !== "sending") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const send = server.repository.listSends()[0];
      assert.equal(send.status, expected);
      assert.equal(send.attempted_count, 1);
      assert.equal(send.recipient_count, 0);
    }
    resendMode = "ok";
  });

  await t.test("logout expires the session", async () => {
    const logout = await post("/api/synk/logout", {}, cookie);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await realFetch(base + "/api/synk/admin/signups", {
      headers: { Cookie: cookie }
    })).status, 401);
  });

  await t.test("serves signup page and supports video range requests", async () => {
    assert.equal((await realFetch(base + "/synk.html")).status, 200);
    const video = await realFetch(base + "/videos/intro-5s.mp4", {
      headers: { Range: "bytes=0-9" }
    });
    assert.equal(video.status, 206);
    assert.equal((await video.arrayBuffer()).byteLength, 10);
    assert.equal((await realFetch(base + "/.env")).status, 404);
  });
});
