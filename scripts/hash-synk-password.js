#!/usr/bin/env node
"use strict";

const { hashPassword } = require("../synk-auth");

const password = process.argv[2] || process.env.SYNK_ADMIN_PASSWORD;
if (!password) {
  console.error("Usage: npm run hash-synk-password -- <password>");
  process.exitCode = 1;
} else {
  hashPassword(password)
    .then(hash => process.stdout.write(`${hash}\n`))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
