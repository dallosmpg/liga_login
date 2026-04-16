const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(crypto.scrypt);
const ROOT_DIR = __dirname;
const DEFAULT_ENV_FILE = path.join(ROOT_DIR, ".env");
const DEFAULT_STATE = { tasks: [], checkins: [], uploads: [] };
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 64 };
const DEFAULT_LIMITS = {
  adminLogin: { windowMs: 15 * 60 * 1000, max: 10 },
  publicWrite: { windowMs: 60 * 1000, max: 120 },
  publicUpload: { windowMs: 15 * 60 * 1000, max: 30 },
};
const DISABLED_QR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function parseEnvValue(rawValue) {
  const value = String(rawValue ?? "").trim();
  const quote = value[0];

  if (quote === "\"" || quote === "'") {
    let endIndex = value.length;

    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === quote && value[index - 1] !== "\\") {
        endIndex = index;
        break;
      }
    }

    const quoted = value.slice(1, endIndex);
    if (quote === "'") {
      return quoted;
    }

    return quoted
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  return value.replace(/\s+#.*$/, "").trim();
}

function loadEnvFile(filePath = DEFAULT_ENV_FILE, targetEnv = process.env) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      trimmed,
    );
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (targetEnv[key] == null) {
      targetEnv[key] = parseEnvValue(rawValue);
    }
  }

  return true;
}

loadEnvFile();

function createConfig(overrides = {}) {
  const port = Number(overrides.port ?? process.env.PORT ?? 3000);
  const baseUrl =
    (overrides.baseUrl ??
      process.env.BASE_URL ??
      `http://localhost:${port}`).replace(/\/+$/, "");
  const dataDir = overrides.dataDir ?? path.join(ROOT_DIR, "data");
  const storageDir = overrides.storageDir ?? path.join(ROOT_DIR, "storage");

  return {
    port,
    baseUrl,
    dataDir,
    storageDir,
    stateFile: path.join(dataDir, "state.json"),
    exportsDir: path.join(storageDir, "exports"),
    publicDir: path.join(ROOT_DIR, "public"),
    adminUsername: overrides.adminUsername ?? process.env.ADMIN_USERNAME ?? "admin",
    adminPasswordHash:
      overrides.adminPasswordHash ?? process.env.ADMIN_PASSWORD_HASH ?? "",
    adminPassword:
      overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? "change-me",
    maxUploadBytes:
      Number(overrides.maxUploadMb ?? process.env.MAX_UPLOAD_MB ?? 8) *
      1024 *
      1024,
    qrBinary: overrides.qrBinary ?? process.env.QR_BINARY ?? "qrencode",
    zipBinary: overrides.zipBinary ?? process.env.ZIP_BINARY ?? "zip",
    trustProxy: toBoolean(overrides.trustProxy ?? process.env.TRUST_PROXY, false),
    secureCookies: toBoolean(
      overrides.secureCookies ?? process.env.SECURE_COOKIES,
      baseUrl.startsWith("https://"),
    ),
    disableQrGeneration: toBoolean(
      overrides.disableQrGeneration ?? process.env.DISABLE_QR_GENERATION,
      false,
    ),
    rateLimits: {
      adminLogin: {
        windowMs: readPositiveNumber(
          overrides.adminLoginRateLimitWindowMs ??
            process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS ??
            DEFAULT_LIMITS.adminLogin.windowMs,
          DEFAULT_LIMITS.adminLogin.windowMs,
        ),
        max: readPositiveNumber(
          overrides.adminLoginRateLimitMax ??
            process.env.ADMIN_LOGIN_RATE_LIMIT_MAX ??
            DEFAULT_LIMITS.adminLogin.max,
          DEFAULT_LIMITS.adminLogin.max,
        ),
      },
      publicWrite: {
        windowMs: readPositiveNumber(
          overrides.publicWriteRateLimitWindowMs ??
            process.env.PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS ??
            DEFAULT_LIMITS.publicWrite.windowMs,
          DEFAULT_LIMITS.publicWrite.windowMs,
        ),
        max: readPositiveNumber(
          overrides.publicWriteRateLimitMax ??
            process.env.PUBLIC_WRITE_RATE_LIMIT_MAX ??
            DEFAULT_LIMITS.publicWrite.max,
          DEFAULT_LIMITS.publicWrite.max,
        ),
      },
      publicUpload: {
        windowMs: readPositiveNumber(
          overrides.publicUploadRateLimitWindowMs ??
            process.env.PUBLIC_UPLOAD_RATE_LIMIT_WINDOW_MS ??
            DEFAULT_LIMITS.publicUpload.windowMs,
          DEFAULT_LIMITS.publicUpload.windowMs,
        ),
        max: readPositiveNumber(
          overrides.publicUploadRateLimitMax ??
            process.env.PUBLIC_UPLOAD_RATE_LIMIT_MAX ??
            DEFAULT_LIMITS.publicUpload.max,
          DEFAULT_LIMITS.publicUpload.max,
        ),
      },
    },
  };
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value == null) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureAppLayout(config) {
  ensureDir(config.dataDir);
  ensureDir(config.storageDir);
  ensureDir(config.exportsDir);

  if (!fs.existsSync(config.stateFile)) {
    writeJsonAtomic(config.stateFile, DEFAULT_STATE);
  }
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return structuredCloneCompat(DEFAULT_STATE);
  }

  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    checkins: Array.isArray(parsed.checkins) ? parsed.checkins : [],
    uploads: Array.isArray(parsed.uploads) ? parsed.uploads : [],
  };
}

