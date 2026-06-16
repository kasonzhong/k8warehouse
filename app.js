(() => {
  'use strict';

  const STORAGE_KEY = 'k8-return-orders-v3';
  const LEGACY_BATCH_KEY = 'k8-return-batches-v2';
  const OLD_STORAGE_KEY = 'k8-return-orders-v1';
  const DB_NAME = 'k8-return-photos';
  const DB_VERSION = 1;
  const PHOTO_STORE = 'photos';
  const MIN_PHOTOS = 2;
  const CLOUD_TABLE = 'return_batches';
  const DEFAULT_PHOTO_BUCKET = 'return-photos';
  const CLOUD_CACHE_PREFIX = 'k8-cloud-cache-v8-';
  const LOCAL_IMPORT_MARK_PREFIX = 'k8-local-import-v8-';

  const els = {};
  let batches = [];
  let activeBatchId = null;
  let activeItemIndex = 0;
  let viewMode = 'process';
  let cameraStream = null;
  let cameraDevices = [];
  let dbPromise = null;
  let wakeLock = null;
  let nativeCameraPending = false;
  let nativeCameraRestartTimer = null;
  let supabaseClient = null;
  let currentUser = null;
  let realtimeChannel = null;
  let cloudSyncTimer = null;
  let cloudSyncRunning = false;
  let cloudKnownIds = new Set();
  let appStartedForUserId = null;

  document.addEventListener('DOMContentLoaded', () => {
    init().catch(error => {
      console.error(error);
      showSetupError(error.message || '系统初始化失败');
    });
  });

  async function init() {
    cacheElements();
    bindEvents();
    setDefaultDate();
    registerServiceWorker();
    await initialiseCloud();
  }

  function cacheElements() {
    [
      'setupScreen', 'authScreen', 'appShell',
      'loginTabBtn', 'registerTabBtn', 'loginForm', 'registerForm',
      'loginSubmitBtn', 'registerSubmitBtn', 'forgotPasswordBtn', 'authMessage',
      'passwordDialog', 'passwordForm', 'passwordMessage',
      'logoutBtn', 'refreshCloudBtn', 'cloudStatus', 'syncDot',
      'userDisplayName', 'userEmail', 'userAvatar',
      'statPending', 'statActive', 'statReview', 'statDone',
      'searchInput', 'statusFilter', 'exportBtn', 'newSingleBtn', 'newBatchBtn',
      'emptyNewBtn', 'floatingAddBtn', 'batchList', 'emptyState',
      'mobileCreateDialog', 'mobileNewSingleBtn', 'mobileNewBatchBtn',
      'newSingleDialog', 'newSingleForm', 'singleDateInput',
      'newBatchDialog', 'newBatchForm', 'batchDateInput',
      'batchDialog', 'closeBatchBtn', 'batchEyebrow', 'batchTitle',
      'batchMeta', 'reviewBatchBtn', 'deleteBatchBtn',
      'batchProgressBar', 'batchProgressText', 'addItemsBtn',
      'itemList', 'batchMain', 'photoPreviewDialog', 'photoPreviewImage',
      'closePhotoPreviewBtn', 'labelDialog', 'labelSku',
      'labelItemId', 'labelTracking', 'labelDate', 'printLabelBtn',
      'batchCardTemplate'
    ].forEach(id => els[id] = document.getElementById(id));
  }

  function bindEvents() {
    els.loginTabBtn.addEventListener('click', () => setAuthMode('login'));
    els.registerTabBtn.addEventListener('click', () => setAuthMode('register'));
    els.loginForm.addEventListener('submit', signInUser);
    els.registerForm.addEventListener('submit', registerUser);
    els.forgotPasswordBtn.addEventListener('click', sendPasswordReset);
    els.passwordForm.addEventListener('submit', updateRecoveredPassword);
    els.logoutBtn.addEventListener('click', signOutUser);
    els.refreshCloudBtn.addEventListener('click', async () => {
      await flushCloudSync();
      await loadCloudBatches({ preserveOpenBatch: true });
    });

    els.newSingleBtn.addEventListener('click', openNewSingleDialog);
    els.newBatchBtn.addEventListener('click', openNewBatchDialog);
    els.emptyNewBtn.addEventListener('click', openNewSingleDialog);
    els.floatingAddBtn.addEventListener('click', () => {
      if (isMobileLayout()) {
        els.mobileCreateDialog.showModal();
      } else {
        openNewSingleDialog();
      }
    });
    els.mobileNewSingleBtn.addEventListener('click', () => {
      els.mobileCreateDialog.close();
      openNewSingleDialog();
    });
    els.mobileNewBatchBtn.addEventListener('click', () => {
      els.mobileCreateDialog.close();
      openNewBatchDialog();
    });

    document.querySelectorAll('[data-close]').forEach(button => {
      button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
    });

    els.newSingleForm.addEventListener('submit', createSingleOrder);
    els.newBatchForm.addEventListener('submit', createBatch);
    els.searchInput.addEventListener('input', renderBatches);
    els.statusFilter.addEventListener('change', renderBatches);
    els.exportBtn.addEventListener('click', exportCSV);
    els.closeBatchBtn.addEventListener('click', closeBatch);
    els.deleteBatchBtn.addEventListener('click', deleteActiveBatch);
    els.addItemsBtn.addEventListener('click', addItemsToActiveBatch);
    els.printLabelBtn.addEventListener('click', () => window.print());
    els.closePhotoPreviewBtn.addEventListener('click', closePhotoPreview);
    els.photoPreviewDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closePhotoPreview();
    });

    els.batchDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeBatch();
    });

    document.addEventListener('keydown', event => {
      if (!els.batchDialog.open || viewMode !== 'process') return;
      const target = event.target;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (event.code === 'Space' && !typing && !event.repeat) {
        const button = document.getElementById('captureBtn');
        if (button && !button.disabled) {
          event.preventDefault();
          capturePhoto();
        }
      }
    });

    window.addEventListener('beforeunload', () => saveLocalCloudCache());
    window.addEventListener('online', () => {
      setCloudStatus('syncing', '网络恢复，正在同步…');
      flushCloudSync();
    });
    window.addEventListener('offline', () => {
      setCloudStatus('offline', '离线：修改将在联网后同步');
    });
  }

  function openNewSingleDialog() {
    setDefaultDate();
    els.newSingleDialog.showModal();
    setTimeout(() => els.newSingleForm.elements.client.focus(), 50);
  }

  function openNewBatchDialog() {
    setDefaultDate();
    els.newBatchDialog.showModal();
    setTimeout(() => els.newBatchForm.elements.client.focus(), 50);
  }

  function setDefaultDate() {
    const today = toDateInput(new Date());
    if (!els.singleDateInput.value) els.singleDateInput.value = today;
    if (!els.batchDateInput.value) els.batchDateInput.value = today;
  }

  function loadBatches() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) {
        batches = saved;
        normaliseBatches();
        return;
      }
    } catch {
      // Continue with migration.
    }

    try {
      const previous = JSON.parse(localStorage.getItem(LEGACY_BATCH_KEY) || '[]');
      if (Array.isArray(previous) && previous.length) {
        batches = previous;
        normaliseBatches();
        saveBatches();
        return;
      }
    } catch {
      // Continue with older single-order migration.
    }

    batches = migrateLegacyOrders();
    saveBatches();
  }

  function normaliseBatches() {
    batches.forEach(batch => {
      batch.items = Array.isArray(batch.items) ? batch.items : [];
      batch.orderType = batch.orderType || 'batch';
      batch.name = String(batch.name || `${batch.client || '客户'}（${formatDateOnly(batch.date || toDateInput(new Date()))}）${batch.orderType === 'single' ? '退货单' : '批量退货单'}`)
        .replaceAll('退货处理文件夹', '退货单')
        .replaceAll('退货文件夹', '退货单');
      batch.items.forEach((item, index) => {
        item.sequence = item.sequence || index + 1;
        item.photos = Array.isArray(item.photos) ? item.photos : [];
        item.inspection = item.inspection || blankInspection();
        item.tracking = item.tracking || '';
        item.sku = item.sku || '';
        item.notes = item.notes || '';
      });
    });
  }

  function migrateLegacyOrders() {
    let oldOrders = [];
    try {
      const saved = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) || '[]');
      oldOrders = Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
    if (!oldOrders.length) return [];

    const groups = new Map();

    oldOrders.forEach((order, index) => {
      const date = toDateInput(order.createdAt ? new Date(order.createdAt) : new Date());
      const key = `${order.client || '历史客户'}__${date}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: makeBatchId(),
          orderType: 'batch',
          client: order.client || '历史客户',
          date,
          name: `${order.client || '历史客户'}（${formatDateOnly(date)}）批量退货单`,
          inspectionRequired: !!order.steps?.inspection?.done,
          notes: '由旧版单件退货记录自动迁移',
          createdAt: order.createdAt || new Date().toISOString(),
          updatedAt: order.updatedAt || new Date().toISOString(),
          completedAt: null,
          items: []
        });
      }

      const photos = [
        ...(order.steps?.labelPhoto?.photoIds || []),
        ...(order.steps?.itemPhoto?.photoIds || []),
        ...(order.steps?.extraPhoto?.photoIds || [])
      ];

      groups.get(key).items.push({
        id: order.id || makeItemId(),
        sequence: groups.get(key).items.length + 1,
        tracking: order.tracking || '',
        sku: order.confirmedSku || order.expectedSku || '',
        notes: order.notes || '',
        photos,
        inspection: order.inspection || blankInspection(),
        processedAt: order.steps?.completed?.completedAt || null
      });
    });

    const migrated = [...groups.values()];
    migrated.forEach(batch => {
      const allDone = batch.items.length && batch.items.every(item => isItemReady(item, batch));
      if (allDone && batch.items.every(item => item.processedAt)) {
        batch.completedAt = latestDate(batch.items.map(item => item.processedAt));
      }
    });
    return migrated;
  }

  function saveBatches() {
    saveLocalCloudCache();
    if (!currentUser || !supabaseClient) return;

    setCloudStatus(
      navigator.onLine ? 'syncing' : 'offline',
      navigator.onLine ? '有修改，正在同步…' : '离线：修改将在联网后同步'
    );

    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
      flushCloudSync();
    }, 650);
  }


  function createSingleOrder(event) {
    event.preventDefault();
    const form = new FormData(els.newSingleForm);
    const client = String(form.get('client') || '').trim();
    const date = String(form.get('orderDate') || '').trim();
    const now = new Date().toISOString();
    const item = createBlankItem(
      1,
      String(form.get('tracking') || '').trim(),
      String(form.get('sku') || '').trim()
    );
    item.notes = String(form.get('notes') || '').trim();

    const order = {
      id: makeBatchId(),
      orderType: 'single',
      client,
      date,
      name: `${client}（${formatDateOnly(date)}）退货单`,
      inspectionRequired: form.get('inspectionRequired') === 'on',
      notes: String(form.get('notes') || '').trim(),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      items: [item]
    };

    batches.unshift(order);
    saveBatches();
    els.newSingleForm.reset();
    setDefaultDate();
    els.newSingleDialog.close();
    renderBatches();
    openBatch(order.id);
  }

  function createBatch(event) {
    event.preventDefault();
    const form = new FormData(els.newBatchForm);
    const client = String(form.get('client') || '').trim();
    const date = String(form.get('batchDate') || '').trim();
    const prefilled = parsePrefill(String(form.get('prefill') || ''));
    const total = Math.max(1, prefilled.length);
    const now = new Date().toISOString();
    const batch = {
      id: makeBatchId(),
      orderType: 'batch',
      client,
      date,
      name: `${client}（${formatDateOnly(date)}）批量退货单`,
      inspectionRequired: form.get('inspectionRequired') === 'on',
      notes: String(form.get('notes') || '').trim(),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      items: Array.from({ length: total }, (_, index) => {
        const preset = prefilled[index] || {};
        return createBlankItem(index + 1, preset.tracking || '', preset.sku || '');
      })
    };

    batches.unshift(batch);
    saveBatches();
    els.newBatchForm.reset();
    setDefaultDate();
    els.newBatchDialog.close();
    renderBatches();
    openBatch(batch.id);
  }

  function parsePrefill(text) {
    return text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\t|,|\|/).map(part => part.trim());
        return { tracking: parts[0] || '', sku: parts[1] || '' };
      });
  }

  function createBlankItem(sequence, tracking = '', sku = '') {
    return {
      id: makeItemId(),
      sequence,
      tracking,
      sku,
      notes: '',
      photos: [],
      inspection: blankInspection(),
      processedAt: null
    };
  }

  function blankInspection() {
    return {
      condition: '',
      result: '',
      accessoriesComplete: false,
      packagingDamaged: false,
      itemDamaged: false,
      notes: ''
    };
  }

  function renderBatches() {
    const query = els.searchInput.value.trim().toLowerCase();
    const filter = els.statusFilter.value;

    const filtered = batches.filter(batch => {
      const itemText = batch.items.map(item =>
        `${item.tracking} ${item.sku} ${item.notes}`
      ).join(' ');
      const haystack = `${batch.name} ${batch.client} ${batch.notes} ${itemText}`.toLowerCase();
      return (!query || haystack.includes(query)) &&
        (filter === 'all' || getBatchStatus(batch).key === filter);
    });

    els.batchList.innerHTML = '';

    filtered.forEach(batch => {
      const fragment = els.batchCardTemplate.content.cloneNode(true);
      const card = fragment.querySelector('.batch-card');
      const status = getBatchStatus(batch);
      const ready = batch.items.filter(item => isItemReady(item, batch)).length;
      const progress = batch.items.length ? Math.round(ready / batch.items.length * 100) : 0;

      fragment.querySelector('.status-pill').textContent = status.label;
      fragment.querySelector('.status-pill').classList.add(status.key);
      fragment.querySelector('.batch-id').textContent = batch.id;
      fragment.querySelector('.batch-name').textContent = batch.name;
      fragment.querySelector('.batch-note').textContent = batch.notes || '无退货单备注';
      fragment.querySelector('.batch-count').textContent = `${ready}/${batch.items.length} 件已处理`;
      fragment.querySelector('.batch-inspection').textContent =
        `${batch.orderType === 'single' ? '单件退货单' : '批量退货单'} · ${batch.inspectionRequired ? '包含分拣质检' : '快速处理模式'}`;
      fragment.querySelector('.batch-time').textContent = batch.completedAt
        ? `完成：${formatDateTime(batch.completedAt)}`
        : `创建：${formatDateTime(batch.createdAt)}`;
      fragment.querySelector('.mini-progress span').style.width = `${progress}%`;
      fragment.querySelector('.batch-step-label').textContent =
        batch.completedAt ? `已于 ${formatDateTime(batch.completedAt)} 确认完成`
        : status.key === 'review' ? '全部单件已处理，等待统一复核'
        : `剩余 ${batch.items.length - ready} 件`;
      fragment.querySelector('.open-batch-btn').textContent =
        batch.completedAt ? '查看记录'
        : status.key === 'review' ? '查看记录'
        : ready ? '继续处理' : '开始处理';

      card.addEventListener('click', event => {
        if (!event.target.closest('button')) openBatch(batch.id);
      });
      fragment.querySelector('.open-batch-btn').addEventListener('click', () => openBatch(batch.id));
      fragment.querySelector('.export-batch-btn').addEventListener('click', event => {
        event.stopPropagation();
        exportBatchExcel(batch.id, event.currentTarget);
      });
      els.batchList.appendChild(fragment);
    });

    const empty = batches.length === 0;
    els.emptyState.classList.toggle('hidden', !empty);
    els.batchList.classList.toggle('hidden', empty);
    updateStats();
  }

  function updateStats() {
    const counts = { pending: 0, active: 0, review: 0, done: 0 };
    batches.forEach(batch => counts[getBatchStatus(batch).key]++);
    els.statPending.textContent = counts.pending;
    els.statActive.textContent = counts.active;
    els.statReview.textContent = counts.review;
    els.statDone.textContent = counts.done;
  }

  function getBatchStatus(batch) {
    if (batch.completedAt) return { key: 'done', label: '已完成' };
    const ready = batch.items.filter(item => isItemReady(item, batch)).length;
    if (batch.items.length && ready === batch.items.length) {
      return { key: 'review', label: '待统一复核' };
    }
    const hasWork = batch.items.some(item =>
      item.photos.length || item.tracking || item.sku || item.notes ||
      Object.values(item.inspection || {}).some(Boolean)
    );
    return hasWork
      ? { key: 'active', label: '处理中' }
      : { key: 'pending', label: '待处理' };
  }

  function isItemReady(item, batch) {
    const photosReady = item.photos.length >= MIN_PHOTOS;
    const skuReady = !!item.sku.trim();
    const inspectionReady = !batch.inspectionRequired ||
      (!!item.inspection.condition && !!item.inspection.result);
    return photosReady && skuReady && inspectionReady;
  }

  function itemValidationText(item, batch) {
    const missing = [];
    if (item.photos.length < MIN_PHOTOS) missing.push(`至少 ${MIN_PHOTOS} 张照片`);
    if (!item.sku.trim()) missing.push('SKU');
    if (batch.inspectionRequired && !item.inspection.condition) missing.push('商品状态');
    if (batch.inspectionRequired && !item.inspection.result) missing.push('处理建议');
    return missing.length ? `待完成：${missing.join('、')}` : '本件资料已完整';
  }

  function openBatch(batchId) {
    activeBatchId = batchId;
    const batch = getActiveBatch();
    const firstIncomplete = batch.items.findIndex(item => !isItemReady(item, batch));
    activeItemIndex = firstIncomplete >= 0 ? firstIncomplete : 0;
    viewMode = batch.completedAt || firstIncomplete < 0 ? 'review' : 'process';
    els.batchDialog.showModal();
    document.body.classList.add('dialog-open');
    requestWakeLock();
    renderBatch();
  }

  function closeBatch() {
    persistActiveItemFields();
    stopCamera();
    releaseWakeLock();
    document.body.classList.remove('dialog-open');
    saveBatches();
    renderBatches();
    if (els.batchDialog.open) els.batchDialog.close();
    activeBatchId = null;
  }

  function getActiveBatch() {
    return batches.find(batch => batch.id === activeBatchId);
  }

  function getActiveItem() {
    return getActiveBatch()?.items[activeItemIndex];
  }

  function renderBatch() {
    const batch = getActiveBatch();
    if (!batch) return;

    const ready = batch.items.filter(item => isItemReady(item, batch)).length;
    const progress = batch.items.length ? Math.round(ready / batch.items.length * 100) : 0;

    els.batchEyebrow.textContent = batch.id;
    els.batchTitle.textContent = batch.name;
    els.batchMeta.textContent =
      `${batch.orderType === 'single' ? '单件退货单' : '批量退货单'} · ${batch.items.length} 件 · ${batch.inspectionRequired ? '需要分拣质检' : '快速处理模式'}${batch.notes ? ` · ${batch.notes}` : ''}`;
    els.addItemsBtn.classList.toggle('hidden', batch.orderType === 'single');
    els.batchProgressBar.style.width = `${progress}%`;
    els.batchProgressText.textContent =
      batch.completedAt
        ? `全部任务已于 ${formatDateTime(batch.completedAt)} 统一复核完成`
        : `${ready}/${batch.items.length} 件资料完整`;
    els.reviewBatchBtn.textContent = viewMode === 'review' ? '返回单件处理' : '统一复核';
    els.reviewBatchBtn.onclick = () => {
      if (viewMode === 'review') {
        viewMode = 'process';
        renderBatch();
      } else {
        enterReviewMode();
      }
    };

    els.batchMain.classList.toggle('review-mode', viewMode === 'review');
    els.batchMain.classList.toggle('process-mode', viewMode !== 'review');
    renderItemList();

    els.batchMain.classList.toggle('review-mode', viewMode === 'review');
    els.batchMain.classList.toggle('process-mode', viewMode === 'process');
    els.batchDialog.dataset.viewMode = viewMode;

    if (viewMode === 'review') {
      stopCamera();
      renderReview();
    } else {
      renderProcessor();
    }
  }

  function renderItemList() {
    const batch = getActiveBatch();
    els.itemList.innerHTML = '';

    batch.items.forEach((item, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'item-row-wrap';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `item-row ${index === activeItemIndex && viewMode === 'process' ? 'active' : ''}`;
      const ready = isItemReady(item, batch);
      const hasWork = item.photos.length || item.tracking || item.sku || item.notes;
      button.innerHTML = `
        <span class="item-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="item-info">
          <strong>${escapeHtml(item.sku || `退货 ${index + 1}`)}</strong>
          <small>${escapeHtml(item.tracking || (ready ? '资料完整' : '待录入'))}</small>
        </span>
        <span class="item-state ${ready ? 'ready' : hasWork ? 'active' : ''}"></span>
      `;
      button.addEventListener('click', () => {
        persistActiveItemFields();
        activeItemIndex = index;
        viewMode = 'process';
        if (batch.completedAt) batch.completedAt = null;
        renderBatch();
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'item-delete-btn';
      deleteButton.title = `删除退货 ${index + 1}`;
      deleteButton.setAttribute('aria-label', `删除退货 ${index + 1}`);
      deleteButton.textContent = '×';
      deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        deleteReturnItem(index);
      });

      wrapper.append(button, deleteButton);
      els.itemList.appendChild(wrapper);
    });
  }

  async function deleteReturnItem(index) {
    persistActiveItemFields();
    const batch = getActiveBatch();
    const item = batch?.items[index];
    if (!batch || !item) return;

    const label = item.sku || item.tracking || `退货 ${index + 1}`;
    const deletingLast = batch.items.length === 1;
    const message = deletingLast
      ? `这是退货单中的最后一项。删除“${label}”后，整张退货单也会被删除。确定继续吗？`
      : `确定删除“${label}”及其全部照片吗？`;
    if (!confirm(message)) return;

    for (const photoId of item.photos) {
      await deletePhoto(photoId);
    }

    if (deletingLast) {
      batches = batches.filter(candidate => candidate.id !== batch.id);
      saveLocalCloudCache();
      await deleteBatchFromCloud(batch.id);
      stopCamera();
      if (els.batchDialog.open) els.batchDialog.close();
      activeBatchId = null;
      renderBatches();
      showToast('退货单已删除');
      return;
    }

    batch.items.splice(index, 1);
    renumberItems(batch);
    batch.completedAt = null;
    batch.updatedAt = new Date().toISOString();

    if (activeItemIndex > index) activeItemIndex -= 1;
    if (activeItemIndex >= batch.items.length) activeItemIndex = batch.items.length - 1;

    saveBatches();
    renderBatch();
    renderBatches();
    showToast('该退货任务已删除');
  }

  function renderProcessor() {
    const batch = getActiveBatch();
    const item = getActiveItem();
    if (!item) return;

    els.batchMain.innerHTML = `
      <div class="processor">
        <section class="camera-column">
          <div class="camera-topline">
            <div>
              <h3>直接拍面单和货物</h3>
              <p class="camera-instruction">建议第 1 张拍完整面单，之后直接拆包拍商品和需要的补充细节。</p>
            </div>
            <div class="camera-controls">
              <select id="cameraSelect" aria-label="选择摄像头">
                <option value="">正在读取摄像头…</option>
              </select>
              <button id="refreshCameraBtn" class="small-btn" type="button">刷新</button>
            </div>
          </div>

          <div class="camera-stage">
            <video id="cameraVideo" autoplay playsinline muted></video>
            <div id="cameraPlaceholder" class="camera-placeholder">
              <strong>正在自动打开摄像头</strong>
              <span>首次使用请允许浏览器访问摄像头。</span>
            </div>
            <div class="camera-guide" aria-hidden="true"></div>
          </div>

          <canvas id="cameraCanvas" class="hidden"></canvas>

          <div class="camera-bottom">
            <p id="cameraStatus" class="camera-status">正在连接摄像头…</p>
            <label class="upload-button desktop-upload-button">
              上传本地图片
              <input id="photoUploadInput" type="file" accept="image/*" multiple />
            </label>
            <label class="mobile-native-camera-button">
              手机相机拍照
              <input id="nativeCameraInput" type="file" accept="image/*" capture="environment" />
            </label>
            <button id="captureBtn" class="capture-btn" type="button" disabled>
              <span class="capture-dot"></span>
              实时画面拍照
            </button>
            <div id="mobileRecentPhotos" class="mobile-recent-photos" aria-live="polite"></div>
          </div>
        </section>

        <section class="details-column">
          <div class="item-titlebar">
            <div>
              <h3>退货 ${item.sequence}</h3>
              <p>${escapeHtml(item.id)}</p>
            </div>
            <span class="photo-requirement">至少 2 张：面单＋货物</span>
          </div>

          <section class="detail-section">
            <h4>本件照片预览</h4>
            <div id="photoGallery" class="photo-gallery"></div>
          </section>

          <div class="stack">
            <label class="field">
              面单号 / Tracking Number（可选）
              <input id="trackingInput" value="${escapeHtml(item.tracking)}" placeholder="可扫描、粘贴或留空" autocomplete="off" />
            </label>

            <div class="inline-actions">
              <label class="field">
                录入 / 上传 SKU
                <input id="skuInput" value="${escapeHtml(item.sku)}" placeholder="请输入或扫描 SKU" autocomplete="off" />
              </label>
              <button id="printSkuBtn" class="secondary-btn" type="button">打印 SKU</button>
            </div>
          </div>

          ${batch.inspectionRequired ? renderInspectionFields(item) : ''}

          <label class="field" style="margin-top:14px;">
            本件备注（可选）
            <textarea id="itemNotesInput" rows="3" placeholder="记录需要客户注意的情况">${escapeHtml(item.notes)}</textarea>
          </label>

          <div class="processor-actions">
            <span id="validationText" class="validation-text">${escapeHtml(itemValidationText(item, batch))}</span>
            <div class="action-buttons">
              <button id="saveItemBtn" class="secondary-btn" type="button">保存本件</button>
              ${batch.orderType === 'batch'
                ? `<button id="finishBatchBtn" class="secondary-btn" type="button">结束本批并复核</button>`
                : ''}
              <button id="saveNextBtn" class="primary-btn" type="button">
                ${batch.orderType === 'batch' ? '保存并新建下一件' : '保存并进入复核'}
              </button>
            </div>
          </div>
        </section>
      </div>

      <nav class="mobile-workflow-nav" aria-label="手机快捷操作">
        <button id="mobileTasksBtn" type="button"><strong>☰</strong>任务</button>
        <button id="mobilePhotoBtn" type="button"><strong>📷</strong>拍照</button>
        <button id="mobileDetailsBtn" type="button"><strong>✎</strong>资料</button>
        <button id="mobileNextBtn" class="mobile-next-button" type="button"><strong>→</strong>下一步</button>
      </nav>
    `;

    bindProcessorEvents();
    renderActivePhotoGallery();
    initialiseCamera();
  }

  function renderInspectionFields(item) {
    const i = item.inspection;
    return `
      <section class="detail-section" style="margin-top:16px;">
        <h4>分拣质检</h4>
        <div class="inspection-grid">
          <label class="field">
            商品状态
            <select id="conditionInput">
              <option value="">请选择</option>
              ${option('全新', i.condition)}
              ${option('近新', i.condition)}
              ${option('有使用痕迹', i.condition)}
              ${option('损坏', i.condition)}
              ${option('无法判断', i.condition)}
            </select>
          </label>
          <label class="field">
            处理建议
            <select id="resultInput">
              <option value="">请选择</option>
              ${option('可二次销售', i.result)}
              ${option('需重新包装', i.result)}
              ${option('需客户确认', i.result)}
              ${option('不可销售', i.result)}
            </select>
          </label>
        </div>
        <div class="checklist">
          <label><input id="accessoriesInput" type="checkbox" ${i.accessoriesComplete ? 'checked' : ''}>配件齐全</label>
          <label><input id="packagingInput" type="checkbox" ${i.packagingDamaged ? 'checked' : ''}>原包装有破损</label>
          <label><input id="damageInput" type="checkbox" ${i.itemDamaged ? 'checked' : ''}>商品本体有破损</label>
        </div>
        <label class="field" style="margin-top:10px;">
          质检备注
          <textarea id="inspectionNotesInput" rows="3" placeholder="缺件、瑕疵、污渍或序列号">${escapeHtml(i.notes)}</textarea>
        </label>
      </section>
    `;
  }

  function option(value, selected) {
    return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`;
  }

  function bindProcessorEvents() {
    document.getElementById('trackingInput').addEventListener('input', updateValidationPreview);
    document.getElementById('skuInput').addEventListener('input', updateValidationPreview);
    document.getElementById('itemNotesInput').addEventListener('input', updateValidationPreview);

    ['conditionInput', 'resultInput', 'accessoriesInput', 'packagingInput', 'damageInput', 'inspectionNotesInput']
      .forEach(id => document.getElementById(id)?.addEventListener('change', updateValidationPreview));

    document.getElementById('saveItemBtn').addEventListener('click', () => {
      persistActiveItemFields();
      const batch = getActiveBatch();
      const item = getActiveItem();
      if (isItemReady(item, batch)) item.processedAt = item.processedAt || new Date().toISOString();
      saveBatches();
      renderItemList();
      updateValidationPreview();
      showToast('本件已保存');
    });

    document.getElementById('saveNextBtn').addEventListener('click', saveAndNext);
    document.getElementById('finishBatchBtn')?.addEventListener('click', finishBatchAndReview);
    document.getElementById('printSkuBtn').addEventListener('click', showSkuLabel);
    document.getElementById('photoUploadInput').addEventListener('change', uploadLocalPhotos);

    const nativeCameraInput = document.getElementById('nativeCameraInput');
    nativeCameraInput?.addEventListener('pointerdown', prepareNativeCamera, { passive: true });
    nativeCameraInput?.addEventListener('click', prepareNativeCamera, { passive: true });
    nativeCameraInput?.addEventListener('change', handleNativeCameraPhoto);

    document.getElementById('captureBtn').addEventListener('click', capturePhoto);
    document.getElementById('refreshCameraBtn').addEventListener('click', () => refreshCameraDevices(true));
    document.getElementById('cameraSelect').addEventListener('change', event => startCamera(event.target.value));

    document.getElementById('mobileTasksBtn')?.addEventListener('click', () => {
      document.querySelector('.item-sidebar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('mobilePhotoBtn')?.addEventListener('click', () => {
      document.querySelector('.camera-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('mobileDetailsBtn')?.addEventListener('click', () => {
      document.querySelector('.details-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => document.getElementById('skuInput')?.focus({ preventScroll: true }), 350);
    });
    document.getElementById('mobileNextBtn')?.addEventListener('click', () => {
      document.getElementById('saveNextBtn')?.click();
    });
  }

  function persistActiveItemFields() {
    if (!activeBatchId || viewMode !== 'process') return;
    const batch = getActiveBatch();
    const item = getActiveItem();
    if (!batch || !item || !document.getElementById('skuInput')) return;

    item.tracking = document.getElementById('trackingInput').value.trim();
    item.sku = document.getElementById('skuInput').value.trim();
    item.notes = document.getElementById('itemNotesInput').value.trim();

    if (batch.inspectionRequired) {
      item.inspection = {
        condition: document.getElementById('conditionInput')?.value || '',
        result: document.getElementById('resultInput')?.value || '',
        accessoriesComplete: !!document.getElementById('accessoriesInput')?.checked,
        packagingDamaged: !!document.getElementById('packagingInput')?.checked,
        itemDamaged: !!document.getElementById('damageInput')?.checked,
        notes: document.getElementById('inspectionNotesInput')?.value.trim() || ''
      };
    }

    batch.updatedAt = new Date().toISOString();
    if (batch.completedAt) batch.completedAt = null;
    saveBatches();
  }

  function updateValidationPreview() {
    persistActiveItemFields();
    const batch = getActiveBatch();
    const item = getActiveItem();
    const label = document.getElementById('validationText');
    if (label) label.textContent = itemValidationText(item, batch);
  }

  function saveAndNext() {
    persistActiveItemFields();
    const batch = getActiveBatch();
    const item = getActiveItem();

    if (!isItemReady(item, batch)) {
      showToast(itemValidationText(item, batch));
      return;
    }

    item.processedAt = item.processedAt || new Date().toISOString();
    batch.updatedAt = new Date().toISOString();

    const nextIncomplete = batch.items.findIndex((candidate, index) =>
      index > activeItemIndex && !isItemReady(candidate, batch)
    );

    if (nextIncomplete >= 0) {
      activeItemIndex = nextIncomplete;
      saveBatches();
      renderBatch();
      showToast('已保存，进入下一件');
      return;
    }

    const earlierIncomplete = batch.items.findIndex((candidate, index) =>
      index < activeItemIndex && !isItemReady(candidate, batch)
    );

    if (earlierIncomplete >= 0) {
      activeItemIndex = earlierIncomplete;
      saveBatches();
      renderBatch();
      showToast('已保存，返回尚未完成的退货任务');
      return;
    }

    if (batch.orderType === 'batch') {
      const nextItem = createBlankItem(batch.items.length + 1);
      batch.items.push(nextItem);
      activeItemIndex = batch.items.length - 1;
      saveBatches();
      renderBatch();
      showToast('已保存，已新建下一件退货任务');
      return;
    }

    saveBatches();
    viewMode = 'review';
    renderBatch();
    showToast('退货单已处理，请进行复核');
  }

  function finishBatchAndReview() {
    persistActiveItemFields();
    const batch = getActiveBatch();
    const item = getActiveItem();

    if (isItemUntouched(item) && batch.items.length > 1) {
      batch.items.splice(activeItemIndex, 1);
      renumberItems(batch);
      activeItemIndex = Math.max(0, batch.items.length - 1);
    } else if (!isItemReady(item, batch)) {
      showToast(itemValidationText(item, batch));
      return;
    } else {
      item.processedAt = item.processedAt || new Date().toISOString();
    }

    removeTrailingUntouchedItems(batch);
    batch.updatedAt = new Date().toISOString();
    saveBatches();
    viewMode = 'review';
    renderBatch();
    showToast('已结束本批，请进行统一复核');
  }

  function enterReviewMode() {
    persistActiveItemFields();
    const batch = getActiveBatch();
    removeTrailingUntouchedItems(batch);
    activeItemIndex = Math.min(activeItemIndex, Math.max(0, batch.items.length - 1));
    batch.updatedAt = new Date().toISOString();
    saveBatches();
    viewMode = 'review';
    renderBatch();
  }

  function removeTrailingUntouchedItems(batch) {
    while (batch.items.length > 1 && isItemUntouched(batch.items[batch.items.length - 1])) {
      batch.items.pop();
    }
    renumberItems(batch);
  }

  function renumberItems(batch) {
    batch.items.forEach((item, index) => {
      item.sequence = index + 1;
    });
  }

  function isItemUntouched(item) {
    const inspection = item.inspection || {};
    return !item.photos.length &&
      !item.tracking.trim() &&
      !item.sku.trim() &&
      !item.notes.trim() &&
      !inspection.condition &&
      !inspection.result &&
      !inspection.accessoriesComplete &&
      !inspection.packagingDamaged &&
      !inspection.itemDamaged &&
      !inspection.notes;
  }

  async function renderActivePhotoGallery() {
    const item = getActiveItem();
    const gallery = document.getElementById('photoGallery');
    if (!gallery || !item) return;

    gallery.innerHTML = '';
    if (!item.photos.length) {
      gallery.innerHTML = `<div class="photo-empty">摄像头已默认开启。先拍完整面单，再直接拆包拍货物。</div>`;
      await renderMobileRecentPhotos(item);
      return;
    }

    for (let index = 0; index < item.photos.length; index++) {
      const photoId = item.photos[index];
      const blob = await getPhoto(photoId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const tile = document.createElement('div');
      tile.className = 'photo-tile';
      tile.innerHTML = `
        <img alt="退货照片 ${index + 1}">
        <span class="photo-index">${index + 1}</span>
        <button class="remove-photo" type="button" aria-label="删除照片">×</button>
      `;
      const image = tile.querySelector('img');
      image.src = url;
      image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      image.addEventListener('click', () => previewPhoto(photoId));
      tile.querySelector('.remove-photo').addEventListener('click', async () => {
        await deletePhoto(photoId);
        item.photos = item.photos.filter(id => id !== photoId);
        item.processedAt = null;
        getActiveBatch().completedAt = null;
        saveBatches();
        renderActivePhotoGallery();
        renderItemList();
        updateValidationPreview();
      });
      gallery.appendChild(tile);
    }

    await renderMobileRecentPhotos(item);
  }

  async function renderMobileRecentPhotos(item) {
    const strip = document.getElementById('mobileRecentPhotos');
    if (!strip) return;

    strip.innerHTML = '';
    if (!item.photos.length) {
      strip.innerHTML = '<span class="mobile-photo-status">尚未保存照片</span>';
      return;
    }

    const label = document.createElement('span');
    label.className = 'mobile-photo-status';
    label.textContent = `已保存 ${item.photos.length} 张`;
    strip.appendChild(label);

    const recentIds = item.photos.slice(-3);
    for (const photoId of recentIds) {
      const blob = await getPhoto(photoId);
      if (!blob) continue;

      const url = URL.createObjectURL(blob);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-recent-photo';
      button.setAttribute('aria-label', '查看最近保存的照片');

      const image = document.createElement('img');
      image.alt = '最近保存的退货照片';
      image.src = url;
      image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      image.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
      button.appendChild(image);
      button.addEventListener('click', () => previewPhoto(photoId));
      strip.appendChild(button);
    }
  }

  function prepareNativeCamera() {
    if (nativeCameraPending) return;

    nativeCameraPending = true;
    clearTimeout(nativeCameraRestartTimer);
    stopCamera();
    setCameraMessage('正在打开手机相机…拍照后请点击“使用照片”或“完成”。');

    const placeholder = document.getElementById('cameraPlaceholder');
    if (placeholder) {
      placeholder.classList.remove('hidden');
      placeholder.innerHTML =
        '<strong>手机相机使用中</strong><span>拍摄完成后，照片会自动保存并显示在下方。</span>';
    }

    const resumeAfterReturn = () => {
      clearTimeout(nativeCameraRestartTimer);
      nativeCameraRestartTimer = setTimeout(async () => {
        if (!nativeCameraPending) return;
        nativeCameraPending = false;
        if (els.batchDialog.open && viewMode === 'process') {
          await initialiseCamera().catch(() => {});
        }
      }, 900);
    };

    window.addEventListener('focus', resumeAfterReturn, { once: true });
  }

  async function handleNativeCameraPhoto(event) {
    clearTimeout(nativeCameraRestartTimer);
    nativeCameraPending = false;

    try {
      await uploadLocalPhotos(event, { source: 'camera' });
    } finally {
      if (els.batchDialog.open && viewMode === 'process') {
        setTimeout(() => initialiseCamera().catch(() => {}), 350);
      }
    }
  }

  async function uploadLocalPhotos(event, options = {}) {
    const input = event.currentTarget || event.target;
    const files = [...(input?.files || [])];

    // Clear immediately so taking another photo with the same generated filename
    // will still trigger a change event on iOS/Android.
    if (input) input.value = '';

    if (!files.length) {
      if (options.source === 'camera') showToast('没有收到照片，请重新拍摄');
      return;
    }

    const item = getActiveItem();
    const batch = getActiveBatch();
    if (!item || !batch) {
      showToast('当前退货任务不存在，请重新进入');
      return;
    }

    const beforeCount = item.photos.length;
    const failed = [];
    setCameraMessage('正在处理并保存照片，请稍候…');
    showToast(files.length > 1 ? `正在保存 ${files.length} 张照片…` : '正在保存照片…');

    for (const file of files) {
      try {
        if (!file || !file.size) throw new Error('照片文件为空');

        const blob = await compressImage(file);
        if (!blob || !blob.size) throw new Error('照片转换失败');

        const id = makePhotoId(item.id);
        await putPhoto(id, blob);

        // Verify the IndexedDB write before updating the order data.
        const stored = await getPhoto(id);
        if (!stored || !stored.size) {
          await deletePhoto(id).catch(() => {});
          throw new Error('浏览器未能保存照片');
        }

        item.photos.push(id);
      } catch (error) {
        failed.push({
          name: file?.name || '手机照片',
          message: error?.message || '无法读取'
        });
        console.error('Photo import failed:', error, file);
      }
    }

    if (item.photos.length > beforeCount) {
      item.processedAt = null;
      batch.completedAt = null;
      batch.updatedAt = new Date().toISOString();
      saveBatches();

      await renderActivePhotoGallery();
      renderItemList();
      updateValidationPreview();

      const savedCount = item.photos.length - beforeCount;
      setCameraMessage(`照片已保存：本件共 ${item.photos.length} 张`);
      showToast(
        failed.length
          ? `成功保存 ${savedCount} 张，${failed.length} 张失败`
          : `照片已保存，本件共 ${item.photos.length} 张`
      );

      if (isMobileLayout()) {
        document.getElementById('mobileRecentPhotos')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      }
    } else {
      setCameraMessage('照片保存失败，请查看提示后重试');
      const detail = failed[0]?.message || '手机没有把照片返回给网页';
      showToast(`照片未保存：${detail}`);
    }
  }

  async function initialiseCamera() {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      setCameraMessage('当前地址不能开启实时画面；请使用“手机相机拍照”，或通过 HTTPS 打开网页。');
      document.getElementById('cameraPlaceholder')?.classList.remove('hidden');
      document.getElementById('cameraPlaceholder').innerHTML =
        '<strong>使用手机原生相机</strong><span>点击下方“手机相机拍照”即可使用后置摄像头。</span>';
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraMessage('浏览器不支持实时画面；手机可使用下方“手机相机拍照”。');
      return;
    }

    const video = document.getElementById('cameraVideo');
    if (cameraStream && cameraStream.active) {
      video.srcObject = cameraStream;
      await video.play().catch(() => {});
      const track = cameraStream.getVideoTracks()[0];
      updateCameraReady(track);
      await refreshCameraDevices(false);
      return;
    }

    try {
      await startCamera(localStorage.getItem('k8-camera-device') || '');
      await refreshCameraDevices(false);
    } catch (error) {
      handleCameraError(error);
    }
  }

  async function refreshCameraDevices(restart = false) {
    try {
      const select = document.getElementById('cameraSelect');
      if (!select) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameraDevices = devices.filter(device => device.kind === 'videoinput');
      const current = select.value || localStorage.getItem('k8-camera-device') || '';

      select.innerHTML = '';
      if (!cameraDevices.length) {
        select.innerHTML = '<option value="">未发现摄像头</option>';
        setCameraMessage('未发现视频输入设备，请检查 USB 连接。');
        return;
      }

      cameraDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `摄像头 ${index + 1}`;
        select.appendChild(option);
      });

      const match = cameraDevices.find(device => device.deviceId === current);
      select.value = match ? current : cameraDevices[0].deviceId;
      if (restart && select.value) await startCamera(select.value);
    } catch (error) {
      handleCameraError(error);
    }
  }

  async function startCamera(deviceId = '') {
    stopCamera();
    const constraints = {
      width: { ideal: isMobileLayout() ? 1920 : 3840 },
      height: { ideal: isMobileLayout() ? 1080 : 2160 },
      facingMode: { ideal: 'environment' }
    };
    if (deviceId) {
      delete constraints.facingMode;
      constraints.deviceId = { exact: deviceId };
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    const video = document.getElementById('cameraVideo');
    if (!video) return;
    video.srcObject = cameraStream;
    await video.play();

    const track = cameraStream.getVideoTracks()[0];
    const settings = track.getSettings();
    localStorage.setItem('k8-camera-device', settings.deviceId || deviceId || '');
    updateCameraReady(track);

    const select = document.getElementById('cameraSelect');
    if (select && settings.deviceId) select.value = settings.deviceId;
    if (!cameraDevices.length) await refreshCameraDevices(false);
  }

  function updateCameraReady(track) {
    const placeholder = document.getElementById('cameraPlaceholder');
    const button = document.getElementById('captureBtn');
    const settings = track.getSettings();
    placeholder?.classList.add('hidden');
    if (button) button.disabled = false;
    setCameraMessage(`${track.label || '摄像头已连接'} · ${settings.width || '?'}×${settings.height || '?'}`);
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
  }

  async function capturePhoto() {
    const item = getActiveItem();
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    const button = document.getElementById('captureBtn');
    if (!item || !video || !canvas || !cameraStream) return;

    if (!video.videoWidth || !video.videoHeight) {
      showToast('摄像头画面尚未准备好');
      return;
    }

    button.disabled = true;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          value => value ? resolve(value) : reject(new Error('照片保存失败')),
          'image/jpeg',
          0.96
        );
      });
      const id = makePhotoId(item.id);
      await putPhoto(id, blob);
      item.photos.push(id);
      item.processedAt = null;
      const batch = getActiveBatch();
      batch.updatedAt = new Date().toISOString();
      batch.completedAt = null;
      saveBatches();
      flashCamera();
      await renderActivePhotoGallery();
      renderItemList();
      updateValidationPreview();
      setCameraMessage(`已保存第 ${item.photos.length} 张照片`);
    } catch (error) {
      showToast(error.message || '照片保存失败');
    } finally {
      button.disabled = false;
    }
  }

  function flashCamera() {
    document.querySelector('.camera-stage')?.animate(
      [{ filter: 'brightness(1)' }, { filter: 'brightness(2.4)' }, { filter: 'brightness(1)' }],
      { duration: 220, easing: 'ease-out' }
    );
  }

  function setCameraMessage(message) {
    const status = document.getElementById('cameraStatus');
    if (status) status.textContent = message;
  }

  function handleCameraError(error) {
    stopCamera();
    const placeholder = document.getElementById('cameraPlaceholder');
    placeholder?.classList.remove('hidden');
    const messages = {
      NotAllowedError: '摄像头权限被拒绝，请在浏览器地址栏旁允许摄像头。',
      NotFoundError: '没有发现摄像头，请检查 USB 连接。',
      NotReadableError: '摄像头可能被其他软件占用，请关闭录像软件、Zoom 或 OBS。',
      OverconstrainedError: '摄像头不支持请求的参数，请点击刷新。',
      SecurityError: '实时摄像头只能在 localhost 或 HTTPS 中使用；手机仍可点击“手机相机拍照”。'
    };
    const message = messages[error?.name] || `无法启动摄像头：${error?.message || '未知错误'}`;
    setCameraMessage(message);
    showToast(message);
  }

  function renderReview() {
    const batch = getActiveBatch();
    const ready = batch.items.filter(item => isItemReady(item, batch)).length;
    const allReady = ready === batch.items.length && batch.items.length > 0;

    els.batchMain.innerHTML = `
      <section class="review-page">
        <div class="review-head">
          <div>
            <h3>批次统一复核</h3>
            <p class="muted">直接查看每件退货的实际照片、SKU 和质检记录。确认后才生成整张退货单的完成时间戳。</p>
          </div>
          <div class="review-summary">
            <span>${ready}/${batch.items.length} 件资料完整</span>
            <span>${batch.inspectionRequired ? '包含分拣质检' : '快速处理模式'}</span>
          </div>
        </div>

        ${batch.completedAt
          ? `<div class="complete-banner">已于 ${formatDateTime(batch.completedAt)} 完成统一复核。</div>`
          : ''}

        <div id="reviewList" class="review-list"></div>

        <div class="review-footer">
          <span>${allReady ? '全部退货任务均已达到完成条件。' : '仍有任务未完成，请返回对应退货任务补充资料。'}</span>
          <button id="confirmBatchBtn" class="primary-btn" type="button"
            ${!allReady || batch.completedAt ? 'disabled' : ''}>
            ${batch.completedAt ? '已确认完成' : '确认全部任务完成'}
          </button>
        </div>
      </section>
    `;

    renderReviewCards();
    document.getElementById('confirmBatchBtn').addEventListener('click', confirmBatchCompletion);
  }

  async function renderReviewCards() {
    const batch = getActiveBatch();
    const list = document.getElementById('reviewList');
    list.innerHTML = '';

    for (let index = 0; index < batch.items.length; index++) {
      const item = batch.items[index];
      const ready = isItemReady(item, batch);
      const card = document.createElement('article');
      card.className = `review-card ${ready ? '' : 'incomplete'}`;
      card.innerHTML = `
        <div class="review-card-head">
          <div>
            <h4>退货 ${item.sequence} · ${escapeHtml(item.sku || '未录入 SKU')}</h4>
            <p>${ready ? '资料完整' : escapeHtml(itemValidationText(item, batch))}</p>
          </div>
          <button class="secondary-btn edit-item-btn" type="button">返回编辑</button>
        </div>

        <div class="review-info">
          <div><small>面单号</small><strong>${escapeHtml(item.tracking || '未填写')}</strong></div>
          <div><small>SKU</small><strong>${escapeHtml(item.sku || '未填写')}</strong></div>
          <div><small>处理结果</small><strong>${escapeHtml(batch.inspectionRequired ? (item.inspection.result || '未填写') : '快速处理')}</strong></div>
        </div>

        ${item.notes || item.inspection.notes
          ? `<p class="muted">${escapeHtml([item.inspection.notes, item.notes].filter(Boolean).join('；'))}</p>`
          : ''}

        <div class="review-photos" data-item-index="${index}"></div>
      `;

      card.querySelector('.edit-item-btn').addEventListener('click', () => {
        batch.completedAt = null;
        activeItemIndex = index;
        viewMode = 'process';
        renderBatch();
      });

      list.appendChild(card);
      await hydrateReviewPhotos(card.querySelector('.review-photos'), item);
    }
  }

  async function hydrateReviewPhotos(container, item) {
    if (!item.photos.length) {
      container.innerHTML = '<div class="review-empty">暂无照片</div>';
      return;
    }

    for (const photoId of item.photos) {
      const blob = await getPhoto(photoId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const wrap = document.createElement('div');
      wrap.className = 'review-photo';
      const image = document.createElement('img');
      image.alt = '退货复核照片';
      image.src = url;
      image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      image.addEventListener('click', () => previewPhoto(photoId));
      wrap.appendChild(image);
      container.appendChild(wrap);
    }
  }


  async function previewPhoto(photoId) {
    const blob = await getPhoto(photoId);
    if (!blob) {
      showToast('照片文件不存在');
      return;
    }
    closePhotoPreview();
    const url = URL.createObjectURL(blob);
    els.photoPreviewImage.src = url;
    els.photoPreviewImage.dataset.objectUrl = url;
    els.photoPreviewDialog.showModal();
  }

  function closePhotoPreview(closeDialog = true) {
    const url = els.photoPreviewImage.dataset.objectUrl;
    if (url) URL.revokeObjectURL(url);
    els.photoPreviewImage.removeAttribute('src');
    delete els.photoPreviewImage.dataset.objectUrl;
    if (closeDialog && els.photoPreviewDialog.open) els.photoPreviewDialog.close();
  }

  function confirmBatchCompletion() {
    const batch = getActiveBatch();
    if (!batch.items.length || !batch.items.every(item => isItemReady(item, batch))) {
      showToast('仍有退货任务未完成');
      return;
    }

    const now = new Date().toISOString();
    batch.items.forEach(item => {
      item.processedAt = item.processedAt || now;
    });
    batch.completedAt = now;
    batch.updatedAt = now;
    saveBatches();
    renderBatch();
    showToast('批次已统一复核完成');
  }

  function showSkuLabel() {
    persistActiveItemFields();
    const item = getActiveItem();
    if (!item.sku) {
      showToast('请先录入 SKU');
      document.getElementById('skuInput')?.focus();
      return;
    }
    els.labelSku.textContent = item.sku;
    els.labelItemId.textContent = `Item: ${item.id}`;
    els.labelTracking.textContent = `Tracking: ${item.tracking || 'N/A'}`;
    els.labelDate.textContent = formatDateTime(new Date().toISOString());
    els.labelDialog.showModal();
  }

  function addItemsToActiveBatch() {
    persistActiveItemFields();
    const batch = getActiveBatch();
    if (batch.orderType === 'single') return;

    const existingBlank = batch.items.findIndex(item => isItemUntouched(item));
    if (existingBlank >= 0) {
      activeItemIndex = existingBlank;
      viewMode = 'process';
      renderBatch();
      showToast('已切换到尚未处理的退货任务');
      return;
    }

    batch.items.push(createBlankItem(batch.items.length + 1));
    batch.completedAt = null;
    batch.updatedAt = new Date().toISOString();
    activeItemIndex = batch.items.length - 1;
    viewMode = 'process';
    saveBatches();
    renderBatch();
    showToast('已添加 1 件退货任务');
  }

  async function deleteActiveBatch() {
    const batch = getActiveBatch();
    if (!batch || !confirm(`确定删除退货单“${batch.name}”？其中所有退货任务和照片都会删除。`)) return;

    for (const item of batch.items) {
      for (const photoId of item.photos) {
        await deletePhoto(photoId);
      }
    }

    batches = batches.filter(candidate => candidate.id !== batch.id);
    saveLocalCloudCache();
    await deleteBatchFromCloud(batch.id);
    closeBatch();
    showToast('退货单已删除');
  }


  async function exportBatchExcel(batchId, button = null) {
    const batch = batches.find(candidate => candidate.id === batchId);
    if (!batch) return;
    if (!window.JSZip) {
      showToast('Excel 导出组件未加载，请重新打开系统');
      return;
    }

    const originalText = button?.textContent;
    if (button) {
      button.disabled = true;
      button.classList.add('exporting');
      button.textContent = '正在生成 Excel…';
    }
    showToast('正在整理照片并生成 Excel 表格…');

    try {
      const workbookBlob = await buildBatchXlsx(batch);
      const safeClient = sanitiseFilename(batch.client || '客户');
      const safeDate = String(batch.date || toDateInput(new Date())).replaceAll('-', '');
      downloadBlob(workbookBlob, `${safeClient}_${safeDate}_退货处理.xlsx`);
      showToast('Excel 已导出：清单页含大图，高清照片页可完整预览');
    } catch (error) {
      console.error(error);
      showToast(`Excel 导出失败：${error.message || '未知错误'}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.classList.remove('exporting');
        button.textContent = originalText || '导出 Excel 表格';
      }
    }
  }

  async function buildBatchXlsx(batch) {
    const zip = new JSZip();
    const images = [];

    for (let itemIndex = 0; itemIndex < batch.items.length; itemIndex++) {
      const item = batch.items[itemIndex];
      for (let photoIndex = 0; photoIndex < item.photos.length; photoIndex++) {
        const photoId = item.photos[photoIndex];
        const original = await getPhoto(photoId);
        if (!original) continue;
        const normalised = await normaliseExcelImage(original);
        images.push({
          itemIndex,
          photoIndex,
          previewRowIndex: images.length,
          bytes: await normalised.blob.arrayBuffer(),
          extension: normalised.extension,
          contentType: normalised.contentType,
          width: normalised.width,
          height: normalised.height
        });
      }
    }

    const maxPhotos = Math.max(1, ...batch.items.map(item => item.photos.length));
    const mainLastColumn = columnName(3 + maxPhotos);
    const mainLastRow = Math.max(1, batch.items.length + 1);
    const mainRows = [];

    const headerCells = [
      inlineCell('A1', 'sku', 1),
      inlineCell('B1', '日期', 1),
      inlineCell('C1', '单号', 1),
      inlineCell('D1', '图片', 1)
    ];
    for (let imageCol = 1; imageCol < maxPhotos; imageCol++) {
      headerCells.push(inlineCell(`${columnName(4 + imageCol)}1`, '', 1));
    }
    mainRows.push(`<row r="1" ht="24" customHeight="1">${headerCells.join('')}</row>`);

    batch.items.forEach((item, index) => {
      const rowNumber = index + 2;
      const rowCells = [
        inlineCell(`A${rowNumber}`, item.sku || '', 2),
        inlineCell(`B${rowNumber}`, formatExportDate(batch.date), 2),
        inlineCell(`C${rowNumber}`, item.tracking || '', 2)
      ];
      for (let imageCol = 0; imageCol < maxPhotos; imageCol++) {
        rowCells.push(emptyCell(`${columnName(4 + imageCol)}${rowNumber}`, 2));
      }
      // 128pt is approximately 171px: large enough to see the return evidence clearly.
      mainRows.push(`<row r="${rowNumber}" ht="128" customHeight="1">${rowCells.join('')}</row>`);
    });

    const mainImageCols = Array.from({ length: maxPhotos }, (_, index) =>
      `<col min="${4 + index}" max="${4 + index}" width="25.5" customWidth="1"/>`
    ).join('');

    // The second worksheet is a full-size gallery. One image per row avoids tiny thumbnails
    // and works better in Excel, WPS and Tencent Docs.
    const previewRows = [];
    previewRows.push(`<row r="1" ht="24" customHeight="1">${[
      inlineCell('A1', 'sku', 1),
      inlineCell('B1', '日期', 1),
      inlineCell('C1', '单号', 1),
      inlineCell('D1', '照片序号', 1),
      inlineCell('E1', '高清图片预览', 1)
    ].join('')}</row>`);

    images.forEach((image, index) => {
      const item = batch.items[image.itemIndex];
      const rowNumber = index + 2;
      previewRows.push(`<row r="${rowNumber}" ht="300" customHeight="1">${[
        inlineCell(`A${rowNumber}`, item?.sku || '', 2),
        inlineCell(`B${rowNumber}`, formatExportDate(batch.date), 2),
        inlineCell(`C${rowNumber}`, item?.tracking || '', 2),
        inlineCell(`D${rowNumber}`, String(image.photoIndex + 1), 2),
        emptyCell(`E${rowNumber}`, 2)
      ].join('')}</row>`);
    });

    if (!images.length) {
      previewRows.push(`<row r="2" ht="34" customHeight="1">${[
        inlineCell('A2', '', 2),
        inlineCell('B2', '', 2),
        inlineCell('C2', '', 2),
        inlineCell('D2', '', 2),
        inlineCell('E2', '本退货单暂无照片', 2)
      ].join('')}</row>`);
    }

    const hasImages = images.length > 0;
    const previewLastRow = Math.max(2, images.length + 1);

    zip.file('[Content_Types].xml', contentTypesXml(images));
    zip.folder('_rels').file('.rels', rootRelationshipsXml());
    zip.folder('docProps').file('app.xml', appPropertiesXml());
    zip.folder('docProps').file('core.xml', corePropertiesXml());
    zip.folder('xl').file('workbook.xml', workbookXml());
    zip.folder('xl').folder('_rels').file('workbook.xml.rels', workbookRelationshipsXml());
    zip.folder('xl').file('styles.xml', stylesXml());

    zip.folder('xl').folder('worksheets').file('sheet1.xml', worksheetXml({
      dimensions: `A1:${mainLastColumn}${mainLastRow}`,
      rows: mainRows.join(''),
      columns: `
        <col min="1" max="1" width="18" customWidth="1"/>
        <col min="2" max="2" width="14" customWidth="1"/>
        <col min="3" max="3" width="24" customWidth="1"/>
        ${mainImageCols}`,
      hasImages,
      drawingRelationshipId: 'rId1'
    }));

    zip.folder('xl').folder('worksheets').file('sheet2.xml', worksheetXml({
      dimensions: `A1:E${previewLastRow}`,
      rows: previewRows.join(''),
      columns: `
        <col min="1" max="1" width="18" customWidth="1"/>
        <col min="2" max="2" width="14" customWidth="1"/>
        <col min="3" max="3" width="24" customWidth="1"/>
        <col min="4" max="4" width="12" customWidth="1"/>
        <col min="5" max="5" width="76" customWidth="1"/>`,
      hasImages,
      drawingRelationshipId: 'rId1'
    }));

    if (hasImages) {
      const worksheetRels = zip.folder('xl').folder('worksheets').folder('_rels');
      worksheetRels.file('sheet1.xml.rels', worksheetRelationshipsXml('../drawings/drawing1.xml'));
      worksheetRels.file('sheet2.xml.rels', worksheetRelationshipsXml('../drawings/drawing2.xml'));

      const drawings = zip.folder('xl').folder('drawings');
      drawings.file('drawing1.xml', drawingXml(images, 'thumbnail'));
      drawings.file('drawing2.xml', drawingXml(images, 'preview'));
      const drawingRels = drawings.folder('_rels');
      drawingRels.file('drawing1.xml.rels', drawingRelationshipsXml(images));
      drawingRels.file('drawing2.xml.rels', drawingRelationshipsXml(images));

      const mediaFolder = zip.folder('xl').folder('media');
      images.forEach((image, index) => {
        // Store the original JPEG/PNG bytes. ZIP compression does not reduce image quality.
        mediaFolder.file(`image${index + 1}.${image.extension}`, image.bytes);
      });
    }

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  function contentTypesXml(images) {
    const extensions = new Map();
    images.forEach(image => extensions.set(image.extension, image.contentType));
    const imageDefaults = [...extensions.entries()]
      .map(([extension, contentType]) => `<Default Extension="${extension}" ContentType="${contentType}"/>`)
      .join('');
    const drawingOverrides = images.length
      ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/drawings/drawing2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${drawingOverrides}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }

  function rootRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  function appPropertiesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>K8 Return Processing System</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>退货清单</vt:lpstr><vt:lpstr>高清照片</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>`;
  }

  function corePropertiesXml() {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>K8 Return Processing System</dc:creator>
  <cp:lastModifiedBy>K8 Return Processing System</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function workbookXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
  <sheets>
    <sheet name="退货清单" sheetId="1" r:id="rId1"/>
    <sheet name="高清照片" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;
  }

  function workbookRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Arial"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF76D7F0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  function worksheetXml({ dimensions, rows, columns, hasImages, drawingRelationshipId }) {
    const drawing = hasImages ? `<drawing r:id="${drawingRelationshipId}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimensions}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columns}</cols>
  <sheetData>${rows}</sheetData>
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  ${drawing}
</worksheet>`;
  }

  function worksheetRelationshipsXml(target) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${target}"/>
</Relationships>`;
  }

  function drawingXml(images, mode) {
    const anchors = images.map((image, index) => {
      const isPreview = mode === 'preview';
      const col = isPreview ? 4 : 3 + image.photoIndex;
      const row = isPreview ? 1 + image.previewRowIndex : 1 + image.itemIndex;
      const relId = index + 1;
      const shapeId = index + 2;
      const boxWidth = isPreview ? 510 : 174;
      const boxHeight = isPreview ? 390 : 160;
      const padding = isPreview ? 10 : 6;
      const fitted = fitImageWithin(
        image.width || 1,
        image.height || 1,
        boxWidth - padding * 2,
        boxHeight - padding * 2
      );
      const xOffsetPx = padding + Math.max(0, (boxWidth - padding * 2 - fitted.width) / 2);
      const yOffsetPx = padding + Math.max(0, (boxHeight - padding * 2 - fitted.height) / 2);
      const cx = Math.round(fitted.width * 9525);
      const cy = Math.round(fitted.height * 9525);
      const xOffset = Math.round(xOffsetPx * 9525);
      const yOffset = Math.round(yOffsetPx * 9525);
      const description = xmlEscape(`退货 ${image.itemIndex + 1} 照片 ${image.photoIndex + 1}`);

      return `<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${xOffset}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${yOffset}</xdr:rowOff></xdr:from>
  <xdr:ext cx="${cx}" cy="${cy}"/>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="Picture ${relId}" descr="${description}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
  }

  function fitImageWithin(width, height, maxWidth, maxHeight) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight);
    return {
      width: Math.max(1, Math.round(safeWidth * scale)),
      height: Math.max(1, Math.round(safeHeight * scale))
    };
  }

  function drawingRelationshipsXml(images) {
    const relationships = images.map((image, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.${image.extension}"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
  }

  function inlineCell(reference, value, styleId = 0) {
    const style = styleId ? ` s="${styleId}"` : '';
    return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }

  function emptyCell(reference, styleId = 0) {
    const style = styleId ? ` s="${styleId}"` : '';
    return `<c r="${reference}"${style}/>`;
  }

  function columnName(number) {
    let result = '';
    let value = number;
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function xmlEscape(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  function formatExportDate(value) {
    const parts = String(value || '').split('-');
    if (parts.length !== 3) return value || '';
    return `${parts[0]}/${Number(parts[1])}/${Number(parts[2])}`;
  }

  function sanitiseFilename(value) {
    return String(value || '退货单')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '退货单';
  }

  async function normaliseExcelImage(blob) {
    const source = await loadImageSource(blob);
    const width = source.width || source.naturalWidth || 1;
    const height = source.height || source.naturalHeight || 1;

    if (blob.type === 'image/png') {
      if (typeof source.close === 'function') source.close();
      return { blob, extension: 'png', contentType: 'image/png', width, height };
    }

    if (blob.type === 'image/jpeg' || blob.type === 'image/jpg' || !blob.type) {
      if (typeof source.close === 'function') source.close();
      return { blob, extension: 'jpg', contentType: 'image/jpeg', width, height };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    if (typeof source.close === 'function') source.close();
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片格式转换失败')), 'image/jpeg', 0.95);
    });
    return { blob: jpeg, extension: 'jpg', contentType: 'image/jpeg', width, height };
  }

  function exportCSV() {
    const rows = batches.flatMap(batch => batch.items.map(item => [
      batch.id,
      batch.name,
      batch.client,
      batch.date,
      batch.inspectionRequired ? '是' : '否',
      item.sequence,
      item.id,
      item.tracking,
      item.sku,
      isItemReady(item, batch) ? '资料完整' : '待处理',
      item.inspection.condition || '',
      item.inspection.result || '',
      item.inspection.accessoriesComplete ? '是' : '否',
      item.inspection.packagingDamaged ? '是' : '否',
      item.inspection.itemDamaged ? '是' : '否',
      item.inspection.notes || '',
      item.notes || '',
      item.processedAt ? formatDateTime(item.processedAt) : '',
      batch.completedAt ? formatDateTime(batch.completedAt) : ''
    ]));

    if (!rows.length) {
      showToast('没有可导出的退货记录');
      return;
    }

    const headers = [
      '退货单ID', '退货单名称', '客户', '处理日期', '是否质检',
      '序号', '退货任务ID', '面单号', 'SKU', '单件状态',
      '商品状态', '处理建议', '配件齐全', '包装破损', '商品破损',
      '质检备注', '本件备注', '单件保存时间', '批次确认完成时间'
    ];
    const csv = '\uFEFF' + [headers, ...rows]
      .map(row => row.map(csvCell).join(','))
      .join('\n');

    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `K8批量退货记录_${toDateInput(new Date())}.csv`
    );
  }

  function csvCell(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function compressImage(file) {
    const source = await loadImageSource(file);
    const width = Number(source.width || source.naturalWidth || 0);
    const height = Number(source.height || source.naturalHeight || 0);

    if (!width || !height) {
      if (typeof source.close === 'function') source.close();
      throw new Error('无法读取照片尺寸，可能是手机照片格式不兼容');
    }

    // Large iPhone images can exceed Safari's canvas memory limit.
    // 2048px is still clear enough for labels/returns and reliable on mobile.
    const maxSide = isMobileLayout() ? 2048 : 3200;
    const ratio = Math.min(1, maxSide / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * ratio));
    const targetHeight = Math.max(1, Math.round(height * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      if (typeof source.close === 'function') source.close();
      throw new Error('浏览器无法创建图片画布');
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(source, 0, 0, targetWidth, targetHeight);

    if (typeof source.close === 'function') source.close();

    let result = await canvasToBlob(canvas, 0.92);

    // A second, smaller attempt helps iOS Safari when memory is tight.
    if (!result && isMobileLayout()) {
      const fallbackCanvas = document.createElement('canvas');
      const fallbackRatio = Math.min(1, 1600 / Math.max(width, height));
      fallbackCanvas.width = Math.max(1, Math.round(width * fallbackRatio));
      fallbackCanvas.height = Math.max(1, Math.round(height * fallbackRatio));
      const fallbackContext = fallbackCanvas.getContext('2d', { alpha: false });
      if (fallbackContext) {
        fallbackContext.fillStyle = '#ffffff';
        fallbackContext.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        fallbackContext.drawImage(canvas, 0, 0, fallbackCanvas.width, fallbackCanvas.height);
        result = await canvasToBlob(fallbackCanvas, 0.88);
      }
    }

    if (!result) throw new Error('照片压缩失败，可能是图片过大');
    return result;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(resolve => {
      try {
        canvas.toBlob(blob => resolve(blob || null), 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });
  }

  async function loadImageSource(file) {
    // createImageBitmap is fast, but some iOS versions expose it while failing
    // on HEIC or high-resolution camera files. Always fall back to <img>.
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        console.warn('createImageBitmap failed; using image fallback:', error);
      }
    }

    return loadImageElement(file);
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      const cleanup = () => URL.revokeObjectURL(url);

      image.onload = () => {
        cleanup();
        resolve(image);
      };

      image.onerror = () => {
        cleanup();
        const type = String(file?.type || '').toLowerCase();
        const isHeic = type.includes('heic') || type.includes('heif') ||
          /\.(heic|heif)$/i.test(file?.name || '');
        reject(new Error(
          isHeic
            ? '当前浏览器无法转换 HEIC 照片，请把手机相机格式改为“兼容性最佳/JPEG”后重试'
            : '无法读取这张照片，请重新拍摄或选择 JPEG/PNG 图片'
        ));
      };

      image.src = url;

      if (typeof image.decode === 'function') {
        image.decode().catch(() => {
          // onload/onerror remains the source of truth for older Safari.
        });
      }
    });
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function putPhoto(id, blob) {
    if (!currentUser || !supabaseClient) {
      throw new Error('请先登录账户');
    }
    if (!navigator.onLine) {
      throw new Error('当前离线，照片必须联网后才能上传到云端');
    }

    const bucket = getPhotoBucket();
    const { error } = await supabaseClient.storage
      .from(bucket)
      .upload(id, blob, {
        contentType: blob.type || 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });

    if (error) throw new Error(`云端照片上传失败：${error.message}`);

    await putLocalPhoto(id, blob).catch(() => {});
  }

  async function getPhoto(id) {
    const cached = await getLocalPhoto(id).catch(() => null);
    if (cached) return cached;

    // Legacy photo IDs remain readable from the old browser database.
    if (!isCloudPhotoPath(id) || !supabaseClient || !currentUser) {
      return cached;
    }

    const { data, error } = await supabaseClient.storage
      .from(getPhotoBucket())
      .download(id);

    if (error) {
      console.warn('Cloud photo download failed:', error);
      return null;
    }

    await putLocalPhoto(id, data).catch(() => {});
    return data;
  }

  async function deletePhoto(id) {
    if (isCloudPhotoPath(id) && supabaseClient && currentUser) {
      const { error } = await supabaseClient.storage
        .from(getPhotoBucket())
        .remove([id]);
      if (error) console.warn('Cloud photo delete failed:', error);
    }
    await deleteLocalPhoto(id).catch(() => {});
  }

  async function putLocalPhoto(id, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getLocalPhoto(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readonly');
      const request = tx.objectStore(PHOTO_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteLocalPhoto(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  function makeBatchId() {
    return `BATCH-${toDateInput(new Date()).replaceAll('-', '')}-${String(Date.now()).slice(-5)}-${Math.random().toString(16).slice(2,5).toUpperCase()}`;
  }

  function makeItemId() {
    return `RET-${String(Date.now()).slice(-7)}-${Math.random().toString(16).slice(2,6).toUpperCase()}`;
  }

  function makePhotoId(itemId) {
    if (!currentUser) {
      return `${itemId}-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
    }
    const batchId = activeBatchId || 'unassigned';
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
    return `${currentUser.id}/${batchId}/${itemId}/${filename}`;
  }

  function isCloudPhotoPath(id) {
    return !!currentUser && String(id || '').startsWith(`${currentUser.id}/`);
  }

  function getPhotoBucket() {
    return window.K8_SUPABASE_CONFIG?.photoBucket || DEFAULT_PHOTO_BUCKET;
  }

  function toDateInput(date) {
    const value = new Date(date);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDateOnly(value) {
    const parts = String(value).split('-');
    if (parts.length !== 3) return value;
    return `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function formatDateTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(value));
  }

  function latestDate(values) {
    const dates = values.filter(Boolean).map(value => new Date(value));
    if (!dates.length) return null;
    return new Date(Math.max(...dates.map(date => date.getTime()))).toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function showToast(message) {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2300);
  }



  async function initialiseCloud() {
    const config = window.K8_SUPABASE_CONFIG || {};
    const configured =
      typeof config.url === 'string' &&
      /^https:\/\/.+\.supabase\.co\/?$/.test(config.url.trim()) &&
      typeof config.publishableKey === 'string' &&
      config.publishableKey.trim() &&
      !config.publishableKey.includes('YOUR_');

    if (!configured || !window.supabase?.createClient) {
      showSetupScreen();
      return;
    }

    supabaseClient = window.supabase.createClient(
      config.url.trim().replace(/\/$/, ''),
      config.publishableKey.trim(),
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      }
    );

    supabaseClient.auth.onAuthStateChange((event, session) => {
      setTimeout(() => handleAuthEvent(event, session), 0);
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
      showAuthScreen();
      setAuthMessage(error.message, 'error');
      return;
    }

    if (data.session?.user) {
      await startUserSession(data.session.user);
    } else {
      showAuthScreen();
    }
  }

  async function handleAuthEvent(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
      els.passwordDialog.showModal();
      return;
    }

    if (event === 'SIGNED_OUT' || !session?.user) {
      stopUserSession();
      showAuthScreen();
      return;
    }

    if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'INITIAL_SESSION'].includes(event)) {
      await startUserSession(session.user);
    }
  }

  async function startUserSession(user) {
    if (!user) return;
    currentUser = user;
    updateAccountUI(user);
    showAppShell();

    if (appStartedForUserId !== user.id) {
      appStartedForUserId = user.id;
      await loadCloudBatches();
      await maybeImportLocalData();
      subscribeToCloudChanges();
    }

    setCloudStatus(
      navigator.onLine ? 'online' : 'offline',
      navigator.onLine ? '云端已连接' : '离线：显示本机缓存'
    );
  }

  function stopUserSession() {
    stopCamera();
    unsubscribeFromCloudChanges();
    currentUser = null;
    appStartedForUserId = null;
    batches = [];
    cloudKnownIds = new Set();
    if (els.batchDialog.open) els.batchDialog.close();
    renderBatches();
  }

  function showSetupScreen() {
    els.setupScreen.classList.remove('hidden');
    els.authScreen.classList.add('hidden');
    els.appShell.classList.add('hidden');
  }

  function showSetupError(message) {
    showSetupScreen();
    const paragraph = els.setupScreen.querySelector('.auth-note');
    if (paragraph) paragraph.textContent = message;
  }

  function showAuthScreen() {
    els.setupScreen.classList.add('hidden');
    els.authScreen.classList.remove('hidden');
    els.appShell.classList.add('hidden');
    setAuthMode('login');
  }

  function showAppShell() {
    els.setupScreen.classList.add('hidden');
    els.authScreen.classList.add('hidden');
    els.appShell.classList.remove('hidden');
  }

  function setAuthMode(mode) {
    const register = mode === 'register';
    els.loginTabBtn.classList.toggle('active', !register);
    els.registerTabBtn.classList.toggle('active', register);
    els.loginForm.classList.toggle('hidden', register);
    els.registerForm.classList.toggle('hidden', !register);
    setAuthMessage('');
  }

  function setAuthMessage(message, type = '') {
    els.authMessage.textContent = message || '';
    els.authMessage.className = `auth-message ${type}`.trim();
  }

  async function signInUser(event) {
    event.preventDefault();
    const form = new FormData(els.loginForm);
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');

    setAuthButtonBusy(els.loginSubmitBtn, true, '正在登录…');
    setAuthMessage('');

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    setAuthButtonBusy(els.loginSubmitBtn, false, '登录');

    if (error) {
      setAuthMessage(translateAuthError(error.message), 'error');
    }
  }

  async function registerUser(event) {
    event.preventDefault();
    const form = new FormData(els.registerForm);
    const displayName = String(form.get('displayName') || '').trim();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');

    if (password !== confirmPassword) {
      setAuthMessage('两次输入的密码不一致。', 'error');
      return;
    }

    setAuthButtonBusy(els.registerSubmitBtn, true, '正在创建账户…');
    setAuthMessage('');

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: location.origin
      }
    });

    setAuthButtonBusy(els.registerSubmitBtn, false, '创建账户');

    if (error) {
      setAuthMessage(translateAuthError(error.message), 'error');
      return;
    }

    if (data.session) {
      setAuthMessage('账户创建成功，正在进入系统…', 'success');
    } else {
      setAuthMessage('账户已创建。请打开邮箱中的确认邮件，然后返回登录。', 'success');
      setAuthMode('login');
      els.loginForm.elements.email.value = email;
    }
  }

  async function sendPasswordReset() {
    const email = String(els.loginForm.elements.email.value || '').trim();
    if (!email) {
      setAuthMessage('请先填写需要找回密码的邮箱。', 'error');
      els.loginForm.elements.email.focus();
      return;
    }

    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin
    });

    if (error) {
      setAuthMessage(translateAuthError(error.message), 'error');
    } else {
      setAuthMessage('重置密码邮件已发送，请检查邮箱。', 'success');
    }
  }

  async function updateRecoveredPassword(event) {
    event.preventDefault();
    const form = new FormData(els.passwordForm);
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');

    if (password !== confirmPassword) {
      els.passwordMessage.textContent = '两次密码不一致。';
      els.passwordMessage.className = 'auth-message error';
      return;
    }

    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) {
      els.passwordMessage.textContent = translateAuthError(error.message);
      els.passwordMessage.className = 'auth-message error';
      return;
    }

    els.passwordMessage.textContent = '密码已更新。';
    els.passwordMessage.className = 'auth-message success';
    setTimeout(() => els.passwordDialog.close(), 700);
  }

  async function signOutUser() {
    await flushCloudSync();
    await supabaseClient.auth.signOut();
  }

  function setAuthButtonBusy(button, busy, text) {
    button.disabled = busy;
    button.textContent = text;
  }

  function translateAuthError(message) {
    const text = String(message || '');
    if (/invalid login credentials/i.test(text)) return '邮箱或密码不正确。';
    if (/email not confirmed/i.test(text)) return '请先打开邮箱中的确认邮件。';
    if (/user already registered/i.test(text)) return '这个邮箱已经注册，请直接登录。';
    if (/password should be/i.test(text)) return '密码长度不足，请至少输入6位。';
    if (/rate limit/i.test(text)) return '请求次数过多，请稍后再试。';
    return text || '账户操作失败，请重试。';
  }

  function updateAccountUI(user) {
    const displayName =
      user.user_metadata?.display_name ||
      user.email?.split('@')[0] ||
      '用户';
    els.userDisplayName.textContent = displayName;
    els.userEmail.textContent = user.email || '';
    els.userAvatar.textContent = displayName.slice(0, 1).toUpperCase();
  }

  function setCloudStatus(state, message) {
    if (!els.cloudStatus || !els.syncDot) return;
    els.cloudStatus.textContent = message;
    els.syncDot.className = `sync-dot ${state || ''}`.trim();
  }

  function userCacheKey() {
    return currentUser ? `${CLOUD_CACHE_PREFIX}${currentUser.id}` : null;
  }

  function saveLocalCloudCache() {
    const key = userCacheKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(batches));
    } catch (error) {
      console.warn('Local cloud cache write failed:', error);
    }
  }

  function readLocalCloudCache() {
    const key = userCacheKey();
    if (!key) return [];
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  async function loadCloudBatches(options = {}) {
    if (!currentUser || !supabaseClient) return;

    const openBatchId = options.preserveOpenBatch ? activeBatchId : null;
    els.batchList.innerHTML =
      '<div class="cloud-loading"><strong>正在读取云端退货数据</strong><span>请稍候…</span></div>';
    els.emptyState.classList.add('hidden');
    setCloudStatus('syncing', '正在读取云端数据…');

    if (!navigator.onLine) {
      batches = readLocalCloudCache();
      normaliseBatches();
      renderBatches();
      setCloudStatus('offline', '离线：显示本机缓存');
      return;
    }

    const { data, error } = await supabaseClient
      .from(CLOUD_TABLE)
      .select('id,payload,updated_at')
      .order('updated_at', { ascending: false });

    if (error) {
      console.error(error);
      const cache = readLocalCloudCache();
      if (cache.length) {
        batches = cache;
        normaliseBatches();
        renderBatches();
        setCloudStatus('error', '云端读取失败，显示本机缓存');
        return;
      }
      batches = [];
      renderBatches();
      setCloudStatus('error', `云端读取失败：${error.message}`);
      return;
    }

    batches = (data || [])
      .map(row => row.payload)
      .filter(Boolean);
    normaliseBatches();
    cloudKnownIds = new Set(batches.map(batch => batch.id));
    saveLocalCloudCache();
    renderBatches();
    setCloudStatus('online', '云端已同步');

    if (openBatchId && batches.some(batch => batch.id === openBatchId)) {
      activeBatchId = openBatchId;
      renderBatch();
    }
  }

  async function flushCloudSync() {
    clearTimeout(cloudSyncTimer);
    if (cloudSyncRunning || !currentUser || !supabaseClient) return;
    if (!navigator.onLine) {
      setCloudStatus('offline', '离线：修改将在联网后同步');
      return;
    }

    cloudSyncRunning = true;
    setCloudStatus('syncing', '正在同步云端…');

    try {
      if (batches.length) {
        const rows = batches.map(batch => ({
          user_id: currentUser.id,
          id: batch.id,
          payload: batch,
          created_at: batch.createdAt || new Date().toISOString(),
          updated_at: batch.updatedAt || new Date().toISOString()
        }));

        const { error } = await supabaseClient
          .from(CLOUD_TABLE)
          .upsert(rows, { onConflict: 'user_id,id' });

        if (error) throw error;
        cloudKnownIds = new Set(batches.map(batch => batch.id));
      }

      saveLocalCloudCache();
      setCloudStatus('online', '所有修改已同步');
    } catch (error) {
      console.error('Cloud sync failed:', error);
      setCloudStatus('error', `同步失败：${error.message}`);
    } finally {
      cloudSyncRunning = false;
    }
  }

  async function deleteBatchFromCloud(batchId) {
    if (!currentUser || !supabaseClient || !navigator.onLine) {
      cloudKnownIds.delete(batchId);
      setCloudStatus('offline', '离线删除尚未同步');
      return;
    }

    const { error } = await supabaseClient
      .from(CLOUD_TABLE)
      .delete()
      .eq('id', batchId);

    if (error) {
      setCloudStatus('error', `云端删除失败：${error.message}`);
      throw error;
    }

    cloudKnownIds.delete(batchId);
    setCloudStatus('online', '云端已同步');
  }

  function subscribeToCloudChanges() {
    unsubscribeFromCloudChanges();
    if (!currentUser || !supabaseClient) return;

    realtimeChannel = supabaseClient
      .channel(`return-batches-${currentUser.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: CLOUD_TABLE,
          filter: `user_id=eq.${currentUser.id}`
        },
        handleCloudChange
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          setCloudStatus('online', '云端实时同步已开启');
        }
      });
  }

  function unsubscribeFromCloudChanges() {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
    }
    realtimeChannel = null;
  }

  function handleCloudChange(change) {
    if (!currentUser) return;

    if (change.eventType === 'DELETE') {
      const id = change.old?.id;
      if (!id) return;
      const index = batches.findIndex(batch => batch.id === id);
      if (index >= 0) batches.splice(index, 1);
      if (activeBatchId === id && els.batchDialog.open) {
        els.batchDialog.close();
        activeBatchId = null;
        showToast('这张退货单已在另一台设备删除');
      }
      saveLocalCloudCache();
      renderBatches();
      return;
    }

    const remote = change.new?.payload;
    if (!remote?.id) return;

    const index = batches.findIndex(batch => batch.id === remote.id);
    const local = index >= 0 ? batches[index] : null;
    const remoteTime = new Date(remote.updatedAt || 0).getTime();
    const localTime = new Date(local?.updatedAt || 0).getTime();

    if (local && remoteTime <= localTime) return;

    if (index >= 0) batches[index] = remote;
    else batches.unshift(remote);

    normaliseBatches();
    saveLocalCloudCache();
    renderBatches();

    if (activeBatchId === remote.id && els.batchDialog.open) {
      renderBatch();
      showToast('已同步另一台设备的更新');
    }
  }

  async function maybeImportLocalData() {
    if (!currentUser || !supabaseClient) return;
    const marker = `${LOCAL_IMPORT_MARK_PREFIX}${currentUser.id}`;
    if (localStorage.getItem(marker)) return;

    const localBatches = readLegacyLocalBatches();
    if (!localBatches.length) {
      localStorage.setItem(marker, 'none');
      return;
    }

    const shouldImport = confirm(
      `检测到这台设备中有 ${localBatches.length} 张旧版退货单。是否上传到当前账户的云端？`
    );

    if (!shouldImport) {
      localStorage.setItem(marker, 'skipped');
      return;
    }

    setCloudStatus('syncing', '正在迁移旧版退货数据…');
    const imported = [];

    for (const batch of localBatches) {
      const copy = JSON.parse(JSON.stringify(batch));
      copy.userImportedAt = new Date().toISOString();

      for (const item of copy.items || []) {
        const uploadedPaths = [];
        for (const oldPhotoId of item.photos || []) {
          try {
            if (isCloudPhotoPath(oldPhotoId)) {
              uploadedPaths.push(oldPhotoId);
              continue;
            }
            const blob = await getLocalPhoto(oldPhotoId);
            if (!blob) continue;
            const path = `${currentUser.id}/${copy.id}/${item.id}/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
            await putPhoto(path, blob);
            uploadedPaths.push(path);
          } catch (error) {
            console.warn('Legacy photo migration failed:', error);
          }
        }
        item.photos = uploadedPaths;
      }

      copy.updatedAt = new Date().toISOString();
      imported.push(copy);
    }

    const existingIds = new Set(batches.map(batch => batch.id));
    for (const batch of imported) {
      if (!existingIds.has(batch.id)) batches.push(batch);
    }

    normaliseBatches();
    saveBatches();
    await flushCloudSync();
    localStorage.setItem(marker, 'done');
    renderBatches();
    showToast(`已把 ${imported.length} 张旧版退货单迁移到云端`);
  }

  function readLegacyLocalBatches() {
    const keys = [STORAGE_KEY, LEGACY_BATCH_KEY];
    for (const key of keys) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(value) && value.length) return value;
      } catch {
        // Try next legacy key.
      }
    }
    return [];
  }

  function isMobileLayout() {
    return window.matchMedia('(max-width: 820px)').matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch {
      // Ignore unsupported or already-released wake locks.
    }
    wakeLock = null;
  }

  function registerServiceWorker() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (els.batchDialog.open) requestWakeLock();
        if (currentUser && navigator.onLine) {
          flushCloudSync();
        }
      }
    });

    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (els.batchDialog.open && viewMode === 'process') refreshCameraDevices(false);
    });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
    }
  }
})();
