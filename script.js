/* script.js - Aurum Atelier: Google Drive Integration (Actual Filenames) */

/* --- GOOGLE DRIVE CONFIGURATION --- */
const API_KEY = "AIzaSyBhi05HMVGg90dPP91zG1RZtNxm-d6hnQw"; 

const DRIVE_FOLDERS = {
  diamond_earrings: "1N0jndAEIThUuuNAJpvuRMGsisIaXCgMZ",
  diamond_necklaces: "1JGV8T03YdzjfW0Dyt9aMPybH8V9-gEhw",
  gold_earrings: "1GMZpcv4A1Gy2xiaIC1XPG_IOAt9NrDpi",
  gold_necklaces: "1QIvX-PrSVrK9gz-TEksqiKlXPGv2hsS5"
};

/* Asset Cache to store fetched Drive data */
const JEWELRY_ASSETS = {};
const PRELOADED_IMAGES = {}; 

/* --- 1. PRELOAD WATERMARK --- */
const watermarkImg = new Image();
watermarkImg.src = 'logo_watermark.png'; 

/* DOM Elements */
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('overlay');
const canvasCtx = canvasElement.getContext('2d');
const loadingStatus = document.getElementById('loading-status');

/* --- HIDE GESTURE INDICATOR --- */
const gestureIndicator = document.getElementById('gesture-indicator');
if (gestureIndicator) {
    gestureIndicator.style.display = 'none';
}
const indicatorDot = document.getElementById('indicator-dot');

/* App State */
let earringImg = null, necklaceImg = null, currentType = '';
let isProcessingHand = false;
let isProcessingFace = false;

/* --- Gesture State --- */
let lastGestureTime = 0;
const GESTURE_COOLDOWN = 800; 
let previousHandX = null;     

/* --- Try All / Gallery State --- */
let autoTryRunning = false;
let autoSnapshots = []; // Now stores objects: { url: "...", name: "..." }
let autoTryIndex = 0;
let autoTryTimeout = null;
let currentPreviewData = { url: null, name: 'aurum_look.png' }; 

/* --- GOOGLE DRIVE API FETCH --- */
async function fetchFromDrive(category) {
    if (JEWELRY_ASSETS[category]) return;

    const folderId = DRIVE_FOLDERS[category];
    if (!folderId) {
        console.error(`No Folder ID found for category: ${category}`);
        return;
    }

    loadingStatus.style.display = 'block';
    loadingStatus.textContent = "Fetching Designs...";

    try {
        const query = `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,thumbnailLink)&key=${API_KEY}`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error.message);
        }

        // Map Drive files using High-Res Thumbnail Hack
        JEWELRY_ASSETS[category] = data.files.map(file => {
            const highResSource = file.thumbnailLink 
                ? file.thumbnailLink.replace(/=s\d+$/, "=s3000") 
                : `https://drive.google.com/uc?export=view&id=${file.id}`;

            return {
                id: file.id,
                name: file.name,
                src: highResSource
            };
        });

        loadingStatus.style.display = 'none';

    } catch (err) {
        console.error("Drive API Error:", err);
        loadingStatus.textContent = "Error Loading Images";
        alert("Failed to load images. Check console (F12).");
    }
}

/* --- PRELOADER --- */
async function preloadCategory(type) {
    await fetchFromDrive(type);
    
    if (!JEWELRY_ASSETS[type]) return;

    if (!PRELOADED_IMAGES[type]) {
        PRELOADED_IMAGES[type] = [];
        const files = JEWELRY_ASSETS[type];

        const promises = files.map(file => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous'; 
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null); 
                img.src = file.src;
                PRELOADED_IMAGES[type].push(img);
            });
        });

        loadingStatus.style.display = 'block';
        loadingStatus.textContent = "Downloading Assets...";
        await Promise.all(promises);
        loadingStatus.style.display = 'none';
    }
}

/* --- UI Indicator Helpers --- */
function updateHandIndicator(detected) {
  if (!detected) previousHandX = null; 
}

function flashIndicator(color) {
    if(indicatorDot && indicatorDot.style.display !== 'none') {
        indicatorDot.style.background = color;
        setTimeout(() => { indicatorDot.style.background = "#00ff88"; }, 300);
    }
}

