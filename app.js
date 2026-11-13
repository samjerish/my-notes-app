const DB_NAME = "study-shelf";
const STORE_NAME = "pdfs";
const PROFILE_KEY = "study-shelf-profile";
const SUBJECTS_KEY = "study-shelf-subjects";
const ADMIN_UPLOAD_CODE = "7061";
const ADMIN_PROFILE = { name: "Sam", batch: "3" };
const UNASSIGNED_SUBJECT = "Unassigned";
const CONTRIBUTION_SECTION = "contributed";
const BUNDLED_REVISION_FILES = [
  "modelquestions.pdf",
  "REVISION1.pdf",
  "REVISION2.pdf",
  "REVISION3.pdf",
  "REVISION4.pdf",
  "REVISION5.pdf",
  "REVISION6.pdf",
  "Theory of Computation Question Bank.pdf",
  "ToC_QuestionBank_FA_RE_CFG.pdf",
];
const state = { view: "library", subject: "TOC", section: "revision", sortOldest: false };
let subjects = ["TOC"];
let db;
let toastTimer;
let uploadProgressTimer;
let cloudBackend = null;
let sharedFiles = null;
let stopCloudSubscriptions = null;
let pendingFileAssignment = null;
let pendingShareFile = null;
let pendingShareBlob = null;
let shareLoadId = 0;
let pendingAdminRequest = null;
let preserveAdminRequestOnCodeClose = false;
let requestedUploadSection = null;
let authorizedAdminUploadSection = null;

const fileInput = document.querySelector("#file-input");
const fileList = document.querySelector("#file-list");
const emptyState = document.querySelector("#empty-state");
const shareDialog = document.querySelector("#share-dialog");
const shareWhatsAppButton = document.querySelector("#share-whatsapp-button");
const shareDownloadButton = document.querySelector("#share-download-button");

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("subject", "subject");
      store.createIndex("section", "section");
      store.createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getLocalFiles() {
  return requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
}

function saveLocalFile(file, section, subject = state.subject, source = "library") {
  const record = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type || "application/pdf",
    section,
    subject,
    source,
    createdAt: Date.now(),
    blob: file,
  };
  return requestResult(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).add(record));
}

async function seedBundledFiles() {
  const existingFiles = await getLocalFiles();
  const existingNames = new Set(existingFiles.map((file) => file.name));
  for (const name of BUNDLED_REVISION_FILES) {
    if (existingNames.has(name)) continue;
    const response = await fetch(`revision-pdfs/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Could not load bundled PDF "${name}" (${response.status}).`);
    const pdf = await response.blob();
    await saveLocalFile(new File([pdf], name, { type: "application/pdf" }), "revision", "TOC");
  }
}

function removeLocalFile(id) {
  return requestResult(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
}

function moveLocalFileToSubject(file, subject) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put({ ...file, subject });
    request.onerror = () => reject(request.error);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Could not assign this PDF."));
  });
}

function getAllFiles() {
  if (!cloudBackend?.auth.currentUser) return getLocalFiles();
  return sharedFiles ? Promise.resolve(sharedFiles) : cloudBackend.getAllFiles();
}

function isCloudFile(file) {
  return Number.isInteger(file.chunkCount) || Boolean(file.storagePath);
}

function saveFile(file, section, subject = state.subject, source = "library", options = {}) {
  if (cloudBackend?.auth.currentUser) {
    return cloudBackend.saveFile(file, section, subject, source, options);
  }
  options.onProgress?.(0);
  return saveLocalFile(file, section, subject, source).then((record) => {
    options.onProgress?.(100);
    return record;
  });
}

function removeFile(file) {
  return cloudBackend?.auth.currentUser && isCloudFile(file)
    ? cloudBackend.removeFile(file)
    : removeLocalFile(file.id);
}

function moveFileToSubject(file, subject) {
  return cloudBackend?.auth.currentUser
    ? cloudBackend.moveFileToSubject(file, subject)
    : moveLocalFileToSubject(file, subject);
}

function canManageFile(file) {
  return Boolean(cloudBackend?.isAdmin() && isCloudFile(file) && cloudBackend.canManageFile(file));
}

function showBackendStatus(message, isError = false) {
  const loginStatus = document.querySelector("#login-backend-status");
  const appStatus = document.querySelector("#cloud-mode-notice");
  loginStatus.textContent = message;
  appStatus.textContent = message;
  loginStatus.hidden = !message;
  appStatus.hidden = !message;
  loginStatus.classList.toggle("backend-status-error", isError);
  appStatus.classList.toggle("backend-status-error", isError);
}

function updateAdminMenu() {
  const isAdmin = Boolean(cloudBackend?.isAdmin());
  const adminIsConfigured = Boolean(cloudBackend?.isAdminConfigured());
  const adminButton = document.querySelector("#admin-login-button");
  adminButton.hidden = !cloudBackend;
  adminButton.textContent = isAdmin
    ? "Admin account active"
    : adminIsConfigured ? "Admin sign in" : "Admin setup required";
  adminButton.disabled = isAdmin || !adminIsConfigured;
  document.querySelector("#publish-local-library-button").hidden = !isAdmin;
  document.querySelector("#add-subject-button").hidden = !isAdmin;
}

function cacheSubjects(sharedSubjects) {
  try {
    localStorage.setItem(SUBJECTS_KEY, JSON.stringify(sharedSubjects));
  } catch (error) {
    console.error("Could not cache subjects in this browser:", error);
  }
}

async function refreshCloudSubjects() {
  if (!cloudBackend?.auth.currentUser) return null;
  const sharedSubjects = await cloudBackend.getSubjects();
  if (sharedSubjects) {
    subjects = sharedSubjects;
    cacheSubjects(subjects);
  }
  return sharedSubjects;
}

