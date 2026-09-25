/* ============================================================================
 * main.js — 權限、對話框、事件綁定、模擬調度、啟動
 * v8.2
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, on, emit, EVT,
  uid, esc, logSystem,
  saveState, loadState,
  syncAIParamsToUI, readAIParamsFromUI,
  ROLE, ROLE_LABELS,
  buildFullSnapshot,
  updateModeBar, requestSwitchMode,
  LS_PREFIX, AI_LS_KEY,
  hhmmToMinutes,
  computeAllocation,
  DYN_ROUTE_SAMPLE_SEC,
  getWorker, releaseWorker, bumpSimRunId,
  buildSandboxFileName,
  timeAgo,
} = window.SLG;

const Auth = () => window.SLG.Auth;
const viz = () => window.SLG.viz;
const R = () => window.SLG.R;
const DYN = () => window.SLG.DYN;
const DEPLOY = () => window.SLG.DEPLOY;

/* ============================================================
   確認對話框
   ============================================================ */
let confirmCb = null;
function showConfirm(title, msg, cb){
  document.getElementById('modalTitle').textContent = '⚠️ ' + title;
  document.getElementById('modalMessage').textContent = msg;
  document.getElementById('confirmModal').classList.add('show');
  confirmCb = cb;
}

/* ============================================================
   權限工具
   ============================================================ */
function requirePerm(checkFn, label){
  let ok = false;
  try{ ok = !!checkFn(); }catch(e){ ok = false; }
  if(ok) return true;
  alert('🔒 權限不足：' + label + '\n\n請聯繫管理員開啟權限，或切換至有權限的帳號。');
  return false;
}

function togglePerm(el, enabled, reason){
  if(!el) return;
  if(enabled){
    el.classList.remove('perm-disabled');
    el.removeAttribute('title');
  } else {
    el.classList.add('perm-disabled');
    if(reason) el.title = '🔒 ' + reason;
  }
}

function disableInputs(ids, disabled){
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.disabled = !!disabled;
  });
}

function effectiveCanEditData(){
  if(window.SLG.isInRoom()) return window.SLG.canEditRoomData();
  return Auth() && Auth().canEditData();
}
function effectiveCanImportExcel(){
  if(window.SLG.isInRoom()) return window.SLG.getEffectiveImportExcelPermission();
  return Auth() && Auth().canImportExcel();
}

