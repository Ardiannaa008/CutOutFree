// ─── Touch-Up Editor ──────────────────────────────────────────────────────
// Background swap (color / photo) + dual-brush mask refine tool.
//
// How the masking works (same trick Photoshop layer masks use):
//   - `originalCanvas` holds the untouched source photo pixels, forever.
//   - `maskCanvas` holds ONLY an alpha channel — how visible each pixel
//     should be. It starts out equal to the AI cutout's alpha.
//   - Erase brush  -> paint on maskCanvas with `destination-out` (subtracts alpha).
//   - Restore brush -> paint on maskCanvas with `source-over` (adds alpha back,
//     revealing the original pixel underneath).
//   - Every stroke redraw is just 2 `drawImage` calls (destination-in trick),
//     so it's GPU-composited — no manual per-pixel loops, no lag even at
//     several-megapixel photo sizes.
//
// This file is self-contained: it injects its own <style> + DOM into
// #editor-root and exposes `openEditor()`. It reuses the page's existing
// CSS custom properties (--purple, --bg, --border, etc.) from :root.

let root = null;
let els = {};
let state = null;

const MAX_EDIT_DIMENSION = 2600; // cap working resolution — plenty for brush precision, keeps things fast
const HISTORY_LIMIT = 25;

export function initEditor() {
  if (root) return;
  root = document.getElementById("editor-root");
  injectStyles();
  root.innerHTML = buildMarkup();
  cacheEls();
  wireStaticEvents();
}

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .ed-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(5,6,12,0.72);
      backdrop-filter: blur(6px);
      display: none;
      align-items: center; justify-content: center;
      padding: 16px;
    }
    .ed-overlay.open { display: flex; }
    .ed-panel {
      width: min(1180px, 100%);
      height: min(880px, 96vh);
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      display: flex; flex-direction: column;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,0.55);
    }
    .ed-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 22px; border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .ed-title { font-size: 14px; font-weight: 600; color: var(--text); }
    .ed-close {
      width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--border);
      background: var(--glass); color: var(--muted); cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 16px;
    }
    .ed-close:hover { color: var(--text); border-color: rgba(255,255,255,0.25); }

    .ed-body { flex: 1; display: flex; min-height: 0; }
    .ed-toolbar {
      width: 244px; flex-shrink: 0; padding: 18px; overflow-y: auto;
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 12px;
    }
    .ed-tool-group {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--glass);
    }
    .ed-group-label {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted-dim); font-weight: 600; margin-bottom: 10px;
    }
    .ed-mode-row { display: flex; gap: 8px; }
    .ed-mode-btn {
      flex: 1; min-height: 34px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
      background: transparent; color: var(--muted); font-size: 12px; font-weight: 500;
      cursor: pointer; font-family: inherit; transition: all .15s;
      white-space: nowrap;
    }
    .ed-mode-btn:hover:not(.active) { color: var(--text); background: var(--glass); border-color: rgba(255,255,255,0.22); }
    .ed-mode-btn.active[data-mode="erase"] {
      background: rgba(255,107,107,0.14); border-color: var(--danger); color: var(--danger);
    }
    .ed-mode-btn.active[data-mode="restore"] {
      background: rgba(61,220,151,0.14); border-color: var(--green); color: var(--green);
    }
    .ed-slider-row { margin-bottom: 12px; }
    .ed-slider-label {
      display: flex; justify-content: space-between; font-size: 11.5px;
      color: var(--muted); margin-bottom: 6px;
    }
    .ed-slider-label span:last-child { color: var(--text); font-variant-numeric: tabular-nums; }
    input[type="range"].ed-range {
      width: 100%; accent-color: var(--purple); cursor: pointer;
    }
    .ed-toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; color: var(--muted);
    }
    .ed-toggle-row input { accent-color: var(--purple); width: 16px; height: 16px; cursor: pointer; }

    .ed-bg-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
    .ed-swatch {
      width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
      border: 2px solid var(--border); position: relative; flex-shrink: 0;
    }
    .ed-swatch.active { border-color: var(--purple); box-shadow: 0 0 0 2px rgba(178,107,251,0.35); }
    .ed-swatch.transparent {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Crect width='6' height='6' fill='%23bbb'/%3E%3Crect x='6' y='0' width='6' height='6' fill='%23888'/%3E%3Crect x='0' y='6' width='6' height='6' fill='%23888'/%3E%3Crect x='6' y='6' width='6' height='6' fill='%23bbb'/%3E%3C/svg%3E");
      background-size: 10px 10px;
    }
    .ed-swatch.ed-swatch-label {
      width: auto; min-width: 58px; padding: 0 8px;
      display: flex; align-items: center; justify-content: center;
      background: var(--glass-strong); color: var(--muted);
      font-size: 10.5px; font-weight: 600; white-space: nowrap;
    }
    .ed-swatch.ed-swatch-label.active { color: var(--text); }
    .ed-swatch-color { -webkit-appearance: none; appearance: none; padding: 0; background: conic-gradient(red,yellow,lime,cyan,blue,magenta,red); }
    .ed-swatch-color::-webkit-color-swatch-wrapper { padding: 0; }
    .ed-swatch-color::-webkit-color-swatch { border: none; border-radius: 6px; }
    .ed-bg-upload {
      width: 100%; margin-top: 10px; padding: 9px 10px; border-radius: 10px;
      border: 1px dashed var(--border); background: var(--glass); color: var(--muted);
      font-size: 11.5px; cursor: pointer; font-family: inherit; text-align: center;
    }
    .ed-bg-upload:hover { color: var(--text); border-color: rgba(255,255,255,0.3); }

    .ed-btn-row { display: flex; gap: 8px; }
    .ed-icon-btn {
      flex: 1; min-height: 30px; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--border);
      background: transparent; color: var(--muted); cursor: pointer; font-size: 11.5px;
      font-family: inherit; transition: all .15s;
      white-space: nowrap;
    }
    .ed-icon-btn:hover:not(:disabled) { color: var(--text); background: var(--glass); border-color: rgba(255,255,255,0.22); }
    .ed-icon-btn:active:not(:disabled) { color: var(--text); background: var(--glass-strong); border-color: rgba(255,255,255,0.3); }
    .ed-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .ed-canvas-area {
      flex: 1; position: relative; overflow: hidden;
      background-color: #26282f;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%232c2e36'/%3E%3Crect x='8' y='0' width='8' height='8' fill='%23222329'/%3E%3Crect x='0' y='8' width='8' height='8' fill='%23222329'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%232c2e36'/%3E%3C/svg%3E");
      background-size: 20px 20px;
      cursor: crosshair;
      touch-action: none;
      border-left: 1px solid var(--border);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04), inset 0 18px 42px rgba(0,0,0,0.28);
    }
    .ed-canvas-stack {
      position: absolute; top: 0; left: 0; transform-origin: 0 0;
    }
    .ed-canvas-stack canvas, .ed-canvas-stack img { display: block; position: absolute; top: 0; left: 0; }
    .ed-overlay-img { opacity: 0; pointer-events: none; transition: opacity .15s; }
    .ed-overlay-img.on { opacity: 0.4; }
    .ed-brush-cursor {
      position: fixed; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.85);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.5); pointer-events: none; z-index: 1001;
      transform: translate(-50%, -50%); display: none;
    }
    .ed-zoom-row { display: flex; align-items: center; gap: 8px; }
    .ed-zoom-pct { flex: 1; text-align: center; font-size: 11.5px; color: var(--muted); }

    .ed-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 22px 18px; border-top: 1px solid var(--border); flex-shrink: 0;
      gap: 10px; flex-wrap: wrap;
    }
    .ed-footer-left { display: flex; gap: 8px; }
    .ed-footer-right { display: flex; gap: 8px; }
    .ed-btn {
      padding: 9px 18px; border-radius: 8px; font-size: 12.5px; font-weight: 500;
      cursor: pointer; font-family: inherit; border: 1px solid var(--border);
      background: transparent; color: var(--muted); transition: all .15s;
    }
    .ed-btn:hover { color: var(--text); background: var(--glass); border-color: rgba(255,255,255,0.25); }
    .ed-btn-primary {
      border-color: transparent; background: linear-gradient(135deg, var(--purple), var(--blue));
      color: #fff; font-weight: 600;
    }
    .ed-btn-primary:hover { color: #fff; filter: brightness(1.08); box-shadow: 0 8px 22px rgba(109,125,253,0.3); }
    .ed-hint { font-size: 10.5px; color: var(--muted-dim); padding: 0 18px 10px; }

    @media (max-width: 720px) {
      .ed-body { flex-direction: column; }
      .ed-toolbar { width: 100%; border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; max-height: 40vh; padding: 14px; }
      .ed-tool-group { flex: 1 1 190px; }
      .ed-canvas-area { border-left: none; }
      .ed-panel { height: 100vh; border-radius: 0; }
    }
  `;
  document.head.appendChild(style);
}

function buildMarkup() {
  return `
    <div class="ed-overlay" id="ed-overlay">
      <div class="ed-panel">
        <div class="ed-header">
          <div class="ed-title" id="ed-title">Edit image</div>
          <button class="ed-close" id="ed-close" title="Close">✕</button>
        </div>
        <div class="ed-body">
          <div class="ed-toolbar">
            <div class="ed-tool-group">
              <div class="ed-group-label">Brush</div>
              <div class="ed-mode-row">
                <button class="ed-mode-btn active" data-mode="erase">🧽 Erase</button>
                <button class="ed-mode-btn" data-mode="restore">🖌 Restore</button>
              </div>
              <div class="ed-btn-row" style="margin:10px 0 12px">
                <button class="ed-icon-btn" id="ed-clean-edges">✨ Clean edges</button>
              </div>
              <div class="ed-slider-row">
                <div class="ed-slider-label"><span>Brush size</span><span id="ed-size-val">40px</span></div>
                <input type="range" class="ed-range" id="ed-size" min="4" max="200" value="40" />
              </div>
              <div class="ed-slider-row" style="margin-bottom:0">
                <div class="ed-slider-label"><span>Softness</span><span id="ed-feather-val">40%</span></div>
                <input type="range" class="ed-range" id="ed-feather" min="0" max="95" value="40" />
              </div>
            </div>
            <div class="ed-tool-group">
              <div class="ed-group-label">View</div>
              <div class="ed-toggle-row" style="margin-bottom:10px">
                <span>Show original overlay</span>
                <input type="checkbox" id="ed-overlay-toggle" />
              </div>
              <div class="ed-zoom-row">
                <button class="ed-icon-btn" id="ed-zoom-out" title="Zoom out">－</button>
                <span class="ed-zoom-pct" id="ed-zoom-pct">100%</span>
                <button class="ed-icon-btn" id="ed-zoom-in" title="Zoom in">＋</button>
                <button class="ed-icon-btn" id="ed-zoom-reset" title="Fit to view">⤢</button>
              </div>
            </div>
            <div class="ed-tool-group">
              <div class="ed-group-label">Background</div>
              <div class="ed-bg-swatches" id="ed-bg-swatches">
                <div class="ed-swatch transparent active" data-bg="transparent" title="Transparent"></div>
                <div class="ed-swatch" data-bg="#ffffff" style="background:#ffffff" title="White"></div>
                <div class="ed-swatch" data-bg="#0a0c14" style="background:#0a0c14" title="Black"></div>
                <div class="ed-swatch" data-bg="#6d7dfd" style="background:#6d7dfd" title="Blue"></div>
                <div class="ed-swatch" data-bg="#b26bfb" style="background:#b26bfb" title="Purple"></div>
                <div class="ed-swatch" data-bg="#3ddc97" style="background:#3ddc97" title="Green"></div>
                <div class="ed-swatch ed-swatch-label" data-bg="blur" title="Blur original background">Blur bg</div>
                <input type="color" class="ed-swatch ed-swatch-color" id="ed-color-picker" title="Custom color" value="#fb6bb0" />
              </div>
              <div class="ed-slider-row" id="ed-blur-row" style="display:none;margin-top:10px">
                <div class="ed-slider-label"><span>Blur amount</span><span id="ed-blur-val">12px</span></div>
                <input type="range" class="ed-range" id="ed-blur" min="2" max="30" value="12" />
              </div>
              <input type="file" id="ed-bg-file" accept="image/png,image/jpeg,image/webp" style="display:none" />
              <button class="ed-bg-upload" id="ed-bg-upload-btn">Upload background photo…</button>
            </div>
            <div class="ed-tool-group">
              <div class="ed-group-label">Outline</div>
              <div class="ed-toggle-row" style="margin-bottom:10px">
                <span>Add outline</span>
                <input type="checkbox" id="ed-outline-toggle" />
              </div>
              <div class="ed-bg-swatches" id="ed-outline-swatches">
                <div class="ed-swatch active" data-outline="#ffffff" style="background:#ffffff" title="White"></div>
                <div class="ed-swatch" data-outline="#0a0c14" style="background:#0a0c14" title="Black"></div>
                <div class="ed-swatch" data-outline="#6d7dfd" style="background:#6d7dfd" title="Blue"></div>
                <div class="ed-swatch" data-outline="#fb6bb0" style="background:#fb6bb0" title="Pink"></div>
                <div class="ed-swatch" data-outline="#3ddc97" style="background:#3ddc97" title="Green"></div>
              </div>
              <div class="ed-slider-row" style="margin-top:10px;margin-bottom:0">
                <div class="ed-slider-label"><span>Width</span><span id="ed-outline-width-val">8px</span></div>
                <input type="range" class="ed-range" id="ed-outline-width" min="2" max="30" value="8" />
              </div>
            </div>
            <div class="ed-tool-group">
              <div class="ed-group-label">History</div>
              <div class="ed-btn-row">
                <button class="ed-icon-btn" id="ed-undo" disabled>↶ Undo</button>
                <button class="ed-icon-btn" id="ed-redo" disabled>↷ Redo</button>
              </div>
            </div>
          </div>
          <div class="ed-canvas-area" id="ed-canvas-area">
            <div class="ed-canvas-stack" id="ed-canvas-stack">
              <img class="ed-overlay-img" id="ed-overlay-img" alt="" />
              <canvas id="ed-display-canvas"></canvas>
            </div>
          </div>
        </div>
        <div class="ed-hint">Scroll to zoom · hold Space (or two fingers) to pan · [ ] to resize brush · Ctrl+Z / Ctrl+Shift+Z to undo/redo</div>
        <div class="ed-footer">
          <div class="ed-footer-left">
            <button class="ed-btn" id="ed-reset-all">Reset to AI result</button>
          </div>
          <div class="ed-footer-right">
            <button class="ed-btn" id="ed-cancel">Cancel</button>
            <button class="ed-btn ed-btn-primary" id="ed-apply">Apply changes</button>
          </div>
        </div>
      </div>
    </div>
    <div class="ed-brush-cursor" id="ed-brush-cursor"></div>
  `;
}

function cacheEls() {
  const g = (id) => document.getElementById(id);
  els = {
    overlay: g("ed-overlay"),
    title: g("ed-title"),
    close: g("ed-close"),
    modeBtns: root.querySelectorAll(".ed-mode-btn"),
    size: g("ed-size"),
    sizeVal: g("ed-size-val"),
    feather: g("ed-feather"),
    featherVal: g("ed-feather-val"),
    cleanEdges: g("ed-clean-edges"),
    overlayToggle: g("ed-overlay-toggle"),
    zoomOut: g("ed-zoom-out"),
    zoomIn: g("ed-zoom-in"),
    zoomReset: g("ed-zoom-reset"),
    zoomPct: g("ed-zoom-pct"),
    bgSwatches: g("ed-bg-swatches"),
    colorPicker: g("ed-color-picker"),
    blurRow: g("ed-blur-row"),
    blur: g("ed-blur"),
    blurVal: g("ed-blur-val"),
    bgFile: g("ed-bg-file"),
    bgUploadBtn: g("ed-bg-upload-btn"),
    outlineToggle: g("ed-outline-toggle"),
    outlineSwatches: g("ed-outline-swatches"),
    outlineWidth: g("ed-outline-width"),
    outlineWidthVal: g("ed-outline-width-val"),
    undo: g("ed-undo"),
    redo: g("ed-redo"),
    canvasArea: g("ed-canvas-area"),
    canvasStack: g("ed-canvas-stack"),
    overlayImg: g("ed-overlay-img"),
    displayCanvas: g("ed-display-canvas"),
    brushCursor: g("ed-brush-cursor"),
    resetAll: g("ed-reset-all"),
    cancel: g("ed-cancel"),
    apply: g("ed-apply"),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────
// job: { cutoutUrl, originalUrl, name }
// onApply(blob) is called with the final composited PNG blob when the user hits Apply.
export function openEditor(job, onApply) {
  if (!root) initEditor();
  els.title.textContent = `Edit — ${job.name || "image"}`;
  els.overlay.classList.add("open");
  document.body.style.overflow = "hidden";
  loadJob(job).then(() => {
    state.onApply = onApply;
  });
}

function closeEditor() {
  els.overlay.classList.remove("open");
  document.body.style.overflow = "";
  if (state) {
    if (state.bgObjectUrl) URL.revokeObjectURL(state.bgObjectUrl);
    state = null;
  }
}

// ─── Loading the job into working canvases ──────────────────────────────
async function loadJob(job) {
  const [cutoutImg, originalImg] = await Promise.all([
    loadImage(job.cutoutUrl),
    loadImage(job.originalUrl),
  ]);

  // Work at the original photo's resolution (capped) — the cutout PNG from
  // @imgly/background-removal is generated at the same pixel dimensions as
  // the input, so both images line up 1:1.
  let w = originalImg.naturalWidth;
  let h = originalImg.naturalHeight;
  if (Math.max(w, h) > MAX_EDIT_DIMENSION) {
    const scale = MAX_EDIT_DIMENSION / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const originalCanvas = document.createElement("canvas");
  originalCanvas.width = w;
  originalCanvas.height = h;
  originalCanvas.getContext("2d").drawImage(originalImg, 0, 0, w, h);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = w;
  maskCanvas.height = h;
  // Seed the mask from the AI cutout's own alpha channel.
  maskCanvas.getContext("2d").drawImage(cutoutImg, 0, 0, w, h);

  const scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = w;
  scratchCanvas.height = h;

  els.displayCanvas.width = w;
  els.displayCanvas.height = h;
  els.displayCanvas.style.width = w + "px";
  els.displayCanvas.style.height = h + "px";
  els.overlayImg.src = job.originalUrl;
  els.overlayImg.style.width = w + "px";
  els.overlayImg.style.height = h + "px";

  state = {
    w, h,
    originalCanvas, maskCanvas, scratchCanvas,
    mode: "erase",
    brushSize: 40,
    feather: 40,
    background: { type: "transparent" },
    outline: {
      enabled: false,
      color: "#ffffff",
      width: 8,
      maskCanvas: null,
      dirty: true,
    },
    showOverlay: false,
    zoom: 1,
    tx: 0, ty: 0,
    history: [snapshotMask(maskCanvas)],
    historyIndex: 0,
    isDrawing: false,
    isPanning: false,
    spaceHeld: false,
    lastX: 0, lastY: 0,
    activePointers: new Map(),
    pinchStartDist: 0,
    pinchStartZoom: 1,
    bgObjectUrl: null,
    job,
    onApply: null,
  };

  // reset UI controls
  els.overlayToggle.checked = false;
  setMode("erase");
  els.size.value = 40; els.sizeVal.textContent = "40px";
  els.feather.value = 40; els.featherVal.textContent = "40%";
  els.blur.value = 12; els.blurVal.textContent = "12px"; els.blurRow.style.display = "none";
  els.outlineToggle.checked = false;
  els.outlineWidth.value = 8; els.outlineWidthVal.textContent = "8px";
  els.bgSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
  root.querySelector('.ed-swatch[data-bg="transparent"]').classList.add("active");
  els.outlineSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
  els.outlineSwatches.querySelector('.ed-swatch[data-outline="#ffffff"]').classList.add("active");
  updateUndoRedoButtons();
  fitToView();
  render();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────
function render() {
  const { w, h } = state;
  const ctx = els.displayCanvas.getContext("2d");

  buildScratchCanvas();
  ctx.clearRect(0, 0, w, h);
  drawComposite(ctx);

  els.overlayImg.classList.toggle("on", state.showOverlay);
}

function buildScratchCanvas() {
  const { originalCanvas, maskCanvas, scratchCanvas, w, h } = state;
  const sctx = scratchCanvas.getContext("2d");
  sctx.clearRect(0, 0, w, h);
  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(originalCanvas, 0, 0);
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(maskCanvas, 0, 0);
  sctx.globalCompositeOperation = "source-over";
}

function drawComposite(ctx) {
  drawBackground(ctx);
  drawOutline(ctx);
  ctx.drawImage(state.scratchCanvas, 0, 0);
}

function drawBackground(ctx) {
  const { background, w, h } = state;
  if (background.type === "transparent") {
    return;
  }
  if (background.type === "color") {
    ctx.fillStyle = background.value;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (background.type === "image") {
    drawCover(ctx, background.img, w, h);
    return;
  }
  if (background.type === "blur") {
    const amount = background.amount;
    const pad = Math.ceil(amount * 2);
    ctx.save();
    ctx.filter = `blur(${amount}px)`;
    ctx.drawImage(state.originalCanvas, -pad, -pad, w + pad * 2, h + pad * 2);
    ctx.restore();
  }
}

function drawOutline(ctx) {
  const { outline, w, h } = state;
  if (!outline.enabled) return;
  const outlineMask = getOutlineMask();
  const outlineCanvas = document.createElement("canvas");
  outlineCanvas.width = w;
  outlineCanvas.height = h;
  const octx = outlineCanvas.getContext("2d");
  octx.fillStyle = outline.color;
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = "destination-in";
  octx.drawImage(outlineMask, 0, 0);
  octx.globalCompositeOperation = "source-over";
  ctx.drawImage(outlineCanvas, 0, 0);
}

function getOutlineMask() {
  const { outline, maskCanvas } = state;
  if (!outline.maskCanvas || outline.dirty) {
    outline.maskCanvas = snapshotMask(maskCanvas);
    dilateAlpha(outline.maskCanvas, outline.width);
    outline.dirty = false;
  }
  return outline.maskCanvas;
}

function invalidateOutlineMask() {
  if (!state?.outline) return;
  state.outline.dirty = true;
}

function drawCover(ctx, img, w, h) {
  const ir = img.naturalWidth / img.naturalHeight;
  const cr = w / h;
  let sw, sh, sx, sy;
  if (ir > cr) {
    sh = img.naturalHeight;
    sw = sh * cr;
    sx = (img.naturalWidth - sw) / 2;
    sy = 0;
  } else {
    sw = img.naturalWidth;
    sh = sw / cr;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

function erodeAlpha(maskCanvas, radiusPx) {
  return morphAlpha(maskCanvas, radiusPx, "erode");
}

function dilateAlpha(maskCanvas, radiusPx) {
  return morphAlpha(maskCanvas, radiusPx, "dilate");
}

function morphAlpha(maskCanvas, radiusPx, mode) {
  const radius = Math.max(0, Math.round(radiusPx));
  if (radius === 0) return maskCanvas;

  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d");
  ctx.drawImage(maskCanvas, 0, 0);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const srcAlpha = new Uint8ClampedArray(w * h);
  const passAlpha = new Uint8ClampedArray(w * h);
  const outAlpha = new Uint8ClampedArray(w * h);
  const pickInitial = mode === "erode" ? 255 : 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    srcAlpha[p] = data[i + 3];
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let picked = pickInitial;
      const from = Math.max(0, x - radius);
      const to = Math.min(w - 1, x + radius);
      for (let xx = from; xx <= to; xx++) {
        const alpha = srcAlpha[row + xx];
        picked = mode === "erode" ? Math.min(picked, alpha) : Math.max(picked, alpha);
      }
      passAlpha[row + x] = picked;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let picked = pickInitial;
      const from = Math.max(0, y - radius);
      const to = Math.min(h - 1, y + radius);
      for (let yy = from; yy <= to; yy++) {
        const alpha = passAlpha[yy * w + x];
        picked = mode === "erode" ? Math.min(picked, alpha) : Math.max(picked, alpha);
      }
      outAlpha[y * w + x] = picked;
    }
  }

  const outCtx = maskCanvas.getContext("2d");
  const out = outCtx.getImageData(0, 0, w, h);
  for (let i = 0, p = 0; i < out.data.length; i += 4, p++) {
    out.data[i + 3] = outAlpha[p];
  }
  outCtx.putImageData(out, 0, 0);
  return maskCanvas;
}

// ─── Brush painting ───────────────────────────────────────────────────────
function stampBrush(x, y) {
  const ctx = state.maskCanvas.getContext("2d");
  const r = state.brushSize / 2;
  const featherFrac = state.feather / 100;
  const innerStop = Math.max(0, 1 - featherFrac);

  ctx.save();
  ctx.globalCompositeOperation = state.mode === "erase" ? "destination-out" : "source-over";
  const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(r, 0.1));
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(innerStop, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function strokeTo(x, y) {
  const dx = x - state.lastX;
  const dy = y - state.lastY;
  const dist = Math.hypot(dx, dy);
  const spacing = Math.max(state.brushSize / 5, 1.5);
  const steps = Math.max(1, Math.floor(dist / spacing));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stampBrush(state.lastX + dx * t, state.lastY + dy * t);
  }
  state.lastX = x;
  state.lastY = y;
  render();
}

// ─── Coordinate mapping ───────────────────────────────────────────────────
function clientToCanvas(clientX, clientY) {
  const rect = els.displayCanvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * state.w,
    y: ((clientY - rect.top) / rect.height) * state.h,
  };
}

// ─── Zoom / pan ───────────────────────────────────────────────────────────
function applyTransform() {
  els.canvasStack.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.zoom})`;
  els.zoomPct.textContent = Math.round(state.zoom * 100) + "%";
}

