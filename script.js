// script.js — with BodyPix-based occlusion (hair/face in front of necklace)

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

/* TUNABLES */
const NECK_SCALE_MULTIPLIER   = 1.15;
const NECK_Y_OFFSET_FACTOR    = 0.95;
const NECK_X_OFFSET_FACTOR    = 0.0;

/* BodyPix settings */
let bodyPixNet = null;
const BODYPIX_CONFIG = {
  architecture: 'MobileNetV1',
  outputStride: 16,
  multiplier: 0.50,        // smaller model → faster
  quantBytes: 2
};
const SEGMENTATION_CONFIG = {
  internalResolution: 'low', // low/medium/high
  segmentationThreshold: 0.7,
  maxDetections: 1,
  scoreThreshold: 0.3,
  nmsRadius: 20
};
// How often to run BodyPix (ms). Use 200–400 for low cost.
const BODYPIX_THROTTLE_MS = 250;

let lastBodyPixRun = 0;
let lastPersonSegmentation = null; // Uint8Array mask

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

/* WATERMARK */
const watermarkImg = new Image();
watermarkImg.src = "logo_watermark.png";
watermarkImg.crossOrigin = "anonymous";
function ensureWatermarkLoaded() {
  return new Promise((resolve) => {
    if (watermarkImg.complete && watermarkImg.naturalWidth !== 0) resolve();
    else { watermarkImg.onload = () => resolve(); watermarkImg.onerror = () => resolve(); }
  });
}

/* IMAGE HELPERS */
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = src;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
}
async function changeEarring(src) { earringSrc = src; const img = await loadImage(src); if (img) earringImg = img; }
async function changeNecklace(src) { necklaceSrc = src; const img = await loadImage(src); if (img) necklaceImg = img; }

/* CATEGORY / UI (unchanged helpers) */
function toggleCategory(category) {
  document.getElementById('subcategory-buttons').style.display = 'flex';
  const subButtons = document.querySelectorAll('#subcategory-buttons button');
  subButtons.forEach(btn => {
    btn.style.display = btn.innerText.toLowerCase().includes(category) ? 'inline-block' : 'none';
  });
  document.getElementById('jewelry-options').style.display = 'none';
  stopAutoTry();
}
function selectJewelryType(type) {
  currentType = type;
  document.getElementById('jewelry-options').style.display = 'flex';
  earringImg = null; necklaceImg = null; earringSrc = ''; necklaceSrc = '';
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
  const { start, end } = getRangeForType(type); const list = [];
  for (let i = start; i <= end; i++) list.push(`${type}/${type}${i}.png`);
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
    btn.onclick = () => { if (type.includes('earrings')) changeEarring(src); else changeNecklace(src); };
    container.appendChild(btn);
  }
}

/* MEDIAPIPE FaceMesh */
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
});
faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });

/* ===== Helper: run BodyPix segmentation (throttled) ===== */
async function ensureBodyPixLoaded() {
  if (bodyPixNet) return;
  bodyPixNet = await bodyPix.load(BODYPIX_CONFIG); // load model
  console.log("BodyPix loaded");
}

async function runBodyPixIfNeeded() {
  const now = performance.now();
  if (!bodyPixNet) return;
  if (now - lastBodyPixRun < BODYPIX_THROTTLE_MS) return;
  lastBodyPixRun = now;

  // run a quick person segmentation on the video element
  try {
    const seg = await bodyPixNet.segmentPerson(videoElement, SEGMENTATION_CONFIG);
    // seg.data is Uint8Array of 0/1 per pixel (width*height)
    lastPersonSegmentation = {
      data: seg.data,
      width: seg.width,
      height: seg.height
    };
  } catch (e) {
    console.warn("BodyPix segment error:", e);
  }
}