function applyPermissions(){
  const signedIn = state.auth.signedIn;

  /* ── 1. Tab 可見性（v8.2 最終） ── */
  const guestAllowed  = ['tab-rules'];
  const memberAllowed = [
    'tab-room', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-rules'
  ];
  const adminAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-account', 'tab-rules'
  ];
  const superAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-account', 'tab-accounts', 'tab-rules'
  ];

  document.querySelectorAll('.top-nav button[data-tab]').forEach(btn => {
    const tabId = btn.dataset.tab;
    let allowed = false;

    if(!signedIn){
      allowed = guestAllowed.includes(tabId);
    } else if(Auth() && Auth().isSuperAdmin()){
      allowed = superAllowed.includes(tabId);
    } else if(Auth() && Auth().isAdmin()){
      allowed = adminAllowed.includes(tabId);
    } else {
      allowed = memberAllowed.includes(tabId);
    }
    btn.style.display = allowed ? '' : 'none';
  });

  const activeBtn = document.querySelector('.top-nav button.active');
  if(activeBtn && activeBtn.style.display === 'none'){
    const firstVisible = [...document.querySelectorAll('.top-nav button[data-tab]')]
      .find(b => b.style.display !== 'none');
    if(firstVisible) firstVisible.click();
  }

  /* ── 2. 房間連線區 ── */
  togglePerm(document.getElementById('btnCreateRoom'),
    Auth() && Auth().canCreateRoom(), '需要幹部以上權限');
  togglePerm(document.getElementById('btnJoinRoom'), signedIn, '請先登入');

  /* ── 3. 參數 Tab ── */
  const canEditSettings = Auth() && Auth().canEditSettings();
  ['btnSaveSettings', 'btnResetAll', 'btnAISave', 'btnAIReset'].forEach(id => {
    togglePerm(document.getElementById(id), canEditSettings, '需要管理員以上權限');
  });
  disableInputs([
    'globalTimeLimit','globalMarchTimeSec','globalConsumeMinPerMin','globalConsumeMaxPerMin',
    'globalSiegeEfficiency','globalMaxLossRatio','globalMinLossRatio',
    'aiR25','aiR20','aiR15','aiR12','aiR10','aiR08','aiR06','aiR00',
    'aiTeamFactor','aiWallFactor1','aiWallFactor2','aiDefendFactor','aiMinPct'
  ], !canEditSettings);

  /* ── 4. 參戰盟 Tab ── */
  const canEditData = effectiveCanEditData();
  togglePerm(document.getElementById('btnSaveAlliance'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnCancelAllianceEdit'), canEditData, '需要編輯資料權限');
  disableInputs(['allyName','allyIcon','allySide','allyMemberCount','allyTotalPower'], !canEditData);

  /* ── 5. 城池 Tab ── */
  togglePerm(document.getElementById('btnAddZone'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnOpenNewCity'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnSimulate'),
    Auth() && Auth().canRunSim(), '請先登入');
  const newZoneNameEl = document.getElementById('newZoneName');
  if(newZoneNameEl) newZoneNameEl.disabled = !canEditData;

  /* ── 6. Excel 匯入區 ── */
  const canImportExcel = effectiveCanImportExcel();
  togglePerm(document.getElementById('btnOpenExcelImport'), canImportExcel, '需要 Excel 匯入權限');
  togglePerm(document.getElementById('btnExportCitiesCSV'), signedIn, '請先登入');
  togglePerm(document.getElementById('btnExportRoutesCSV'), signedIn, '請先登入');

  /* ── 7. 聊天室 ── */
  togglePerm(document.getElementById('btnSendChat'), signedIn, '請先登入');
  const chatInputEl = document.getElementById('chatInput');
  if(chatInputEl) chatInputEl.disabled = !signedIn;

  /* ── 8. 動態生成的編輯/刪除按鈕 ── */
  document.querySelectorAll(
    '[data-action="edit-city"],[data-action="del-city"],' +
    '[data-action="edit-alliance"],[data-action="del-alliance"],' +
    '[data-action="del-zone"],[data-deploy-edit]'
  ).forEach(b => {
    togglePerm(b, canEditData, '需要編輯資料權限');
  });

  /* ── 9. P6 房間編輯按鈕 / v8.2 房間沙盤按鈕 ── */
  if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
  if(window.SLG.updateRoomSandboxActions) window.SLG.updateRoomSandboxActions();
}

/* ============================================================
   模擬調度
   ============================================================ */
let simWatchdog = null;

function collectCitiesForSim(zoneId){
  return zoneId === 'all' ? state.cities : state.cities.filter(c => c.zoneId === zoneId);
}

function validateCrossDay(cities, timeLimitMin){
  if(cities.length === 0) return { ok:true };
  const mins = cities.map(c => hhmmToMinutes(c.defStartTime || '19:00'));
  if((Math.max(...mins) - Math.min(...mins)) + timeLimitMin > 1440){
    return { ok: false, msg: '時間跨度 + 時長超過 24 小時。' };
  }
  return { ok:true };
}

function executeSimulation(zoneId){
  if(state.isSimulating) return;

  const timeLimitMin = parseInt(document.getElementById('globalTimeLimit').value) || 120;
  const consumeMinPerMin = parseFloat(document.getElementById('globalConsumeMinPerMin').value) || 10;
  const consumeMaxPerMin = parseFloat(document.getElementById('globalConsumeMaxPerMin').value) || 30;
  const siegeEfficiency = parseFloat(document.getElementById('globalSiegeEfficiency').value) || 1;
  const marchTimeSec = parseInt(document.getElementById('globalMarchTimeSec').value) || 0;
  const maxLossRatio = (parseFloat(document.getElementById('globalMaxLossRatio').value) || 90) / 100;
  const minLossRatio = (parseFloat(document.getElementById('globalMinLossRatio').value) || 10) / 100;

  Object.assign(state.settings, {
    timeLimitMin, consumeMinPerMin, consumeMaxPerMin,
    siegeEfficiency, marchTimeSec, maxLossRatio, minLossRatio
  });
  state.settingsRev++;
  saveState();

  const cities = collectCitiesForSim(zoneId);
  if(cities.length === 0){ logSystem('❌ 無城池資料'); return; }
  const v = validateCrossDay(cities, timeLimitMin);
  if(!v.ok){ logSystem('❌ ' + v.msg); return; }

  const defStartMins = cities.map(c => hhmmToMinutes(c.defStartTime || '19:00'));
  state.simBaseMin = Math.min(...defStartMins);
  state.isSimulating = true;
  state.dynRows = []; state.narrativeLines = [];

  document.getElementById('narrativeOutput').innerHTML = '推演中...';
  DYN().setRows([]);
  viz().reset();
  R().renderProgress(0);

  clearTimeout(simWatchdog);
  simWatchdog = setTimeout(() => {
    if(state.isSimulating){
      console.error('[Sim] watchdog 觸發，強制解鎖');
      state.isSimulating = false;
      R().renderProgress(0);
      logSystem('❌ 推演逾時，已強制中止');
    }
  }, 30000);

  const runId = bumpSimRunId();
  const maxDefStartRel = Math.max(...defStartMins) - state.simBaseMin;
  const maxSec = maxDefStartRel * 60 + timeLimitMin * 60;
  const snapshotSet = viz().getSchedule(maxSec);
  const dynSet = new Set();
  for(let s=0;s<=maxSec;s+=DYN_ROUTE_SAMPLE_SEC) dynSet.add(s);
  dynSet.add(maxSec);
  const dynRowsBuffer = [];

  const worker = getWorker();
  if(worker){
    const onMessage = (e) => {
      const msg = e.data || {};
      if(msg.runId !== runId) return;
      switch(msg.type){
        case 'progress':
          R().renderDebug({msg:`⏳ ${Math.round(msg.progress*100)}%`});
          R().renderProgress(msg.progress);
          break;
        case 'snapshot':
          viz().ingestSnapshot(msg.sec, msg.snap);
          break;
        case 'dyn_sample':
          if(msg.rows) for(const r of msg.rows) dynRowsBuffer.push(r);
          break;
        case 'done':
          worker.removeEventListener('message', onMessage);
          state.dynRows = dynRowsBuffer;
          handleSimulationDone(msg.result);
          break;
        case 'error':
          worker.removeEventListener('message', onMessage);
          logSystem('❌ 推演失敗：' + msg.error);
          state.isSimulating = false;
          clearTimeout(simWatchdog);
          break;
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({
      type:'run',
      payload:{
        cities: JSON.parse(JSON.stringify(cities)),
        settings: {...state.settings},
        snapshotsAt: snapshotSet,
        dynSampleAt: [...dynSet],
        runId
      }
    });
    return;
  }

  setTimeout(async () => {
    try{
      const result = await window.SLG.runSimulation(
        JSON.parse(JSON.stringify(cities)),
        {...state.settings},
        {
          onProgress: ({progress}) => {
            R().renderProgress(progress);
            R().renderDebug({msg:`⏳ ${Math.round(progress*100)}%`});
          },
          onSnapshot: (sec, snap) => viz().ingestSnapshot(sec, snap),
          snapshotAt: new Set(snapshotSet),
          dynSampleAt: new Set(dynSet),
          onDynSample: (sec, rows) => { for(const r of rows) dynRowsBuffer.push(r); },
        }
      );
      state.dynRows = dynRowsBuffer;
      handleSimulationDone(result);
    }catch(err){
      console.error(err);
      state.isSimulating = false;
      clearTimeout(simWatchdog);
    }
  }, 30);
}

function handleSimulationDone(result){
  clearTimeout(simWatchdog);
  R().renderProgress(1);
  setTimeout(() => R().renderProgress(0), 1000);
  if(result.aborted){
    logSystem('⛔ 推演已中止');
    state.isSimulating = false;
    return;
  }
  if(result.minDefStartMin !== undefined) state.simBaseMin = result.minDefStartMin;
  state.narrativeLines = result.narrativeLines || [];
  R().renderNarrative(state.narrativeLines);
  DYN().setRows(state.dynRows);
  DYN().populateCityFilters();
  saveState();

  if(state.isHost && window.SLG.isConnected()){
    window.SLG.publish({ type:'viz_payload', data: viz().getAllSnapshots() });
    window.SLG.publish({ type:'dyn_payload', rows: state.dynRows });
    window.SLG.sendSystemChat('⚡ 推演完成');
  }
  viz().finalize();
  state.isSimulating = false;
  logSystem('✅ 推演完成');
}

/* ============================================================
   ★ P6：審核彈窗渲染
   ============================================================ */
function renderEditRequestReview(){
  const list = document.getElementById('editRequestList');
  const modal = document.getElementById('editRequestReviewModal');
  if(!list || !modal) return;

  const canReview = state.isHost || (Auth() && Auth().isAdmin());
  if(!canReview){
    modal.classList.remove('show');
    return;
  }

  const reqs = Object.entries(state.pendingEditRequests || {});
  if(reqs.length === 0){
    modal.classList.remove('show');
    return;
  }

  const visibleReqs = reqs.filter(([uid]) => uid !== state.auth.accountUid);
  if(visibleReqs.length === 0){
    modal.classList.remove('show');
    return;
  }

  list.innerHTML = visibleReqs.map(([uid, r]) => {
    const time = r.requestedAt
      ? new Date(r.requestedAt).toLocaleTimeString().slice(0,5)
      : '—';
    return `<div class="edit-request-item" data-uid="${esc(uid)}">
      <div class="edit-request-info">
        <div class="edit-request-name">🙋 ${esc(r.displayName || r.username || uid)}</div>
        <div class="edit-request-time">申請於 ${esc(time)}</div>
      </div>
      <div class="edit-request-actions">
        <button class="btn btn-danger btn-sm" data-action="reject-edit-req" data-uid="${esc(uid)}">拒絕</button>
        <button class="btn btn-success btn-sm" data-action="approve-edit-req" data-uid="${esc(uid)}">批准</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="approve-edit-req"]').forEach(btn => {
    btn.addEventListener('click', function(){
      const uid = this.dataset.uid;
      const item = this.closest('.edit-request-item');
      if(item) item.classList.add('removing');
      window.SLG.approveEditRequest(uid);
    });
  });
  list.querySelectorAll('[data-action="reject-edit-req"]').forEach(btn => {
    btn.addEventListener('click', function(){
      const uid = this.dataset.uid;
      const item = this.closest('.edit-request-item');
      if(item) item.classList.add('removing');
      window.SLG.rejectEditRequest(uid);
    });
  });

  modal.classList.add('show');
}

/* ============================================================
   ★ v8.2：房間空沙盤提示 Modal
   ============================================================ */
function showRoomEmptyPrompt(){
  if(!window.SLG.isInRoom()) return;
  if(state.roomHasSnapshot) return;
  if(!window.SLG.canUploadSandboxToRoom()) return;
  const modal = document.getElementById('roomEmptyPromptModal');
  if(!modal) return;
  modal.classList.add('show');
}

function hideRoomEmptyPrompt(){
  const modal = document.getElementById('roomEmptyPromptModal');
  if(modal) modal.classList.remove('show');
}

/* ============================================================
   ★ v8.2：上載沙盤至房間
   ============================================================ */
async function uploadMySandboxToRoom(){
  if(!window.SLG.canUploadSandboxToRoom()){
    alert('您沒有上載沙盤的權限');
    return;
  }
  if(!window.SLG.isConnected()){
    alert('請先加入房間');
    return;
  }
  const myData = window.SLG.buildSandboxData();
  const fileName = buildSandboxFileName(state.auth.displayName, Date.now());
  if(!confirm(`確定要將「我的沙盤」上載到房間嗎？\n\n這會覆蓋房間目前的沙盤。`)) return;
  try{
    await window.SLG.uploadSandboxToRoom(myData, fileName);
    hideRoomEmptyPrompt();
    alert('✅ 已上載沙盤到房間！');
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  }catch(e){
    console.warn(e);
  }
}

/* ============================================================
   ★ v8.2：從沙盤清單選一個上載到房間
   ============================================================ */
async function openSandboxPicker(){
  const modal = document.getElementById('sandboxPickerModal');
  const tbody = document.getElementById('sandboxPickerTableBody');
  if(!modal || !tbody) return;

  modal.classList.add('show');
  tbody.innerHTML = '<tr><td colspan="5" class="sandbox-empty">載入中...</td></tr>';

  try{
    const all = await window.SLG.fetchAllSandboxes();
    const list = Object.entries(all)
      .map(([uid, sb]) => ({ uid, ...sb }))
      .filter(sb => window.SLG.canViewSandboxOf(sb.uid, sb.role || 'member'))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if(list.length === 0){
      tbody.innerHTML = '<tr><td colspan="5" class="sandbox-empty">無可用沙盤</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(sb => {
      const isSelf = sb.uid === state.auth.accountUid;
      const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);
      const cityCount = sb.data?.cities?.length || 0;
      return `<tr class="${isSelf ? 'row-self' : ''}">
        <td class="sandbox-name">${esc(fileName)}${isSelf ? ' <span class="chip" style="font-size:9px;color:var(--neon-yellow);">你</span>' : ''}</td>
        <td class="sandbox-owner">${esc(sb.displayName || sb.username || '—')}</td>
        <td class="col-num">${cityCount}</td>
        <td class="sandbox-time">${esc(timeAgo(sb.updatedAt))}</td>
        <td class="col-actions">
          <button class="btn btn-primary btn-sm" data-action="pick-sandbox" data-uid="${sb.uid}">📤 上載到房間</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="pick-sandbox"]').forEach(btn => {
      btn.addEventListener('click', async function(){
        const uid = this.dataset.uid;
        const sb = all[uid];
        if(!sb || !sb.data){
          alert('沙盤資料為空');
          return;
        }
        const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);
        if(!confirm(`確定要將「${fileName}」上載到房間嗎？\n\n這會覆蓋房間目前的沙盤。`)) return;

        modal.classList.remove('show');
        try{
          await window.SLG.uploadSandboxToRoom(sb.data, fileName);
          hideRoomEmptyPrompt();
          alert('✅ 已上載沙盤到房間！');
          R().renderAll();
          if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
        }catch(e){
          console.warn(e);
        }
      });
    });
  }catch(e){
    tbody.innerHTML = '<tr><td colspan="5" class="sandbox-empty">載入失敗</td></tr>';
    console.warn(e);
  }
}

