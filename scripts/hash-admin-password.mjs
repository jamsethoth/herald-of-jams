import { randomBytes, scrypt as scryptCallback } from "node:crypto";

function readPassword() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stderr.write("Administrator password: ");
      let value = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (character) => {
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      };
      process.stdin.on("data", onData);
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "")));
    process.stdin.on("error", reject);
  });
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error === null ? resolve(result) : reject(error)),
    );
  });
}

const password = await readPassword();
const salt = randomBytes(16);
const hash = await scrypt(password, salt);
process.stdout.write(`scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}\n`);