function structuredCloneCompat(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function normalizeParticipantId(rawValue) {
  const value = String(rawValue ?? "").trim().toUpperCase();

  if (!value) {
    throw badRequest("A rajtszám megadása kötelező.");
  }

  if (!/^[A-Z0-9_-]{1,32}$/.test(value)) {
    throw badRequest(
      "A rajtszám csak betűket, számokat, kötőjelet és aláhúzást tartalmazhat.",
    );
  }

  return value;
}

function normalizeTaskName(rawValue) {
  const value = String(rawValue ?? "").trim();

  if (!value) {
    throw badRequest("A feladat neve kötelező.");
  }

  if (value.length > 120) {
    throw badRequest("A feladat neve legfeljebb 120 karakter lehet.");
  }

  return value;
}

function normalizeTaskDate(rawValue) {
  const value = String(rawValue ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest("A feladat dátuma YYYY-MM-DD formátumú legyen.");
  }

  const candidate = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(candidate.getTime())) {
    throw badRequest("A feladat dátuma érvénytelen.");
  }

  return value;
}

function normalizeCheckinValidation(rawValue) {
  const value = String(rawValue ?? "open").trim().toLowerCase();

  if (!["open", "gps"].includes(value)) {
    throw badRequest("Érvénytelen bejelentkezési mód.");
  }

  return value;
}

function normalizeCoordinate(rawValue, label, min, max) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`${label} érvénytelen.`);
  }

  return value;
}

function normalizeRadiusMeters(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 10 || value > 10000) {
    throw badRequest("A GPS sugár 10 és 10000 méter közötti érték legyen.");
  }

  return Math.round(value);
}

function normalizeTaskCheckinOptions(rawValue = {}) {
  const checkinValidation = normalizeCheckinValidation(
    rawValue.checkinValidation,
  );

  if (checkinValidation !== "gps") {
    return {
      checkinValidation,
      checkinLatitude: null,
      checkinLongitude: null,
      checkinRadiusMeters: null,
    };
  }

  return {
    checkinValidation,
    checkinLatitude: normalizeCoordinate(
      rawValue.checkinLatitude,
      "A GPS szélesség",
      -90,
      90,
    ),
    checkinLongitude: normalizeCoordinate(
      rawValue.checkinLongitude,
      "A GPS hosszúság",
      -180,
      180,
    ),
    checkinRadiusMeters: normalizeRadiusMeters(
      rawValue.checkinRadiusMeters,
    ),
  };
}

function taskRequiresGps(task) {
  return task.checkinValidation === "gps";
}