/* ============================================================
   ★ v8.2：下載房間沙盤到我的沙盤
   ============================================================ */
async function downloadRoomSandbox(){
  if(!state.roomHasSnapshot || !state.roomSnapshot){
    alert('房間尚無沙盤');
    return;
  }

  const fileName = window.SLG.buildSandboxFileName(state.auth.displayName, Date.now());
  if(!confirm(`確定要把房間沙盤下載到你的個人沙盤嗎？\n\n這會覆蓋你目前的個人沙盤。`)) return;

  try{
    /* 先把目前沙盤備份到 localStorage */
    backupCurrentSandbox();

    window.SLG.applySandboxData(state.roomSnapshot.data);
    saveState();
    await window.SLG.saveMySandbox();
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    alert('✅ 已下載房間沙盤到你的個人沙盤！');
  }catch(e){
    console.warn(e);
    alert('下載失敗：' + e.message);
  }
}

/* ============================================================
   ★ v8.2：從沙盤清單載入
   ============================================================ */
async function loadSandboxFromList(uid){
  if(!uid) return;
  try{
    const sb = await window.SLG.fetchUserSandbox(uid);
    if(!sb || !sb.data){
      alert('沙盤資料為空');
      return;
    }
    const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);

    /* 顯示確認 */
    const ok = confirm(
      `確定要載入「${fileName}」嗎？\n\n` +
      `這會覆蓋你目前的個人沙盤。\n` +
      `（原沙盤會自動備份到本機）`
    );
    if(!ok) return;

    /* 備份目前沙盤 */
    backupCurrentSandbox();

    /* 套用並上傳到個人雲端沙盤 */
    window.SLG.applySandboxData(sb.data);
    saveState();
    await window.SLG.saveMySandbox();
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    alert(`✅ 已載入「${fileName}」到你的沙盤！`);
    logSystem(`📥 已載入 ${fileName} 到個人沙盤`);
  }catch(e){
    console.warn(e);
    alert('載入失敗：' + e.message);
  }
}

