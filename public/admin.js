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

function renderTasks(tasks) {
  if (!tasks.length) {
    adminElements.tasksList.innerHTML =
      '<div class="task-card"><p class="muted">Még nincs létrehozott feladat.</p></div>';
    return;
  }

  adminElements.tasksList.innerHTML = tasks
    .map(
      (task) => `
        <article class="task-card">
          <div class="section-header">
            <div>
              <h3>${task.name}</h3>
              <p class="muted">${task.taskDate}</p>
            </div>
            <div class="pill-row">
              <span class="chip">${task.checkinCount} bejelentkezés</span>
              <span class="chip">${task.uploadCount} feltöltés</span>
            </div>
          </div>

          <div class="token-row">
            <a href="${task.publicUrl}" target="_blank" rel="noreferrer">${task.publicUrl}</a>
          </div>

          <div class="actions">
            <a class="button primary" href="${task.qrUrl}">QR letöltése</a>
            <a class="button secondary" href="${task.zipUrl}">ZIP letöltése</a>
            <button class="button ghost" type="button" data-copy="${task.publicUrl}">Link másolása</button>
          </div>

          <div class="pill-row">
            ${task.checkins
              .map(
                (item) =>
                  `<span class="chip">BE ${item.participantId}</span>`,
              )
              .join("")}
          </div>

          <div class="pill-row">
            ${task.uploads
              .map(
                (item) =>
                  `<span class="chip">IGC ${item.participantId}.igc</span>`,
              )
              .join("")}
          </div>
        </article>
      `,
    )
    .join("");

  adminElements.tasksList.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        adminFlash("A feladat linkje vágólapra másolva.", "success");
      } catch (_error) {
        adminFlash("A vágólap elérése nem sikerült.", "error");
      }
    });
  });
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