function hasGpsConfig(task) {
  return (
    taskRequiresGps(task) &&
    Number.isFinite(task.checkinLatitude) &&
    Number.isFinite(task.checkinLongitude) &&
    Number.isFinite(task.checkinRadiusMeters)
  );
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceMetersBetween(left, right) {
  const earthRadiusMeters = 6371000;
  const deltaLat = toRadians(right.latitude - left.latitude);
  const deltaLon = toRadians(right.longitude - left.longitude);
  const leftLat = toRadians(left.latitude);
  const rightLat = toRadians(right.latitude);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLon / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function normalizeGpsLocation(rawValue = {}) {
  return {
    latitude: normalizeCoordinate(rawValue.latitude, "A GPS szélesség", -90, 90),
    longitude: normalizeCoordinate(
      rawValue.longitude,
      "A GPS hosszúság",
      -180,
      180,
    ),
    accuracyMeters: normalizeCoordinate(
      rawValue.accuracyMeters,
      "A GPS pontosság",
      0,
      5000,
    ),
  };
}

function validateCheckinLocation(task, rawLocation) {
  if (!taskRequiresGps(task)) {
    return { method: "open" };
  }

  if (!hasGpsConfig(task)) {
    throw badRequest("A GPS bejelentkezés nincs megfelelően beállítva.", 500);
  }

  const location = normalizeGpsLocation(rawLocation);
  const distanceMeters = distanceMetersBetween(
    {
      latitude: task.checkinLatitude,
      longitude: task.checkinLongitude,
    },
    location,
  );
  const maxAccuracyMeters = Math.max(task.checkinRadiusMeters, 100);

  if (location.accuracyMeters > maxAccuracyMeters) {
    throw badRequest(
      `A GPS pontosság túl alacsony (${Math.round(location.accuracyMeters)} m). Próbáld újra jobb vétellel.`,
    );
  }

  if (distanceMeters > task.checkinRadiusMeters) {
    throw badRequest(
      `A megadott hely ${Math.round(distanceMeters)} m-re van a bejelentkezési ponttól, a megengedett sugár ${task.checkinRadiusMeters} m.`,
      403,
    );
  }

  return {
    method: "gps",
    gpsDistanceMeters: Math.round(distanceMeters),
    gpsAccuracyMeters: Math.round(location.accuracyMeters),
  };
}

function validateCheckinAccess(task, body = {}) {
  if (!taskRequiresGps(task)) {
    return { method: "open" };
  }

  if (
    task.qrCheckinToken &&
    safeCompare(body.qrCheckinToken, task.qrCheckinToken)
  ) {
    return { method: "qr" };
  }

  return validateCheckinLocation(task, body.location);
}

function taskDirectory(config, taskId) {
  return path.join(config.storageDir, "tasks", taskId);
}

function taskLogsDirectory(config, taskId) {
  return path.join(taskDirectory(config, taskId), "logs");
}

function taskQrPath(config, taskId) {
  return path.join(taskDirectory(config, taskId), "qr", "task.png");
}

function taskQrMetadataPath(config, taskId) {
  return path.join(taskDirectory(config, taskId), "qr", "task.url");
}

function taskPublicUrl(config, task) {
  return `${config.baseUrl}/task/${task.publicToken}`;
}

function taskQrPublicUrl(config, task) {
  const publicUrl = taskPublicUrl(config, task);
  if (!task.qrCheckinToken) {
    return publicUrl;
  }

  return `${publicUrl}?qr=${encodeURIComponent(task.qrCheckinToken)}`;
}

function createQrCheckinToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
}

function taskArchiveName(task) {
  return `${task.taskDate}-${slugify(task.name)}-logs.zip`;
}

function taskQrDownloadName(task) {
  return `${task.taskDate}-${slugify(task.name)}-qr.png`;
}

function taskCheckinsDownloadName(task) {
  return `${task.taskDate}-${slugify(task.name)}-checkins.csv`;
}

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertProductionConfig(config, env = process.env) {
  if (env.NODE_ENV !== "production") {
    return;
  }

  if (!isValidPasswordHash(config.adminPasswordHash)) {
    throw new Error(
      "ADMIN_PASSWORD_HASH must be set to a valid scrypt hash in production.",
    );
  }
}

function scryptMaxmem(params) {
  return Math.max(32 * 1024 * 1024, 128 * params.N * params.r + 1024 * 1024);
}

async function derivePasswordKey(password, salt, params) {
  return scryptAsync(String(password ?? ""), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: scryptMaxmem(params),
  });
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function areScryptParamsSafe(params) {
  return (
    Number.isInteger(Math.log2(params.N)) &&
    params.N >= 1024 &&
    params.N <= 1048576 &&
    params.r >= 1 &&
    params.r <= 64 &&
    params.p >= 1 &&
    params.p <= 16 &&
    params.keyLength >= 32 &&
    params.keyLength <= 128
  );
}

function parsePasswordHash(passwordHash) {
  const parts = String(passwordHash ?? "").split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") {
    return null;
  }

  const params = {
    N: parsePositiveInteger(parts[1]),
    r: parsePositiveInteger(parts[2]),
    p: parsePositiveInteger(parts[3]),
    keyLength: parsePositiveInteger(parts[4]),
  };

  if (!params.N || !params.r || !params.p || !params.keyLength) {
    return null;
  }

  if (!areScryptParamsSafe(params)) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[5], "base64url");
    const hash = Buffer.from(parts[6], "base64url");
    if (salt.length < 16 || hash.length !== params.keyLength) {
      return null;
    }

    return { params, salt, hash };
  } catch (_error) {
    return null;
  }
}

function isValidPasswordHash(passwordHash) {
  return Boolean(parsePasswordHash(passwordHash));
}

