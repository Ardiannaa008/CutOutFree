import { removeBackground as imglyRemoveBackground } from "@imgly/background-removal";
import { inject, track } from "@vercel/analytics";
import { initEditor, openEditor } from "./editor.js";

initEditor();

// Initialize Analytics
inject();
// ─── State ───────────────────────────────────────────────────────────────────
const jobs = new Map();
let activeBatchDone = 0;
let activeBatchTotal = 0;
let modelReady = false;

// ─── Concurrency-limited queue ───────────────────────────────────────────────
// Running background-removal on every dropped file at once doesn't actually
// speed things up (the WASM model session is shared), it just makes them all
// fight over the same CPU/memory — which can stall or crash the tab on
// lower-end devices with big batches. Cap how many run at the same time.
const MAX_CONCURRENT = 3;
let runningCount = 0;
const fileQueue = [];

function enqueueFile(file) {
  fileQueue.push(file);
  pumpQueue();
}

function pumpQueue() {
  while (runningCount < MAX_CONCURRENT && fileQueue.length > 0) {
    const file = fileQueue.shift();
    runningCount++;
    processFile(file).finally(() => {
      runningCount--;
      pumpQueue();
    });
  }
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusBar = document.getElementById("status-bar");
const progressInner = document.getElementById("progress-inner");
const statusText = document.getElementById("status-text");
const resultsEl = document.getElementById("results");
const imageGrid = document.getElementById("image-grid");
const resultsTitle = document.getElementById("results-title");
const statusSpinner = document.getElementById("status-spinner");
const toast = document.getElementById("toast");
const modelBanner = document.getElementById("model-banner");
const modelBannerText = document.getElementById("model-banner-text");
const modelProgressInner = document.getElementById("model-progress-inner");
const modelBannerPct = document.getElementById("model-banner-pct");

// ─── Model warm-up ────────────────────────────────────────────────────────────
async function warmUpModel() {
  // Only show banner on first visit (model not cached yet)
  const cached = localStorage.getItem("cutout-model-cached");
  if (!cached) {
    modelBanner.classList.add("visible");
  }

  // Create a tiny 1x1 transparent PNG as a warm-up image
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));

  try {
    await imglyRemoveBackground(blob, {
      progress: (key, current, total) => {
        if (!cached) {
          const pct = total > 0 ? Math.round((current / total) * 100) : 0;
          modelProgressInner.style.width = pct + "%";
          modelBannerPct.textContent = pct + "%";
          if (key.includes("fetch") || key.includes("load")) {
            modelBannerText.textContent = "Downloading AI model…";
          } else if (key.includes("inference")) {
            modelBannerText.textContent = "Initialising AI model…";
          }
        }
      },
    });
  } catch (_) {
    // Warm-up errors are silent — real errors will surface when user uploads
  }

  modelReady = true;
  localStorage.setItem("cutout-model-cached", "1");
  modelBanner.classList.remove("visible");
  modelBanner.classList.add("done");
}

warmUpModel();

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ─── Drag & drop ──────────────────────────────────────────────────────────────
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () =>
  dropzone.classList.remove("drag-over"),
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  handleFiles(Array.from(e.dataTransfer.files));
});

// ─── File input ───────────────────────────────────────────────────────────────
fileInput.addEventListener("change", () => {
  handleFiles(Array.from(fileInput.files));
  fileInput.value = "";
});

// ─── Paste support (Ctrl+V / Cmd+V) ──────────────────────────────────────────
document.addEventListener("paste", (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const images = items
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;
  e.preventDefault();
  dropzone.classList.add("drag-over");
  setTimeout(() => dropzone.classList.remove("drag-over"), 400);
  handleFiles(images);
});

// ─── Buttons ──────────────────────────────────────────────────────────────────
document.getElementById("dl-all-btn").addEventListener("click", downloadAll);
document.getElementById("clear-btn").addEventListener("click", clearAll);

// ─── Validation limits ────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB per image — plenty for photos, guards against giant TIFFs/RAWs crashing the tab
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILES = 20;

