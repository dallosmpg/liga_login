const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  assertProductionConfig,
  buildCheckinsCsv,
  createConfig,
  createPasswordHash,
  createRateLimiter,
  createStore,
  isValidPasswordHash,
  loadEnvFile,
  normalizeParticipantId,
  requireAdminSameOrigin,
  securityHeaders,
  shouldGenerateTaskQr,
  validateIgcBuffer,
  verifyPassword,
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

test("buildCheckinsCsv exports checked-in pilots with upload status", () => {
  const task = { id: "task-1" };
  const store = {
    listCheckins(taskId) {
      assert.equal(taskId, task.id);
      return [
        { participantId: "117", checkedInAt: "2026-04-16T10:00:00.000Z" },
        { participantId: "118", checkedInAt: "2026-04-16T10:05:00.000Z" },
      ];
    },
    listUploads(taskId) {
      assert.equal(taskId, task.id);
      return [
        {
          participantId: "117",
          uploadedAt: "2026-04-16T14:00:00.000Z",
          originalName: "flight, final.igc",
          flightDate: "2026-04-16",
          fixCount: 42,
        },
      ];
    },
  };

  assert.equal(
    buildCheckinsCsv(task, store),
    [
      "participant_id,checked_in_at,uploaded,uploaded_at,original_name,flight_date,fix_count",
      "117,2026-04-16T10:00:00.000Z,yes,2026-04-16T14:00:00.000Z,\"flight, final.igc\",2026-04-16,42",
      "118,2026-04-16T10:05:00.000Z,no,,,,",
      "",
    ].join("\n"),
  );
});

test("shouldGenerateTaskQr detects missing and stale QR URL metadata", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liga-login-qr-"));
  const task = { id: "task-1", publicToken: "token-1" };
  const config = createConfig({
    dataDir: path.join(tempRoot, "data"),
    storageDir: path.join(tempRoot, "storage"),
    baseUrl: "https://task.xcliga.xyz",
  });
  const qrDir = path.join(config.storageDir, "tasks", task.id, "qr");
  const qrPath = path.join(qrDir, "task.svg");
  const metadataPath = path.join(qrDir, "task.url");

  try {
    assert.equal(shouldGenerateTaskQr(task, config), true);

    fs.mkdirSync(qrDir, { recursive: true });
    fs.writeFileSync(qrPath, "<svg></svg>");
    assert.equal(shouldGenerateTaskQr(task, config), true);

    fs.writeFileSync(metadataPath, "http://localhost:3000/task/token-1\n");
    assert.equal(shouldGenerateTaskQr(task, config), true);

    fs.writeFileSync(metadataPath, "https://task.xcliga.xyz/task/token-1\n");
    assert.equal(shouldGenerateTaskQr(task, config), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createMockResponse() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("scrypt admin password hashes verify only matching passwords", async () => {
  const passwordHash = await createPasswordHash("correct horse battery", {
    salt: Buffer.alloc(16, 1),
  });

  assert.match(passwordHash, /^scrypt\$/);
  assert.equal(isValidPasswordHash(passwordHash), true);
  assert.equal(await verifyPassword("correct horse battery", passwordHash), true);
  assert.equal(await verifyPassword("wrong horse battery", passwordHash), false);
  assert.equal(await verifyPassword("correct horse battery", "not-a-hash"), false);
});

test("production config requires a valid admin password hash", async () => {
  const passwordHash = await createPasswordHash("long-random-password", {
    salt: Buffer.alloc(16, 2),
  });

  assert.throws(
    () =>
      assertProductionConfig(
        { adminPassword: "long-random-password", adminPasswordHash: "" },
        { NODE_ENV: "production" },
      ),
    /ADMIN_PASSWORD_HASH/,
  );

  assert.throws(
    () =>
      assertProductionConfig(
        { adminPasswordHash: "not-a-hash" },
        { NODE_ENV: "production" },
      ),
    /ADMIN_PASSWORD_HASH/,
  );

  assert.doesNotThrow(() =>
    assertProductionConfig(
      { adminPasswordHash: passwordHash },
      { NODE_ENV: "production" },
    ),
  );
});

test("rate limiter returns 429 after the configured request budget", () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    keyGenerator: () => "test-key",
  });
  let nextCalls = 0;

  const firstResponse = createMockResponse();
  limiter({ method: "POST", path: "/api/admin/login" }, firstResponse, () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(firstResponse.statusCode, 200);

  const secondResponse = createMockResponse();
  limiter({ method: "POST", path: "/api/admin/login" }, secondResponse, () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.headers["retry-after"], "60");
});

test("admin same-origin guard rejects cross-origin unsafe requests", () => {
  const guard = requireAdminSameOrigin({
    baseUrl: "https://liga.example.test",
  });
  const crossOriginResponse = createMockResponse();
  let nextCalls = 0;

  guard(
    {
      method: "POST",
      get(name) {
        return name.toLowerCase() === "origin"
          ? "https://evil.example.test"
          : undefined;
      },
    },
    crossOriginResponse,
    () => {
      nextCalls += 1;
    },
  );

  assert.equal(crossOriginResponse.statusCode, 403);
  assert.equal(nextCalls, 0);

  const sameOriginResponse = createMockResponse();
  guard(
    {
      method: "POST",
      get(name) {
        return name.toLowerCase() === "origin"
          ? "https://liga.example.test"
          : undefined;
      },
    },
    sameOriginResponse,
    () => {
      nextCalls += 1;
    },
  );

  assert.equal(sameOriginResponse.statusCode, 200);
  assert.equal(nextCalls, 1);
});

test("security headers include CSP and frame protection", () => {
  const middleware = securityHeaders({ secureCookies: true });
  const response = createMockResponse();
  let nextCalled = false;

  middleware({}, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["strict-transport-security"], /max-age=31536000/);
});