async function createPasswordHash(password, options = {}) {
  const params = {
    N: options.N ?? SCRYPT_PARAMS.N,
    r: options.r ?? SCRYPT_PARAMS.r,
    p: options.p ?? SCRYPT_PARAMS.p,
    keyLength: options.keyLength ?? SCRYPT_PARAMS.keyLength,
  };
  const salt = options.salt ?? crypto.randomBytes(16);
  const hash = await derivePasswordKey(password, salt, params);

  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    params.keyLength,
    Buffer.from(salt).toString("base64url"),
    Buffer.from(hash).toString("base64url"),
  ].join("$");
}

async function verifyPassword(password, passwordHash) {
  const parsed = parsePasswordHash(passwordHash);
  if (!parsed) {
    return false;
  }

  let candidate;
  try {
    candidate = await derivePasswordKey(password, parsed.salt, parsed.params);
  } catch (_error) {
    return false;
  }
  if (candidate.length !== parsed.hash.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, parsed.hash);
}

async function verifyAdminPassword(password, config) {
  if (config.adminPasswordHash) {
    return verifyPassword(password, config.adminPasswordHash);
  }

  return safeCompare(password, config.adminPassword);
}

function safeCompare(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function parseCookies(cookieHeader) {
  return String(cookieHeader ?? "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((cookies, chunk) => {
      const separatorIndex = chunk.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }

      const key = chunk.slice(0, separatorIndex).trim();
      const value = chunk.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }

  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getRequestIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, max, keyGenerator } = {}) {
  const buckets = new Map();
  const limitWindowMs = Number(windowMs);
  const maxRequests = Number(max);

  return (req, res, next) => {
    if (!Number.isFinite(limitWindowMs) || !Number.isFinite(maxRequests)) {
      return next();
    }

    if (limitWindowMs <= 0 || maxRequests <= 0) {
      return next();
    }

    const now = Date.now();
    const key =
      keyGenerator?.(req) ??
      `${req.method}:${req.path}:${getRequestIp(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + limitWindowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count <= maxRequests) {
      return next();
    }

    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(Math.max(1, retryAfterSeconds)));
    return res.status(429).json({
      error: "Túl sok kérés. Kérlek próbáld újra később.",
    });
  };
}

function securityHeaders(config) {
  return (_req, res, next) => {
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "));
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(self), microphone=(), payment=()",
    );

    if (config.secureCookies) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }

    next();
  };
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch (_error) {
    return false;
  }
}

function requireAdminSameOrigin(config) {
  return (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      return next();
    }

    const origin = req.get("origin");
    const referer = req.get("referer");

    if (origin && !sameOrigin(origin, config.baseUrl)) {
      return res.status(403).json({ error: "Érvénytelen admin kérés eredet." });
    }

    if (!origin && referer && !sameOrigin(referer, config.baseUrl)) {
      return res.status(403).json({ error: "Érvénytelen admin kérés eredet." });
    }

    return next();
  };
}

function createStore(config) {
  let state = readState(config.stateFile);

  function persist() {
    writeJsonAtomic(config.stateFile, state);
  }

  function findTaskById(taskId) {
    return state.tasks.find((task) => task.id === taskId) ?? null;
  }

  function findTaskByToken(token) {
    return state.tasks.find((task) => task.publicToken === token) ?? null;
  }

  function listCheckins(taskId) {
    return state.checkins
      .filter((item) => item.taskId === taskId)
      .sort((left, right) => left.checkedInAt.localeCompare(right.checkedInAt));
  }

  function listUploads(taskId) {
    return state.uploads
      .filter((item) => item.taskId === taskId)
      .sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt));
  }

  return {
    getState() {
      return state;
    },

    listTasks() {
      return [...state.tasks].sort((left, right) =>
        right.taskDate.localeCompare(left.taskDate),
      );
    },

    findTaskById,
    findTaskByToken,
    listCheckins,
    listUploads,

    ensureTaskQrCheckinToken(taskId) {
      const task = findTaskById(taskId);
      if (!task) {
        return null;
      }

      if (!task.qrCheckinToken) {
        task.qrCheckinToken = createQrCheckinToken();
        persist();
      }

      return task;
    },

    findCheckin(taskId, participantId) {
      return (
        state.checkins.find(
          (item) =>
            item.taskId === taskId && item.participantId === participantId,
        ) ?? null
      );
    },

    createCheckin(taskId, participantId, metadata = {}) {
      const existing = this.findCheckin(taskId, participantId);
      if (existing) {
        return { record: existing, created: false };
      }

      const record = {
        taskId,
        participantId,
        checkedInAt: new Date().toISOString(),
        method: metadata.method ?? "open",
        gpsDistanceMeters: metadata.gpsDistanceMeters ?? null,
        gpsAccuracyMeters: metadata.gpsAccuracyMeters ?? null,
      };
      state.checkins.push(record);
      persist();
      return { record, created: true };
    },

    findUpload(taskId, participantId) {
      return (
        state.uploads.find(
          (item) =>
            item.taskId === taskId && item.participantId === participantId,
        ) ?? null
      );
    },

    saveUpload(taskId, participantId, originalName, stats) {
      const existing = this.findUpload(taskId, participantId);
      if (existing) {
        throw badRequest(
          "Ehhez a rajtszámhoz ezen a feladaton már tartozik napló. Csere előtt előbb töröld a meglévőt.",
          409,
        );
      }

      const record = {
        taskId,
        participantId,
        originalName,
        storedFilename: `${participantId}.igc`,
        uploadedAt: new Date().toISOString(),
        flightDate: stats.flightDate,
        fixCount: stats.fixCount,
      };

      state.uploads.push(record);
      persist();
      return record;
    },

    deleteUpload(taskId, participantId) {
      const index = state.uploads.findIndex(
        (item) => item.taskId === taskId && item.participantId === participantId,
      );

      if (index === -1) {
        return null;
      }

      const [removed] = state.uploads.splice(index, 1);
      persist();
      return removed;
    },

    createTask(name, taskDate, checkinOptions = {}) {
      const task = {
        id: crypto.randomUUID(),
        publicToken: crypto.randomUUID(),
        qrCheckinToken: createQrCheckinToken(),
        name,
        taskDate,
        ...checkinOptions,
        createdAt: new Date().toISOString(),
      };

      state.tasks.push(task);
      persist();
      return task;
    },

    updateTask(taskId, updates) {
      const task = findTaskById(taskId);
      if (!task) {
        return null;
      }

      Object.assign(task, updates, { updatedAt: new Date().toISOString() });
      persist();
      return task;
    },

    deleteTask(taskId) {
      const existing = findTaskById(taskId);
      state = {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== taskId),
        checkins: state.checkins.filter((item) => item.taskId !== taskId),
        uploads: state.uploads.filter((item) => item.taskId !== taskId),
      };
      persist();
      return existing;
    },
  };
}

function parseIgcDate(rawValue) {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(rawValue);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const year = Number(match[3]) <= 79 ? 2000 + Number(match[3]) : 1900 + Number(match[3]);
  const date = new Date(Date.UTC(year, monthIndex, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function validateIgcBuffer(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw badRequest("Az IGC fájl megadása kötelező.");
  }

  if (path.extname(file.originalname ?? "").toLowerCase() !== ".igc") {
    throw badRequest("Csak .igc fájl tölthető fel.");
  }

  const rawText = file.buffer.toString("latin1");
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw badRequest("A feltöltött fájl üres.");
  }

  if (!lines[0].startsWith("A") || lines[0].length < 4) {
    throw badRequest("Érvénytelen IGC fejléc rekord.");
  }

  const dateLine = lines.find((line) => /^H[FO]DTE(?:DATE:)?\d{6}/.test(line));
  if (!dateLine) {
    throw badRequest("Az IGC fájlból hiányzik a HFDTE dátum rekord.");
  }

  const rawDate = dateLine.match(/^H[FO]DTE(?:DATE:)?(\d{6})/)?.[1];
  const flightDate = rawDate ? parseIgcDate(rawDate) : null;
  if (!flightDate) {
    throw badRequest("Az IGC dátum rekord érvénytelen.");
  }

  const fixPattern = /^B\d{6}\d{7}[NS]\d{8}[EW][AV]\d{5}\d{5}/;
  const fixCount = lines.filter((line) => fixPattern.test(line)).length;
  if (fixCount < 3) {
    throw badRequest("Az IGC fájl nem tartalmaz elegendő érvényes pontrekordot.");
  }

  return { flightDate, fixCount };
}

function serializePublicTask(task, store, participantId, config) {
  const checkin = participantId ? store.findCheckin(task.id, participantId) : null;
  const upload = participantId ? store.findUpload(task.id, participantId) : null;

  return {
    task: {
      name: task.name,
      taskDate: task.taskDate,
      publicUrl: taskPublicUrl(config, task),
      checkinValidation: task.checkinValidation ?? "open",
    },
    participantId,
    checkedIn: Boolean(checkin),
    checkedInAt: checkin?.checkedInAt ?? null,
    checkinMethod: checkin?.method ?? null,
    gpsDistanceMeters: checkin?.gpsDistanceMeters ?? null,
    gpsAccuracyMeters: checkin?.gpsAccuracyMeters ?? null,
    upload: upload
      ? {
          participantId: upload.participantId,
          uploadedAt: upload.uploadedAt,
          originalName: upload.originalName,
          storedFilename: upload.storedFilename,
          flightDate: upload.flightDate,
          fixCount: upload.fixCount,
        }
      : null,
  };
}

function serializeAdminTask(task, store, config) {
  const checkins = store.listCheckins(task.id);
  const uploads = store.listUploads(task.id);

  return {
    id: task.id,
    name: task.name,
    taskDate: task.taskDate,
    createdAt: task.createdAt,
    publicToken: task.publicToken,
    publicUrl: taskPublicUrl(config, task),
    qrUrl: `/api/admin/tasks/${task.id}/qr`,
    zipUrl: `/api/admin/tasks/${task.id}/logs.zip`,
    checkinsCsvUrl: `/api/admin/tasks/${task.id}/checkins.csv`,
    checkinValidation: task.checkinValidation ?? "open",
    checkinLatitude: task.checkinLatitude ?? null,
    checkinLongitude: task.checkinLongitude ?? null,
    checkinRadiusMeters: task.checkinRadiusMeters ?? null,
    checkinCount: checkins.length,
    uploadCount: uploads.length,
    checkins,
    uploads,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }

  return text;
}

function buildCheckinsCsv(task, store) {
  const uploadsByParticipant = new Map(
    store.listUploads(task.id).map((upload) => [upload.participantId, upload]),
  );
  const rows = [
    [
      "participant_id",
      "checked_in_at",
      "checkin_method",
      "gps_distance_meters",
      "gps_accuracy_meters",
      "uploaded",
      "uploaded_at",
      "original_name",
      "flight_date",
      "fix_count",
    ],
  ];

  for (const checkin of store.listCheckins(task.id)) {
    const upload = uploadsByParticipant.get(checkin.participantId);
    rows.push([
      checkin.participantId,
      checkin.checkedInAt,
      checkin.method ?? "open",
      checkin.gpsDistanceMeters ?? "",
      checkin.gpsAccuracyMeters ?? "",
      upload ? "yes" : "no",
      upload?.uploadedAt ?? "",
      upload?.originalName ?? "",
      upload?.flightDate ?? "",
      upload?.fixCount ?? "",
    ]);
  }

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

async function generateTaskQr(task, config) {
  const outputPath = taskQrPath(config, task.id);
  const metadataPath = taskQrMetadataPath(config, task.id);
  const qrPublicUrl = taskQrPublicUrl(config, task);
  ensureDir(path.dirname(outputPath));

  if (config.disableQrGeneration) {
    await fsp.writeFile(outputPath, DISABLED_QR_PNG);
    await fsp.writeFile(metadataPath, `${qrPublicUrl}\n`, "utf8");
    return outputPath;
  }

  await execFileAsync(config.qrBinary, [
    "-t",
    "PNG",
    "--size=20",
    "--margin=4",
    "-o",
    outputPath,
    qrPublicUrl,
  ]);
  await fsp.writeFile(metadataPath, `${qrPublicUrl}\n`, "utf8");

  return outputPath;
}

function shouldGenerateTaskQr(task, config) {
  const qrPath = taskQrPath(config, task.id);
  const metadataPath = taskQrMetadataPath(config, task.id);

  if (!fs.existsSync(qrPath) || !fs.existsSync(metadataPath)) {
    return true;
  }

  return fs.readFileSync(metadataPath, "utf8").trim() !== taskQrPublicUrl(config, task);
}

async function buildZipArchive(task, store, config) {
  const uploads = store.listUploads(task.id);
  if (uploads.length === 0) {
    throw badRequest("Ehhez a feladathoz még nincs feltöltött napló.", 404);
  }

  const zipPath = path.join(
    config.exportsDir,
    `${task.id}-${Date.now()}-${crypto.randomUUID()}.zip`,
  );
  const files = uploads.map((upload) =>
    path.join(taskLogsDirectory(config, task.id), upload.storedFilename),
  );

  await execFileAsync(config.zipBinary, ["-j", "-q", zipPath, ...files]);
  return zipPath;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createApp(overrides = {}) {
  const config = createConfig(overrides);
  assertProductionConfig(config);
  ensureAppLayout(config);

  const app = express();
  app.disable("x-powered-by");

  const store = createStore(config);
  const adminSessions = new Map();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes },
  });

  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }

  const adminLoginLimiter = createRateLimiter({
    ...config.rateLimits.adminLogin,
    keyGenerator: (req) => `admin-login:${getRequestIp(req)}`,
  });
  const publicWriteLimiter = createRateLimiter({
    ...config.rateLimits.publicWrite,
    keyGenerator: (req) => `public-write:${getRequestIp(req)}`,
  });
  const publicUploadLimiter = createRateLimiter({
    ...config.rateLimits.publicUpload,
    keyGenerator: (req) =>
      `public-upload:${getRequestIp(req)}:${req.params.token ?? ""}`,
  });

  app.use(securityHeaders(config));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/admin", requireAdminSameOrigin(config));

  function getAdminSession(req) {
    const token = parseCookies(req.headers.cookie).admin_session;
    if (!token) {
      return null;
    }

    const session = adminSessions.get(token);
    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      adminSessions.delete(token);
      return null;
    }

    return { token, ...session };
  }

  function requireAdmin(req, res, next) {
    const session = getAdminSession(req);
    if (!session) {
      return res.status(401).json({ error: "Admin belépés szükséges." });
    }

    req.adminSession = session;
    next();
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(config.publicDir, "home.html"));
  });

  app.get("/task/:token", (_req, res) => {
    res.sendFile(path.join(config.publicDir, "task.html"));
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(config.publicDir, "admin.html"));
  });

  app.get(
    "/api/public/tasks/:token",
    asyncRoute(async (req, res) => {
      const task = store.findTaskByToken(req.params.token);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const participantId = req.query.participantId
        ? normalizeParticipantId(req.query.participantId)
        : null;

      res.json(serializePublicTask(task, store, participantId, config));
    }),
  );

  app.post(
    "/api/public/tasks/:token/checkin",
    publicWriteLimiter,
    asyncRoute(async (req, res) => {
      const task = store.findTaskByToken(req.params.token);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const participantId = normalizeParticipantId(req.body.participantId);
      const existingCheckin = store.findCheckin(task.id, participantId);
      const checkinMetadata = existingCheckin
        ? {}
        : validateCheckinAccess(task, req.body);
      const result = store.createCheckin(
        task.id,
        participantId,
        checkinMetadata,
      );

      res.json({
        message: result.created ? "Sikeres bejelentkezés." : "Már be van jelentkezve.",
        ...serializePublicTask(task, store, participantId, config),
      });
    }),
  );

  app.post(
    "/api/public/tasks/:token/upload",
    publicUploadLimiter,
    upload.single("igc"),
    asyncRoute(async (req, res) => {
      const task = store.findTaskByToken(req.params.token);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const participantId = normalizeParticipantId(req.body.participantId);
      const checkin = store.findCheckin(task.id, participantId);
      if (!checkin) {
        throw badRequest("IGC feltöltés előtt előbb jelentkezz be.");
      }

      if (store.findUpload(task.id, participantId)) {
        throw badRequest(
          "Ehhez a rajtszámhoz ezen a feladaton már tartozik napló. Csere előtt előbb töröld a meglévőt.",
          409,
        );
      }

      const stats = validateIgcBuffer(req.file);
      const logsDir = taskLogsDirectory(config, task.id);
      ensureDir(logsDir);
      await fsp.writeFile(
        path.join(logsDir, `${participantId}.igc`),
        req.file.buffer,
      );
      store.saveUpload(task.id, participantId, req.file.originalname, stats);

      res.status(201).json({
        message: "Az IGC feltöltése sikeres.",
        ...serializePublicTask(task, store, participantId, config),
      });
    }),
  );

  app.delete(
    "/api/public/tasks/:token/upload",
    publicWriteLimiter,
    asyncRoute(async (req, res) => {
      const task = store.findTaskByToken(req.params.token);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const participantId = normalizeParticipantId(req.body.participantId);
      const uploadRecord = store.deleteUpload(task.id, participantId);
      if (!uploadRecord) {
        throw badRequest("Ehhez a rajtszámhoz nincs feltöltött napló.", 404);
      }

      const filePath = path.join(
        taskLogsDirectory(config, task.id),
        uploadRecord.storedFilename,
      );
      if (fs.existsSync(filePath)) {
        await fsp.unlink(filePath);
      }

      res.json({
        message: "A feltöltött napló törölve.",
        ...serializePublicTask(task, store, participantId, config),
      });
    }),
  );

  app.post(
    "/api/admin/login",
    adminLoginLimiter,
    asyncRoute(async (req, res) => {
      const { username, password } = req.body ?? {};
      const usernameMatches = safeCompare(username, config.adminUsername);
      const passwordMatches = await verifyAdminPassword(password, config);

      if (!usernameMatches || !passwordMatches) {
        throw badRequest("Érvénytelen admin belépési adatok.", 401);
      }

      const token = crypto.randomBytes(32).toString("hex");
      adminSessions.set(token, {
        username: config.adminUsername,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      res.setHeader(
        "Set-Cookie",
        serializeCookie("admin_session", token, {
          maxAge: 7 * 24 * 60 * 60,
          secure: config.secureCookies,
        }),
      );

      res.json({ username: config.adminUsername });
    }),
  );

  app.post("/api/admin/logout", requireAdmin, (req, res) => {
    adminSessions.delete(req.adminSession.token);
    res.setHeader(
      "Set-Cookie",
      serializeCookie("admin_session", "", {
        maxAge: 0,
        secure: config.secureCookies,
      }),
    );
    res.json({ ok: true });
  });

  app.get("/api/admin/session", (req, res) => {
    const session = getAdminSession(req);
    if (!session) {
      return res.status(401).json({ error: "Admin belépés szükséges." });
    }

    res.json({ username: session.username });
  });

  app.get("/api/admin/tasks", requireAdmin, (req, res) => {
    res.json(store.listTasks().map((task) => serializeAdminTask(task, store, config)));
  });

  app.post(
    "/api/admin/tasks",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const name = normalizeTaskName(req.body.name);
      const taskDate = normalizeTaskDate(req.body.taskDate);
      const checkinOptions = normalizeTaskCheckinOptions(req.body);
      const task = store.createTask(name, taskDate, checkinOptions);

      try {
        await generateTaskQr(task, config);
      } catch (error) {
        store.deleteTask(task.id);
        fs.rmSync(taskDirectory(config, task.id), { force: true, recursive: true });
        throw badRequest(
          `A feladat létrehozása nem sikerült, mert a QR-kód generálása hibára futott: ${error.message}`,
          500,
        );
      }

      res.status(201).json(serializeAdminTask(task, store, config));
    }),
  );

  app.put(
    "/api/admin/tasks/:taskId",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const name = normalizeTaskName(req.body.name);
      const taskDate = normalizeTaskDate(req.body.taskDate);
      const checkinOptions = normalizeTaskCheckinOptions(req.body);
      const task = store.updateTask(req.params.taskId, {
        name,
        taskDate,
        ...checkinOptions,
      });

      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      res.json(serializeAdminTask(task, store, config));
    }),
  );

  app.delete(
    "/api/admin/tasks/:taskId",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const task = store.deleteTask(req.params.taskId);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      await fsp.rm(taskDirectory(config, task.id), {
        force: true,
        recursive: true,
      });

      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/admin/tasks/:taskId/qr",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const task = store.ensureTaskQrCheckinToken(req.params.taskId);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const qrPath = taskQrPath(config, task.id);
      if (shouldGenerateTaskQr(task, config)) {
        await generateTaskQr(task, config);
      }

      res.download(qrPath, taskQrDownloadName(task));
    }),
  );

  app.get(
    "/api/admin/tasks/:taskId/logs.zip",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const task = store.findTaskById(req.params.taskId);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const zipPath = await buildZipArchive(task, store, config);
      res.download(zipPath, taskArchiveName(task), async () => {
        if (fs.existsSync(zipPath)) {
          await fsp.unlink(zipPath).catch(() => {});
        }
      });
    }),
  );

  app.get(
    "/api/admin/tasks/:taskId/checkins.csv",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const task = store.findTaskById(req.params.taskId);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${taskCheckinsDownloadName(task)}"`,
      );
      res.send(buildCheckinsCsv(task, store));
    }),
  );

  app.use(express.static(config.publicDir));

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: `A feltöltött fájl meghaladja a ${config.maxUploadBytes / 1024 / 1024} MB-os limitet.` });
    }

    const status = error.status ?? 500;
    const message =
      status >= 500 ? "Belső szerverhiba." : error.message ?? "A kérés sikertelen volt.";

    if (status >= 500) {
      console.error(error);
    }

    res.status(status).json({ error: message });
  });

  return { app, config };
}

if (require.main === module) {
  const { app, config } = createApp();
  app.listen(config.port, () => {
    console.log(`Liga login app listening on ${config.baseUrl}`);
  });
}

module.exports = {
  assertProductionConfig,
  createApp,
  buildCheckinsCsv,
  createConfig,
  createPasswordHash,
  createRateLimiter,
  createStore,
  isValidPasswordHash,
  loadEnvFile,
  distanceMetersBetween,
  normalizeParticipantId,
  normalizeTaskCheckinOptions,
  requireAdminSameOrigin,
  securityHeaders,
  shouldGenerateTaskQr,
  taskQrPublicUrl,
  validateCheckinAccess,
  validateIgcBuffer,
  validateCheckinLocation,
  verifyPassword,
};
