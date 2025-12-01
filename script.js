// script.js - draws video into canvas + jewelry + watermark (full baked captures)

const videoElement   = document.getElementById('webcam');
const canvasElement  = document.getElementById('overlay');
const canvasCtx      = canvasElement.getContext('2d');

let earringImg = null;
let necklaceImg = null;
let earringSrc = '';
let necklaceSrc = '';
let currentType = '';
let smoothedLandmarks = null;
let lastSnapshotDataURL = '';

/* TRY ALL + Gallery */
let autoTryRunning = false;
let autoTryTimeout = null;
let autoTryIndex = 0;
let autoSnapshots = [];

const tryAllBtn      = document.getElementById('tryall-btn');
const flashOverlay   = document.getElementById('flash-overlay');
const galleryModal   = document.getElementById('gallery-modal');
const galleryMain    = document.getElementById('gallery-main');
const galleryThumbs  = document.getElementById('gallery-thumbs');
const galleryClose   = document.getElementById('gallery-close');

/* ------------ WATERMARK: load watermark image ------------ */
const watermarkImg = new Image();
watermarkImg.src = "logo_watermark.png";
watermarkImg.crossOrigin = "anonymous";

function ensureWatermarkLoaded() {
  return new Promise((resolve) => {
    if (watermarkImg.complete && watermarkImg.naturalWidth !== 0) {
      resolve();
    } else {
      watermarkImg.onload = () => resolve();
      watermarkImg.onerror = () => resolve();
    }
  });
}

/* ------------ image helpers ------------ */
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
}

async function changeEarring(src) {
  earringSrc = src;
  const img = await loadImage(earringSrc);
  if (img) earringImg = img;
}

async function changeNecklace(src) {
  necklaceSrc = src;
  const img = await loadImage(necklaceSrc);
  if (img) necklaceImg = img;
}

/* ------------ category / subcategory ------------ */
function toggleCategory(category) {
  document.getElementById('subcategory-buttons').style.display = 'flex';
  const subButtons = document.querySelectorAll('#subcategory-buttons button');
  subButtons.forEach(btn => {
    btn.style.display =
      btn.innerText.toLowerCase().includes(category) ? 'inline-block' : 'none';
  });
  document.getElementById('jewelry-options').style.display = 'none';
  stopAutoTry();
}

function selectJewelryType(type) {
  currentType = type;
  document.getElementById('jewelry-options').style.display = 'flex';

  earringImg = null;
  necklaceImg = null;
  earringSrc = '';
  necklaceSrc = '';

  const { start, end } = getRangeForType(type);
  insertJewelryOptions(type, 'jewelry-options', start, end);

  stopAutoTry();
}

function getRangeForType(type) {
  let start = 1, end = 15;
  switch (type) {
    case 'gold_earrings':     end = 16; break;
    case 'gold_necklaces':    end = 19; break;
    case 'diamond_earrings':  end = 9;  break;
    case 'diamond_necklaces': end = 6;  break;
    default:                  end = 15;
  }
  return { start, end };
}

function buildImageList(type) {
  const { start, end } = getRangeForType(type);
  const list = [];
  for (let i = start; i <= end; i++) {
    list.push(`${type}/${type}${i}.png`);
  }
  return list;
}

function insertJewelryOptions(type, containerId, startIndex, endIndex) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (let i = startIndex; i <= endIndex; i++) {
    const filename = `${type}${i}.png`;
    const src = `${type}/${filename}`;
    const btn = document.createElement('button');
    const img = document.createElement('img');
    img.src = src;
    btn.appendChild(img);
    btn.onclick = () => {
      if (type.includes('earrings')) {
        changeEarring(src);
      } else {
        changeNecklace(src);
      }
    };
    container.appendChild(btn);
  }
}

/* ------------ Mediapipe FaceMesh ------------ */
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
});

faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

/* ===== Updated: draw video into canvas then overlays ===== */
faceMesh.onResults((results) => {
  // ensure canvas size matches video
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width  = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }

  // draw the current video frame into the canvas (so canvas contains camera feed)
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  try {
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
  } catch (e) {
    console.warn("Video draw failed:", e);
  }

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    smoothedLandmarks = null;
    // still draw watermark so user sees it
    try {
      if (watermarkImg && watermarkImg.naturalWidth) {
        const cw = canvasElement.width, ch = canvasElement.height;
        const wmWidth = Math.round(cw * 0.22);
        const wmHeight = Math.round((watermarkImg.height / watermarkImg.width) * wmWidth);
        const padding = Math.round(cw * 0.02);
        canvasCtx.globalAlpha = 0.85;
        canvasCtx.drawImage(watermarkImg, cw - wmWidth - padding, ch - wmHeight - padding, wmWidth, wmHeight);
        canvasCtx.globalAlpha = 1.0;
      }
    } catch (e) {}
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];

  if (!smoothedLandmarks) {
    smoothedLandmarks = landmarks;
  } else {
    smoothedLandmarks = smoothedLandmarks.map((prev, i) => ({
      x: prev.x * 0.7 + landmarks[i].x * 0.3,
      y: prev.y * 0.7 + landmarks[i].y * 0.3,
      z: prev.z * 0.7 + landmarks[i].z * 0.3,
    }));
  }

  // draw jewelry + watermark on top of the already-drawn video frame
  drawJewelry(smoothedLandmarks, canvasCtx);
});

