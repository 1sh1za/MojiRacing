/**
 * Vercel ビルド時に MOJI_PARTY_HOST を config.js に書き込む。
 * 例: MOJI_PARTY_HOST=mojiracing.username.partykit.dev
 */
const fs = require("fs");
const path = require("path");

const host = (process.env.MOJI_PARTY_HOST || "").trim();
const out = path.join(__dirname, "..", "config.js");
const body = `window.MOJI_CONFIG = ${JSON.stringify({ partyHost: host })};\n`;
fs.writeFileSync(out, body, "utf8");
console.log(`config.js written (partyHost: ${host || "(empty — solo only)"})`);