/* ---------- HAND DETECTION (SWIPE LOGIC) ---------- */
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 0, 
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  isProcessingHand = false; 
  const hasHand = results.multiHandLandmarks && results.multiHandLandmarks.length > 0;
  updateHandIndicator(hasHand);

  if (!hasHand || autoTryRunning) return;

  const now = Date.now();
  if (now - lastGestureTime < GESTURE_COOLDOWN) return;

  const landmarks = results.multiHandLandmarks[0];
  const indexTip = landmarks[8]; 
  const currentX = indexTip.x;   

  if (previousHandX !== null) {
      const diff = currentX - previousHandX;
      const SWIPE_THRESHOLD = 0.04; 

      if (diff < -SWIPE_THRESHOLD) { 
        navigateJewelry(1);
        lastGestureTime = now;
        flashIndicator("#d4af37");
        previousHandX = null; 
      } 
      else if (diff > SWIPE_THRESHOLD) { 
        navigateJewelry(-1);
        lastGestureTime = now;
        flashIndicator("#d4af37");
        previousHandX = null; 
      }
  }

  if (now - lastGestureTime > 100) {
      previousHandX = currentX;
  }
});

/* ---------- FACE MESH ---------- */
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({ refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

faceMesh.onResults((results) => {
  isProcessingFace = false;
  
  if(loadingStatus.style.display !== 'none' && loadingStatus.textContent === "Loading AI Models...") {
      loadingStatus.style.display = 'none';
  }

  canvasElement.width = videoElement.videoWidth;
  canvasElement.height = videoElement.videoHeight;
  
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  canvasCtx.translate(canvasElement.width, 0);
  canvasCtx.scale(-1, 1);

  if (results.multiFaceLandmarks && results.multiFaceLandmarks[0]) {
    const lm = results.multiFaceLandmarks[0];
    
    const leftEar = { x: lm[132].x * canvasElement.width, y: lm[132].y * canvasElement.height };
    const rightEar = { x: lm[361].x * canvasElement.width, y: lm[361].y * canvasElement.height };
    const neck = { x: lm[152].x * canvasElement.width, y: lm[152].y * canvasElement.height };
    const earDist = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);

    if (earringImg && earringImg.complete) {
      let ew = earDist * 0.25;
      let eh = (earringImg.height/earringImg.width) * ew;
      canvasCtx.drawImage(earringImg, leftEar.x - ew/2, leftEar.y, ew, eh);
      canvasCtx.drawImage(earringImg, rightEar.x - ew/2, rightEar.y, ew, eh);
    }
    
    if (necklaceImg && necklaceImg.complete) {
      let nw = earDist * 1.2;
      let nh = (necklaceImg.height/necklaceImg.width) * nw;
      canvasCtx.drawImage(necklaceImg, neck.x - nw/2, neck.y + (earDist*0.2), nw, nh);
    }
  }
  canvasCtx.restore();
});

/* ---------- FAST CAMERA INIT & LOOP ---------- */
async function startCameraFast() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: "user"
            }
        });
        
        videoElement.srcObject = stream;
        
        videoElement.onloadeddata = () => {
            videoElement.play();
            loadingStatus.textContent = "Loading AI Models...";
            detectLoop(); 
        };
    } catch (err) {
        console.error("Camera Error:", err);
        alert("Camera permission denied. Please allow camera access.");
        loadingStatus.textContent = "Camera Error";
    }
}

async function detectLoop() {
    if (videoElement.readyState >= 2) {
        if (!isProcessingFace) {
            isProcessingFace = true;
            await faceMesh.send({image: videoElement});
        }
        if (!isProcessingHand) {
            isProcessingHand = true;
            await hands.send({image: videoElement});
        }
    }
    requestAnimationFrame(detectLoop);
}

window.onload = startCameraFast;

/* ---------- NAVIGATION & SELECTION ---------- */
function navigateJewelry(dir) {
  if (!currentType || !PRELOADED_IMAGES[currentType]) return;
  
  const list = PRELOADED_IMAGES[currentType];
  let currentImg = currentType.includes('earrings') ? earringImg : necklaceImg;
  
  let idx = list.indexOf(currentImg);
  if (idx === -1) idx = 0; 

  let nextIdx = (idx + dir + list.length) % list.length;
  
  const nextItem = list[nextIdx];
  if (currentType.includes('earrings')) earringImg = nextItem;
  else necklaceImg = nextItem;
}

async function selectJewelryType(type) {
  currentType = type;
  
  await preloadCategory(type); 
  
  const container = document.getElementById('jewelry-options');
  container.innerHTML = '';
  container.style.display = 'flex';
  
  const files = JEWELRY_ASSETS[type];
  if (!files) return;

  files.forEach((file, i) => {
    const btnImg = new Image();
    btnImg.src = file.src; 
    btnImg.crossOrigin = 'anonymous';
    btnImg.className = "thumb-btn"; 
    btnImg.onclick = () => {
        const fullImg = PRELOADED_IMAGES[type][i];
        if (type.includes('earrings')) earringImg = fullImg;
        else necklaceImg = fullImg;
    };
    container.appendChild(btnImg);
  });
}

function toggleCategory(cat) {
  document.getElementById('subcategory-buttons').style.display = 'flex';
  const subs = document.querySelectorAll('.subpill');
  subs.forEach(b => b.style.display = b.innerText.toLowerCase().includes(cat) ? 'inline-block' : 'none');
}