// ─── Handle files ─────────────────────────────────────────────────────────────
function handleFiles(files) {
  if (!files.length) return;

  const wrongType = files.filter((f) => !ALLOWED_TYPES.includes(f.type));
  const tooBig = files.filter(
    (f) => ALLOWED_TYPES.includes(f.type) && f.size > MAX_FILE_SIZE,
  );

  if (wrongType.length) {
    showToast(
      `⚠️ ${wrongType.length} file(s) skipped — only JPG, PNG, or WebP are accepted`,
    );
  }
  if (tooBig.length) {
    showToast(
      `⚠️ ${tooBig.length} file(s) skipped — max size is ${formatSize(MAX_FILE_SIZE)}`,
    );
  }

  files = files
    .filter((f) => ALLOWED_TYPES.includes(f.type) && f.size <= MAX_FILE_SIZE)
    .slice(0, MAX_FILES);

  if (!files.length) return;

  if (files.length === MAX_FILES) {
    showToast(`Processing the first ${MAX_FILES} images at once`);
  }

  activeBatchDone = 0;
  activeBatchTotal = files.length;
  updateStatus(`Processing ${activeBatchTotal} image(s)…`);
  statusBar.classList.add("visible");
  statusSpinner.style.display = "";
  resultsEl.classList.add("visible");

  files.forEach(enqueueFile);
}

function updateStatus(msg) {
  statusText.textContent = msg;
  const pct =
    activeBatchTotal > 0 ? (activeBatchDone / activeBatchTotal) * 100 : 0;
  progressInner.style.width = pct + "%";
}

// ─── Process one file ─────────────────────────────────────────────────────────
function processFile(file) {
  const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const card = document.createElement("div");
  card.className = "image-card";
  card.innerHTML = `
    <div class="card-preview processing" id="preview-${id}">
      <img id="orig-${id}" alt="${file.name}" />
      <div class="card-status-overlay" id="overlay-${id}">
        <div class="spinner" style="width:28px;height:28px;border-width:2px;"></div>
        <div class="card-status-label" id="label-${id}">Loading…</div>
      </div>
    </div>
    <div class="card-info">
      <div class="card-meta">
        <div class="card-name">${file.name}</div>
        <div class="card-size">${formatSize(file.size)}</div>
      </div>
      <div class="card-actions">
        <button class="btn-edit" id="edit-${id}" disabled>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
          Edit
        </button>
        <button class="btn-dl" id="dl-${id}" disabled>Download</button>
      </div>
    </div>
  `;
  imageGrid.prepend(card);
  resultsTitle.textContent = `Results (${imageGrid.children.length})`;

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = document.getElementById(`orig-${id}`);
    if (img) img.src = e.target.result;
  };
  reader.readAsDataURL(file);

  jobs.set(id, { status: "processing", blob: null, file });

  return imglyRemoveBackground(file, {
    progress: (key, current, total) => {
      if (key.includes("inference")) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        const label = document.getElementById(`label-${id}`);
        if (label) label.textContent = `${pct}%`;
      }
    },
  })
    .then((blob) => {
      //For vercel analitycs tracking
      track("Background Removed");

      const url = URL.createObjectURL(blob);
      const img = document.getElementById(`orig-${id}`);
      if (img) img.src = url;

      const preview = document.getElementById(`preview-${id}`);
      if (preview) preview.classList.remove("processing");

      const overlay = document.getElementById(`overlay-${id}`);
      if (overlay) overlay.classList.add("done");

      const outName = file.name.replace(/\.[^.]+$/, "") + "_cutout.png";
      const dlBtn = document.getElementById(`dl-${id}`);
      if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.onclick = () => {
          const job = jobs.get(id);
          triggerDownload(job.url, outName, job.blob);
        };
      }

      const editBtn = document.getElementById(`edit-${id}`);
      if (editBtn) {
        editBtn.disabled = false;
        editBtn.onclick = () => openImageEditor(id);
      }

      jobs.set(id, {
        status: "done",
        url,
        blob,
        file,
        name: file.name.replace(/\.[^.]+$/, ""),
      });
      activeBatchDone++;
      updateStatus(
        activeBatchDone < activeBatchTotal
          ? `Processing… (${activeBatchDone}/${activeBatchTotal})`
          : `✓ Done!`,
      );
      if (activeBatchDone === activeBatchTotal) {
        statusSpinner.style.display = "none";
        showToast(`✓ ${activeBatchDone} image(s) processed successfully!`);
      }
    })
    .catch((err) => {
      console.error("Processing error:", err);
      handleError(id, "Processing failed. Try a different image.");
    });
}

// ─── Touch-up editor bridge ───────────────────────────────────────────────────
function openImageEditor(id) {
  const job = jobs.get(id);
  if (!job || job.status !== "done") return;

  if (!job.originalUrl) job.originalUrl = URL.createObjectURL(job.file);

  openEditor(
    { cutoutUrl: job.url, originalUrl: job.originalUrl, name: job.name },
    (editedBlob) => {
      // Swap the old object URL for the newly edited result everywhere it's used.
      const oldUrl = job.url;
      const newUrl = URL.createObjectURL(editedBlob);

      const img = document.getElementById(`orig-${id}`);
      if (img) img.src = newUrl;

      const dlBtn = document.getElementById(`dl-${id}`);
      if (dlBtn) {
        const outName = job.name + "_cutout.png";
        dlBtn.onclick = () => {
          const j = jobs.get(id);
          triggerDownload(j.url, outName, j.blob);
        };
      }

      job.url = newUrl;
      job.blob = editedBlob;
      jobs.set(id, job);

      URL.revokeObjectURL(oldUrl);
      track("Image Edited");
      showToast("✓ Edits applied");
    },
  );
}