function backupCurrentSandbox(){
  try{
    const key = LS_PREFIX + 'sandboxBackup_' + Date.now();
    const data = {
      backedUpAt: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(state.settings)),
      alliances: JSON.parse(JSON.stringify(state.alliances)),
      zones: JSON.parse(JSON.stringify(state.zones)),
      cities: JSON.parse(JSON.stringify(state.cities)),
    };
    localStorage.setItem(key, JSON.stringify(data));
    logSystem(`💾 已備份目前沙盤（key: ${key}）`);

    /* 清理過舊備份（保留最近 5 個） */
    const keys = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith(LS_PREFIX + 'sandboxBackup_')) keys.push(k);
    }
    keys.sort();
    while(keys.length > 5){
      localStorage.removeItem(keys.shift());
    }
  }catch(e){ console.warn('備份失敗', e); }
}

/* ============================================================
   事件綁定
   ============================================================ */
function bindUI(){
  /* ── 頂部 Tab 切換 ── */
  document.querySelectorAll('.top-nav button').forEach(btn => {
    btn.addEventListener('click', function(){
      document.querySelectorAll('.top-nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const tabId = this.dataset.tab;
      document.getElementById(tabId).classList.add('active');
      if(tabId === 'tab-cities') R().renderCities();
      if(tabId === 'tab-alliances') R().renderAlliances();
      if(tabId === 'tab-dyn'){ DYN().setRows(state.dynRows); DYN().populateCityFilters(); }
      if(tabId === 'tab-narrative'){ R().renderNarrative(state.narrativeLines); }
      if(tabId === 'tab-viz') requestAnimationFrame(() => requestAnimationFrame(() => viz().activate()));
      if(tabId === 'tab-params') syncAIParamsToUI();
      if(tabId === 'tab-deploy'){ DEPLOY().populateZoneFilter(); DEPLOY().render(); }
      if(tabId === 'tab-sandbox'){
        /* 進入沙盤數據 Tab 時，非同步載入清單 */
        refreshSandboxList();
      }
      if(tabId === 'tab-accounts'){
        if(Auth() && (Auth().isSuperAdmin() || Auth().isAdmin())){
          window.SLG.Accounts.refresh();
        }
      }
      if(tabId === 'tab-chat'){
        state.unreadChat = 0;
        R().renderChatBadge();
        R().renderChat();
        const el = document.getElementById('chatMessages');
        if(el) el.scrollTop = el.scrollHeight;
      }
    });
  });

  /* ── 模式切換 ── */
  const btnSwitchMode = document.getElementById('btnSwitchMode');
  if(btnSwitchMode) btnSwitchMode.addEventListener('click', requestSwitchMode);

  /* ── 帳號 UI ── */
  if(window.SLG.bindAuthUI) window.SLG.bindAuthUI();

  /* ── 指揮官名稱 ── */
  const nameInput = document.getElementById('commanderName');
  nameInput.addEventListener('input', function(){
    state.commanderName = this.value.trim();
    saveState();
  });

  /* ── 建立房間 ── */
  document.getElementById('btnCreateRoom').addEventListener('click', async () => {
    if(!requirePerm(() => Auth() && Auth().canCreateRoom(), '建立房間')) return;
    const name = nameInput.value.trim();
    if(!name){ alert('請先填寫指揮官名稱'); return; }
    const db = window.SLG.getDb();
    if(!db){ alert('Firebase 尚未初始化'); return; }
    state.commanderName = name;

    let code = null;
    for(let i = 0; i < 10; i++){
      const candidate = String(Math.floor(100000 + Math.random()*900000));
      try{
        const snap = await db.ref(`rooms/${candidate}/presence`).once('value');
        if(!snap.exists()){ code = candidate; break; }
      }catch(e){ code = candidate; break; }
    }
    if(!code){ alert('無法生成房間碼'); return; }

    document.getElementById('roomCode').value = code;
    window.SLG.connectFirebase(code, true);
    saveState();
  });

  /* ── 加入房間 ── */
  document.getElementById('btnJoinRoom').addEventListener('click', () => {
    if(!requirePerm(() => state.auth.signedIn, '請先登入才能加入房間')) return;
    const name = nameInput.value.trim();
    if(!name){ alert('請先填寫指揮官名稱'); return; }
    const code = document.getElementById('roomCode').value.trim();
    if(code.length !== 6){ alert('請輸入6位數房間碼'); return; }
    state.commanderName = name;
    window.SLG.connectFirebase(code, false);
    saveState();
  });

  /* ── 中斷連線 ── */
  document.getElementById('btnDisconnect').addEventListener('click', () => {
    window.SLG.requestDisconnect();
  });

  /* ── 房間沙盤操作 ── */
  const btnUploadSandbox = document.getElementById('btnUploadSandboxToRoom');
  if(btnUploadSandbox) btnUploadSandbox.addEventListener('click', uploadMySandboxToRoom);

  const btnDownloadRoomSandbox = document.getElementById('btnDownloadRoomSandbox');
  if(btnDownloadRoomSandbox) btnDownloadRoomSandbox.addEventListener('click', downloadRoomSandbox);

  /* ── P6：申請編輯權限 ── */
  const btnRequestRoomEdit = document.getElementById('btnRequestRoomEdit');
  if(btnRequestRoomEdit){
    btnRequestRoomEdit.addEventListener('click', () => {
      window.SLG.requestRoomEditAccess();
    });
  }

  /* ── P6：審核彈窗關閉 ── */
  const btnReviewClose = document.getElementById('editRequestReviewClose');
  if(btnReviewClose){
    btnReviewClose.addEventListener('click', () => {
      document.getElementById('editRequestReviewModal').classList.remove('show');
    });
  }

  /* ── v8.2：房間空沙盤提示 ── */
  document.querySelectorAll('[data-room-action]').forEach(btn => {
    btn.addEventListener('click', function(){
      const action = this.dataset.roomAction;
      if(action === 'uploadMine'){
        uploadMySandboxToRoom();
      } else if(action === 'pickFromList'){
        hideRoomEmptyPrompt();
        openSandboxPicker();
      } else if(action === 'stayEmpty'){
        hideRoomEmptyPrompt();
      }
    });
  });

  const roomEmptyCancel = document.getElementById('roomEmptyCancel');
  if(roomEmptyCancel) roomEmptyCancel.addEventListener('click', hideRoomEmptyPrompt);

  /* ── v8.2：沙盤清單選擇彈窗 ── */
  const sandboxPickerCancel = document.getElementById('sandboxPickerCancel');
  if(sandboxPickerCancel) sandboxPickerCancel.addEventListener('click', () => {
    document.getElementById('sandboxPickerModal').classList.remove('show');
  });

  /* ── v8.2：沙盤數據重整 ── */
  const btnSandboxRefresh = document.getElementById('btnSandboxesRefresh');
  if(btnSandboxRefresh) btnSandboxRefresh.addEventListener('click', refreshSandboxList);

  /* ── v8.2：救援工具 ── */
  const btnRescue = document.getElementById('btnRescueRoom');
  if(btnRescue){
    btnRescue.addEventListener('click', async () => {
      const roomCode = document.getElementById('rescueRoomCode').value.trim();
      const statusEl = document.getElementById('rescueStatus');
      if(!roomCode || roomCode.length !== 6){
        alert('請輸入 6 位數房間碼');
        return;
      }
      if(!confirm(`確定要重建房間 ${roomCode} 的沙盤嗎？\n\n⚠️ 這會覆蓋該房間目前的 latestSnapshot！`)) return;

      statusEl.textContent = '⏳ 正在重播事件流...';
      btnRescue.disabled = true;
      try{
        const result = await window.SLG.rescueRoomSnapshot(roomCode);
        statusEl.innerHTML = `✅ 重建完成：${result.eventsCount} 個事件 / ${result.patchesCount} 個補丁<br>` +
          `→ 城池 ${result.citiesCount} 座 / 同盟 ${result.alliancesCount} 個`;
        alert('✅ 救援成功！');
      }catch(e){
        statusEl.textContent = '❌ 失敗：' + e.message;
        alert('❌ 救援失敗：' + e.message);
      }finally{
        btnRescue.disabled = false;
      }
    });
  }

  /* ── 儲存戰鬥參數 ── */
  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '修改戰鬥參數')) return;
    window.SLG.updateSettings({
      timeLimitMin: parseInt(document.getElementById('globalTimeLimit').value) || 120,
      consumeMinPerMin: parseFloat(document.getElementById('globalConsumeMinPerMin').value) || 10,
      consumeMaxPerMin: parseFloat(document.getElementById('globalConsumeMaxPerMin').value) || 30,
      siegeEfficiency: parseFloat(document.getElementById('globalSiegeEfficiency').value) || 1,
      marchTimeSec: parseInt(document.getElementById('globalMarchTimeSec').value) || 0,
      maxLossRatio: (parseFloat(document.getElementById('globalMaxLossRatio').value) || 90) / 100,
      minLossRatio: (parseFloat(document.getElementById('globalMinLossRatio').value) || 10) / 100,
    });
    R().renderMatrix();
    alert('戰鬥參數已儲存');
  });

  /* ── 重置所有數據 ── */
  document.getElementById('btnResetAll').addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '重置資料')) return;
    showConfirm('重置所有數據', '⚠️ 這將清除本機所有資料，並重置雲端沙盤！確定嗎？', async () => {
      localStorage.removeItem(LS_PREFIX + 'state');
      localStorage.removeItem(AI_LS_KEY);
      try{
        /* 清空雲端沙盤 */
        const db = window.SLG.getDb();
        if(db && state.auth.accountUid){
          state.settings = {
            timeLimitMin:120, consumeMinPerMin:10, consumeMaxPerMin:30,
            siegeEfficiency:1, marchTimeSec:0, maxLossRatio:0.9, minLossRatio:0.1
          };
          state.alliances = [];
          state.zones = [];
          state.cities = [];
          await window.SLG.saveMySandbox();
        }
      }catch(e){}
      location.reload();
    });
  });

  /* ── AI 參數 ── */
  document.getElementById('btnAISave').addEventListener('click', function(){
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '修改 AI 參數')) return;
    window.SLG.AI.setParams(readAIParamsFromUI());
    window.SLG.AI.saveParams();
    alert('AI 參數已儲存');
  });
  document.getElementById('btnAIReset').addEventListener('click', function(){
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '恢復 AI 預設')) return;
    showConfirm('恢復 AI 預設參數', '這會將所有 AI 參數恢復為預設值，確定嗎？', () => {
      window.SLG.AI.resetParams();
      syncAIParamsToUI();
      logSystem('🔄 AI 參數已恢復預設');
    });
  });
  ['aiR25','aiR20','aiR15','aiR12','aiR10','aiR08','aiR06','aiR00',
   'aiTeamFactor','aiWallFactor1','aiWallFactor2','aiDefendFactor','aiMinPct'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => window.SLG.AI.setParams(readAIParamsFromUI()));
  });

  /* ── 同盟表單 ── */
  document.getElementById('allyMemberCount').addEventListener('input', window.SLG.updateAllianceAvgPowerPreview);
  document.getElementById('allyTotalPower').addEventListener('input', window.SLG.updateAllianceAvgPowerPreview);

  document.getElementById('btnSaveAlliance').addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '編輯同盟')) return;
    const name = document.getElementById('allyName').value.trim();
    if(!name){ alert('請輸入同盟名稱'); return; }
    const icon = document.getElementById('allyIcon').value.trim();
    const side = document.getElementById('allySide').value;
    const memberCount = parseFloat(document.getElementById('allyMemberCount').value) || 0;
    const totalPower = parseFloat(document.getElementById('allyTotalPower').value) || 0;
    if(memberCount <= 0){ alert('總人數必須大於 0'); return; }
    const avgPower = totalPower / memberCount;
    if(side === 'self'){
      state.alliances.forEach(a => {
        if(a.side === 'self' && a.id !== state.editingAllianceId){
          a.side = 'enemy';
          state.entityRev.alliance[a.id] = (state.entityRev.alliance[a.id] || 0) + 1;
          window.SLG.markDirty('alliance', a.id);
        }
      });
    }
    const id = state.editingAllianceId || uid();
    window.SLG.upsertEntity('alliance', {
      id, name, icon, side, memberCount, totalPower, avgPower, power: totalPower
    });
    window.SLG.resetAllianceForm();
    R().renderAlliances();
    saveState();
  });

  document.getElementById('btnCancelAllianceEdit').addEventListener('click', window.SLG.resetAllianceForm);

  document.querySelectorAll('.icon-quick').forEach(btn => {
    btn.addEventListener('click', function(){
      document.getElementById('allyIcon').value = this.dataset.icon || '';
    });
  });

  document.getElementById('allianceTableBody').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-action="edit-alliance"]');
    const delBtn = e.target.closest('[data-action="del-alliance"]');
    if(editBtn){
      if(!requirePerm(() => effectiveCanEditData(), '編輯同盟')) return;
      window.SLG.startEditAlliance(editBtn.dataset.id);
      return;
    }
    if(delBtn){
      if(!requirePerm(() => effectiveCanEditData(), '刪除同盟')) return;
      const a = state.alliances.find(x => x.id === delBtn.dataset.id);
      if(!a) return;
      showConfirm('刪除同盟', `確定刪除「${a.name}」？`, () => {
        if(state.editingAllianceId === a.id) window.SLG.resetAllianceForm();
        window.SLG.deleteEntity('alliance', a.id);
        R().renderAlliances();
        saveState();
      });
    }
  });

  /* ── 戰區 ── */
  document.getElementById('btnAddZone').addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '新增戰區')) return;
    const name = document.getElementById('newZoneName').value.trim();
    if(!name) return;
    window.SLG.upsertEntity('zone', { id: uid(), name });
    document.getElementById('newZoneName').value = '';
    R().renderZones(); R().renderCities();
    saveState();
  });

  document.getElementById('zoneList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="del-zone"]');
    if(!btn) return;
    if(!requirePerm(() => effectiveCanEditData(), '刪除戰區')) return;
    showConfirm('刪除戰區', '確定刪除？', () => {
      window.SLG.deleteEntity('zone', btn.dataset.id);
      R().renderZones(); R().renderCities();
      saveState();
    });
  });

  /* ── 新增城池 ── */
  document.getElementById('btnOpenNewCity').addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '新增城池')) return;
    if(state.zones.length === 0){ alert('請先新增戰區'); return; }
    window.SLG.openCityModal(null);
  });

  document.getElementById('cityList').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-action="edit-city"]');
    const delBtn = e.target.closest('[data-action="del-city"]');
    if(editBtn){
      if(!requirePerm(() => effectiveCanEditData(), '編輯城池')) return;
      window.SLG.openCityModal(editBtn.dataset.id);
      return;
    }
    if(delBtn){
      if(!requirePerm(() => effectiveCanEditData(), '刪除城池')) return;
      showConfirm('刪除城池', '確定刪除？', () => {
        window.SLG.deleteEntity('city', delBtn.dataset.id);
        R().renderCities();
        saveState();
      });
    }
  });

  /* ── 城池 Modal ── */
  document.getElementById('cityModalCancel').addEventListener('click', window.SLG.closeCityModal);
  document.getElementById('cityModalSave').addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '儲存城池')) return;
    window.SLG.saveCityFromModal();
  });
  document.getElementById('cityModalAI').addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '套用 AI 建議')) return;
    window.SLG.applyAISuggestion();
  });

  ['cm_totalPower', 'cm_totalTeams'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      window.SLG.updateAutoCalcFields();
      window.SLG.updateAllocPanel();
    });
  });

  document.getElementById('cm_side').addEventListener('change', function(){
    const newSide = this.value;
    const validAtk = window.SLG.ATTACK_RULES[newSide] || [];
    const validDef = window.SLG.DEFEND_RULES[newSide] || [];
    const { attackTargets, defendTargets } = window.SLG.collectCurrentTargets();
    const fAtk = attackTargets.filter(t => {
      const c = state.cities.find(cc => cc.id === t.cityId);
      return c && validAtk.includes(c.side);
    });
    const fDef = defendTargets.filter(t => {
      const c = state.cities.find(cc => cc.id === t.cityId);
      return c && validDef.includes(c.side);
    });
    window.SLG.updateSectionLabels();
    window.SLG.renderTargetSelectors(fAtk, fDef);
  });

  document.getElementById('cm_zone').addEventListener('change', () => {
    const { attackTargets, defendTargets } = window.SLG.collectCurrentTargets();
    window.SLG.renderTargetSelectors(attackTargets, defendTargets);
  });

  /* ── 執行推演 ── */
  document.getElementById('btnSimulate').addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canRunSim(), '請先登入')) return;
    const zoneId = document.getElementById('simZoneSelect').value;
    if(!window.SLG.isConnected()){
      logSystem('⚠️ 未連線，僅本地推演');
      executeSimulation(zoneId);
      return;
    }
    window.SLG.publish({
      type:'trigger_simulate',
      zoneId,
      clientId:state.myClientId,
      name:state.commanderName
    });
    logSystem(`⚡ ${state.commanderName} 啟動推演`);
    if(state.isHost) executeSimulation(zoneId);
  });

  /* ── 確認 Modal ── */
  document.getElementById('modalCancel').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('show');
    confirmCb = null;
  });
  document.getElementById('modalConfirm').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('show');
    if(confirmCb) confirmCb();
    confirmCb = null;
  });

  /* ── Excel ── */
  const btnOpenExcel = document.getElementById('btnOpenExcelImport');
  if(btnOpenExcel) btnOpenExcel.addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanImportExcel(), 'Excel 匯入')) return;
    window.SLG.openExcelImportModal();
  });

  const btnExportCities = document.getElementById('btnExportCitiesCSV');
  if(btnExportCities) btnExportCities.addEventListener('click', window.SLG.exportCitiesCSV);

  const btnExportRoutes = document.getElementById('btnExportRoutesCSV');
  if(btnExportRoutes) btnExportRoutes.addEventListener('click', window.SLG.exportRoutesCSV);

  const btnTemplate = document.getElementById('btnDownloadTemplate');
  if(btnTemplate) btnTemplate.addEventListener('click', window.SLG.downloadExcelTemplate);

  const excelCancel = document.getElementById('excelImportCancel');
  if(excelCancel) excelCancel.addEventListener('click', window.SLG.closeExcelImportModal);

  const excelConfirm = document.getElementById('excelImportConfirm');
  if(excelConfirm) excelConfirm.addEventListener('click', window.SLG.doExcelImport);

  const citiesTextEl = document.getElementById('excelCitiesText');
  const routesTextEl = document.getElementById('excelRoutesText');
  if(citiesTextEl) citiesTextEl.addEventListener('input', window.SLG.updateExcelPreview);
  if(routesTextEl) routesTextEl.addEventListener('input', window.SLG.updateExcelPreview);

  document.querySelectorAll('[data-excel-upload]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.excelUpload;
      const fileInput = document.getElementById(which === 'cities' ? 'excelCitiesFile' : 'excelRoutesFile');
      if(fileInput) fileInput.click();
    });
  });

  document.querySelectorAll('[data-excel-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.excelClear;
      const textarea = document.getElementById(which === 'cities' ? 'excelCitiesText' : 'excelRoutesText');
      if(textarea){ textarea.value = ''; window.SLG.updateExcelPreview(); }
    });
  });

  const citiesFileEl = document.getElementById('excelCitiesFile');
  if(citiesFileEl){
    citiesFileEl.addEventListener('change', function(){
      if(!this.files || !this.files[0]) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        document.getElementById('excelCitiesText').value = e.target.result;
        window.SLG.updateExcelPreview();
      };
      reader.readAsText(this.files[0], 'UTF-8');
      this.value = '';
    });
  }
  const routesFileEl = document.getElementById('excelRoutesFile');
  if(routesFileEl){
    routesFileEl.addEventListener('change', function(){
      if(!this.files || !this.files[0]) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        document.getElementById('excelRoutesText').value = e.target.result;
        window.SLG.updateExcelPreview();
      };
      reader.readAsText(this.files[0], 'UTF-8');
      this.value = '';
    });
  }

  /* ── 聊天室 ── */
  const chatInput = document.getElementById('chatInput');
  const btnSendChat = document.getElementById('btnSendChat');
  function doSendChat(){
    if(!requirePerm(() => state.auth.signedIn, '請先登入才能聊天')) return;
    const text = chatInput.value.trim();
    if(!text) return;
    window.SLG.sendChatMessage(text);
    chatInput.value = '';
    chatInput.focus();
  }
  if(btnSendChat) btnSendChat.addEventListener('click', doSendChat);
  if(chatInput) chatInput.addEventListener('keydown', e => {
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); doSendChat(); }
  });

  const btnClearChat = document.getElementById('btnClearChat');
  if(btnClearChat){
    btnClearChat.addEventListener('click', () => {
      showConfirm('清空聊天室', '確定要清空本機的聊天記錄嗎？（不影響其他人）', () => {
        state.chatMessages = [];
        state.unreadChat = 0;
        R().renderChat();
        R().renderChatBadge();
        saveState();
      });
    });
  }

  /* ── 卸載 ── */
  window.addEventListener('beforeunload', () => {
    /* ★ v8.2：關閉前先嘗試儲存個人沙盤 */
    if(state.auth.signedIn && window.SLG.saveMySandbox){
      try{ window.SLG.saveMySandbox(); }catch(e){}
    }
    saveState();
    try{ releaseWorker(); }catch(e){}
  });

  /* ── 初始化子模組 ── */
  DEPLOY().init();
  if(window.SLG.Accounts) window.SLG.Accounts.init();
}