/* ===== Updated: draw video into canvas then overlays + occlusion ===== */
faceMesh.onResults(async (results) => {
  // sync canvas size to video (important)
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width  = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }

  // draw video frame into canvas first
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  try { canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height); }
  catch (e) { console.warn("Video draw failed:", e); }

  // if face detected? prepare smoothed landmarks
  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    smoothedLandmarks = null;
    // still draw watermark for visual cue
    drawWatermark(canvasCtx);
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];
  if (!smoothedLandmarks) smoothedLandmarks = landmarks;
  else {
    smoothedLandmarks = smoothedLandmarks.map((prev, i) => ({
      x: prev.x * 0.7 + landmarks[i].x * 0.3,
      y: prev.y * 0.7 + landmarks[i].y * 0.3,
      z: prev.z * 0.7 + landmarks[i].z * 0.3,
    }));
  }

  // DRAW JEWELRY ON TOP of video (for now)
  drawJewelry(smoothedLandmarks, canvasCtx);

  // Throttle BodyPix and run segmentation in background
  await ensureBodyPixLoaded();
  runBodyPixIfNeeded(); // do not await long; segmentation will populate lastPersonSegmentation asynchronously

  // If we have a recent person segmentation, composite head region over the jewelry to occlude
  if (lastPersonSegmentation && lastPersonSegmentation.data) {
    compositeHeadOcclusion(canvasCtx, smoothedLandmarks, lastPersonSegmentation);
  } else {
    // fallback: draw watermark only if no segmentation
    drawWatermark(canvasCtx);
  }
});

/* CAMERA initialization (Mediapipe camera util) */
const camera = new Camera(videoElement, {
  onFrame: async () => { await faceMesh.send({ image: videoElement }); },
  width: 1280, height: 720
});
videoElement.addEventListener('loadedmetadata', () => {
  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;
});
camera.start();

/* UTILS: convert normalized landmarks to px */
function toPxX(normX) { return normX * canvasElement.width; }
function toPxY(normY) { return normY * canvasElement.height; }

/* DRAW JEWELRY (improved alignment — same as before) */
function drawJewelry(landmarks, context) {
  const ctx = context || canvasCtx;
  const cw = ctx.canvas.width; const ch = ctx.canvas.height;

  const leftEar = { x: toPxX(landmarks[132].x), y: toPxY(landmarks[132].y) };
  const rightEar = { x: toPxX(landmarks[361].x), y: toPxY(landmarks[361].y) };
  const neckPoint = { x: toPxX(landmarks[152].x), y: toPxY(landmarks[152].y) };

  const earDist = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);

  if (earringImg) {
    const eWidth = earDist * 0.18;
    const eHeight = (earringImg.height / earringImg.width) * eWidth;
    ctx.drawImage(earringImg, leftEar.x - eWidth/2, leftEar.y - eHeight*0.15, eWidth, eHeight);
    ctx.drawImage(earringImg, rightEar.x - eWidth/2, rightEar.y - eHeight*0.15, eWidth, eHeight);
  }

  if (necklaceImg) {
    const desiredWidth = earDist * NECK_SCALE_MULTIPLIER;
    const desiredHeight = (necklaceImg.height / necklaceImg.width) * desiredWidth;
    const yOffset = earDist * NECK_Y_OFFSET_FACTOR;
    const centerX = neckPoint.x + (earDist * NECK_X_OFFSET_FACTOR);
    const centerY = neckPoint.y + yOffset;
    const angle = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);
    ctx.drawImage(necklaceImg, -desiredWidth/2, -desiredHeight/2, desiredWidth, desiredHeight);
    ctx.restore();
  }
}

/* DRAW watermark helper */
function drawWatermark(ctx) {
  try {
    if (watermarkImg && watermarkImg.naturalWidth) {
      const cw = ctx.canvas.width; const ch = ctx.canvas.height;
      const wmWidth = Math.round(cw * 0.22);
      const wmHeight = Math.round((watermarkImg.height / watermarkImg.width) * wmWidth);
      const padding = Math.round(cw * 0.02);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(watermarkImg, cw - wmWidth - padding, ch - wmHeight - padding, wmWidth, wmHeight);
      ctx.globalAlpha = 1.0;
    }
  } catch (e) { console.warn("Watermark draw failed:", e); }
}