function stopWatchingCloudLibrary() {
  if (stopCloudSubscriptions) stopCloudSubscriptions();
  stopCloudSubscriptions = null;
  sharedFiles = null;
}

function startWatchingCloudLibrary() {
  stopWatchingCloudLibrary();
  if (!cloudBackend?.auth.currentUser) return;

  const reportRenderError = (error) => {
    console.error("Could not render a shared-library update:", error);
    showBackendStatus(`Could not refresh the shared library. ${error.message || ""}`, true);
  };
  stopCloudSubscriptions = cloudBackend.watchLibrary(
    (files) => {
      sharedFiles = files;
      render().catch(reportRenderError);
    },
    (sharedSubjects) => {
      if (sharedSubjects === null) {
        showBackendStatus("The shared subject list is not set up yet. Admin sign-in is required.", true);
        return;
      }
      if (!Array.isArray(sharedSubjects) || sharedSubjects.some((subject) => typeof subject !== "string")) {
        showBackendStatus("The shared subject list is invalid. Ask the admin to repair the library settings.", true);
        return;
      }
      subjects = sharedSubjects;
      cacheSubjects(subjects);
      showBackendStatus("");
      render().catch(reportRenderError);
    },
    reportRenderError,
  );
}

function showToast(message, isError = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function iconMarkup(kind) {
  if (kind === "share") return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.5-4.5m-7.5 7 7.5 4.5"/></svg>';
  if (kind === "delete") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15m-13.5 0 .8 13h10.4L18 7M9 7V4.5h6V7m-5 3v6m4-6v6"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg>';
}

function makeFileRow(file) {
  const row = document.createElement("article");
  row.className = "file-row";
  row.classList.toggle("unassigned-file-row", state.subject === UNASSIGNED_SUBJECT);
  row.innerHTML = `
    <span class="pdf-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M14 4v4h4M8.5 15.5h7"/></svg></span>
    <span class="file-copy"><strong title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</strong><span>${formatSize(file.size)} · Added ${formatDate(file.createdAt)}</span></span>
    <span class="file-label ${file.section === "notes" ? "notes-label" : ""}">${file.section === CONTRIBUTION_SECTION ? "Contributed" : file.section === "notes" ? "Handwritten" : "Revision"}</span>
    <span class="file-actions">
      <button class="file-action" type="button" data-action="download" aria-label="Download ${escapeHTML(file.name)}" title="Download">${iconMarkup("download")}</button>
      <button class="file-action" type="button" data-action="share" aria-label="Share ${escapeHTML(file.name)}" title="Share">${iconMarkup("share")}</button>
      <button class="file-action" type="button" data-action="delete" aria-label="Delete ${escapeHTML(file.name)}" title="Delete">${iconMarkup("delete")}</button>
    </span>`;
  row.querySelectorAll(".file-action").forEach((button) => {
    button.addEventListener("click", () => handleFileAction(button.dataset.action, file));
  });
  const fileActions = row.querySelector(".file-actions");
  if (!canManageFile(file)) {
    row.querySelector('[data-action="delete"]').hidden = true;
  }
  if (state.subject === UNASSIGNED_SUBJECT) {
    if (canManageFile(file)) {
      const assignButton = document.createElement("button");
      assignButton.className = "file-assign-button";
      assignButton.type = "button";
      assignButton.dataset.action = "assign";
      assignButton.textContent = "Add to subject";
      assignButton.addEventListener("click", () => handleFileAction("assign", file));
      fileActions.prepend(assignButton);
    }
  }
  return row;
}

function makeSubjectCard(subject, fileCount) {
  const card = document.createElement("article");
  card.className = "subject-tile";

  const openButton = document.createElement("button");
  openButton.className = "subject-open";
  openButton.type = "button";
  openButton.dataset.subject = subject;
  openButton.setAttribute("aria-label", `Open ${subject}`);

  const mark = document.createElement("span");
  mark.className = "subject-tile-mark";
  mark.textContent = subject.slice(0, 1).toLocaleUpperCase();
  const copy = document.createElement("span");
  copy.className = "subject-tile-copy";
  const name = document.createElement("strong");
  name.textContent = subject;
  const total = document.createElement("span");
  total.textContent = `${fileCount} PDF${fileCount === 1 ? "" : "s"}`;
  copy.append(name, total);
  const arrow = document.createElement("span");
  arrow.className = "subject-tile-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
  openButton.append(mark, copy, arrow);
  card.append(openButton);

  if (cloudBackend?.isAdmin() && subject !== UNASSIGNED_SUBJECT) {
    const removeButton = document.createElement("button");
    removeButton.className = "subject-remove";
    removeButton.type = "button";
    removeButton.dataset.removeSubject = subject;
    removeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 0V4h4v3m4 0-.8 13H6.8L6 7m4 4v5m4-5v5"/></svg>';
    removeButton.setAttribute("aria-label", `Remove ${subject}`);
    removeButton.title = `Remove ${subject}`;
    card.append(removeButton);
  }
  return card;
}

async function handleFileAction(action, file) {
  if (action === "share") {
    void openShareDialog(file);
    return;
  }

  if (action === "assign") {
    pendingFileAssignment = file;
    const select = document.querySelector("#file-assign-subject");
    select.replaceChildren(new Option("Choose a subject", ""));
    subjects.forEach((subject) => select.add(new Option(subject, subject)));
    select.value = "";
    document.querySelector("#file-assign-name").textContent = file.name;
    document.querySelector("#file-assign-dialog").showModal();
    select.focus();
    return;
  }

  if (action === "delete") {
    if (!window.confirm(`Remove "${file.name}" from your shelf?`)) return;
    try {
      await removeFile(file);
      await render();
      showToast("PDF removed from your shelf.");
    } catch (error) {
      console.error("Could not remove PDF:", error);
      showToast("Couldn't remove this PDF. Please try again.", true);
    }
    return;
  }

  let blob = file.blob;
  if (cloudBackend?.auth.currentUser && isCloudFile(file)) {
    try {
      blob = await cloudBackend.getFileBlob(file);
    } catch (error) {
      console.error(`Could not download "${file.name}":`, error);
      showToast("Couldn't open this PDF. Check your connection and try again.", true);
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  if (action === "download") {
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function downloadPdfBlob(file, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openShareDialog(file) {
  const loadId = ++shareLoadId;
  pendingShareFile = file;
  pendingShareBlob = null;
  document.querySelector("#share-file-name").textContent = file.name;
  document.querySelector("#share-status").textContent = "Preparing PDF…";
  shareWhatsAppButton.disabled = true;
  shareDownloadButton.disabled = true;
  shareDialog.showModal();

  try {
    const blob = cloudBackend?.auth.currentUser && isCloudFile(file)
      ? await cloudBackend.getFileBlob(file)
      : file.blob;
    if (loadId !== shareLoadId) return;
    if (!(blob instanceof Blob)) throw new Error("The PDF data is unavailable.");
    pendingShareBlob = blob;
    document.querySelector("#share-status").textContent =
      "Choose WhatsApp in your device’s share menu, or download the PDF.";
    shareWhatsAppButton.disabled = false;
    shareDownloadButton.disabled = false;
  } catch (error) {
    if (loadId !== shareLoadId) return;
    console.error("Could not prepare PDF for sharing:", error);
    document.querySelector("#share-status").textContent = "Could not load this PDF. Close and try again.";
    showToast("Couldn't open this PDF. Check your connection and try again.", true);
  }
}

shareDialog.addEventListener("close", () => {
  shareLoadId += 1;
  pendingShareFile = null;
  pendingShareBlob = null;
  shareWhatsAppButton.disabled = true;
  shareDownloadButton.disabled = true;
});

document.querySelector("#share-close-button").addEventListener("click", () => shareDialog.close());
shareDownloadButton.addEventListener("click", () => {
  if (!pendingShareFile || !pendingShareBlob) return;
  downloadPdfBlob(pendingShareFile, pendingShareBlob);
  shareDialog.close();
});
shareWhatsAppButton.addEventListener("click", async () => {
  if (!pendingShareFile || !pendingShareBlob) return;
  const file = pendingShareFile;
  const blob = pendingShareBlob;
  const sharedFile = new File([blob], file.name, { type: "application/pdf" });

  if (navigator.share && navigator.canShare?.({ files: [sharedFile] })) {
    try {
      await navigator.share({ files: [sharedFile], title: file.name });
      shareDialog.close();
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Could not share PDF:", error);
      showToast("Couldn't share this PDF. Download it and attach it in WhatsApp.", true);
    }
    return;
  }

  const message = `Please see the attached PDF: ${file.name}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  downloadPdfBlob(file, blob);
  shareDialog.close();
  showToast("PDF downloaded. Attach it in WhatsApp to send.");
});

function updateUploadProgress(percent, message) {
  window.clearTimeout(uploadProgressTimer);
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  ["#upload-progress-panel", "#contribution-upload-progress"].forEach((selector) => {
    const panel = document.querySelector(selector);
    panel.hidden = false;
    panel.querySelector(".upload-progress-label").textContent = message;
    panel.querySelector(".upload-progress-value").textContent = `${value}%`;
    panel.querySelector("progress").value = value;
  });
}

function finishUploadProgress() {
  updateUploadProgress(100, "Upload complete");
  uploadProgressTimer = window.setTimeout(() => {
    document.querySelector("#upload-progress-panel").hidden = true;
    document.querySelector("#contribution-upload-progress").hidden = true;
  }, 1800);
}

function hideUploadProgress() {
  window.clearTimeout(uploadProgressTimer);
  document.querySelector("#upload-progress-panel").hidden = true;
  document.querySelector("#contribution-upload-progress").hidden = true;
}

async function render() {
  const allFiles = await getAllFiles();
  const displaySubjects = [...subjects];
  if (allFiles.some((file) => file.subject === UNASSIGNED_SUBJECT)) displaySubjects.push(UNASSIGNED_SUBJECT);
  const subjectCounts = new Map(displaySubjects.map((subject) => [
    subject,
    allFiles.filter((file) => file.subject === subject).length,
  ]));
  const isAdmin = Boolean(cloudBackend?.isAdmin());
  const adminOnlyUploadHidden = isAdminOnlySection(state.section) && !isAdmin;
  document.querySelector("#library-view").hidden = state.view !== "library";
  document.querySelector("#subject-view").hidden = state.view !== "subject";
  const isUnassigned = state.subject === UNASSIGNED_SUBJECT;
  document.querySelector("#section-grid").hidden = isUnassigned;
  document.querySelector("#upload-button").hidden = isUnassigned || adminOnlyUploadHidden;
  document.querySelector("#subject-description").hidden = isUnassigned;
  document.querySelector("#sort-button").hidden = isUnassigned;
  document.querySelector("#empty-upload-button").hidden = isUnassigned || adminOnlyUploadHidden;
  document.querySelector("#subject-list").replaceChildren(
    ...displaySubjects.map((subject) => makeSubjectCard(subject, subjectCounts.get(subject))),
  );
  const selectedContributionSubject = contributionSubjectSelect.value;
  contributionSubjectSelect.replaceChildren(new Option("Choose a subject", ""));
  subjects.forEach((subject) => {
    contributionSubjectSelect.add(new Option(subject, subject));
  });
  contributionSubjectSelect.value = subjects.includes(selectedContributionSubject) ? selectedContributionSubject : "";

  const subjectFiles = allFiles.filter((file) => file.subject === state.subject);
  const revisionFiles = subjectFiles.filter((file) => file.section === "revision");
  const noteFiles = subjectFiles.filter((file) => file.section === "notes");
  const contributedFiles = subjectFiles.filter((file) => file.section === CONTRIBUTION_SECTION);
  document.querySelector("#revision-count").textContent = revisionFiles.length;
  document.querySelector("#notes-count").textContent = noteFiles.length;

  document.querySelector("#contributed-count").textContent = contributedFiles.length;
  document.querySelector("#subject-heading").textContent = state.subject;
  document.querySelector("#subject-description").textContent = state.subject === "TOC"
    ? "Theory of Computation · Your notes & revision material"
    : state.subject === UNASSIGNED_SUBJECT
    ? "PDFs saved from removed subjects."
    : `${state.subject} · Your notes & revision material`;
  const visibleFiles = isUnassigned ? subjectFiles : state.section === "notes"
    ? noteFiles
    : state.section === CONTRIBUTION_SECTION ? contributedFiles : revisionFiles;
  const sectionFiles = visibleFiles
    .sort((a, b) => state.sortOldest ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  document.querySelector("#files-title").textContent = isUnassigned
    ? "Unassigned PDFs"
    : state.section === "notes"
    ? "Handwritten notes"
    : state.section === CONTRIBUTION_SECTION ? "Contributed PDFs" : "Revision PDFs";
  document.querySelector("#files-subtitle").textContent = isUnassigned
    ? "Choose a subject for each PDF to add it to your library."
    : state.section === "notes"
    ? "Admin-only uploads · Scans of your own notes, all in one place."
    : state.section === CONTRIBUTION_SECTION
    ? cloudBackend?.auth.currentUser
      ? "Community PDFs shared with all signed-in users."
      : "PDFs contributed in this browser."
    : "Admin-only uploads · A tidy place for your last-minute refreshers.";
  document.querySelector("#files-total").textContent = sectionFiles.length;
  document.querySelector("#empty-section-name").textContent = isUnassigned
    ? "unassigned"
    : state.section === "notes"
    ? "handwritten notes"
    : state.section === CONTRIBUTION_SECTION ? "contributed" : "revision";
  document.querySelector("#sort-button").lastChild.textContent = state.sortOldest ? "Oldest first" : "Newest first";
  fileList.replaceChildren(...sectionFiles.map(makeFileRow));
  emptyState.hidden = sectionFiles.length > 0;
  fileList.hidden = sectionFiles.length === 0;
}

async function addSelectedFiles(files, section = state.section) {
  const pdfs = [...files].filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) {
    showToast("Please choose a PDF file.", true);
    return;
  }
  try {
    for (const [index, file] of pdfs.entries()) {
      const progressLabel = pdfs.length === 1
        ? `Uploading ${file.name}`
        : `Uploading ${index + 1} of ${pdfs.length}: ${file.name}`;
      await saveFile(file, section, state.subject, "library", {
        onProgress: (progress) => updateUploadProgress(
          ((index + progress / 100) / pdfs.length) * 100,
          progressLabel,
        ),
      });
    }
    await render();
    finishUploadProgress();
    const sectionName = section === "notes"
      ? "Handwritten notes"
      : section === CONTRIBUTION_SECTION ? "Contributed PDFs" : "Revision PDFs";
    showToast(`${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} added to ${sectionName}.`);
  } catch (error) {
    hideUploadProgress();
    console.error("Could not save PDF:", error);
    showToast(error.message || "Couldn't save the PDF. Check storage and try again.", true);
  }
}

function showLibrary(profile) {
  const activeProfile = cloudBackend?.isAdmin() ? ADMIN_PROFILE : profile;
  state.view = "library";
  document.querySelector("#login-screen").hidden = true;
  document.querySelector("#app-shell").hidden = false;
  document.querySelector(".top-avatar").textContent = activeProfile.name.trim().charAt(0).toUpperCase();
  document.querySelector(".top-avatar").title = `${activeProfile.name} · Batch ${activeProfile.batch}`;
  document.querySelector("#profile-name").textContent = activeProfile.name;
  document.querySelector("#profile-batch").textContent = `Batch ${activeProfile.batch}`;
  updateAdminMenu();
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#login-submit");
  const submitText = submitButton.querySelector("span");
  const errorMessage = document.querySelector("#login-error");
  const nameInput = document.querySelector("#login-name");
  const batchInput = document.querySelector("#login-batch");
  const profile = { name: nameInput.value.trim(), batch: batchInput.value.trim() };
  errorMessage.hidden = true;
  nameInput.value = profile.name;
  batchInput.value = profile.batch;
  submitButton.disabled = true;
  submitText.textContent = "Signing in...";

  try {
    if (cloudBackend) {
      await cloudBackend.signInStudent();
      await cloudBackend.saveProfile(profile);
      const sharedSubjects = await refreshCloudSubjects();
      if (!sharedSubjects) {
        showBackendStatus(
          "Shared subjects are not initialized. The admin must sign in and publish this device’s library first.",
          true,
        );
      }
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    showLibrary(profile);
    if (cloudBackend) startWatchingCloudLibrary();
    await render();
    showToast("Welcome to your study space.");
  } catch (error) {
    console.error("Sign-in failed:", error);
    errorMessage.textContent = error.message || "Couldn't sign in. Check your connection and try again.";
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitText.textContent = "Get started";
  }
});

function isAdminOnlySection(section) {
  return section === "revision" || section === "notes";
}

function openFilePicker(section) {
  requestedUploadSection = section;
  fileInput.click();
}

function requestFileUpload() {
  if (!isAdminOnlySection(state.section)) {
    openFilePicker(state.section);
    return;
  }

  if (authorizedAdminUploadSection === state.section) {
    openFilePicker(state.section);
    return;
  }

  openAdminCodeDialog({ type: "upload", section: state.section });
}

function openAdminCodeDialog(request) {
  pendingAdminRequest = request;
  const adminCodeInput = document.querySelector("#admin-code-input");
  const isSubjectRequest = request.type === "subject";
  const isSubjectRemovalRequest = request.type === "remove-subject";
  adminCodeInput.value = "";
  adminCodeInput.removeAttribute("aria-invalid");
  const errorMessage = document.querySelector("#admin-code-error");
  errorMessage.textContent = isSubjectRemovalRequest
    ? "Not allowed to remove subjects. Only admin can access."
    : isSubjectRequest
      ? "Not allowed to add subjects. Only admin can access."
      : "Not allowed to add PDFs. Only admin can access.";
  errorMessage.hidden = true;
  document.querySelector("#admin-code-description").textContent = isSubjectRequest
    ? "Enter the admin code to add a subject."
    : isSubjectRemovalRequest
      ? "Enter the admin code to remove this subject."
      : "Enter the admin code to add PDFs to this section.";
  document.querySelector("#admin-code-submit").textContent = isSubjectRequest
    ? "Verify & add subject"
    : isSubjectRemovalRequest
      ? "Verify & remove subject"
      : "Verify & add PDF";
  document.querySelector("#admin-code-dialog").showModal();
  adminCodeInput.focus();
}

function continueAdminRequest(request, options = {}) {
  if (request?.type === "subject") {
    subjectInput.value = "";
    subjectDialog.showModal();
    subjectInput.focus();
    return;
  }
  if (request?.type === "remove-subject") {
    if (!subjects.includes(request.subject) || request.subject === UNASSIGNED_SUBJECT) {
      showToast("Not allowed to remove this subject. Only admin can access.", true);
      return;
    }
    pendingSubjectRemoval = request.subject;
    document.querySelector("#remove-subject-title").textContent = `Remove ${request.subject}?`;
    document.querySelector("#remove-subject-message").textContent =
      "Its PDFs will be kept under Unassigned.";
    document.querySelector("#remove-subject-dialog").showModal();
    return;
  }
  if (request?.type !== "upload" || !isAdminOnlySection(request.section) || request.section !== state.section) {
    showToast("Not allowed to add PDFs. Only admin can access.", true);
    return;
  }
  authorizedAdminUploadSection = request.section;
  if (options.deferFilePicker) {
    showToast("Admin access confirmed. Tap Add PDF again to choose a file.");
    return;
  }
  openFilePicker(request.section);
}

function openAdminLoginDialog() {
  document.querySelector("#admin-login-form").reset();
  document.querySelector("#admin-login-error").hidden = true;
  const emailInput = document.querySelector("#admin-login-email");
  emailInput.value = window.STUDY_CORNER_ADMIN_EMAIL || "";
  document.querySelector("#admin-login-dialog").showModal();
  if (emailInput.value) document.querySelector("#admin-login-password").focus();
  else emailInput.focus();
}

document.querySelector("#upload-button").addEventListener("click", requestFileUpload);
document.querySelector("#empty-upload-button").addEventListener("click", requestFileUpload);
document.querySelector("#admin-code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const adminCodeInput = document.querySelector("#admin-code-input");
  const errorMessage = document.querySelector("#admin-code-error");
  if (adminCodeInput.value.trim() !== ADMIN_UPLOAD_CODE) {
    errorMessage.hidden = false;
    adminCodeInput.setAttribute("aria-invalid", "true");
    adminCodeInput.focus();
    return;
  }

  if (cloudBackend && !cloudBackend.isAdmin()) {
    if (!cloudBackend.isAdminConfigured()) {
      errorMessage.textContent = "Admin email is not configured. Set it in firebase-config.js and Firebase rules.";
      errorMessage.hidden = false;
      return;
    }
    preserveAdminRequestOnCodeClose = true;
    document.querySelector("#admin-code-dialog").close();
    openAdminLoginDialog();
    return;
  }

  const request = pendingAdminRequest;
  pendingAdminRequest = null;
  document.querySelector("#admin-code-dialog").close();
  continueAdminRequest(request);
});
document.querySelector("#admin-code-cancel").addEventListener("click", () => {
  pendingAdminRequest = null;
  document.querySelector("#admin-code-dialog").close();
});
document.querySelector("#admin-code-dialog").addEventListener("close", () => {
  if (preserveAdminRequestOnCodeClose) {
    preserveAdminRequestOnCodeClose = false;
    return;
  }
  pendingAdminRequest = null;
});
document.querySelector("#admin-login-button").addEventListener("click", () => {
  if (!cloudBackend || cloudBackend.isAdmin()) return;
  openAdminLoginDialog();
});
document.querySelector("#admin-login-cancel").addEventListener("click", () => {
  pendingAdminRequest = null;
  document.querySelector("#admin-login-dialog").close();
});
document.querySelector("#admin-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cloudBackend) {
    document.querySelector("#admin-login-error").textContent = "Firebase is not configured.";
    document.querySelector("#admin-login-error").hidden = false;
    return;
  }

  const submitButton = document.querySelector("#admin-login-submit");
  const errorMessage = document.querySelector("#admin-login-error");
  submitButton.disabled = true;
  errorMessage.hidden = true;
  try {
    await cloudBackend.signInAdmin(
      document.querySelector("#admin-login-email").value.trim(),
      document.querySelector("#admin-login-password").value,
    );
    localStorage.setItem(PROFILE_KEY, JSON.stringify(ADMIN_PROFILE));
  } catch (error) {
    console.error("Admin sign-in failed:", error);
    errorMessage.textContent = error.message || "Couldn't sign in as admin.";
    errorMessage.hidden = false;
    submitButton.disabled = false;
    return;
  }

  const request = pendingAdminRequest;
  pendingAdminRequest = null;
  document.querySelector("#admin-login-dialog").close();
  showLibrary(ADMIN_PROFILE);
  if (request?.type === "upload") {
    state.view = "subject";
    state.section = request.section;
  }
  updateAdminMenu();
  startWatchingCloudLibrary();
  try {
    const sharedSubjects = await refreshCloudSubjects();
    if (!sharedSubjects) {
      showBackendStatus("The shared subject list is not set up yet. Admin sign-in is required.", true);
    }
  } catch (error) {
    console.error("Could not load the shared library after admin sign-in:", error);
    showToast("Admin signed in, but the shared library could not be refreshed.", true);
  }
  try {
    await render();
  } catch (error) {
    console.error("Could not render the shared library after admin sign-in:", error);
    showToast("Admin signed in, but the shared library could not be displayed.", true);
  }
  if (request) continueAdminRequest(request, { deferFilePicker: true });
  if (request?.type !== "upload") showToast("Admin access confirmed.");
  submitButton.disabled = false;
});
fileInput.addEventListener("change", async (event) => {
  const section = requestedUploadSection ?? state.section;
  const requiresAdmin = isAdminOnlySection(section);
  const isAuthorized = authorizedAdminUploadSection === section;
  requestedUploadSection = null;
  authorizedAdminUploadSection = null;
  if (requiresAdmin && !isAuthorized) {
    showToast("Not allowed to add PDFs. Only admin can access.", true);
    fileInput.value = "";
    return;
  }
  await addSelectedFiles(event.target.files, section);
  fileInput.value = "";
});
fileInput.addEventListener("cancel", () => {
  requestedUploadSection = null;
  authorizedAdminUploadSection = null;
});

document.querySelectorAll(".section-card").forEach((card) => {
  card.addEventListener("click", async () => {
    state.section = card.dataset.section;
    document.querySelectorAll(".section-card").forEach((item) => item.classList.toggle("active-section", item === card));
    await render();
  });
});

document.querySelector("#sort-button").addEventListener("click", async (event) => {
  state.sortOldest = !state.sortOldest;
  event.currentTarget.lastChild.textContent = state.sortOldest ? "Oldest first" : "Newest first";
  await render();
});

const subjectDialog = document.querySelector("#subject-dialog");
const subjectInput = document.querySelector("#subject-name");

document.querySelector("#add-subject-button").addEventListener("click", () => {
  if (!cloudBackend?.isAdmin()) {
    showToast("Only the admin can add subjects.", true);
    return;
  }
  openAdminCodeDialog({ type: "subject" });
});

document.querySelector("#subject-cancel").addEventListener("click", () => subjectDialog.close());

document.querySelector("#subject-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cloudBackend?.isAdmin()) {
    showToast("Only the admin can add subjects.", true);
    return;
  }

  const subject = subjectInput.value.trim();
  if (!subject) {
    showToast("Enter a subject name.", true);
    subjectInput.focus();
    return;
  }
  if (subject.length > 60) {
    showToast("Subject names must be 60 characters or fewer.", true);
    subjectInput.focus();
    return;
  }
  if (subject.toLocaleLowerCase() === UNASSIGNED_SUBJECT.toLocaleLowerCase()) {
    showToast("That name is reserved for unassigned PDFs.", true);
    subjectInput.focus();
    return;
  }
  if (subjects.some((existing) => existing.toLocaleLowerCase() === subject.toLocaleLowerCase())) {
    showToast("That subject already exists.", true);
    subjectInput.focus();
    return;
  }

  const updatedSubjects = [...subjects, subject];
  try {
    await cloudBackend.saveSubjects(updatedSubjects);
  } catch (error) {
    console.error("Could not save the new subject:", error);
    showToast(error.message || "Couldn't save this subject. Please try again.", true);
    return;
  }

  subjectDialog.close();
  subjects = updatedSubjects;
  cacheSubjects(subjects);
  await render();
  showToast(`${subject} added to your library.`);
});

document.querySelector("#subject-list").addEventListener("click", async (event) => {
  const removeButton = event.target.closest(".subject-remove");
  if (removeButton) {
    if (!cloudBackend?.isAdmin()) {
      showToast("Only the admin can remove subjects.", true);
      return;
    }
    const subject = removeButton.dataset.removeSubject;
    openAdminCodeDialog({ type: "remove-subject", subject });
    return;
  }

  const openButton = event.target.closest(".subject-open");
  if (!openButton) return;
  state.subject = openButton.dataset.subject;
  state.view = "subject";
  state.section = "revision";
  state.sortOldest = false;
  document.querySelectorAll(".section-card").forEach((card) => {
    card.classList.toggle("active-section", card.dataset.section === state.section);
  });
  await render();
});

async function showLibraryHome() {
  state.view = "library";
  await render();
}

document.querySelector("#library-home-button").addEventListener("click", showLibraryHome);
document.querySelector("#back-to-library").addEventListener("click", showLibraryHome);
document.querySelector("#brand-home").addEventListener("click", (event) => {
  event.preventDefault();
  showLibraryHome();
});

const contributionDialog = document.querySelector("#contribution-dialog");
const contributionSubjectSelect = document.querySelector("#contribution-subject");
const contributionFileInput = document.querySelector("#contribution-file");
function openContributionDialog() {
  contributionSubjectSelect.value = state.view === "subject" && subjects.includes(state.subject) ? state.subject : "";
  contributionFileInput.value = "";
  contributionDialog.showModal();
  contributionSubjectSelect.focus();
}
document.querySelector("#contribute-open-button").addEventListener("click", openContributionDialog);
document.querySelector("#contribution-reminder-button").addEventListener("click", openContributionDialog);
document.querySelector("#contribution-cancel").addEventListener("click", () => contributionDialog.close());
document.querySelector("#contribution-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const subject = contributionSubjectSelect.value;
  const file = contributionFileInput.files[0];
  if (!subjects.includes(subject)) {
    showToast("Choose a subject from the list.", true);
    contributionSubjectSelect.focus();
    return;
  }
  if (!file || (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) {
    showToast("Please choose a PDF file.", true);
    contributionFileInput.focus();
    return;
  }

  const submitButton = document.querySelector("#contribution-form button[type='submit']");
  const cancelButton = document.querySelector("#contribution-cancel");
  submitButton.disabled = true;
  cancelButton.disabled = true;
  try {
    await saveFile(file, CONTRIBUTION_SECTION, subject, "contribution", {
      onProgress: (progress) => updateUploadProgress(progress, `Uploading ${file.name}`),
    });
  } catch (error) {
    hideUploadProgress();
    console.error("Could not save contributed PDF:", error);
    showToast(error.message || "Couldn't save this PDF. Check your connection and try again.", true);
    return;
  } finally {
    submitButton.disabled = false;
    cancelButton.disabled = false;
  }

  finishUploadProgress();
  contributionDialog.close();
  state.subject = subject;
  state.view = "subject";
  state.section = CONTRIBUTION_SECTION;
  document.querySelectorAll(".section-card").forEach((card) => {
    card.classList.toggle("active-section", card.dataset.section === state.section);
  });
  await render();
  showToast("Your PDF was added to Contributions.");
});

const feedbackDialog = document.querySelector("#feedback-dialog");
const feedbackForm = document.querySelector("#feedback-form");
const feedbackError = document.querySelector("#feedback-error");
document.querySelector("#feedback-open-button").addEventListener("click", () => {
  feedbackForm.reset();
  feedbackError.hidden = true;
  feedbackDialog.showModal();
  document.querySelector("#feedback-name").focus();
});
document.querySelector("#feedback-cancel").addEventListener("click", () => feedbackDialog.close());
feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#feedback-submit");
  feedbackError.hidden = true;
  submitButton.disabled = true;
  try {
    const response = await fetch(feedbackForm.action, {
      method: "POST",
      body: new FormData(feedbackForm),
      headers: { Accept: "application/json" },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = result.errors?.map((error) => error.message).join(" ");
      throw new Error(details || "We couldn't send your feedback. Please try again.");
    }

    feedbackDialog.close();
    feedbackForm.reset();
    showToast("Thank you for your feedback.");
  } catch (error) {
    console.error("Feedback could not be submitted:", error);
    feedbackError.textContent = error.message || "Couldn't send your feedback. Check your connection and try again.";
    feedbackError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

let pendingSubjectRemoval = null;
const removeSubjectDialog = document.querySelector("#remove-subject-dialog");
document.querySelector("#cancel-remove-subject").addEventListener("click", () => {
  pendingSubjectRemoval = null;
  removeSubjectDialog.close();
});
document.querySelector("#confirm-remove-subject").addEventListener("click", async () => {
  const subject = pendingSubjectRemoval;
  if (!subject) return;
  if (!cloudBackend?.isAdmin()) {
    showToast("Only the admin can remove subjects.", true);
    return;
  }

  const updatedSubjects = subjects.filter((existing) => existing !== subject);
  try {
    await cloudBackend.removeSubject(subject, updatedSubjects);
  } catch (error) {
    console.error(`Could not remove subject "${subject}":`, error);
    showToast(error.message || "Couldn't remove this subject. Please try again.", true);
    return;
  }

  cacheSubjects(updatedSubjects);
  subjects = updatedSubjects;
  if (state.subject === subject) state.view = "library";
  pendingSubjectRemoval = null;
  removeSubjectDialog.close();
  await render();
  showToast(`${subject} removed. Its PDFs are under Unassigned.`);
});

const fileAssignDialog = document.querySelector("#file-assign-dialog");
const fileAssignSubject = document.querySelector("#file-assign-subject");
document.querySelector("#file-assign-cancel").addEventListener("click", () => {
  pendingFileAssignment = null;
  fileAssignDialog.close();
});
document.querySelector("#file-assign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const subject = fileAssignSubject.value;
  if (!pendingFileAssignment || !subjects.includes(subject)) {
    showToast("Choose a subject from the list.", true);
    fileAssignSubject.focus();
    return;
  }

  const file = pendingFileAssignment;
  try {
    await moveFileToSubject(file, subject);
  } catch (error) {
    console.error(`Could not add "${file.name}" to "${subject}":`, error);
    showToast(error.message || "Couldn't add this PDF to the subject. Please try again.", true);
    return;
  }

  pendingFileAssignment = null;
  fileAssignDialog.close();
  state.subject = subject;
  state.view = "subject";
  state.section = file.section;
  document.querySelectorAll(".section-card").forEach((card) => {
    card.classList.toggle("active-section", card.dataset.section === state.section);
  });
  await render();
  showToast(`${file.name} added to ${subject}.`);
});

const profileButton = document.querySelector(".top-avatar");
const profileMenu = document.querySelector("#profile-menu");
profileButton.addEventListener("click", () => {
  const isExpanded = profileButton.getAttribute("aria-expanded") === "true";
  profileButton.setAttribute("aria-expanded", String(!isExpanded));
  profileMenu.hidden = isExpanded;
});

document.addEventListener("click", (event) => {
  if (event.target.closest(".profile-control")) return;
  profileMenu.hidden = true;
  profileButton.setAttribute("aria-expanded", "false");
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  stopWatchingCloudLibrary();
  try {
    if (cloudBackend?.auth.currentUser) await cloudBackend.signOut();
  } catch (error) {
    console.error("Could not sign out of Firebase:", error);
    showToast("Couldn't log out. Please try again.", true);
    return;
  }

  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch (error) {
    console.error("Could not clear the signed-in profile:", error);
    showToast("Couldn't log out. Please try again.", true);
    return;
  }

  document.querySelector("#login-name").value = "";
  document.querySelector("#login-batch").value = "";
  profileMenu.hidden = true;
  profileButton.setAttribute("aria-expanded", "false");
  document.querySelector("#app-shell").hidden = true;
  document.querySelector("#login-screen").hidden = false;
  window.scrollTo({ top: 0 });
});

document.querySelector("#publish-local-library-button").addEventListener("click", async () => {
  if (!cloudBackend?.isAdmin()) {
    showToast("Only the configured Firebase admin can publish this device’s library.", true);
    return;
  }

  const button = document.querySelector("#publish-local-library-button");
  button.disabled = true;
  try {
    const localFiles = await getLocalFiles();
    const subjectList = subjects.length ? subjects.join(", ") : "none";
    const message = `Publish ${localFiles.length} PDF${localFiles.length === 1 ? "" : "s"} and these subjects to the shared library?\n\n${subjectList}\n\nLocal copies will remain on this device.`;
    if (!window.confirm(message)) return;

    const uploaded = await cloudBackend.migrateLocalLibrary(localFiles, subjects);
    await refreshCloudSubjects();
    await render();
    showToast(`${uploaded} local PDF${uploaded === 1 ? "" : "s"} published to the shared library.`);
    showBackendStatus("");
  } catch (error) {
    console.error("Could not publish the local library:", error);
    showToast(error.message || "Couldn't publish this device's library.", true);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    profileMenu.hidden = true;
    profileButton.setAttribute("aria-expanded", "false");
  }
});

try {
  const storedSubjects = JSON.parse(localStorage.getItem(SUBJECTS_KEY) || "null");
  if (Array.isArray(storedSubjects)) {
    subjects = ["TOC", ...new Set(storedSubjects
      .filter((subject) => typeof subject === "string")
      .map((subject) => subject.trim())
      .filter((subject) => subject
        && subject.toLocaleLowerCase() !== "toc"
        && subject.toLocaleLowerCase() !== UNASSIGNED_SUBJECT.toLocaleLowerCase()))];
  }
} catch (error) {
  console.error("Could not read saved subjects:", error);
}

const savedProfile = (() => {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    return profile && typeof profile.name === "string" && typeof profile.batch === "string" ? profile : null;
  } catch (error) {
    console.error("Could not read the saved profile:", error);
    return null;
  }
})();

async function initializeStudyCorner() {
  const firebaseConfig = window.STUDY_CORNER_FIREBASE_CONFIG;
  const adminEmail = window.STUDY_CORNER_ADMIN_EMAIL;
  if (window.StudyCornerFirebase?.isConfigured(firebaseConfig)) {
    try {
      cloudBackend = await window.StudyCornerFirebase.createBackend(firebaseConfig, adminEmail);
      if (!cloudBackend) {
        showBackendStatus("Firebase is not configured. This is a local-only preview; PDFs will not sync between devices.", true);
      }
    } catch (error) {
      console.error("Could not connect to Firebase:", error);
      showBackendStatus(
        `Firebase is unavailable. This is a local-only preview; PDFs will not sync. ${error.message || ""}`,
        true,
      );
    }
  } else {
    showBackendStatus("Firebase is not configured. This is a local-only preview; PDFs will not sync between devices.", true);
  }

  updateAdminMenu();
  try {
    db = await openDatabase();
    try {
      await seedBundledFiles();
    } catch (error) {
      console.error("Could not seed bundled local PDFs:", error);
      if (!cloudBackend) throw error;
    }

    if (savedProfile && (!cloudBackend || cloudBackend.auth.currentUser)) {
      if (cloudBackend) {
        try {
          const sharedSubjects = await refreshCloudSubjects();
          if (!sharedSubjects) {
            showBackendStatus(
              "The shared subject list is not set up yet. Sign in as admin and publish this device’s library.",
              true,
            );
          }
        } catch (error) {
          console.error("Could not load shared subjects:", error);
          showBackendStatus(
            `Could not load the shared library. ${error.message || "Check your connection and Firebase setup."}`,
            true,
          );
        }
      }
      showLibrary(savedProfile);
      if (cloudBackend) startWatchingCloudLibrary();
    }
    await render();
  } catch (error) {
    console.error("Could not open the study library:", error);
    showToast("Couldn't open your library. Check browser storage and Firebase setup.", true);
  }
}

initializeStudyCorner();