// ─── Error handler ────────────────────────────────────────────────────────────
function handleError(id, message) {
  const overlay = document.getElementById(`overlay-${id}`);
  if (overlay) {
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:0 16px;text-align:center;">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--danger);flex-shrink:0;"></div>
        <span style="color:var(--danger);font-size:12px;">${message}</span>
      </div>
    `;
  }
  activeBatchDone++;
  updateStatus(
    activeBatchDone < activeBatchTotal
      ? `Processing… (${activeBatchDone}/${activeBatchTotal})`
      : `Finished with errors`,
  );
  if (activeBatchDone === activeBatchTotal)
    statusSpinner.style.display = "none";
  showToast(`❌ ${message}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function shouldUseMobileShareSave() {
  const ua = navigator.userAgent || "";
  const mobileUa = /Android|iPhone|iPad|iPod|webOS/i.test(ua);
  const smallTouchScreen =
    window.matchMedia?.("(hover: none) and (pointer: coarse)").matches &&
    window.matchMedia?.("(max-width: 820px)").matches;

  return mobileUa || smallTouchScreen;
}

function canShareFiles(files) {
  return !navigator.canShare || navigator.canShare({ files });
}

async function triggerDownload(url, filename, blob) {
  //To track when the user downloads an image
  track("Image Downloaded");

  // On phones, a plain <a download> either does nothing (iOS Safari) or
  // dumps the file into a generic Downloads folder that the Gallery/Photos
  // app never indexes (Android). The Web Share API opens the native
  // "Save Image" sheet instead, which saves straight into the camera roll.
  try {
    if (shouldUseMobileShareSave() && navigator.share && (blob || url)) {
      const fileBlob = blob || (await (await fetch(url)).blob());
      const file = new File([fileBlob], filename, {
        type: fileBlob.type || "image/png",
      });
      if (canShareFiles([file])) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (err) {
          // User cancelled the share sheet — treat as done, don't fall back.
          if (err && err.name === "AbortError") return;
          console.warn("Share failed, falling back to direct download:", err);
        }
      }
    }
  } catch (err) {
    console.warn("Share unavailable, falling back to direct download:", err);
  }

  // Fallback: desktop browsers, or any mobile browser without file-share support.
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function downloadAll() {
  const doneJobs = [...jobs.values()].filter((j) => j.status === "done");
  if (!doneJobs.length) {
    showToast("⚠️ No images ready to download");
    return;
  }

  // Web Share API Level 2 supports sharing multiple files in a single call —
  // iOS and Android both surface a "Save Images" option on the share sheet
  // that saves the whole batch straight into the camera roll/gallery.
  try {
    if (shouldUseMobileShareSave() && navigator.share) {
      const files = await Promise.all(
        doneJobs.map(async (job) => {
          const fileBlob = job.blob || (await (await fetch(job.url)).blob());
          return new File([fileBlob], job.name + "_cutout.png", {
            type: fileBlob.type || "image/png",
          });
        }),
      );

      if (canShareFiles(files)) {
        try {
          await navigator.share({ files });
          doneJobs.forEach(() => track("Image Downloaded"));
          return;
        } catch (err) {
          // User cancelled the share sheet — treat as done, don't fall back.
          if (err && err.name === "AbortError") return;
          console.warn(
            "Multi-file share failed, falling back to direct download:",
            err,
          );
        }
      }
    }
  } catch (err) {
    console.warn("Share unavailable, falling back to direct download:", err);
  }

  // Fallback: desktop browsers, or any mobile browser without multi-file
  // share support (older Android WebViews, some in-app browsers, etc).
  doneJobs.forEach((job, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = job.url;
      a.download = job.name + "_cutout.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      track("Image Downloaded");
    }, i * 250);
  });

  showToast(`⬇️ Downloading ${doneJobs.length} image(s)…`);
}

function clearAll() {
  for (const [, job] of jobs) {
    if (job.url) URL.revokeObjectURL(job.url);
    if (job.originalUrl) URL.revokeObjectURL(job.originalUrl);
  }
  jobs.clear();
  imageGrid.innerHTML = "";
  activeBatchDone = 0;
  activeBatchTotal = 0;
  statusBar.classList.remove("visible");
  resultsEl.classList.remove("visible");
  progressInner.style.width = "0%";
}