/* ---------- Occlusion composite: copy head pixels on top of jewelry ------------- */
/* Approach:
   - Use lastPersonSegmentation.data (binary person mask at segmentation width/height)
   - Build a "head box" from faceMesh landmarks (top of face to neck region)
   - Copy video pixels from an offscreen video->canvas only where (segmentation == 1) AND inside headBox (so hair/face overlay)
   - Draw those pixels onto main canvas on top of jewelry.
*/
function compositeHeadOcclusion(mainCtx, landmarks, personSeg) {
  try {
    // personSeg: { data: Uint8Array, width, height }
    const segData = personSeg.data;
    const segW = personSeg.width;
    const segH = personSeg.height;

    // Build head bounding box from landmarks (take forehead/top values and chin/neck)
    // Use a subset of landmarks representing top of head/forehead/neck to estimate region
    // We'll use landmark indices roughly covering forehead/top of head region: 10, 151, 9, 197, 195, 4 (approx)
    const indices = [10, 151, 9, 197, 195, 4];
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    indices.forEach(i => {
      const x = landmarks[i].x; const y = landmarks[i].y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    });
    // expand box a bit to capture hair
    const padX = 0.18 * (maxX - minX);
    const padY = 0.40 * (maxY - minY);
    const boxLeft = Math.max(0, (minX - padX) * canvasElement.width);
    const boxTop  = Math.max(0, (minY - padY) * canvasElement.height);
    const boxRight= Math.min(canvasElement.width, (maxX + padX) * canvasElement.width);
    const boxBottom=Math.min(canvasElement.height, (maxY + padY) * canvasElement.height);
    const boxW = boxRight - boxLeft;
    const boxH = boxBottom - boxTop;
    if (boxW <= 0 || boxH <= 0) { drawWatermark(mainCtx); return; }

    // Create offscreen canvases
    const offVideo = document.createElement('canvas');
    offVideo.width = canvasElement.width; offVideo.height = canvasElement.height;
    const offVideoCtx = offVideo.getContext('2d');
    // draw current video frame into offVideo
    try { offVideoCtx.drawImage(videoElement, 0, 0, offVideo.width, offVideo.height); } catch (e) { return; }

    // Create mask canvas sized to segmentation; we'll up/downscale as needed
    // We'll iterate over pixels inside the head box region to keep it fast
    const imgData = offVideoCtx.getImageData(boxLeft, boxTop, boxW, boxH);
    const dstData = mainCtx.getImageData(boxLeft, boxTop, boxW, boxH);

    // Map box pixel coords -> segmentation coords
    // personSeg.width/height may differ from canvas; compute scaling
    const sx = segW / canvasElement.width;
    const sy = segH / canvasElement.height;

    // For each pixel in head-box: if segmentation indicates PERSON (1), copy video pixel to main canvas (dstData)
    const pxLen = boxW * boxH;
    for (let y = 0; y < boxH; y++) {
      const segY = Math.floor((boxTop + y) * sy);
      if (segY < 0 || segY >= segH) continue;
      for (let x = 0; x < boxW; x++) {
        const segX = Math.floor((boxLeft + x) * sx);
        if (segX < 0 || segX >= segW) continue;
        const segIdx = segY * segW + segX;
        if (segData[segIdx] === 1) {
          // copy RGBA from imgData to dstData
          const i = (y * boxW + x) * 4;
          dstData.data[i]   = imgData.data[i];
          dstData.data[i+1] = imgData.data[i+1];
          dstData.data[i+2] = imgData.data[i+2];
          dstData.data[i+3] = imgData.data[i+3];
        }
      }
    }

    // put modified dstData back onto main canvas
    mainCtx.putImageData(dstData, boxLeft, boxTop);

    // finally draw watermark
    drawWatermark(mainCtx);

  } catch (e) {
    console.warn("compositeHeadOcclusion failed:", e);
    drawWatermark(mainCtx);
  }
}

/* ---------- Snapshot helpers + Try-All (use same capture logic so watermark & occlusion included) ---------- */
function triggerFlash() { if (!flashOverlay) return; flashOverlay.classList.add('active'); setTimeout(() => flashOverlay.classList.remove('active'), 180); }