function zoomAt(clientX, clientY, factor) {
  const areaRect = els.canvasArea.getBoundingClientRect();
  const px = clientX - areaRect.left;
  const py = clientY - areaRect.top;
  const newZoom = Math.min(8, Math.max(0.1, state.zoom * factor));
  const wx = (px - state.tx) / state.zoom;
  const wy = (py - state.ty) / state.zoom;
  state.tx = px - wx * newZoom;
  state.ty = py - wy * newZoom;
  state.zoom = newZoom;
  applyTransform();
}

function fitToView() {
  const areaRect = els.canvasArea.getBoundingClientRect();
  const pad = 16;
  const scale = Math.min(
    (areaRect.width - pad) / state.w,
    (areaRect.height - pad) / state.h,
    1,
  );
  state.zoom = scale > 0 ? scale : 1;
  state.tx = (areaRect.width - state.w * state.zoom) / 2;
  state.ty = (areaRect.height - state.h * state.zoom) / 2;
  applyTransform();
}

// ─── History ──────────────────────────────────────────────────────────────
function snapshotMask(canvas) {
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext("2d").drawImage(canvas, 0, 0);
  return c;
}

function pushHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshotMask(state.maskCanvas));
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.historyIndex = state.history.length - 1;
  invalidateOutlineMask();
  updateUndoRedoButtons();
}