/* ---------- TRY ALL (AUTO CAPTURE) ---------- */
async function toggleTryAll() {
  if (!currentType) {
    alert("Please select a sub-category (e.g. Gold Earrings) first!");
    return;
  }
  
  if (autoTryRunning) {
    stopAutoTry();
  } else {
    startAutoTry();
  }
}

function startAutoTry() {
  autoTryRunning = true;
  autoSnapshots = [];
  autoTryIndex = 0;
  
  const btn = document.getElementById('tryall-btn');
  btn.textContent = "STOPPING...";
  btn.classList.add('active');
  
  runAutoStep();
}

function stopAutoTry() {
  autoTryRunning = false;
  if (autoTryTimeout) clearTimeout(autoTryTimeout);
  
  const btn = document.getElementById('tryall-btn');
  btn.textContent = "Try All";
  btn.classList.remove('active');
  
  if (autoSnapshots.length > 0) showGallery();
}

async function runAutoStep() {
  if (!autoTryRunning) return;

  const assets = PRELOADED_IMAGES[currentType];
  if (!assets || autoTryIndex >= assets.length) {
    stopAutoTry();
    return;
  }

  const targetImg = assets[autoTryIndex];
  if (currentType.includes('earrings')) earringImg = targetImg;
  else necklaceImg = targetImg;

  autoTryTimeout = setTimeout(() => {
    captureToGallery();
    autoTryIndex++;
    runAutoStep();
  }, 1500); 
}

/* ---------- CAPTURE LOGIC (UPDATED FOR ACTUAL FILENAMES) ---------- */
function captureToGallery() {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = videoElement.videoWidth;
  tempCanvas.height = videoElement.videoHeight;
  const tempCtx = tempCanvas.getContext('2d');
  
  // 1. Draw Video
  tempCtx.translate(tempCanvas.width, 0);
  tempCtx.scale(-1, 1);
  tempCtx.drawImage(videoElement, 0, 0);
  
  // 2. Draw Jewelry
  tempCtx.setTransform(1, 0, 0, 1, 0, 0); 
  try {
      tempCtx.drawImage(canvasElement, 0, 0);
  } catch(e) {
      console.warn("Canvas Tainted");
  }

  // --- FILENAME LOGIC ---
  let itemName = "Aurum Look";
  let itemFilename = "aurum_look.png";
  
  if (currentType && PRELOADED_IMAGES[currentType]) {
      const list = PRELOADED_IMAGES[currentType];
      let currentImg = currentType.includes('earrings') ? earringImg : necklaceImg;
      let idx = list.indexOf(currentImg);
      
      if(idx >= 0 && JEWELRY_ASSETS[currentType][idx]) {
          const rawFilename = JEWELRY_ASSETS[currentType][idx].name;
          
          // Display Name: Remove extension, replace _ with space
          const nameOnly = rawFilename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
          itemName = nameOnly.replace(/\b\w/g, l => l.toUpperCase());
          
          // File Name: Use Actual Name, but ensure .png extension
          // We remove the old extension (like .jpg) and append .png to match the canvas data format
          itemFilename = rawFilename.replace(/\.[^/.]+$/, "") + ".png";
      }
  }

  // 3. Draw Text
  const padding = 20; 
  tempCtx.font = "bold 24px Montserrat, sans-serif";
  tempCtx.textAlign = "left";
  tempCtx.textBaseline = "bottom";
  
  tempCtx.fillStyle = "rgba(0,0,0,0.8)";
  tempCtx.fillText(itemName, padding + 2, tempCanvas.height - padding + 2);
  
  tempCtx.fillStyle = "#ffffff";
  tempCtx.fillText(itemName, padding, tempCanvas.height - padding);

  // 4. Draw Watermark
  if (watermarkImg.complete && watermarkImg.naturalWidth > 0) {
      const wWidth = tempCanvas.width * 0.25; 
      const wHeight = (watermarkImg.height / watermarkImg.width) * wWidth;
      const wX = tempCanvas.width - wWidth - padding;
      const wY = tempCanvas.height - wHeight - padding;
      tempCtx.drawImage(watermarkImg, wX, wY, wWidth, wHeight);
  }
  
  const dataUrl = tempCanvas.toDataURL('image/png');
  
  // Store object with name for ZIP download
  autoSnapshots.push({ url: dataUrl, name: itemFilename });
  
  const flash = document.getElementById('flash-overlay');
  if(flash) {
    flash.classList.add('active');
    setTimeout(() => flash.classList.remove('active'), 100);
  }
  
  return { url: dataUrl, name: itemFilename }; 
}

function takeSnapshot() {
    const shotData = captureToGallery();
    openSinglePreview(shotData);
}