async function takeSnapshot() {
  if (!smoothedLandmarks) { alert("Face not detected. Please try again."); return; }
  await ensureWatermarkLoaded();
  triggerFlash();

  // snapshot canvas
  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = canvasElement.width;
  snapshotCanvas.height = canvasElement.height;
  const ctx = snapshotCanvas.getContext('2d');

  try { ctx.drawImage(videoElement, 0, 0, snapshotCanvas.width, snapshotCanvas.height); } catch (e) { console.warn("Snapshot video draw failed:", e); }

  // draw jewelry onto snapshot
  drawJewelry(smoothedLandmarks, ctx);

  // optionally run a final segmentation to occlude head on snapshot (synchronous using last segmentation)
  if (lastPersonSegmentation && lastPersonSegmentation.data) {
    compositeSnapshotHeadOcclusion(snapshotCanvas, ctx, smoothedLandmarks, lastPersonSegmentation);
  } else {
    drawWatermark(ctx);
  }

  lastSnapshotDataURL = snapshotCanvas.toDataURL('image/png');
  document.getElementById('snapshot-preview').src = lastSnapshotDataURL;
  document.getElementById('snapshot-modal').style.display = 'block';
}

// Similar helper to composite occlusion for snapshot canvas (uses same logic as compositeHeadOcclusion but operates on provided canvas)
function compositeSnapshotHeadOcclusion(snapshotCanvas, ctx, landmarks, personSeg) {
  try {
    const segData = personSeg.data;
    const segW = personSeg.width;
    const segH = personSeg.height;

    const indices = [10, 151, 9, 197, 195, 4];
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    indices.forEach(i => {
      const x = landmarks[i].x; const y = landmarks[i].y;
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    });
    const padX = 0.18 * (maxX - minX);
    const padY = 0.40 * (maxY - minY);
    const boxLeft = Math.max(0, (minX - padX) * snapshotCanvas.width);
    const boxTop  = Math.max(0, (minY - padY) * snapshotCanvas.height);
    const boxRight= Math.min(snapshotCanvas.width, (maxX + padX) * snapshotCanvas.width);
    const boxBottom=Math.min(snapshotCanvas.height, (maxY + padY) * snapshotCanvas.height);
    const boxW = boxRight - boxLeft; const boxH = boxBottom - boxTop;
    if (boxW <= 0 || boxH <= 0) { drawWatermark(ctx); return; }

    const off = document.createElement('canvas'); off.width = snapshotCanvas.width; off.height = snapshotCanvas.height;
    const offCtx = off.getContext('2d');
    offCtx.drawImage(videoElement, 0, 0, off.width, off.height);

    const imgData = offCtx.getImageData(boxLeft, boxTop, boxW, boxH);
    const dstData = ctx.getImageData(boxLeft, boxTop, boxW, boxH);
    const sx = segW / snapshotCanvas.width;
    const sy = segH / snapshotCanvas.height;

    for (let y = 0; y < boxH; y++) {
      const segY = Math.floor((boxTop + y) * sy);
      if (segY < 0 || segY >= segH) continue;
      for (let x = 0; x < boxW; x++) {
        const segX = Math.floor((boxLeft + x) * sx);
        if (segX < 0 || segX >= segW) continue;
        const segIdx = segY * segW + segX;
        if (segData[segIdx] === 1) {
          const i = (y * boxW + x) * 4;
          dstData.data[i]   = imgData.data[i];
          dstData.data[i+1] = imgData.data[i+1];
          dstData.data[i+2] = imgData.data[i+2];
          dstData.data[i+3] = imgData.data[i+3];
        }
      }
    }
    ctx.putImageData(dstData, boxLeft, boxTop);
    drawWatermark(ctx);
  } catch (e) { console.warn("compositeSnapshotHeadOcclusion failed:", e); drawWatermark(ctx); }
}

/* Info modal */
function toggleInfoModal() { const modal = document.getElementById('info-modal'); modal.style.display = modal.style.display === 'block' ? 'none' : 'block'; }

/* TRY ALL + gallery (unchanged logic but ensure snapshots are captured using takeSnapshot-like flow) */
function stopAutoTry() {
  autoTryRunning = false;
  if (autoTryTimeout) clearTimeout(autoTryTimeout);
  autoTryTimeout = null;
  if (tryAllBtn) { tryAllBtn.classList.remove('active'); tryAllBtn.textContent = 'Try All'; }
}
function toggleTryAll() { if (autoTryRunning) stopAutoTry(); else startAutoTry(); }