function restoreHistory(index) {
  const snap = state.history[index];
  const ctx = state.maskCanvas.getContext("2d");
  ctx.clearRect(0, 0, state.w, state.h);
  ctx.drawImage(snap, 0, 0);
  state.historyIndex = index;
  invalidateOutlineMask();
  updateUndoRedoButtons();
  render();
}

function undo() {
  if (state.historyIndex > 0) restoreHistory(state.historyIndex - 1);
}
function redo() {
  if (state.historyIndex < state.history.length - 1) restoreHistory(state.historyIndex + 1);
}
function updateUndoRedoButtons() {
  els.undo.disabled = state.historyIndex <= 0;
  els.redo.disabled = state.historyIndex >= state.history.length - 1;
}

// ─── UI wiring ────────────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  els.modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

function setBrushCursorSize() {
  // size of a screen pixel per canvas pixel, so the on-screen ring matches the true brush footprint
  const rect = els.displayCanvas.getBoundingClientRect();
  const screenPerCanvas = rect.width / state.w;
  const px = state.brushSize * screenPerCanvas;
  els.brushCursor.style.width = px + "px";
  els.brushCursor.style.height = px + "px";
}

function wireStaticEvents() {
  els.close.addEventListener("click", closeEditor);
  els.cancel.addEventListener("click", closeEditor);
  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) closeEditor();
  });

  els.modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  els.size.addEventListener("input", () => {
    state.brushSize = Number(els.size.value);
    els.sizeVal.textContent = state.brushSize + "px";
    setBrushCursorSize();
  });
  els.feather.addEventListener("input", () => {
    state.feather = Number(els.feather.value);
    els.featherVal.textContent = state.feather + "%";
  });
  els.cleanEdges.addEventListener("click", () => {
    if (!state) return;
    const radius = 2;
    erodeAlpha(state.maskCanvas, radius);
    dilateAlpha(state.maskCanvas, radius);
    dilateAlpha(state.maskCanvas, radius);
    erodeAlpha(state.maskCanvas, radius);
    invalidateOutlineMask();
    pushHistory();
    render();
  });

  els.overlayToggle.addEventListener("change", () => {
    state.showOverlay = els.overlayToggle.checked;
    render();
  });

  els.zoomIn.addEventListener("click", () => {
    const r = els.canvasArea.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  els.zoomOut.addEventListener("click", () => {
    const r = els.canvasArea.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
  });
  els.zoomReset.addEventListener("click", fitToView);

  els.canvasArea.addEventListener(
    "wheel",
    (e) => {
      if (!state) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false },
  );

  // background swatches
  els.bgSwatches.addEventListener("click", (e) => {
    const swatch = e.target.closest(".ed-swatch");
    if (!swatch || swatch.id === "ed-color-picker") return;
    els.bgSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    if (swatch.dataset.bg === "transparent") {
      state.background = { type: "transparent" };
      els.blurRow.style.display = "none";
    } else if (swatch.dataset.bg === "blur") {
      state.background = { type: "blur", amount: Number(els.blur.value) };
      els.blurRow.style.display = "";
    } else {
      state.background = { type: "color", value: swatch.dataset.bg };
      els.blurRow.style.display = "none";
    }
    render();
  });
  els.colorPicker.addEventListener("input", () => {
    els.bgSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
    els.colorPicker.classList.add("active");
    els.blurRow.style.display = "none";
    state.background = { type: "color", value: els.colorPicker.value };
    render();
  });
  els.blur.addEventListener("input", () => {
    const amount = Number(els.blur.value);
    els.blurVal.textContent = amount + "px";
    if (state.background.type === "blur") {
      state.background = { type: "blur", amount };
      render();
    }
  });
  els.outlineToggle.addEventListener("change", () => {
    state.outline.enabled = els.outlineToggle.checked;
    if (state.outline.enabled) invalidateOutlineMask();
    render();
  });
  els.outlineSwatches.addEventListener("click", (e) => {
    const swatch = e.target.closest(".ed-swatch");
    if (!swatch) return;
    els.outlineSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
    state.outline.color = swatch.dataset.outline;
    render();
  });
  els.outlineWidth.addEventListener("input", () => {
    state.outline.width = Number(els.outlineWidth.value);
    els.outlineWidthVal.textContent = state.outline.width + "px";
    invalidateOutlineMask();
    render();
  });
  els.bgUploadBtn.addEventListener("click", () => els.bgFile.click());
  els.bgFile.addEventListener("change", async () => {
    const file = els.bgFile.files[0];
    if (!file) return;
    if (state.bgObjectUrl) URL.revokeObjectURL(state.bgObjectUrl);
    state.bgObjectUrl = URL.createObjectURL(file);
    const img = await loadImage(state.bgObjectUrl);
    state.background = { type: "image", img };
    els.bgSwatches.querySelectorAll(".ed-swatch").forEach((s) => s.classList.remove("active"));
    els.blurRow.style.display = "none";
    render();
    els.bgFile.value = "";
  });

  els.undo.addEventListener("click", undo);
  els.redo.addEventListener("click", redo);

  els.resetAll.addEventListener("click", () => {
    if (!state) return;
    const ctx = state.maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, state.w, state.h);
    loadImage(state.job.cutoutUrl).then((img) => {
      ctx.drawImage(img, 0, 0, state.w, state.h);
      invalidateOutlineMask();
      pushHistory();
      render();
    });
  });

  els.apply.addEventListener("click", async () => {
    if (!state) return;
    buildScratchCanvas();
    const outCanvas = document.createElement("canvas");
    outCanvas.width = state.w;
    outCanvas.height = state.h;
    const octx = outCanvas.getContext("2d");
    drawComposite(octx);
    outCanvas.toBlob((blob) => {
      if (blob && state.onApply) state.onApply(blob);
      closeEditor();
    }, "image/png");
  });

  // pointer painting / panning (mouse + touch via Pointer Events)
  els.canvasArea.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  els.canvasArea.addEventListener("pointermove", (e) => {
    if (!state) return;
    els.brushCursor.style.display = "block";
    els.brushCursor.style.left = e.clientX + "px";
    els.brushCursor.style.top = e.clientY + "px";
  });
  els.canvasArea.addEventListener("pointerleave", () => {
    els.brushCursor.style.display = "none";
  });

  window.addEventListener("keydown", (e) => {
    if (!state || !els.overlay.classList.contains("open")) return;
    if (e.code === "Space") { state.spaceHeld = true; els.canvasArea.style.cursor = "grab"; }
    if (e.key === "e" || e.key === "E") setMode("erase");
    if (e.key === "r" || e.key === "R") setMode("restore");
    if (e.key === "[") { els.size.value = Math.max(4, state.brushSize - 6); els.size.dispatchEvent(new Event("input")); }
    if (e.key === "]") { els.size.value = Math.min(200, state.brushSize + 6); els.size.dispatchEvent(new Event("input")); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    if (e.key === "Escape") closeEditor();
  });
  window.addEventListener("keyup", (e) => {
    if (!state) return;
    if (e.code === "Space") { state.spaceHeld = false; els.canvasArea.style.cursor = "crosshair"; }
  });

  window.addEventListener("resize", () => {
    if (state) setBrushCursorSize();
  });
}

function onPointerDown(e) {
  if (!state) return;
  state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  els.canvasArea.setPointerCapture?.(e.pointerId);

  if (state.activePointers.size === 2) {
    // start pinch
    state.isDrawing = false;
    const pts = [...state.activePointers.values()];
    state.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    state.pinchStartZoom = state.zoom;
    return;
  }

  const isPan = state.spaceHeld || e.button === 1;
  if (isPan) {
    state.isPanning = true;
    state.panStartX = e.clientX;
    state.panStartY = e.clientY;
    state.panStartTx = state.tx;
    state.panStartTy = state.ty;
    els.canvasArea.style.cursor = "grabbing";
    return;
  }

  state.isDrawing = true;
  const { x, y } = clientToCanvas(e.clientX, e.clientY);
  state.lastX = x;
  state.lastY = y;
  stampBrush(x, y);
  render();
}

function onPointerMove(e) {
  if (!state) return;
  if (state.activePointers.has(e.pointerId)) {
    state.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  if (state.activePointers.size === 2) {
    const pts = [...state.activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    if (state.pinchStartDist > 0) {
      const factor = dist / state.pinchStartDist;
      const areaRect = els.canvasArea.getBoundingClientRect();
      const px = midX - areaRect.left;
      const py = midY - areaRect.top;
      const newZoom = Math.min(8, Math.max(0.1, state.pinchStartZoom * factor));
      const wx = (px - state.tx) / state.zoom;
      const wy = (py - state.ty) / state.zoom;
      state.tx = px - wx * newZoom;
      state.ty = py - wy * newZoom;
      state.zoom = newZoom;
      applyTransform();
    }
    return;
  }

  if (state.isPanning) {
    state.tx = state.panStartTx + (e.clientX - state.panStartX);
    state.ty = state.panStartTy + (e.clientY - state.panStartY);
    applyTransform();
    return;
  }

  if (state.isDrawing) {
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    strokeTo(x, y);
  }
}

function onPointerUp(e) {
  if (!state) return;
  state.activePointers.delete(e.pointerId);
  const finishedDrawing = state.isDrawing;
  if (finishedDrawing) pushHistory();
  state.isDrawing = false;
  state.isPanning = false;
  state.pinchStartDist = 0;
  els.canvasArea.style.cursor = state.spaceHeld ? "grab" : "crosshair";
  if (finishedDrawing) render();
}