/* ============================================================
   ★ v8.2：非同步載入沙盤清單
   ============================================================ */
async function refreshSandboxList(){
  if(!state.auth.signedIn) return;
  try{
    const all = await window.SLG.fetchAllSandboxes();
    state.sandboxesList = all || {};
    emit(EVT.SANDBOXES_LIST_UPDATED);
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    logSystem(`📊 已載入 ${Object.keys(state.sandboxesList).length} 個沙盤`);
  }catch(e){
    console.warn('載入沙盤清單失敗', e);
  }
}

/* ============================================================
   事件監聽
   ============================================================ */
function bindEvents(){
  on(EVT.DEBUG, (p) => R().renderDebug(p));

  on(EVT.AUTH, () => {
    if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
    applyPermissions();
    updateModeBar();
  });

  on(EVT.CONN, () => {
    R().renderHealth();
    R().renderHost();
    updateModeBar();
    applyPermissions();
    /* ★ v8.2：連線後 1 秒檢查是否需要顯示空沙盤提示 */
    if(window.SLG.isConnected() && !state.roomHasSnapshot){
      setTimeout(() => {
        if(window.SLG.isInRoom() && !state.roomHasSnapshot){
          showRoomEmptyPrompt();
        }
      }, 1500);
    }
  });

  on(EVT.MEMBERS, () => R().renderMembers());

  on(EVT.HOST, () => {
    R().renderHost();
    updateModeBar();
    applyPermissions();
  });

  on(EVT.MODE, () => {
    updateModeBar();
    applyPermissions();
  });

  on(EVT.LOCKS, () => {
    R().renderCities();
    if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY().render();
  });

  on(EVT.DATA, () => {
    R().renderAlliances();
    R().renderZones();
    R().renderCities();
    document.getElementById('globalTimeLimit').value = state.settings.timeLimitMin;
    document.getElementById('globalConsumeMinPerMin').value = state.settings.consumeMinPerMin;
    document.getElementById('globalConsumeMaxPerMin').value = state.settings.consumeMaxPerMin;
    document.getElementById('globalSiegeEfficiency').value = state.settings.siegeEfficiency;
    document.getElementById('globalMarchTimeSec').value = state.settings.marchTimeSec;
    document.getElementById('globalMaxLossRatio').value = Math.round(state.settings.maxLossRatio * 100);
    document.getElementById('globalMinLossRatio').value = Math.round(state.settings.minLossRatio * 100);
    if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY().render();
    /* ★ v8.2：沙盤摘要更新 */
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  });

  on(EVT.DYN_RESULT, () => {
    DYN().setRows(state.dynRows);
    DYN().populateCityFilters();
  });

  on(EVT.SIM_TRIGGER, payload => {
    if(payload.name && payload.clientId !== state.myClientId){
      logSystem(`⚡ ${payload.name} 啟動推演`);
    }
    if(state.isHost){
      document.getElementById('simZoneSelect').value = payload.zoneId || 'all';
      executeSimulation(payload.zoneId || 'all');
    }
  });

  /* ── P6：房間編輯授權變更 ── */
  on(EVT.ROOM_GRANTS, () => {
    if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
    applyPermissions();
    R().renderCities();
    R().renderAlliances();
    R().renderZones();
  });

  /* ── P6：待審核申請變更 ── */
  on(EVT.ROOM_PENDING, () => {
    renderEditRequestReview();
  });

  /* ── v8.2：房間沙盤更新 ── */
  on(EVT.ROOM_SNAPSHOT_UPDATED, () => {
    if(window.SLG.updateRoomSandboxActions) window.SLG.updateRoomSandboxActions();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    /* 房間有沙盤了 → 隱藏提示 */
    if(state.roomHasSnapshot) hideRoomEmptyPrompt();
  });

  /* ── v8.2：個人沙盤更新 ── */
  on(EVT.MY_SANDBOX_UPDATED, () => {
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  });

  /* ── v8.2：沙盤清單更新 ── */
  on(EVT.SANDBOXES_LIST_UPDATED, () => {
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  });
}