/* ------------ Camera ------------ */
// Use Mediapipe Camera for consistent onFrame behaviour
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await faceMesh.send({ image: videoElement });
  },
  width: 1280,
  height: 720
});

// keep canvas size in sync when metadata loads
videoElement.addEventListener('loadedmetadata', () => {
  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;
});

camera.start();

/* ------------ draw jewelry (and watermark) ------------ */
function drawJewelry(landmarks, ctx) {
  const context = ctx || canvasCtx;

  const cw = context.canvas.width;
  const ch = context.canvas.height;

  const earringScale = 0.07;
  const necklaceScale = 0.18;

  // Landmarks used: 132 (left ear), 361 (right ear), 152 (neck)
  const leftEar = {
    x: landmarks[132].x * cw - 6,
    y: landmarks[132].y * ch - 16,
  };
  const rightEar = {
    x: landmarks[361].x * cw + 6,
    y: landmarks[361].y * ch - 16,
  };
  // you can tweak the "+10" to lift/lower the chain
  const neck = {
    x: landmarks[152].x * cw - 8,
    y: landmarks[152].y * ch + 10,
  };

  if (earringImg) {
    const width = earringImg.width * earringScale;
    const height = earringImg.height * earringScale;
    context.drawImage(earringImg, leftEar.x - width / 2, leftEar.y, width, height);
    context.drawImage(earringImg, rightEar.x - width / 2, rightEar.y, width, height);
  }

  if (necklaceImg) {
    const width = necklaceImg.width * necklaceScale;
    const height = necklaceImg.height * necklaceScale;
    context.drawImage(necklaceImg, neck.x - width / 2, neck.y, width, height);
  }

  // DRAW WATERMARK so it's included in captures
  try {
    if (watermarkImg && watermarkImg.naturalWidth) {
      const wmWidth = Math.round(cw * 0.22); // 22% of canvas width
      const wmHeight = Math.round((watermarkImg.height / watermarkImg.width) * wmWidth);
      const padding = Math.round(cw * 0.02);
      const x = cw - wmWidth - padding;
      const y = ch - wmHeight - padding;

      context.globalAlpha = 0.85;
      context.drawImage(watermarkImg, x, y, wmWidth, wmHeight);
      context.globalAlpha = 1.0;
    }
  } catch (e) {
    console.warn("Watermark draw failed:", e);
  }
}

/* ------------ snapshot helpers ------------ */
function triggerFlash() {
  if (!flashOverlay) return;
  flashOverlay.classList.add('active');
  setTimeout(() => flashOverlay.classList.remove('active'), 180);
}

