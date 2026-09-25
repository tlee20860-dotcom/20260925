/* ============================================================================
 * main.js — 權限、對話框、事件綁定、模擬調度、啟動
 * v8.1 P6
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
   權限
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

/* 取得「目前環境」的有效編輯權限 */
function effectiveCanEditData(){
  if(window.SLG.isInRoom && window.SLG.isInRoom()){
    return window.SLG.canEditRoomData && window.SLG.canEditRoomData();
  }
  return Auth() && Auth().canEditData();
}
function effectiveCanImportExcel(){
  if(window.SLG.isInRoom && window.SLG.isInRoom()){
    return window.SLG.getEffectiveImportExcelPermission &&
           window.SLG.getEffectiveImportExcelPermission();
  }
  return Auth() && Auth().canImportExcel();
}

function applyPermissions(){
  const signedIn = state.auth.signedIn;
  const isGuest = state.auth.isGuest;

  /* ── 1. Tab 可見性（v8.1 矩陣） ── */
  const guestAllowed  = ['tab-rules'];
  const memberAllowed = [
    'tab-room', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat', 'tab-rules'
  ];
  const adminAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat', 'tab-account', 'tab-rules'
  ];
  const superAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-viz', 'tab-dyn', 'tab-narrative', 'tab-chat', 'tab-account',
    'tab-accounts', 'tab-rules'
  ];

  document.querySelectorAll('.top-nav button[data-tab]').forEach(btn => {
    const tabId = btn.dataset.tab;
    let allowed = false;

    if(isGuest || !signedIn){
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
  togglePerm(document.getElementById('btnJoinRoom'),
    signedIn && !isGuest, '請先登入');

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

  /* ── 6. 檔案協作區 ── */
  const canImportExcel = effectiveCanImportExcel();
  togglePerm(document.getElementById('btnOpenExcelImport'), canImportExcel, '需要 Excel 匯入權限');
  togglePerm(document.getElementById('btnImportJSON'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnRestoreBackup'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnExportJSON'), signedIn && !isGuest, '請先登入');
  togglePerm(document.getElementById('btnExportCitiesCSV'), signedIn && !isGuest, '請先登入');
  togglePerm(document.getElementById('btnExportRoutesCSV'), signedIn && !isGuest, '請先登入');

  /* ── 7. 聊天室 ── */
  togglePerm(document.getElementById('btnSendChat'), signedIn && !isGuest, '請先登入');
  const chatInputEl = document.getElementById('chatInput');
  if(chatInputEl) chatInputEl.disabled = !signedIn || isGuest;

  /* ── 8. 動態生成的編輯/刪除按鈕 ── */
  document.querySelectorAll(
    '[data-action="edit-city"],[data-action="del-city"],' +
    '[data-action="edit-alliance"],[data-action="del-alliance"],' +
    '[data-action="del-zone"],[data-deploy-edit]'
  ).forEach(b => {
    togglePerm(b, canEditData, '需要編輯資料權限');
  });

  /* ── 9. P6：房間編輯申請按鈕 ── */
  if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
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

  /* Worker 不可用 → 主執行緒同步執行 */
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

  if(state.isHost && window.SLG.isConnected && window.SLG.isConnected()){
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

  /* 只有房主 / 管理員可看 */
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

  /* 隱藏自己送出的申請（管理員不需申請；房主也不會申請） */
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

  /* 綁定按鈕事件 */
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

  /* ── 帳號 UI 綁定 ── */
  if(window.SLG.bindAuthUI) window.SLG.bindAuthUI();

  /* ── 指揮官名稱輸入 ── */
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
    if(!requirePerm(() => state.auth.signedIn && !state.auth.isGuest, '請先登入才能加入房間')) return;
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

  /* ── 推送按鈕 ── */
  const btnRequestPush = document.getElementById('btnRequestPush');
  if(btnRequestPush) btnRequestPush.addEventListener('click', window.SLG.requestPushToRoom);

  const btnApprove = document.getElementById('pushRequestApprove');
  if(btnApprove) btnApprove.addEventListener('click', window.SLG.approvePush);
  const btnReject = document.getElementById('pushRequestReject');
  if(btnReject) btnReject.addEventListener('click', window.SLG.rejectPush);

  /* ── 退出房間選項 ── */
  document.querySelectorAll('[data-exit-choice]').forEach(btn => {
    btn.addEventListener('click', function(){
      window.SLG.confirmExit(this.dataset.exitChoice);
    });
  });
  const exitCancel = document.getElementById('exitRoomCancel');
  if(exitCancel) exitCancel.addEventListener('click', () => {
    document.getElementById('exitRoomModal').classList.remove('show');
  });

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
    showConfirm('重置所有數據', '⚠️ 這將清除所有資料！確定嗎？', () => {
      localStorage.removeItem(LS_PREFIX + 'state');
      localStorage.removeItem(AI_LS_KEY);
      localStorage.removeItem(LS_PREFIX + 'localBackup');
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

  /* ── 檔案協作 ── */
  document.getElementById('btnExportJSON').addEventListener('click', window.SLG.exportSandboxJSON);
  document.getElementById('btnImportJSON').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', function(){
    if (this.files && this.files[0]) window.SLG.importSandboxJSON(this.files[0]);
    this.value = '';
  });
  document.getElementById('btnGenerateShareLink').addEventListener('click', window.SLG.generateShareLink);
  document.getElementById('btnCopyShareLink').addEventListener('click', window.SLG.copyShareLink);
  document.getElementById('importModeOverwrite').addEventListener('click', () => window.SLG.applyImport('overwrite'));
  document.getElementById('importModeMerge').addEventListener('click', () => window.SLG.applyImport('merge'));
  document.getElementById('importModeCancel').addEventListener('click', () => {
    document.getElementById('importModal').classList.remove('show');
  });

  const btnRestore = document.getElementById('btnRestoreBackup');
  if(btnRestore) btnRestore.addEventListener('click', window.SLG.restoreLocalBackup);

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
    if(!requirePerm(() => state.auth.signedIn && !state.auth.isGuest, '請先登入才能聊天')) return;
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

  /* ── ★ P6：申請編輯權限按鈕 ── */
  const btnRequestRoomEdit = document.getElementById('btnRequestRoomEdit');
  if(btnRequestRoomEdit){
    btnRequestRoomEdit.addEventListener('click', () => {
      window.SLG.requestRoomEditAccess();
    });
  }

  /* ── ★ P6：審核彈窗關閉 ── */
  const btnReviewClose = document.getElementById('editRequestReviewClose');
  if(btnReviewClose){
    btnReviewClose.addEventListener('click', () => {
      document.getElementById('editRequestReviewModal').classList.remove('show');
    });
  }

  /* ── 卸載時釋放 ── */
  window.addEventListener('beforeunload', saveState);
  window.addEventListener('beforeunload', () => {
    try{ releaseWorker(); }catch(e){}
  });

  /* ── 初始化子模組 ── */
  DEPLOY().init();
  if(window.SLG.Accounts) window.SLG.Accounts.init();
}

/* ============================================================
   事件監聽
   ============================================================ */
function bindEvents(){
  on(EVT.DEBUG, (p) => R().renderDebug(p));

  on(EVT.AUTH, () => {
    if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
    applyPermissions();
    if(window.SLG.updateGuestModeBanner) window.SLG.updateGuestModeBanner(state.auth.isGuest);
    updateModeBar();
  });

  on(EVT.CONN, () => {
    R().renderHealth();
    R().renderHost();
    updateModeBar();
    /* ★ P6：連線狀態變更 → 重新套用權限（進出房間需刷新編輯按鈕） */
    applyPermissions();
  });

  on(EVT.MEMBERS, () => R().renderMembers());

  on(EVT.HOST, () => {
    R().renderHost();
    updateModeBar();
    /* ★ P6：成為房主 → 重新套用權限 */
    applyPermissions();
  });

  on(EVT.MODE, () => {
    updateModeBar();
    /* ★ P6：模式變更 → 重新套用權限 */
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

  /* ── ★ P6：房間編輯授權變更 ── */
  on(EVT.ROOM_GRANTS, () => {
    if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
    applyPermissions();
    R().renderCities();
    R().renderAlliances();
    R().renderZones();
  });

  /* ── ★ P6：待審核申請變更 ── */
  on(EVT.ROOM_PENDING, () => {
    renderEditRequestReview();
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

  /* 4. 初始化入口門禁（入口遮罩顯示） */
  if(window.SLG.EntryGate){
    window.SLG.EntryGate.init();
    window.SLG.EntryGate.show();
  }

  /* 5. 非同步初始化認證 */
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
      if(window.SLG.updateGuestModeBanner) window.SLG.updateGuestModeBanner(false);
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
      R().renderAll();
      logSystem('🚪 已自動登入，跳過入口');
    } else {
      if(window.SLG.EntryGate) window.SLG.EntryGate.showForm();
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
    }
  })();

  /* 6. 註冊 sender（補丁上傳） */
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
  if(window.SLG.updatePushButtonState) window.SLG.updatePushButtonState();
  updateModeBar();
  if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
  applyPermissions();

  /* 10. 分享連結載入 */
  if (window.SLG.loadFromShareLink && window.SLG.loadFromShareLink()){
    R().renderAll();
    DYN().populateCityFilters();
    DEPLOY().populateZoneFilter();
  }

  console.log('%c[沙盤 v8.1 P6] 7 模組架構 + 房間編輯權限（就緒）', 'color:#22ff88;font-weight:bold;font-size:14px');
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
