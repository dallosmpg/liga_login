#!/usr/bin/env node

const { createPasswordHash } = require("../server");

function readPassword(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        resolve(input.replace(/\r?\n$/, ""));
      });
      return;
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = "";
    process.stdin.on("data", (chunk) => {
      const value = chunk.toString("utf8");

      if (value === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }

      if (value === "\r" || value === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(password);
        return;
      }

      if (value === "\u007f") {
        password = password.slice(0, -1);
        return;
      }

      password += value;
    });
  });
}

(async function main() {
  const password =
    process.argv.length > 2
      ? process.argv.slice(2).join(" ")
      : await readPassword("Admin password: ");

  if (password.length < 12) {
    console.error("Use an admin password with at least 12 characters.");
    process.exit(1);
  }

  const passwordHash = await createPasswordHash(password);
  console.log(`ADMIN_PASSWORD_HASH=${passwordHash}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
