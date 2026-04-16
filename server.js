const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const ROOT_DIR = __dirname;
const DEFAULT_STATE = { tasks: [], checkins: [], uploads: [] };

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
  };
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

function taskDirectory(config, taskId) {
  return path.join(config.storageDir, "tasks", taskId);
}

function taskLogsDirectory(config, taskId) {
  return path.join(taskDirectory(config, taskId), "logs");
}

function taskQrPath(config, taskId) {
  return path.join(taskDirectory(config, taskId), "qr", "task.svg");
}

function taskPublicUrl(config, task) {
  return `${config.baseUrl}/task/${task.publicToken}`;
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
  return `${task.taskDate}-${slugify(task.name)}-qr.svg`;
}

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
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

    findCheckin(taskId, participantId) {
      return (
        state.checkins.find(
          (item) =>
            item.taskId === taskId && item.participantId === participantId,
        ) ?? null
      );
    },

    createCheckin(taskId, participantId) {
      const existing = this.findCheckin(taskId, participantId);
      if (existing) {
        return { record: existing, created: false };
      }

      const record = {
        taskId,
        participantId,
        checkedInAt: new Date().toISOString(),
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

    createTask(name, taskDate) {
      const task = {
        id: crypto.randomUUID(),
        publicToken: crypto.randomUUID(),
        name,
        taskDate,
        createdAt: new Date().toISOString(),
      };

      state.tasks.push(task);
      persist();
      return task;
    },

    deleteTask(taskId) {
      state = {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== taskId),
        checkins: state.checkins.filter((item) => item.taskId !== taskId),
        uploads: state.uploads.filter((item) => item.taskId !== taskId),
      };
      persist();
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
    },
    participantId,
    checkedIn: Boolean(checkin),
    checkedInAt: checkin?.checkedInAt ?? null,
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
    checkinCount: checkins.length,
    uploadCount: uploads.length,
    checkins,
    uploads,
  };
}

async function generateTaskQr(task, config) {
  const outputPath = taskQrPath(config, task.id);
  ensureDir(path.dirname(outputPath));

  if (config.disableQrGeneration) {
    const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 180"><rect width="420" height="180" fill="#f7f1e8"/><text x="24" y="48" fill="#202328" font-family="sans-serif" font-size="18">QR generation disabled</text><text x="24" y="92" fill="#202328" font-family="monospace" font-size="13">${taskPublicUrl(config, task)}</text></svg>`;
    await fsp.writeFile(outputPath, placeholder, "utf8");
    return outputPath;
  }

  await execFileAsync(config.qrBinary, [
    "-t",
    "SVG",
    "--margin=1",
    "--foreground=1B1E20",
    "--background=F8F1E7",
    "-o",
    outputPath,
    taskPublicUrl(config, task),
  ]);

  return outputPath;
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
  ensureAppLayout(config);

  const app = express();
  const store = createStore(config);
  const adminSessions = new Map();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes },
  });

  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

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
    asyncRoute(async (req, res) => {
      const task = store.findTaskByToken(req.params.token);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const participantId = normalizeParticipantId(req.body.participantId);
      const result = store.createCheckin(task.id, participantId);

      res.json({
        message: result.created ? "Sikeres bejelentkezés." : "Már be van jelentkezve.",
        ...serializePublicTask(task, store, participantId, config),
      });
    }),
  );

  app.post(
    "/api/public/tasks/:token/upload",
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
    asyncRoute(async (req, res) => {
      const { username, password } = req.body ?? {};

      if (
        !safeCompare(username, config.adminUsername) ||
        !safeCompare(password, config.adminPassword)
      ) {
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
      const task = store.createTask(name, taskDate);

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

  app.get(
    "/api/admin/tasks/:taskId/qr",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const task = store.findTaskById(req.params.taskId);
      if (!task) {
        throw badRequest("A feladat nem található.", 404);
      }

      const qrPath = taskQrPath(config, task.id);
      if (!fs.existsSync(qrPath)) {
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
  createApp,
  createConfig,
  createStore,
  normalizeParticipantId,
  validateIgcBuffer,
};
