const adminElements = {
  loginPanel: document.getElementById("login-panel"),
  dashboard: document.getElementById("dashboard"),
  loginForm: document.getElementById("login-form"),
  usernameInput: document.getElementById("admin-username"),
  passwordInput: document.getElementById("admin-password"),
  taskForm: document.getElementById("task-form"),
  taskNameInput: document.getElementById("task-name"),
  taskDateInput: document.getElementById("task-date-input"),
  checkinValidationInput: document.getElementById("checkin-validation"),
  checkinLatitudeInput: document.getElementById("checkin-latitude"),
  checkinLongitudeInput: document.getElementById("checkin-longitude"),
  checkinRadiusInput: document.getElementById("checkin-radius"),
  tasksList: document.getElementById("tasks-list"),
  flash: document.getElementById("admin-flash"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),
};

const collapsedTaskIds = new Set();
const editingTaskIds = new Set();
let renderedTasks = [];

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

function createButton(text, className, onClick) {
  const button = createElement("button", {
    className: `button ${className}`,
    textContent: text,
  });
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString("hu-HU") : "-";
}

function checkinValidationLabel(task) {
  if (task.checkinValidation === "gps") {
    return `QR vagy GPS: ${task.checkinLatitude}, ${task.checkinLongitude} / ${task.checkinRadiusMeters} m`;
  }

  return "QR/link helyellenőrzés nélkül";
}

function toggleGpsFields() {
  const gpsEnabled = adminElements.checkinValidationInput.value === "gps";
  [
    adminElements.checkinLatitudeInput,
    adminElements.checkinLongitudeInput,
    adminElements.checkinRadiusInput,
  ].forEach((input) => {
    input.disabled = !gpsEnabled;
    input.required = gpsEnabled;
    input.closest(".gps-field").classList.toggle("is-disabled", !gpsEnabled);
  });
}

function appendOption(select, value, text, selectedValue) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  option.selected = value === selectedValue;
  select.append(option);
}

function createField(label, control, className = "") {
  const field = createElement("label", {
    className: `field ${className}`.trim(),
  });
  field.append(createElement("span", { textContent: label }), control);
  return field;
}

function setGpsControlsEnabled(select, fields) {
  const gpsEnabled = select.value === "gps";
  fields.forEach(({ input, field }) => {
    input.disabled = !gpsEnabled;
    input.required = gpsEnabled;
    field.classList.toggle("is-disabled", !gpsEnabled);
  });
}

