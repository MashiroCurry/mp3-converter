const dropZone = document.getElementById('dropZone');
const dropContent = document.getElementById('dropContent');
const fileInput = document.getElementById('fileInput');
const selectBtn = document.getElementById('selectBtn');
const fileInfo = document.getElementById('fileInfo');
const fileCount = document.getElementById('fileCount');
const fileList = document.getElementById('fileList');
const clearAllBtn = document.getElementById('clearAllBtn');
const convertBtn = document.getElementById('convertBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const fileProgressList = document.getElementById('fileProgressList');
const resultsList = document.getElementById('resultsList');

let selectedFiles = [];
let converting = false;

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- File list management ---

function addFiles(newFiles) {
  let skipped = false;
  for (const f of newFiles) {
    const dup = selectedFiles.some(existing =>
      existing.name === f.name && existing.size === f.size && existing.lastModified === f.lastModified
    );
    if (dup) {
      skipped = true;
      continue;
    }
    selectedFiles.push(f);
  }
  renderFileList();
  hideResults();
  if (skipped) {
    progressText.textContent = '已跳过重复文件';
    progressContainer.style.display = 'block';
    setTimeout(() => { progressContainer.style.display = 'none'; }, 2000);
  }
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  if (selectedFiles.length === 0) {
    fileInput.value = '';
  }
  renderFileList();
  hideResults();
}

function clearFiles() {
  selectedFiles = [];
  fileInput.value = '';
  renderFileList();
  hideResults();
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    fileInfo.style.display = 'none';
    dropContent.style.display = '';
    convertBtn.disabled = true;
    return;
  }
  dropContent.style.display = 'none';
  fileInfo.style.display = 'block';
  fileCount.textContent = selectedFiles.length + ' 个文件';
  convertBtn.disabled = false;

  fileList.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const row = document.createElement('div');
    row.className = 'file-list-item';
    row.innerHTML =
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="file-list-name">${escapeHtml(file.name)}</span>
      <span class="file-list-size">${formatSize(file.size)}</span>
      <button type="button" class="btn-list-remove" data-index="${i}" title="移除">&times;</button>`;
    fileList.appendChild(row);
  });

  fileList.querySelectorAll('.btn-list-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(parseInt(btn.dataset.index));
    });
  });
}

// --- UI helpers ---

function hideResults() {
  resultsList.style.display = 'none';
  resultsList.innerHTML = '';
}

function setProgress(percent, text) {
  progressFill.style.width = percent + '%';
  progressText.textContent = text || Math.round(percent) + '%';
}

function resetUI() {
  convertBtn.disabled = true;
  progressContainer.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备中...';
  fileProgressList.style.display = 'none';
  fileProgressList.innerHTML = '';
  hideResults();
}

// --- File selection ---

selectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
dropZone.addEventListener('click', () => fileInput.click());

clearAllBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearFiles();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    addFiles(Array.from(fileInput.files));
  }
});

// --- Drag and drop ---

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files).filter(f =>
    ['.flac', '.wav', '.mp3'].some(ext => f.name.toLowerCase().endsWith(ext))
  );
  if (files.length > 0) {
    addFiles(files);
  } else {
    showError('仅支持 .flac .wav .mp3 文件');
  }
});

// --- Format selector ---

const formatOptions = document.querySelectorAll('.format-option');
const bitrateSelector = document.getElementById('bitrateSelector');

function toggleBitrateVisibility() {
  const checked = document.querySelector('input[name="targetFormat"]:checked');
  bitrateSelector.style.display = (checked && checked.value === 'mp3') ? 'block' : 'none';
}

formatOptions.forEach(opt => {
  const radio = opt.querySelector('input[type="radio"]');
  if (radio) {
    if (radio.checked) opt.classList.add('active');
    radio.addEventListener('change', () => {
      formatOptions.forEach(o => o.classList.remove('active'));
      if (radio.checked) opt.classList.add('active');
      toggleBitrateVisibility();
    });
  }
});

// Initial state: MP3 is default checked, so show bitrate
toggleBitrateVisibility();

// Bitrate selector highlight
const bitrateOptions = document.querySelectorAll('.bitrate-option');
bitrateOptions.forEach(opt => {
  const radio = opt.querySelector('input[type="radio"]');
  if (radio) {
    if (radio.checked) opt.classList.add('active');
    radio.addEventListener('change', () => {
      bitrateOptions.forEach(o => o.classList.remove('active'));
      if (radio.checked) opt.classList.add('active');
    });
  }
});

// --- Convert ---

convertBtn.addEventListener('click', () => {
  if (selectedFiles.length === 0 || converting) return;
  converting = true;
  convertBtn.disabled = true;

  resetUI();

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('files', f));
  const targetFormatEl = document.querySelector('input[name="targetFormat"]:checked');
  const currentTargetFormat = targetFormatEl ? targetFormatEl.value : 'mp3';
  formData.append('targetFormat', currentTargetFormat);

  const bitrateEl = document.querySelector('input[name="bitrate"]:checked');
  if (bitrateEl && currentTargetFormat === 'mp3') {
    formData.append('bitrate', bitrateEl.value);
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/convert');
  xhr.timeout = 15 * 60 * 1000; // 15 min for large uploads

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = (e.loaded / e.total) * 50;
      setProgress(pct, '上传中 ' + Math.round(pct * 2) + '%');
    }
  };

  xhr.onload = () => {
    try {
      const result = JSON.parse(xhr.responseText);
      if (xhr.status >= 400 || result.error) {
        showError(result.error || '上传失败');
        converting = false;
        convertBtn.disabled = false;
        return;
      }
      setProgress(50, '开始转换...');
      listenBatchProgress(result.taskIds, currentTargetFormat, result.queueSize || 0);
    } catch (_) {
      showError('服务器返回异常');
      converting = false;
      convertBtn.disabled = false;
    }
  };

  xhr.onerror = () => {
    showError('网络错误，请检查连接后重试');
    converting = false;
    convertBtn.disabled = false;
  };

  xhr.ontimeout = () => {
    xhr.abort();
    showError('上传超时，请检查网络后重试');
    converting = false;
    convertBtn.disabled = false;
  };

  xhr.send(formData);
});

// --- Batch SSE progress ---

function listenBatchProgress(taskIds, targetFormat, initialQueueSize) {
  const fmtLabel = (targetFormat || 'mp3').toUpperCase();
  fileProgressList.style.display = 'block';
  fileProgressList.innerHTML = '';

  const itemMap = {};       // taskId → DOM elements
  const receivedClosed = new Set();
  let queueSize = initialQueueSize || 0;

  for (let i = 0; i < taskIds.length; i++) {
    const item = document.createElement('div');
    item.className = 'file-progress-item';
    item.innerHTML =
      `<span class="fpi-name">${escapeHtml(selectedFiles[i].name)}</span>
      <div class="fpi-bar"><div class="fpi-fill"></div></div>
      <span class="fpi-pct">0%</span>
      <button type="button" class="fpi-cancel" data-taskid="${taskIds[i]}" title="取消转换">取消</button>`;
    fileProgressList.appendChild(item);
    itemMap[taskIds[i]] = {
      el: item,
      fill: item.querySelector('.fpi-fill'),
      pct: item.querySelector('.fpi-pct'),
      nameEl: item.querySelector('.fpi-name'),
      cancelBtn: item.querySelector('.fpi-cancel'),
    };

    // Show queue position if this task is waiting
    if (queueSize > 0) {
      const pos = queueSize >= taskIds.length ? queueSize - taskIds.length + i + 1 : i + 1;
      itemMap[taskIds[i]].pct.textContent = '排队';
    }
  }

  // Attach cancel handlers
  document.querySelectorAll('.fpi-cancel').forEach(btn => {
    btn.addEventListener('click', function () {
      const taskId = this.dataset.taskid;
      if (!taskId) return;
      this.disabled = true;
      this.textContent = '...';

      fetch('/api/convert/' + taskId, { method: 'DELETE' })
        .then(r => r.json())
        .then(data => {
          if (!data.success) console.warn('Cancel failed:', data.error);
        })
        .catch(err => console.warn('Cancel error:', err));
    });
  });

  const es = new EventSource('/api/batch-progress?ids=' + encodeURIComponent(taskIds.join(',')));

  es.addEventListener('progress', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    const item = itemMap[data.taskId];
    if (!item) return;
    const pct = Math.round(data.percent);
    item.fill.style.width = pct + '%';
    item.pct.textContent = pct + '%';
    // Hide cancel button once progress starts
    if (pct > 0 && item.cancelBtn) {
      item.cancelBtn.style.display = 'none';
    }
  });

  es.addEventListener('complete', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    if (receivedClosed.has(data.taskId)) return;
    receivedClosed.add(data.taskId);

    const item = itemMap[data.taskId];
    if (item) {
      item.fill.style.width = '100%';
      item.pct.textContent = '100%';
      item.el.classList.add('done');
      if (item.cancelBtn) item.cancelBtn.style.display = 'none';
    }

    const resultItem = document.createElement('div');
    resultItem.className = 'result-item success';
    resultItem.innerHTML =
      `<span>${escapeHtml(item ? item.nameEl.textContent : data.taskId)}</span>
      <a href="${data.downloadUrl}" class="btn-download-sm">下载 ${fmtLabel}</a>`;
    resultsList.appendChild(resultItem);
    resultsList.style.display = 'block';

    maybeDone();
  });

  es.addEventListener('task-error', (e) => {
    let msg = '转换失败';
    let taskId = null;
    try {
      const data = JSON.parse(e.data);
      msg = data.message || msg;
      taskId = data.taskId;
    } catch (_) {}

    if (taskId && receivedClosed.has(taskId)) return;
    if (taskId) receivedClosed.add(taskId);

    if (taskId) {
      const item = itemMap[taskId];
      if (item) {
        if (msg === '已取消') {
          item.el.classList.add('cancelled');
          item.pct.textContent = '已取消';
        } else {
          item.el.classList.add('error');
          item.fill.style.width = '0%';
          item.pct.textContent = '失败';
        }
        if (item.cancelBtn) item.cancelBtn.style.display = 'none';
      }

      const resultItem = document.createElement('div');
      resultItem.className = 'result-item error';
      resultItem.innerHTML =
        `<span>${escapeHtml(item ? item.nameEl.textContent : taskId)}</span>
        <span>${escapeHtml(msg)}</span>`;
      resultsList.appendChild(resultItem);
      resultsList.style.display = 'block';

      maybeDone();
    }
  });

  // Native EventSource — fires on connection drop AND on clean server close (res.end()).
  // Suppress if all tasks already done; otherwise count real failures.
  let connFailures = 0;
  es.onerror = () => {
    if (receivedClosed.size >= taskIds.length) {
      es.close();
      return;
    }
    connFailures++;
    if (connFailures >= 5) {
      es.close();
      showError('SSE 连接断开，请刷新页面重试');
      converting = false;
      convertBtn.disabled = false;
    }
  };

  function maybeDone() {
    if (receivedClosed.size >= taskIds.length) {
      es.close();
      progressContainer.style.display = 'none';
      fileProgressList.style.display = 'none';
      converting = false;
      convertBtn.disabled = false;

      const hasAnySuccess = resultsList.querySelector('.result-item.success');
      showDonateCta(!!hasAnySuccess);
    }
  }
}

function showError(msg) {
  progressContainer.style.display = 'none';
  fileProgressList.style.display = 'none';
  fileProgressList.innerHTML = '';
  resultsList.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'result-item error';
  item.textContent = msg;
  resultsList.appendChild(item);
  resultsList.style.display = 'block';
}

// ========== Donate ==========

const donateFloatBtn = document.getElementById('donateFloatBtn');
const donateOverlay = document.getElementById('donateOverlay');
const donateCard = document.getElementById('donateCard');
const donateClose = document.getElementById('donateClose');
const donatePaidBtn = document.getElementById('donatePaidBtn');
const donateCta = document.getElementById('donateCta');
const mainContent = document.getElementById('mainContent');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toastText');
const qrImage = document.getElementById('qrImage');
const qrLoading = document.getElementById('qrLoading');

// QR image load / error
qrImage.addEventListener('load', () => qrImage.classList.add('complete'));
qrImage.addEventListener('error', () => {
  qrLoading.textContent = '二维码加载失败，请稍后重试';
});

// Focus management
let lastFocusedEl = null;

function openDonate() {
  lastFocusedEl = document.activeElement;
  donatePaidBtn.disabled = false;
  donateOverlay.style.display = 'flex';
  donateClose.focus();
  mainContent.setAttribute('aria-hidden', 'true');
  mainContent.setAttribute('inert', '');
  document.body.style.overflow = 'hidden';
  trackEvent('donate_view');
}

function closeDonate() {
  donateOverlay.style.display = 'none';
  mainContent.removeAttribute('aria-hidden');
  mainContent.removeAttribute('inert');
  document.body.style.overflow = '';
  if (lastFocusedEl && document.contains(lastFocusedEl)) {
    lastFocusedEl.focus();
  }
}

// Focus trap: Tab / Shift+Tab cycles between donateClose ↔ donatePaidBtn
donateCard.addEventListener('keydown', function (e) {
  if (e.key !== 'Tab') return;
  var focusable = [donateClose, donatePaidBtn];
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { last.focus(); e.preventDefault(); }
  } else {
    if (document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
});

// Event bindings
donateFloatBtn.addEventListener('click', function () {
  openDonate();
  trackEvent('donate_view');
});

donateClose.addEventListener('click', closeDonate);

donateOverlay.addEventListener('click', function (e) {
  if (e.target === donateOverlay) closeDonate();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && donateOverlay.style.display === 'flex') {
    closeDonate();
  }
});

donatePaidBtn.addEventListener('click', function () {
  if (donatePaidBtn.disabled) return;
  donatePaidBtn.disabled = true;
  closeDonate();
  showToast('感谢你的支持！');
  localStorage.setItem('donated', Date.now());
  updateCtaAsThanked();
  trackEvent('donate_confirm');
});

// Toast
function showToast(msg) {
  toastText.textContent = msg;
  toast.style.display = 'flex';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () {
    toast.style.opacity = '0';
    setTimeout(function () { toast.style.display = 'none'; }, 300);
  }, 3000);
}

// Returning donor
if (localStorage.getItem('donated') && !sessionStorage.getItem('thanked_shown')) {
  sessionStorage.setItem('thanked_shown', '1');
  setTimeout(function () { showToast('再次感谢你的支持！'); }, 1500);
}

// CTA dynamic text
function showDonateCta(hasAnySuccess) {
  if (!hasAnySuccess) return;
  donateCta.innerHTML = '<p>如果帮到了你，可以请开发者喝杯咖啡 ☕</p><button class="btn-donate-inline" id="donateCtaBtn">支持开发</button>';
  donateCta.style.display = 'block';
  var ctaBtn = document.getElementById('donateCtaBtn');
  if (ctaBtn) {
    ctaBtn.addEventListener('click', function () {
      openDonate();
      trackEvent('donate_view');
    });
  }
}

function updateCtaAsThanked() {
  donateCta.innerHTML = '<p>感谢你的咖啡 ☕ 喜欢的话欢迎分享给更多人～</p>';
  donateCta.style.display = 'block';
}

// Analytics
function trackEvent(name, data) {
  if (typeof gtag !== 'undefined') gtag('event', name, data);
  if (typeof _hmt !== 'undefined') _hmt.push(['_trackEvent', '打赏', name, '']);
  if (typeof plausible !== 'undefined') plausible(name, { props: data });
}