async function startAutoTry() {
  if (!currentType) { alert('Please choose Gold / Diamond and a jewelry type first.'); return; }
  const list = buildImageList(currentType);
  if (!list.length) { alert('No items found for this category.'); return; }

  autoSnapshots = []; autoTryIndex = 0; autoTryRunning = true;
  tryAllBtn.classList.add('active'); tryAllBtn.textContent = 'Stop';

  const step = async () => {
    if (!autoTryRunning) return;
    const src = list[autoTryIndex];
    if (currentType.includes('earrings')) await changeEarring(src); else await changeNecklace(src);
    await new Promise(res => setTimeout(res, 800));
    triggerFlash();
    if (smoothedLandmarks) {
      // capture snapshot with occlusion
      const snapshotCanvas = document.createElement('canvas');
      snapshotCanvas.width = canvasElement.width; snapshotCanvas.height = canvasElement.height;
      const ctx = snapshotCanvas.getContext('2d');
      try { ctx.drawImage(videoElement, 0, 0, snapshotCanvas.width, snapshotCanvas.height); } catch (e) { console.warn("AutoTry video draw failed:", e); }
      drawJewelry(smoothedLandmarks, ctx);
      // run segmentation (best-effort)
      await ensureBodyPixLoaded(); await runBodyPixIfNeeded();
      if (lastPersonSegmentation && lastPersonSegmentation.data) compositeSnapshotHeadOcclusion(snapshotCanvas, ctx, smoothedLandmarks, lastPersonSegmentation);
      else drawWatermark(ctx);
      autoSnapshots.push(snapshotCanvas.toDataURL('image/png'));
    }
    autoTryIndex++;
    if (autoTryIndex >= list.length) { stopAutoTry(); openGallery(); return; }
    autoTryTimeout = setTimeout(step, 2000);
  };
  step();
}

/* GALLERY, DOWNLOAD, SHARE (unchanged) */
function openGallery() {
  if (!autoSnapshots.length) { alert('No snapshots captured.'); return; }
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
  thumbs.forEach((t, i) => t.classList.toggle('active', i === index));
}
if (galleryClose) galleryClose.addEventListener('click', () => { galleryModal.style.display = 'none'; });

async function downloadAllImages() {
  if (!autoSnapshots.length) { alert("No images to download."); return; }
  const zip = new JSZip(); const folder = zip.folder("Your_Looks");
  for (let i = 0; i < autoSnapshots.length; i++) {
    const dataURL = autoSnapshots[i]; const base64Data = dataURL.split(",")[1];
    folder.file(`look_${i + 1}.png`, base64Data, { base64: true });
  }
  const content = await zip.generateAsync({ type: "blob" });
  saveAs(content, "OverlayJewels_Looks.zip");
}

async function shareCurrentFromGallery() {
  if (!galleryMain.src) { alert("No image selected."); return; }
  if (!navigator.share || !navigator.canShare) { alert("Sharing not supported on this device."); return; }
  const resp = await fetch(galleryMain.src); const blob = await resp.blob();
  const file = new File([blob], 'jewelry-look.png', { type: 'image/png' });
  await navigator.share({ title: 'Jewelry Try-On', text: 'Check out my jewellery look!', files: [file] });
}

/* Snapshot saving & sharing helpers */
function saveSnapshot() {
  const link = document.createElement('a'); link.href = lastSnapshotDataURL; link.download = `jewelry-tryon-${Date.now()}.png`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
}
async function shareSnapshot() {
  if (!navigator.share || !navigator.canShare) { alert('Sharing not supported on this device.'); return; }
  const resp = await fetch(lastSnapshotDataURL); const blob = await resp.blob();
  const file = new File([blob], 'jewelry-tryon.png', { type: 'image/png' });
  await navigator.share({ title: 'Jewelry Try-On', text: 'Check out my look!', files: [file] });
}
function closeSnapshotModal() { document.getElementById('snapshot-modal').style.display = 'none'; }

/* export global functions */
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