function createEditForm(task) {
  const form = createElement("form", {
    className: "edit-task-form grid two compact-grid",
  });

  const nameInput = document.createElement("input");
  nameInput.required = true;
  nameInput.value = task.name;

  const dateInput = document.createElement("input");
  dateInput.required = true;
  dateInput.type = "date";
  dateInput.value = task.taskDate;

  const validationSelect = document.createElement("select");
  appendOption(
    validationSelect,
    "open",
    "QR/link alapján, helyellenőrzés nélkül",
    task.checkinValidation,
  );
  appendOption(
    validationSelect,
    "gps",
    "QR-kód vagy GPS hely alapján",
    task.checkinValidation,
  );

  const latitudeInput = document.createElement("input");
  latitudeInput.type = "number";
  latitudeInput.step = "0.000001";
  latitudeInput.min = "-90";
  latitudeInput.max = "90";
  latitudeInput.value = task.checkinLatitude ?? "";

  const longitudeInput = document.createElement("input");
  longitudeInput.type = "number";
  longitudeInput.step = "0.000001";
  longitudeInput.min = "-180";
  longitudeInput.max = "180";
  longitudeInput.value = task.checkinLongitude ?? "";

  const radiusInput = document.createElement("input");
  radiusInput.type = "number";
  radiusInput.step = "1";
  radiusInput.min = "10";
  radiusInput.max = "10000";
  radiusInput.value = task.checkinRadiusMeters ?? "";

  const latitudeField = createField("GPS szélesség", latitudeInput, "gps-field");
  const longitudeField = createField("GPS hosszúság", longitudeInput, "gps-field");
  const radiusField = createField("Sugár méterben", radiusInput, "gps-field");
  const gpsFields = [
    { input: latitudeInput, field: latitudeField },
    { input: longitudeInput, field: longitudeField },
    { input: radiusInput, field: radiusField },
  ];

  validationSelect.addEventListener("change", () =>
    setGpsControlsEnabled(validationSelect, gpsFields),
  );
  setGpsControlsEnabled(validationSelect, gpsFields);

  const formActions = createElement("div", { className: "actions form-actions" });
  const saveButton = createElement("button", {
    className: "button primary",
    textContent: "Mentés",
  });
  saveButton.type = "submit";
  const cancelButton = createButton("Mégse", "ghost", () => {
    editingTaskIds.delete(task.id);
    renderTasks(renderedTasks);
  });
  formActions.append(saveButton, cancelButton);

  form.append(
    createField("Feladat neve", nameInput),
    createField("Feladat dátuma", dateInput),
    createField("Bejelentkezés módja", validationSelect),
    latitudeField,
    longitudeField,
    radiusField,
    formActions,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await adminRequest(`/api/admin/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          taskDate: dateInput.value,
          checkinValidation: validationSelect.value,
          checkinLatitude: latitudeInput.value,
          checkinLongitude: longitudeInput.value,
          checkinRadiusMeters: radiusInput.value,
        }),
      });
      editingTaskIds.delete(task.id);
      await loadTasks();
      adminFlash("A feladat módosítva.", "success");
    } catch (error) {
      adminFlash(error.message, "error");
    }
  });

  return form;
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
    const checkinMethod = createChip(
      checkin.method === "gps"
        ? `GPS ${checkin.gpsDistanceMeters ?? "?"} m / pontosság ${checkin.gpsAccuracyMeters ?? "?"} m`
        : checkin.method === "qr"
          ? "QR-kód"
        : "QR/link",
    );
    checkinMethod.classList.add(
      checkin.method === "gps" || checkin.method === "qr" ? "ok" : "neutral",
    );
    row.append(pilot, checkinMethod, status);
    list.append(row);
  });

  section.append(list);
  return section;
}

function renderTasks(tasks) {
  renderedTasks = tasks;
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
    const isCollapsed = collapsedTaskIds.has(task.id);
    const isEditing = editingTaskIds.has(task.id);
    card.classList.toggle("is-collapsed", isCollapsed);

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
      createChip(checkinValidationLabel(task)),
    );
    const headerActions = createElement("div", { className: "actions task-header-actions" });
    headerActions.append(
      createButton(isCollapsed ? "Megnyitás" : "Összecsukás", "ghost", () => {
        if (collapsedTaskIds.has(task.id)) {
          collapsedTaskIds.delete(task.id);
        } else {
          collapsedTaskIds.add(task.id);
          editingTaskIds.delete(task.id);
        }
        renderTasks(renderedTasks);
      }),
      createButton("Szerkesztés", "secondary", () => {
        editingTaskIds.add(task.id);
        collapsedTaskIds.delete(task.id);
        renderTasks(renderedTasks);
      }),
      createButton("Törlés", "danger", async () => {
        if (
          !window.confirm(
            `Biztosan törlöd ezt a feladatot és minden hozzá tartozó bejelentkezést/feltöltést? (${task.name})`,
          )
        ) {
          return;
        }

        try {
          await adminRequest(`/api/admin/tasks/${task.id}`, { method: "DELETE" });
          collapsedTaskIds.delete(task.id);
          editingTaskIds.delete(task.id);
          await loadTasks();
          adminFlash("A feladat törölve.", "success");
        } catch (error) {
          adminFlash(error.message, "error");
        }
      }),
    );
    header.append(titleGroup, counts, headerActions);

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
      createLinkButton("QR PNG letöltése", task.qrUrl, "primary"),
      createLinkButton("ZIP letöltése", task.zipUrl, "secondary"),
      createLinkButton("Pilótalista CSV", task.checkinsCsvUrl, "secondary"),
      copyButton,
    );

    const body = createElement("div", { className: "task-card-body" });
    if (isEditing) {
      body.append(createEditForm(task));
    }
    body.append(tokenRow, actions, renderPilotList(task));

    card.append(header);
    if (!isCollapsed) {
      card.append(body);
    }
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
        checkinValidation: adminElements.checkinValidationInput.value,
        checkinLatitude: adminElements.checkinLatitudeInput.value,
        checkinLongitude: adminElements.checkinLongitudeInput.value,
        checkinRadiusMeters: adminElements.checkinRadiusInput.value,
      }),
    });
    adminElements.taskForm.reset();
    toggleGpsFields();
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
  toggleGpsFields();
  adminElements.checkinValidationInput.addEventListener("change", toggleGpsFields);

  try {
    await adminRequest("/api/admin/session");
    setAuthenticated(true);
    await loadTasks();
  } catch (_error) {
    setAuthenticated(false);
  }
})();