async function takeSnapshot() {
  if (!smoothedLandmarks) {
    alert("Face not detected. Please try again.");
    return;
  }

  await ensureWatermarkLoaded();

  triggerFlash();

  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = canvasElement.width;
  snapshotCanvas.height = canvasElement.height;
  const ctx = snapshotCanvas.getContext('2d');

  // draw video then overlays (drawJewelry adds jewelry + watermark)
  try {
    ctx.drawImage(videoElement, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
  } catch (e) {
    console.warn("Snapshot video draw failed:", e);
  }
  drawJewelry(smoothedLandmarks, ctx);

  lastSnapshotDataURL = snapshotCanvas.toDataURL('image/png');

  document.getElementById('snapshot-preview').src = lastSnapshotDataURL;
  document.getElementById('snapshot-modal').style.display = 'block';
}

function saveSnapshot() {
  const link = document.createElement('a');
  link.href = lastSnapshotDataURL;
  link.download = `jewelry-tryon-${Date.now()}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function shareSnapshot() {
  if (!navigator.share || !navigator.canShare) {
    alert('Sharing not supported on this device.');
    return;
  }
  const resp = await fetch(lastSnapshotDataURL);
  const blob = await resp.blob();
  const file = new File([blob], 'jewelry-tryon.png', { type: 'image/png' });

  await navigator.share({
    title: 'Jewelry Try-On',
    text: 'Check out my look!',
    files: [file]
  });
}

function closeSnapshotModal() {
  document.getElementById('snapshot-modal').style.display = 'none';
}

/* ------------ info modal ------------ */
function toggleInfoModal() {
  const modal = document.getElementById('info-modal');
  modal.style.display = modal.style.display === 'block' ? 'none' : 'block';
}

/* ------------ TRY ALL logic ------------ */
function stopAutoTry() {
  autoTryRunning = false;
  if (autoTryTimeout) clearTimeout(autoTryTimeout);
  autoTryTimeout = null;
  if (tryAllBtn) {
    tryAllBtn.classList.remove('active');
    tryAllBtn.textContent = 'Try All';
  }
}

function toggleTryAll() {
  if (autoTryRunning) {
    stopAutoTry();
  } else {
    startAutoTry();
  }
}

async function startAutoTry() {
  if (!currentType) {
    alert('Please choose Gold / Diamond and a jewelry type first.');
    return;
  }

  const list = buildImageList(currentType);
  if (!list.length) {
    alert('No items found for this category.');
    return;
  }

  autoSnapshots = [];
  autoTryIndex = 0;
  autoTryRunning = true;
  tryAllBtn.classList.add('active');
  tryAllBtn.textContent = 'Stop';

  const step = async () => {
    if (!autoTryRunning) return;

    const src = list[autoTryIndex];

    if (currentType.includes('earrings')) {
      await changeEarring(src);
    } else {
      await changeNecklace(src);
    }

    // wait for visual stabilisation
    await new Promise(res => setTimeout(res, 800));

    triggerFlash();
    if (smoothedLandmarks) {
      await ensureWatermarkLoaded();

      const snapshotCanvas = document.createElement('canvas');
      snapshotCanvas.width = canvasElement.width;
      snapshotCanvas.height = canvasElement.height;
      const ctx = snapshotCanvas.getContext('2d');

      try {
        ctx.drawImage(videoElement, 0, 0, snapshotCanvas.width, snapshotCanvas.height);
      } catch (e) {
        console.warn("AutoTry video draw failed:", e);
      }
      drawJewelry(smoothedLandmarks, ctx);

      const dataURL = snapshotCanvas.toDataURL('image/png');
      autoSnapshots.push(dataURL);
    }

    autoTryIndex++;
    if (autoTryIndex >= list.length) {
      stopAutoTry();
      openGallery();
      return;
    }

    autoTryTimeout = setTimeout(step, 2000);
  };

  step();
}

/* ------------ Gallery (after TRY ALL) ------------ */
function openGallery() {
  if (!autoSnapshots.length) {
    alert('No snapshots captured.');
    return;
  }

  galleryThumbs.innerHTML = '';
  autoSnapshots.forEach((src, idx) => {
    const img = document.createElement('img');
    img.src = src;
    img.onclick = () => setGalleryMain(idx);
    galleryThumbs.appendChild(img);
  });

  setGalleryMain(0);
  galleryModal.style.display = 'flex';
}

function setGalleryMain(index) {
  const src = autoSnapshots[index];
  galleryMain.src = src;

  const thumbs = galleryThumbs.querySelectorAll('img');
  thumbs.forEach((t, i) => {
    t.classList.toggle('active', i === index);
  });
}

if (galleryClose) {
  galleryClose.addEventListener('click', () => {
    galleryModal.style.display = 'none';
  });
}

/* ------------ Download All (ZIP) from gallery ------------ */
async function downloadAllImages() {
  if (!autoSnapshots.length) {
    alert("No images to download.");
    return;
  }

  const zip = new JSZip();
  const folder = zip.folder("Your_Looks");

  for (let i = 0; i < autoSnapshots.length; i++) {
    const dataURL = autoSnapshots[i]; // already watermarked
    const base64Data = dataURL.split(",")[1]; // remove header
    folder.file(`look_${i + 1}.png`, base64Data, { base64: true });
  }

  const content = await zip.generateAsync({ type: "blob" });
  saveAs(content, "OverlayJewels_Looks.zip");
}

/* ------------ Share current image from gallery ------------ */
async function shareCurrentFromGallery() {
  if (!galleryMain.src) {
    alert("No image selected.");
    return;
  }
  if (!navigator.share || !navigator.canShare) {
    alert("Sharing not supported on this device.");
    return;
  }

  const resp = await fetch(galleryMain.src);
  const blob = await resp.blob();
  const file = new File([blob], 'jewelry-look.png', { type: 'image/png' });

  await navigator.share({
    title: 'Jewelry Try-On',
    text: 'Check out my jewellery look!',
    files: [file]
  });
}

/* expose functions globally */
window.toggleCategory = toggleCategory;
window.selectJewelryType = selectJewelryType;
window.takeSnapshot = takeSnapshot;
window.saveSnapshot = saveSnapshot;
window.shareSnapshot = shareSnapshot;
window.closeSnapshotModal = closeSnapshotModal;
window.toggleInfoModal = toggleInfoModal;
window.toggleTryAll = toggleTryAll;
window.downloadAllImages = downloadAllImages;
window.shareCurrentFromGallery = shareCurrentFromGallery;
