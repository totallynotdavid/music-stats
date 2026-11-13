#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";

const [sourceId] = process.argv.slice(2);
if (!/^\d+$/.test(sourceId ?? "")) {
  console.error("usage: node scripts/make-token.mjs SOURCE_ID");
  process.exit(1);
}

const token = `msu_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(token).digest("hex");
const hint = token.slice(-4);

console.log(`token: ${token}`);
console.log(
  `INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (${sourceId}, X'${hash}', '${hint}', unixepoch());`,
);