/* ---------- SINGLE PREVIEW ---------- */
function openSinglePreview(shotData) {
    currentPreviewData = shotData; 
    
    const modal = document.getElementById('preview-modal');
    const img = document.getElementById('preview-image');
    
    img.src = shotData.url;
    modal.style.display = 'flex';
}

function closePreview() {
    document.getElementById('preview-modal').style.display = 'none';
}

function downloadSingleSnapshot() {
    if(currentPreviewData && currentPreviewData.url) {
        saveAs(currentPreviewData.url, currentPreviewData.name);
    }
}

async function shareSingleSnapshot() {
    if(!currentPreviewData.url) return;
    
    const response = await fetch(currentPreviewData.url);
    const blob = await response.blob();
    
    const file = new File([blob], currentPreviewData.name, { type: "image/png" });
    
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'My Aurum Atelier Look',
                text: 'Check out this jewelry I tried on virtually!',
                files: [file]
            });
        } catch (err) {
            console.warn("Share failed:", err);
        }
    } else {
        alert("Sharing not supported. Please Download.");
    }
}

/* ---------- GALLERY & LIGHTBOX ---------- */
function showGallery() {
  const modal = document.getElementById('gallery-modal');
  const grid = document.getElementById('gallery-grid');
  if(!modal || !grid) return;

  grid.innerHTML = '';
  
  // Loop through objects now
  autoSnapshots.forEach((item, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = "gallery-item-wrapper";
    
    const img = document.createElement('img');
    img.src = item.url; // Access .url
    img.className = "gallery-thumb";
    
    img.onclick = () => openLightbox(index);
    
    wrapper.appendChild(img);
    grid.appendChild(wrapper);
  });
  
  modal.style.display = 'flex';
}

function openLightbox(selectedIndex) {
    const lightbox = document.getElementById('lightbox-overlay');
    const lightboxImg = document.getElementById('lightbox-image');
    const strip = document.getElementById('lightbox-thumbs');
    
    lightboxImg.src = autoSnapshots[selectedIndex].url; // Access .url
    
    strip.innerHTML = '';
    
    autoSnapshots.forEach((item, idx) => {
        const thumb = document.createElement('img');
        thumb.src = item.url; // Access .url
        thumb.className = "strip-thumb";
        if(idx === selectedIndex) thumb.classList.add('active');
        
        thumb.onclick = () => {
            lightboxImg.src = item.url;
            document.querySelectorAll('.strip-thumb').forEach(t => t.classList.remove('active'));
            thumb.classList.add('active');
        };
        
        strip.appendChild(thumb);
    });

    lightbox.style.display = 'flex';
}

function closeLightbox() {
    document.getElementById('lightbox-overlay').style.display = 'none';
}

function closeGallery() {
  document.getElementById('gallery-modal').style.display = 'none';
}

/* ---------- ZIP DOWNLOAD (UPDATED for ACTUAL NAMES) ---------- */
function downloadAllAsZip() {
    if (autoSnapshots.length === 0) {
        alert("No images to download!");
        return;
    }

    const overlay = document.getElementById('process-overlay');
    const spinner = document.getElementById('process-spinner');
    const success = document.getElementById('process-success');
    const text = document.getElementById('process-text');

    overlay.style.display = 'flex';
    spinner.style.display = 'block';
    success.style.display = 'none';
    text.innerText = "Packaging Collection...";

    const zip = new JSZip();
    const folder = zip.folder("Aurum_Collection");

    autoSnapshots.forEach((item, index) => {
        const base64Data = item.url.replace(/^data:image\/(png|jpg);base64,/, "");
        // Use the stored actual filename
        folder.file(item.name, base64Data, {base64: true});
    });

    zip.generateAsync({type:"blob"})
    .then(function(content) {
        saveAs(content, "Aurum_Collection.zip");

        spinner.style.display = 'none';
        success.style.display = 'block';
        text.innerText = "Download Started!";

        setTimeout(() => {
            overlay.style.display = 'none';
        }, 2000);
    });
}

/* ---------- INITIALIZATION ---------- */
window.toggleCategory = toggleCategory;
window.selectJewelryType = selectJewelryType;
window.toggleTryAll = toggleTryAll;
window.closeGallery = closeGallery;
window.closeLightbox = closeLightbox;
window.takeSnapshot = takeSnapshot;
window.downloadAllAsZip = downloadAllAsZip;
window.closePreview = closePreview;
window.downloadSingleSnapshot = downloadSingleSnapshot;
window.shareSingleSnapshot = shareSingleSnapshot;

/* ===========================
   DISABLE RIGHT CLICK & DEV TOOLS
   ============================ */
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.onkeydown = function(e) {
  if (e.keyCode === 123) return false; 
  if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67 || e.keyCode === 75)) return false;
  if (e.ctrlKey && e.keyCode === 85) return false; 
};