const participantStorageKey = "liga.participantId";
const token = window.location.pathname.split("/").filter(Boolean).pop();

const elements = {
  title: document.getElementById("task-title"),
  date: document.getElementById("task-date"),
  participantForm: document.getElementById("participant-form"),
  participantInput: document.getElementById("participant-id"),
  participantConfirmInput: document.getElementById("participant-id-confirm"),
  clearParticipantButton: document.getElementById("clear-participant"),
  checkinButton: document.getElementById("checkin-button"),
  uploadForm: document.getElementById("upload-form"),
  uploadInput: document.getElementById("igc-file"),
  uploadButton: document.getElementById("upload-button"),
  deleteButton: document.getElementById("delete-button"),
  statusCards: document.getElementById("status-cards"),
  flash: document.getElementById("flash"),
};

let currentState = null;
let participantId = window.localStorage.getItem(participantStorageKey) || "";

elements.participantInput.value = participantId;
elements.participantConfirmInput.value = participantId;

async function request(url, options = {}) {
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

function setFlash(message, kind = "") {
  elements.flash.textContent = message;
  elements.flash.className = `flash ${kind}`.trim();
}

function readConfirmedParticipantId() {
  const firstValue = elements.participantInput.value.trim().toUpperCase();
  const secondValue = elements.participantConfirmInput.value.trim().toUpperCase();

  if (!firstValue || !secondValue) {
    throw new Error("A rajtszámot mindkét mezőben meg kell adni.");
  }

  if (firstValue !== secondValue) {
    throw new Error("A két rajtszám nem egyezik.");
  }

  return firstValue;
}

function renderStatus() {
  if (!currentState) {
    return;
  }

  elements.title.textContent = currentState.task.name;
  elements.date.textContent = currentState.task.taskDate;

  const items = [
    {
      label: participantId
        ? `Rajtszám: ${participantId}`
        : "A rajtszám még nincs megadva",
      kind: participantId ? "ok" : "warn",
    },
    {
      label: currentState.checkedIn
        ? `Bejelentkezve: ${new Date(currentState.checkedInAt).toLocaleString("hu-HU")}`
        : "Még nincs bejelentkezve",
      kind: currentState.checkedIn ? "ok" : "warn",
    },
    {
      label: currentState.upload
        ? `Feltöltve: ${currentState.upload.storedFilename}, ${currentState.upload.fixCount} ponttal`
        : "Nincs feltöltött IGC",
      kind: currentState.upload ? "ok" : "warn",
    },
  ];

  elements.statusCards.innerHTML = items
    .map(
      (item) =>
        `<div class="status-pill ${item.kind}">${item.label}</div>`,
    )
    .join("");

  const canAct = Boolean(participantId);
  elements.checkinButton.disabled = !canAct || currentState.checkedIn;
  elements.uploadButton.disabled =
    !canAct || !currentState.checkedIn || Boolean(currentState.upload);
  elements.uploadInput.disabled =
    !canAct || !currentState.checkedIn || Boolean(currentState.upload);
  elements.deleteButton.disabled = !canAct || !currentState.upload;
}

async function loadTaskState() {
  const query = participantId
    ? `?participantId=${encodeURIComponent(participantId)}`
    : "";
  currentState = await request(`/api/public/tasks/${token}${query}`);
  renderStatus();
}

elements.participantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    participantId = readConfirmedParticipantId();
    window.localStorage.setItem(participantStorageKey, participantId);
    elements.participantInput.value = participantId;
    elements.participantConfirmInput.value = participantId;
    setFlash(`A rajtszám megerősítve és mentve: ${participantId}.`, "success");
    await loadTaskState();
  } catch (error) {
    setFlash(error.message, "error");
  }
});

elements.clearParticipantButton.addEventListener("click", async () => {
  participantId = "";
  elements.participantInput.value = "";
  elements.participantConfirmInput.value = "";
  window.localStorage.removeItem(participantStorageKey);
  setFlash("A rajtszám törölve.", "success");
  await loadTaskState().catch((error) => setFlash(error.message, "error"));
});

elements.checkinButton.addEventListener("click", async () => {
  try {
    currentState = await request(`/api/public/tasks/${token}/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participantId }),
    });
    renderStatus();
    setFlash("A bejelentkezés rögzítve.", "success");
  } catch (error) {
    setFlash(error.message, "error");
  }
});

elements.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = elements.uploadInput.files[0];
  if (!file) {
    setFlash("Feltöltés előtt válassz ki egy .igc fájlt.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("participantId", participantId);
  formData.append("igc", file);

  try {
    currentState = await request(`/api/public/tasks/${token}/upload`, {
      method: "POST",
      body: formData,
    });
    elements.uploadForm.reset();
    renderStatus();
    setFlash("Az IGC feltöltve és ellenőrizve.", "success");
  } catch (error) {
    setFlash(error.message, "error");
  }
});

elements.deleteButton.addEventListener("click", async () => {
  try {
    currentState = await request(`/api/public/tasks/${token}/upload`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participantId }),
    });
    renderStatus();
    setFlash("A feltöltött napló törölve.", "success");
  } catch (error) {
    setFlash(error.message, "error");
  }
});

loadTaskState().catch((error) => {
  elements.title.textContent = "A feladat nem érhető el";
  elements.date.textContent = "";
  setFlash(error.message, "error");
});
