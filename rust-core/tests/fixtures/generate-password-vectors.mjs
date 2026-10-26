import { scryptSync } from "node:crypto";

const saltHex = "000102030405060708090a0b0c0d0e0f";
const inputs = [
  ["ascii", "synthetic-password-123"],
  ["unicode", "合成密码🔒"],
  ["lone-surrogates", "\ud800middle\udc00"],
  ["empty", ""],
  ["embedded-nul", "a\0b"],
  ["maximum-bytes", "x".repeat(1024)],
];

console.log(JSON.stringify({
  node: process.version,
  openssl: process.versions.openssl,
  parameters: { N: 16384, r: 8, p: 1, keylen: 32 },
  vectors: inputs.map(([label, password]) => ({
    label,
    passwordHex: Buffer.from(password, "utf8").toString("hex"),
    stored: `${saltHex}:${scryptSync(password, Buffer.from(saltHex, "hex"), 32).toString("hex")}`,
  })),
}, null, 2));
