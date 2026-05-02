import { removeBackground as imglyRemoveBackground } from "@imgly/background-removal";

// ─── State ───────────────────────────────────────────────────────────────────
const jobs = new Map();
let activeBatchDone = 0;
let activeBatchTotal = 0;
let modelReady = false;

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
  handleFiles(
    Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")),
  );
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

// ─── Handle files ─────────────────────────────────────────────────────────────
function handleFiles(files) {
  if (!files.length) return;

  const invalid = files.filter((f) => !f.type.startsWith("image/"));
  if (invalid.length) {
    showToast(
      `⚠️ ${invalid.length} file(s) skipped — only images are accepted`,
    );
  }
  files = files.filter((f) => f.type.startsWith("image/")).slice(0, 20);
  if (!files.length) return;

  activeBatchDone = 0;
  activeBatchTotal = files.length;
  updateStatus(`Processing ${activeBatchTotal} image(s)…`);
  statusBar.classList.add("visible");
  statusSpinner.style.display = "";
  resultsEl.classList.add("visible");

  files.forEach(processFile);
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
      <div>
        <div class="card-name">${file.name}</div>
        <div class="card-size">${formatSize(file.size)}</div>
      </div>
      <button class="btn-dl" id="dl-${id}" disabled>Download</button>
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

  jobs.set(id, { status: "processing", blob: null });

  imglyRemoveBackground(file, {
    progress: (key, current, total) => {
      if (key.includes("inference")) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        const label = document.getElementById(`label-${id}`);
        if (label) label.textContent = `${pct}%`;
      }
    },
  })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const img = document.getElementById(`orig-${id}`);
      if (img) img.src = url;

      const preview = document.getElementById(`preview-${id}`);
      if (preview) preview.classList.remove("processing");

      const overlay = document.getElementById(`overlay-${id}`);
      if (overlay) overlay.classList.add("done");

      const dlBtn = document.getElementById(`dl-${id}`);
      if (dlBtn) {
        dlBtn.disabled = false;
        const outName = file.name.replace(/\.[^.]+$/, "") + "_cutout.png";
        dlBtn.onclick = () => triggerDownload(url, outName);
      }

      jobs.set(id, {
        status: "done",
        url,
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

function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadAll() {
  let count = 0;
  for (const [, job] of jobs) {
    if (job.status === "done") {
      setTimeout(
        () => triggerDownload(job.url, job.name + "_cutout.png"),
        count * 250,
      );
      count++;
    }
  }
  if (!count) showToast("⚠️ No images ready to download");
  else showToast(`⬇️ Downloading ${count} image(s)…`);
}

function clearAll() {
  for (const [, job] of jobs) {
    if (job.url) URL.revokeObjectURL(job.url);
  }
  jobs.clear();
  imageGrid.innerHTML = "";
  activeBatchDone = 0;
  activeBatchTotal = 0;
  statusBar.classList.remove("visible");
  resultsEl.classList.remove("visible");
  progressInner.style.width = "0%";
}
