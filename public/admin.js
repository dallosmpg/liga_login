const adminElements = {
  loginPanel: document.getElementById("login-panel"),
  dashboard: document.getElementById("dashboard"),
  loginForm: document.getElementById("login-form"),
  usernameInput: document.getElementById("admin-username"),
  passwordInput: document.getElementById("admin-password"),
  taskForm: document.getElementById("task-form"),
  taskNameInput: document.getElementById("task-name"),
  taskDateInput: document.getElementById("task-date-input"),
  tasksList: document.getElementById("tasks-list"),
  flash: document.getElementById("admin-flash"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),
};

function adminFlash(message, kind = "") {
  adminElements.flash.textContent = message;
  adminElements.flash.className = `flash ${kind}`.trim();
}

async function adminRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "A kérés sikertelen volt.");
  }

  return payload;
}

function setAuthenticated(isAuthenticated) {
  adminElements.loginPanel.classList.toggle("hidden", isAuthenticated);
  adminElements.dashboard.classList.toggle("hidden", !isAuthenticated);
  adminElements.logoutButton.classList.toggle("hidden", !isAuthenticated);
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.textContent != null) {
    element.textContent = options.textContent;
  }

  return element;
}

function createLinkButton(text, href, className) {
  const link = createElement("a", {
    className: `button ${className}`,
    textContent: text,
  });
  link.href = href;
  return link;
}

function createChip(text) {
  return createElement("span", { className: "chip", textContent: text });
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("hu-HU") : "-";
}

function renderPilotList(task) {
  const section = createElement("div", { className: "pilot-section" });
  const heading = createElement("div", { className: "pilot-list-heading" });
  heading.append(
    createElement("span", { textContent: "Bejelentkezett pilóták" }),
    createElement("span", {
      className: "muted",
      textContent: `${task.checkinCount} fő`,
    }),
  );
  section.append(heading);

  if (!task.checkins.length) {
    section.append(
      createElement("p", {
        className: "muted",
        textContent: "Még nincs bejelentkezett pilóta.",
      }),
    );
    return section;
  }

  const uploadsByParticipant = new Map(
    task.uploads.map((upload) => [upload.participantId, upload]),
  );
  const list = createElement("div", { className: "pilot-list" });

  task.checkins.forEach((checkin) => {
    const upload = uploadsByParticipant.get(checkin.participantId);
    const row = createElement("div", { className: "pilot-row" });
    const pilot = createElement("div", { className: "pilot-main" });
    pilot.append(
      createElement("strong", { textContent: checkin.participantId }),
      createElement("span", {
        className: "muted",
        textContent: `Be: ${formatDateTime(checkin.checkedInAt)}`,
      }),
    );

    const status = createChip(
      upload
        ? `IGC feltöltve: ${formatDateTime(upload.uploadedAt)}`
        : "Nincs IGC",
    );
    status.classList.add(upload ? "ok" : "warn");
    row.append(pilot, status);
    list.append(row);
  });

  section.append(list);
  return section;
}

function renderTasks(tasks) {
  adminElements.tasksList.replaceChildren();

  if (!tasks.length) {
    const card = createElement("div", { className: "task-card" });
    card.append(
      createElement("p", {
        className: "muted",
        textContent: "Még nincs létrehozott feladat.",
      }),
    );
    adminElements.tasksList.append(card);
    return;
  }

  const cards = tasks.map((task) => {
    const card = createElement("article", { className: "task-card" });
    const header = createElement("div", { className: "section-header" });
    const titleGroup = createElement("div");
    titleGroup.append(
      createElement("h3", { textContent: task.name }),
      createElement("p", { className: "muted", textContent: task.taskDate }),
    );

    const counts = createElement("div", { className: "pill-row" });
    counts.append(
      createChip(`${task.checkinCount} bejelentkezés`),
      createChip(`${task.uploadCount} feltöltés`),
    );
    header.append(titleGroup, counts);

    const tokenRow = createElement("div", { className: "token-row" });
    const publicLink = createElement("a", { textContent: task.publicUrl });
    publicLink.href = task.publicUrl;
    publicLink.target = "_blank";
    publicLink.rel = "noreferrer";
    tokenRow.append(publicLink);

    const actions = createElement("div", { className: "actions" });
    const copyButton = createElement("button", {
      className: "button ghost",
      textContent: "Link másolása",
    });
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(task.publicUrl);
        adminFlash("A feladat linkje vágólapra másolva.", "success");
      } catch (_error) {
        adminFlash("A vágólap elérése nem sikerült.", "error");
      }
    });

    actions.append(
      createLinkButton("QR letöltése", task.qrUrl, "primary"),
      createLinkButton("ZIP letöltése", task.zipUrl, "secondary"),
      createLinkButton("Pilótalista CSV", task.checkinsCsvUrl, "secondary"),
      copyButton,
    );

    card.append(header, tokenRow, actions, renderPilotList(task));
    return card;
  });

  adminElements.tasksList.append(...cards);
}

async function loadTasks() {
  const tasks = await adminRequest("/api/admin/tasks");
  renderTasks(tasks);
}

adminElements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await adminRequest("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: adminElements.usernameInput.value.trim(),
        password: adminElements.passwordInput.value,
      }),
    });
    adminElements.loginForm.reset();
    setAuthenticated(true);
    await loadTasks();
    adminFlash("Sikeres admin belépés.", "success");
  } catch (error) {
    adminFlash(error.message, "error");
  }
});

adminElements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await adminRequest("/api/admin/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: adminElements.taskNameInput.value.trim(),
        taskDate: adminElements.taskDateInput.value,
      }),
    });
    adminElements.taskForm.reset();
    await loadTasks();
    adminFlash("A feladat létrejött.", "success");
  } catch (error) {
    adminFlash(error.message, "error");
  }
});

adminElements.refreshButton.addEventListener("click", async () => {
  try {
    await loadTasks();
    adminFlash("A feladatlista frissítve.", "success");
  } catch (error) {
    adminFlash(error.message, "error");
  }
});

adminElements.logoutButton.addEventListener("click", async () => {
  try {
    await adminRequest("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    adminElements.tasksList.innerHTML = "";
    adminFlash("Sikeres kijelentkezés.", "success");
  } catch (error) {
    adminFlash(error.message, "error");
  }
});

(async function bootstrap() {
  adminElements.taskDateInput.value = new Date().toISOString().slice(0, 10);

  try {
    await adminRequest("/api/admin/session");
    setAuthenticated(true);
    await loadTasks();
  } catch (_error) {
    setAuthenticated(false);
  }
})();
