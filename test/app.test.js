const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createConfig,
  createStore,
  loadEnvFile,
  normalizeParticipantId,
  validateIgcBuffer,
} = require("../server");

function buildIgc() {
  return [
    "AXXXTEST",
    "HFDTE110426",
    "B1200004651234N01912345EA0123401234",
    "B1201004651235N01912346EA0123501235",
    "B1202004651236N01912347EA0123601236",
  ].join("\n");
}

test("store supports task creation, check-in, duplicate protection, delete, and re-upload", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liga-login-"));
  const config = createConfig({
    dataDir: path.join(tempRoot, "data"),
    storageDir: path.join(tempRoot, "storage"),
    baseUrl: "http://127.0.0.1",
    adminUsername: "admin",
    adminPassword: "secret",
    disableQrGeneration: true,
  });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.writeFileSync(
    config.stateFile,
    JSON.stringify({ tasks: [], checkins: [], uploads: [] }, null, 2),
  );
  const store = createStore(config);

  try {
    const participantId = normalizeParticipantId("117");
    const task = store.createTask("Task 1", "2026-04-11");

    const firstCheckin = store.createCheckin(task.id, participantId);
    assert.equal(firstCheckin.created, true);

    const repeatedCheckin = store.createCheckin(task.id, participantId);
    assert.equal(repeatedCheckin.created, false);

    const stats = validateIgcBuffer({
      originalname: "flight.igc",
      buffer: Buffer.from(buildIgc(), "utf8"),
    });

    const firstUpload = store.saveUpload(task.id, participantId, "flight.igc", stats);
    assert.equal(firstUpload.storedFilename, "117.igc");
    assert.equal(firstUpload.fixCount, 3);

    assert.throws(
      () => store.saveUpload(task.id, participantId, "replacement.igc", stats),
      /előbb töröld/,
    );

    const removed = store.deleteUpload(task.id, participantId);
    assert.equal(removed.storedFilename, "117.igc");

    const secondUpload = store.saveUpload(
      task.id,
      participantId,
      "replacement.igc",
      stats,
    );
    assert.equal(secondUpload.originalName, "replacement.igc");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("loadEnvFile applies .env values without overriding real environment", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liga-login-env-"));
  const envPath = path.join(tempRoot, ".env");
  const targetEnv = {
    ADMIN_PASSWORD: "from-real-env",
  };

  fs.writeFileSync(
    envPath,
    [
      "PORT=4321",
      "BASE_URL=https://liga.example.test",
      "ADMIN_USERNAME=liga-admin",
      "ADMIN_PASSWORD=from-dot-env",
      "TRUST_PROXY=true # inline comment",
      "SECURE_COOKIES=\"true\"",
      "IGNORED_LINE",
    ].join("\n"),
  );

  try {
    assert.equal(loadEnvFile(envPath, targetEnv), true);
    assert.equal(targetEnv.PORT, "4321");
    assert.equal(targetEnv.BASE_URL, "https://liga.example.test");
    assert.equal(targetEnv.ADMIN_USERNAME, "liga-admin");
    assert.equal(targetEnv.ADMIN_PASSWORD, "from-real-env");
    assert.equal(targetEnv.TRUST_PROXY, "true");
    assert.equal(targetEnv.SECURE_COOKIES, "true");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