/* ============================================================
   啟動
   ============================================================ */
function boot(){
  /* 1. 讀取本機狀態 */
  loadState();

  /* 2. 填入 UI 初始值 */
  document.getElementById('commanderName').value = state.commanderName || '';
  document.getElementById('roomCode').value = state.roomCode || '';
  document.getElementById('globalTimeLimit').value = state.settings.timeLimitMin;
  document.getElementById('globalConsumeMinPerMin').value = state.settings.consumeMinPerMin;
  document.getElementById('globalConsumeMaxPerMin').value = state.settings.consumeMaxPerMin;
  document.getElementById('globalSiegeEfficiency').value = state.settings.siegeEfficiency;
  document.getElementById('globalMarchTimeSec').value = state.settings.marchTimeSec;
  document.getElementById('globalMaxLossRatio').value = Math.round(state.settings.maxLossRatio * 100);
  document.getElementById('globalMinLossRatio').value = Math.round(state.settings.minLossRatio * 100);
  syncAIParamsToUI();

  /* 3. 初始化 Firebase */
  window.SLG.initFirebase();

  /* 4. 初始化入口門禁 */
  if(window.SLG.EntryGate){
    window.SLG.EntryGate.init();
    window.SLG.EntryGate.show();
  }

  /* 5. 註冊雲端同步函式 */
  window.SLG.registerCloudSync(() => {
    if(state.auth.signedIn){
      window.SLG.saveMySandbox().catch(e => console.warn('雲端同步失敗', e));
    }
  });
  window.SLG.registerRoomSnapshotSync(() => {
    if(state.isHost){
      window.SLG.publishRoomSnapshot().catch(e => console.warn('房間快照同步失敗', e));
    }
  });

  /* 6. 註冊 sender */
  window.SLG.registerSender(patches => {
    if(!state.connected) return;
    window.SLG.publish({
      type:'sync_patch',
      clientId:state.myClientId,
      lamport:state.lamport,
      patches
    });
  });

  /* 7. 綁定 UI 與事件 */
  bindUI();
  bindEvents();

  /* 8. 初始化子模組 */
  viz().init();
  DYN().init();
  window.SLG.resetAllianceForm();

  /* 9. 首繪 */
  R().renderAll();
  DYN().setRows(state.dynRows);
  DYN().populateCityFilters();
  R().renderNarrative(state.narrativeLines);
  R().renderChat();
  R().renderChatBadge();
  R().renderProgress(0);
  DEPLOY().populateZoneFilter();
  updateModeBar();
  if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
  applyPermissions();

  /* 10. 非同步初始化認證 */
  (async () => {
    let ok = false;
    if(window.SLG.Auth){
      ok = await window.SLG.Auth.initFirebaseAuth();
    }
    let loggedIn = false;
    if(ok){
      loggedIn = await window.SLG.Auth.restoreSession();
    }

    if(loggedIn){
      if(window.SLG.EntryGate) window.SLG.EntryGate.hide();
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
      R().renderAll();
      logSystem('🚪 已自動登入，跳過入口');
      /* 載入沙盤清單（若在沙盤數據 Tab） */
      if(document.getElementById('tab-sandbox')?.classList.contains('active')){
        refreshSandboxList();
      }
    } else {
      if(window.SLG.EntryGate) window.SLG.EntryGate.showForm();
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
    }
  })();

  console.log('%c[沙盤 v8.2] 雲端個人沙盤 + 房間沙盤（就緒）', 'color:#22ff88;font-weight:bold;font-size:14px');
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();