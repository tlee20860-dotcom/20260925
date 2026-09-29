/* ============================================================================
 * main.js — 權限、對話框、事件綁定、模擬調度、啟動
 * v8.8.0：地圖庫事件綁定 + 地圖庫權限控制 + 啟動初始化
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, on, emit, EVT,
  uid, esc, logSystem,
  saveState, saveStateImportant, loadState,
  syncAIParamsToUI, readAIParamsFromUI,
  syncTroopTiersToUI, readTroopTiersFromUI,
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
  isAllianceIconUsed,
  resetAllianceOrder,
  isOnline,
  initNetworkWatcher,
  getSyncPrefs, setSyncPrefs,
  performCloudUpload, startSyncTimer, stopSyncTimer,
  markCloudDirty,
} = window.SLG;

const Auth = () => window.SLG.Auth;
const viz = () => window.SLG.viz;
const R = () => window.SLG.R;
const DYN = () => window.SLG.DYN;
const DEPLOY = () => window.SLG.DEPLOY;
const MapLibrary = () => window.SLG.MapLibrary;

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
function effectiveCanEditMapLibrary(){
  if(!Auth() || !Auth().isSignedIn()) return false;
  if(window.SLG.canEditMapLibrary) return window.SLG.canEditMapLibrary();
  return false;
}

function applyPermissions(){
  const signedIn = state.auth.signedIn;
  const guestAllowed  = ['tab-rules'];
  const memberAllowed = [
    'tab-room', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-summary', 'tab-map', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-account', 'tab-rules'
  ];
  const adminAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-summary', 'tab-map', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-account', 'tab-rules'
  ];
  const superAllowed  = [
    'tab-room', 'tab-params', 'tab-alliances', 'tab-cities', 'tab-deploy',
    'tab-summary', 'tab-map', 'tab-dyn', 'tab-narrative', 'tab-chat',
    'tab-sandbox', 'tab-account', 'tab-accounts', 'tab-rules'
  ];

  document.querySelectorAll('.top-nav button[data-tab]').forEach(btn => {
    const tabId = btn.dataset.tab;
    let allowed = false;
    if(!signedIn){ allowed = guestAllowed.includes(tabId); }
    else if(Auth() && Auth().isSuperAdmin()){ allowed = superAllowed.includes(tabId); }
    else if(Auth() && Auth().isAdmin()){ allowed = adminAllowed.includes(tabId); }
    else { allowed = memberAllowed.includes(tabId); }
    btn.style.display = allowed ? '' : 'none';
  });

  const activeBtn = document.querySelector('.top-nav button.active');
  if(activeBtn && activeBtn.style.display === 'none'){
    const firstVisible = [...document.querySelectorAll('.top-nav button[data-tab]')]
      .find(b => b.style.display !== 'none');
    if(firstVisible) firstVisible.click();
  }

  togglePerm(document.getElementById('btnCreateRoom'), Auth() && Auth().canCreateRoom(), '需要幹部以上權限');
  togglePerm(document.getElementById('btnJoinRoom'), signedIn, '請先登入');

  const canEditSettings = Auth() && Auth().canEditSettings();
  ['btnSaveSettings', 'btnResetAll', 'btnAISave', 'btnAIReset'].forEach(id => {
    togglePerm(document.getElementById(id), canEditSettings, '需要管理員以上權限');
  });
  disableInputs([
    'globalTimeLimit','globalMarchTimeSec','globalConsumeMinPerMin','globalConsumeMaxPerMin',
    'globalSiegeEfficiency','globalMaxLossRatio','globalMinLossRatio',
    'globalAttackRequireRoute','globalCrossZoneWar',
    'aiR25','aiR20','aiR15','aiR12','aiR10','aiR08','aiR06','aiR00',
    'aiTeamFactor','aiWallFactor1','aiWallFactor2','aiDefendFactor','aiMinPct'
  ], !canEditSettings);

  ['btnSaveTiers','btnResetTiers'].forEach(id => {
    togglePerm(document.getElementById(id), canEditSettings, '需要管理員以上權限');
  });
  disableInputs([
    'tier1Max','tier1Teams','tier2Max','tier2Teams','tier3Max','tier3Teams','tier4Teams',
    'tierAutoCalcOnImport','tierPreserveOldTotal'
  ], !canEditSettings);

  const canEditData = effectiveCanEditData();
  togglePerm(document.getElementById('btnSaveAlliance'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnCancelAllianceEdit'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnResetAllianceOrder'), canEditData, '需要編輯資料權限');
  disableInputs(['allyName','allyIcon','allySide','allyMemberCount','allyTotalPower'], !canEditData);

  togglePerm(document.getElementById('btnAddZone'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnOpenNewCity'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnSimulate'), Auth() && Auth().canRunSim(), '請先登入');
  const newZoneNameEl = document.getElementById('newZoneName');
  if(newZoneNameEl) newZoneNameEl.disabled = !canEditData;

  const cityBatchZoneEl = document.getElementById('cityBatchZone');
  if(cityBatchZoneEl) cityBatchZoneEl.disabled = !canEditData;
  const cityBatchAllianceEl = document.getElementById('cityBatchAlliance');
  if(cityBatchAllianceEl) cityBatchAllianceEl.disabled = !canEditData;
  const cityBatchSideEl = document.getElementById('cityBatchSide');
  if(cityBatchSideEl) cityBatchSideEl.disabled = !canEditData;
  togglePerm(document.getElementById('btnCityBatchApplyZone'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnCityBatchApplyAlliance'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnCityBatchApplySide'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnCityBatchDelete'), canEditData, '需要編輯資料權限');

  togglePerm(document.getElementById('btnAddRouteLine'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnQuickAddRoute'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnExpandAllRouteGroups'), true, '');
  togglePerm(document.getElementById('btnCollapseAllRouteGroups'), true, '');
  togglePerm(document.getElementById('btnMapEditRoute'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnMapRelayout'), true, '');
  togglePerm(document.getElementById('btnMapFit'), true, '');
  togglePerm(document.getElementById('btnMapClearHighlight'), true, '');

  togglePerm(document.getElementById('btnAddWarLine'), canEditData, '需要編輯資料權限');
  togglePerm(document.getElementById('btnWarAddManual'), canEditData, '需要編輯資料權限');
  const warAddSrcEl = document.getElementById('warAddSrc');
  if(warAddSrcEl) warAddSrcEl.disabled = !canEditData;
  const warAddTypeEl = document.getElementById('warAddType');
  if(warAddTypeEl) warAddTypeEl.disabled = !canEditData;
  const warAddTgtEl = document.getElementById('warAddTgt');
  if(warAddTgtEl) warAddTgtEl.disabled = !canEditData;

  const canImportExcel = effectiveCanImportExcel();
  togglePerm(document.getElementById('btnOpenExcelImport'), canImportExcel, '需要 Excel 匯入權限');
  togglePerm(document.getElementById('btnExportCitiesCSV'), signedIn, '請先登入');
  togglePerm(document.getElementById('btnExportRoutesCSV'), signedIn, '請先登入');
  togglePerm(document.getElementById('btnExportMapRoutesCSV'), signedIn, '請先登入');
  togglePerm(document.getElementById('btnExportAlliancesCSV'), signedIn, '請先登入');

  togglePerm(document.getElementById('btnSendChat'), signedIn, '請先登入');
  const chatInputEl = document.getElementById('chatInput');
  if(chatInputEl) chatInputEl.disabled = !signedIn;

  /* v8.8.0：地圖庫按鈕權限 */
  const canEditMapLib = effectiveCanEditMapLibrary();
  togglePerm(document.getElementById('btnMapUpload'), signedIn && canEditMapLib, '需要地圖庫編輯權限');
  togglePerm(document.getElementById('btnMapCalibrate'), signedIn && canEditMapLib, '需要地圖庫編輯權限');
  togglePerm(document.getElementById('btnMapExportCoords'), signedIn, '請先登入');
  const mapLibViewModeEl = document.getElementById('mapLibraryViewMode');
  if(mapLibViewModeEl) mapLibViewModeEl.disabled = !signedIn;
  const mapLibSelectEl = document.getElementById('mapLibrarySelect');
  if(mapLibSelectEl) mapLibSelectEl.disabled = !signedIn;

  document.querySelectorAll(
    '[data-action="edit-city"],[data-action="del-city"],' +
    '[data-action="edit-alliance"],[data-action="del-alliance"],' +
    '[data-action="edit-zone"],[data-action="del-zone"],[data-deploy-edit],' +
    '[data-action="save-alliance-inline"],[data-action="cancel-alliance-inline"],' +
    '[data-action="save-city-inline"],[data-action="cancel-city-inline"]'
  ).forEach(b => {
    togglePerm(b, canEditData, '需要編輯資料權限');
  });

  document.querySelectorAll(
    '.list-table [data-war-time],' +
    '.list-table [data-war-src],' +
    '.list-table [data-war-type],' +
    '.list-table [data-war-tgt],' +
    '.list-table [data-deploy-field]'
  ).forEach(el => { el.disabled = !canEditData; });
  document.querySelectorAll('[data-war-del], [data-route-del]').forEach(b => {
    togglePerm(b, canEditData, '需要編輯資料權限');
  });

  document.querySelectorAll('tr.inline-editing input, tr.inline-editing select').forEach(el => {
    el.disabled = !canEditData;
  });

  document.querySelectorAll('#allianceTableBody tr[draggable]').forEach(tr => {
    tr.draggable = canEditData;
  });
  document.querySelectorAll('#allianceTableBody .drag-handle').forEach(el => {
    el.style.cursor = canEditData ? 'grab' : 'not-allowed';
    el.style.opacity = canEditData ? '' : '.35';
  });

  document.querySelectorAll('#iconQuickRow .icon-quick').forEach(b => {
    if(!canEditData){ b.disabled = true; b.style.pointerEvents = 'none'; b.style.opacity = '.35'; }
  });

  document.querySelectorAll('.city-member-cell').forEach(el => {
    if(canEditData){
      el.classList.remove('disabled-cell');
      el.style.cursor = 'pointer';
    } else {
      el.classList.add('disabled-cell');
      el.style.cursor = 'not-allowed';
    }
  });

  /* Gallery 內的按鈕也要跟著權限切換 */
  document.querySelectorAll('#mapGalleryGrid [data-action="calibrate"],#mapGalleryGrid [data-action="edit"]').forEach(b => {
    b.disabled = !canEditMapLib;
    if(!canEditMapLib) b.classList.add('perm-disabled');
    else b.classList.remove('perm-disabled');
  });

  if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
  if(window.SLG.updateRoomSandboxActions) window.SLG.updateRoomSandboxActions();
}

/* ============================================================
   網路中斷遮罩
   ============================================================ */
function showNetworkOverlay(){
  const el = document.getElementById('networkOverlay');
  if(el) el.classList.add('show');
}
function hideNetworkOverlay(){
  const el = document.getElementById('networkOverlay');
  if(el) el.classList.remove('show');
}
function showSyncOverlay(){
  const el = document.getElementById('syncOverlay');
  if(el) el.classList.add('show');
}
function hideSyncOverlay(){
  const el = document.getElementById('syncOverlay');
  if(el) el.classList.remove('show');
}
function handleNetworkChange({ online }){
  if(online){
    hideNetworkOverlay();
    logSystem('🟢 網路已恢復');
    if(state.auth.signedIn && state.mySandbox.cloudLoaded && state.sync.dirty){
      performCloudUpload('reconnect').catch(e => console.warn('恢復後同步失敗', e));
    }
  } else {
    showNetworkOverlay();
    logSystem('🔴 網路已中斷');
  }
}

/* ============================================================
   同步事件（含 visibility 修正 + beforeunload 遮罩）
   ============================================================ */
let pendingVisibilityUpload = null;

function bindSyncWatchers(){
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState !== 'hidden'){
      if(state.auth.signedIn && state.sync.dirty && !state.sync.uploading && isOnline()){
        logSystem('🔄 偵測到殘留變更，重新觸發上傳');
        performCloudUpload('visibility-restore').catch(e => console.warn(e));
      }
      return;
    }
    if(!state.sync.prefs.visibilitySync) return;
    if(!state.auth.signedIn) return;
    if(!state.sync.dirty) return;
    if(!isOnline()) return;
    if(pendingVisibilityUpload) return;

    logSystem('👁️ 分頁隱藏，觸發上傳');
    pendingVisibilityUpload = performCloudUpload('visibilitychange')
      .finally(() => { pendingVisibilityUpload = null; });
  });

  window.addEventListener('beforeunload', (e) => {
    saveState();
    if(!state.auth.signedIn) return;
    if(!state.sync.prefs.beforeUnloadSync) return;
    if(!state.sync.dirty) return;
    if(state.sync._allowClose) return;

    try{ performCloudUpload('beforeunload'); }catch(_){}
    showSyncOverlay();
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  on(EVT.SYNC_STATE, () => {
    if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus();
    updateModeBar();
    if(!state.sync.dirty && !state.sync.uploading){
      hideSyncOverlay();
    }
  });
}

/* ====== 中場休息：第 1/2 段結束 ====== */
/* ============================================================
   同步設定 UI 綁定
   ============================================================ */
function bindSyncSettingsUI(){
  const intervalEl = document.getElementById('syncIntervalMin');
  const impEl = document.getElementById('syncImportantImmediate');
  const visEl = document.getElementById('syncVisibility');
  const buEl = document.getElementById('syncBeforeUnload');

  const prefs = getSyncPrefs();
  if(intervalEl) intervalEl.value = prefs.intervalMin;
  if(impEl) impEl.checked = !!prefs.importantImmediate;
  if(visEl) visEl.checked = !!prefs.visibilitySync;
  if(buEl) buEl.checked = !!prefs.beforeUnloadSync;

  const btnSave = document.getElementById('btnSaveSyncPrefs');
  if(btnSave && !btnSave.dataset.bound){
    btnSave.dataset.bound = '1';
    btnSave.addEventListener('click', () => {
      const intervalMin = Math.max(0, Math.min(60, parseInt(intervalEl?.value, 10) || 0));
      const patch = {
        intervalMin,
        importantImmediate: !!impEl?.checked,
        visibilitySync: !!visEl?.checked,
        beforeUnloadSync: !!buEl?.checked,
      };
      setSyncPrefs(patch);
      if(state.auth.signedIn && intervalMin > 0){ startSyncTimer(); }
      else { stopSyncTimer(); }
      updateModeBar();
      logSystem('☁️ 同步設定已儲存（間隔 ' + (intervalMin === 0 ? '停用' : intervalMin + ' 分鐘') + '）');
      alert('✅ 同步設定已儲存');
    });
  }

  const btnNow = document.getElementById('btnManualSyncNow');
  if(btnNow && !btnNow.dataset.bound){
    btnNow.dataset.bound = '1';
    btnNow.addEventListener('click', async () => {
      if(!state.auth.signedIn){ alert('請先登入'); return; }
      if(!isOnline()){ alert('離線中，無法上傳'); return; }
      btnNow.disabled = true;
      btnNow.textContent = '⏳ 上傳中...';
      try{
        await performCloudUpload('manual');
        alert('✅ 已上傳到雲端');
      }catch(e){
        alert('❌ 上傳失敗：' + (e.message || e));
      }finally{
        btnNow.disabled = false;
        btnNow.textContent = '☁️ 立即上傳';
      }
    });
  }

  const statusBtn = document.getElementById('syncStatus');
  if(statusBtn && !statusBtn.dataset.bound){
    statusBtn.dataset.bound = '1';
    statusBtn.addEventListener('click', async () => {
      if(!state.auth.signedIn){ alert('請先登入才能查看雲端歷史'); return; }
      if(!isOnline()){ alert('離線中，無法讀取歷史'); return; }
      const modal = document.getElementById('historyModal');
      if(modal) modal.classList.add('show');
      if(window.SLG.renderHistoryList) await window.SLG.renderHistoryList();
    });
  }
}

/* ============================================================
   分級設定 UI 綁定
   ============================================================ */
function bindTroopTierUI(){
  syncTroopTiersToUI();

  const btnSave = document.getElementById('btnSaveTiers');
  if(btnSave && !btnSave.dataset.bound){
    btnSave.dataset.bound = '1';
    btnSave.addEventListener('click', () => {
      if(!requirePerm(() => Auth() && Auth().canEditSettings(), '修改分級設定')) return;
      const data = readTroopTiersFromUI();
      const t = data.tiers;
      if(!(t[0].maxLevel < t[1].maxLevel && t[1].maxLevel < t[2].maxLevel)){
        alert('⚠️ 分級門檻必須遞增（級別1 < 級別2 < 級別3）');
        return;
      }
      window.SLG.setTroopTiers(data);
      let recalcCount = 0;
      for(const c of state.cities){
        if(!c.tierCounts) continue;
        const calc = window.SLG.calcTeamsFromTiers(c.tierCounts);
        if(calc.totalTeams !== c.totalTeams){
          c.totalTeams = calc.totalTeams;
          c.memberCount = calc.totalMembers;
          c.avgPower = c.totalTeams > 0 ? Math.floor((Number(c.totalPower) || 0) / c.totalTeams) : 0;
          state.entityRev.city[c.id] = (state.entityRev.city[c.id] || 0) + 1;
          window.SLG.markDirty('city', c.id);
          recalcCount++;
        }
      }
      if(recalcCount > 0){
        window.SLG.tickLamport();
        window.SLG.flushPatches();
      }
      saveStateImportant();
      R().renderCities();
      if(window.SLG.CityManager) window.SLG.CityManager.render();
      if(R().renderCityMatrix) R().renderCityMatrix();
      alert('✅ 分級設定已儲存' + (recalcCount > 0 ? `\n\n已重算 ${recalcCount} 座城池的總隊數` : ''));
      logSystem(`⚔️ 分級設定已儲存（重算 ${recalcCount} 城）`);
    });
  }

  const btnReset = document.getElementById('btnResetTiers');
  if(btnReset && !btnReset.dataset.bound){
    btnReset.dataset.bound = '1';
    btnReset.addEventListener('click', () => {
      if(!requirePerm(() => Auth() && Auth().canEditSettings(), '恢復分級預設')) return;
      showConfirm('恢復分級預設', '這會將分級規則恢復為預設值（17/20/24 級）。\n\n現有城池的總隊數不會自動重算。\n\n確定執行？', () => {
        window.SLG.resetTroopTiers();
        syncTroopTiersToUI();
        logSystem('🔄 分級設定已恢復預設');
      });
    });
  }
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
  const attackRequireRouteEl = document.getElementById('globalAttackRequireRoute');
  const attackRequireRoute = attackRequireRouteEl ? !!attackRequireRouteEl.checked : false;
  const crossZoneWarEl = document.getElementById('globalCrossZoneWar');
  const crossZoneWarAllowed = crossZoneWarEl ? !!crossZoneWarEl.checked : false;

  Object.assign(state.settings, {
    timeLimitMin, consumeMinPerMin, consumeMaxPerMin,
    siegeEfficiency, marchTimeSec, maxLossRatio, minLossRatio,
    attackRequireRoute, crossZoneWarAllowed,
  });
  state.settingsRev++;
  saveState();

  const cities = collectCitiesForSim(zoneId);
  if(cities.length === 0){ logSystem('❌ 無城池資料'); return; }
  if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(cities);

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
        case 'snapshot': viz().ingestSnapshot(msg.sec, msg.snap); break;
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
  if(result.aborted){ logSystem('⛔ 推演已中止'); state.isSimulating = false; return; }
  if(result.minDefStartMin !== undefined) state.simBaseMin = result.minDefStartMin;
  state.narrativeLines = result.narrativeLines || [];
  R().renderNarrative(state.narrativeLines);
  DYN().setRows(state.dynRows);
  DYN().populateCityFilters();
  saveState();

  if(window.SLG.Summary){
    const summary = window.SLG.Summary.build(result, state.cities, state.alliances, state.dynRows);
    window.SLG.Summary.render(summary);
    logSystem('📊 推演總結已建立');
  }
  if(state.isHost && window.SLG.isConnected()){
    window.SLG.publish({ type:'viz_payload', data: viz().getAllSnapshots() });
    window.SLG.publish({ type:'dyn_payload', rows: state.dynRows });
    window.SLG.sendSystemChat('⚡ 推演完成');
  }
  viz().finalize();
  state.isSimulating = false;
  logSystem('✅ 推演完成');

  const summaryTab = document.querySelector('.top-nav button[data-tab="tab-summary"]');
  if(summaryTab && summaryTab.style.display !== 'none'){ summaryTab.click(); }
}

/* ============================================================
   審核彈窗
   ============================================================ */
function renderEditRequestReview(){
  const list = document.getElementById('editRequestList');
  const modal = document.getElementById('editRequestReviewModal');
  if(!list || !modal) return;
  const canReview = state.isHost || (Auth() && Auth().isAdmin());
  if(!canReview){ modal.classList.remove('show'); return; }
  const reqs = Object.entries(state.pendingEditRequests || {});
  if(reqs.length === 0){ modal.classList.remove('show'); return; }
  const visibleReqs = reqs.filter(([uid]) => uid !== state.auth.accountUid);
  if(visibleReqs.length === 0){ modal.classList.remove('show'); return; }
  list.innerHTML = visibleReqs.map(([uid, r]) => {
    const time = r.requestedAt ? new Date(r.requestedAt).toLocaleTimeString().slice(0,5) : '—';
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
   房間空沙盤提示
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
   上載沙盤至房間 / 沙盤清單 / 下載
   ============================================================ */
async function uploadMySandboxToRoom(){
  if(!window.SLG.canUploadSandboxToRoom()){ alert('您沒有上載沙盤的權限'); return; }
  if(!window.SLG.isConnected()){ alert('請先加入房間'); return; }
  const myData = window.SLG.buildSandboxData();
  const fileName = buildSandboxFileName(state.auth.displayName, Date.now());
  if(!confirm(`確定要將「我的沙盤」上載到房間嗎？\n\n這會覆蓋房間目前的沙盤。`)) return;
  try{
    await window.SLG.uploadSandboxToRoom(myData, fileName);
    hideRoomEmptyPrompt();
    alert('✅ 已上載沙盤到房間！');
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  }catch(e){ console.warn(e); }
}

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
        if(!sb || !sb.data){ alert('沙盤資料為空'); return; }
        const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);
        if(!confirm(`確定要將「${fileName}」上載到房間嗎？\n\n這會覆蓋房間目前的沙盤。`)) return;
        modal.classList.remove('show');
        try{
          await window.SLG.uploadSandboxToRoom(sb.data, fileName);
          hideRoomEmptyPrompt();
          alert('✅ 已上載沙盤到房間！');
          R().renderAll();
          if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
        }catch(e){ console.warn(e); }
      });
    });
  }catch(e){
    tbody.innerHTML = '<tr><td colspan="5" class="sandbox-empty">載入失敗</td></tr>';
    console.warn(e);
  }
}

async function downloadRoomSandbox(){
  if(!state.roomHasSnapshot || !state.roomSnapshot){ alert('房間尚無沙盤'); return; }
  const fileName = window.SLG.buildSandboxFileName(state.auth.displayName, Date.now());
  if(!confirm(`確定要把房間沙盤下載到你的個人沙盤嗎？\n\n這會覆蓋你目前的個人沙盤。`)) return;
  try{
    backupCurrentSandbox();
    window.SLG.applySandboxData(state.roomSnapshot.data);
    saveState();
    await window.SLG.saveMySandbox();
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    if(window.SLG.RouteManager) window.SLG.RouteManager.render();
    if(window.SLG.GameMap) window.SLG.GameMap.reset();
    alert('✅ 已下載房間沙盤到你的個人沙盤！');
  }catch(e){
    console.warn(e);
    alert('下載失敗：' + e.message);
  }
}

async function loadSandboxFromList(uid){
  if(!uid) return;
  try{
    const sb = await window.SLG.fetchUserSandbox(uid);
    if(!sb || !sb.data){ alert('沙盤資料為空'); return; }
    const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);
    const ok = confirm(
      `確定要載入「${fileName}」嗎？\n\n` +
      `這會覆蓋你目前的個人沙盤。\n（原沙盤會自動備份到本機）`
    );
    if(!ok) return;
    backupCurrentSandbox();
    window.SLG.applySandboxData(sb.data);
    saveState();
    await window.SLG.saveMySandbox();
    R().renderAll();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    if(window.SLG.RouteManager) window.SLG.RouteManager.render();
    if(window.SLG.GameMap) window.SLG.GameMap.reset();
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
      routes: JSON.parse(JSON.stringify(state.routes)),
    };
    localStorage.setItem(key, JSON.stringify(data));
    logSystem(`💾 已備份目前沙盤（key: ${key}）`);
    const keys = [];
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith(LS_PREFIX + 'sandboxBackup_')) keys.push(k);
    }
    keys.sort();
    while(keys.length > 5){ localStorage.removeItem(keys.shift()); }
  }catch(e){ console.warn('備份失敗', e); }
}

/* ============================================================
   地圖子檢視切換
   ============================================================ */
let currentMapView = 'route';
function switchMapView(view){
  currentMapView = view;
  document.querySelectorAll('.map-view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mapView === view);
  });
  const routeWrap = document.getElementById('mapRouteWrap');
  const dynamicWrap = document.getElementById('mapDynamicWrap');
  if(routeWrap) routeWrap.style.display = (view === 'route') ? '' : 'none';
  if(dynamicWrap) dynamicWrap.style.display = (view === 'dynamic') ? '' : 'none';
  if(view === 'route'){
    if(window.SLG.GameMap) window.SLG.GameMap.activate();
    if(MapLibrary()) MapLibrary().applyViewMode();
  }
  else { if(window.SLG.viz) viz().activate(); }
}

/* ============================================================
   清單偏好初始化
   ============================================================ */
function initListPrefs(){
  try{
    const ws = localStorage.getItem('slg_war_sort_v856');
    if(ws) state.listPrefs.warSort = ws;
    const wg = localStorage.getItem('slg_war_group_v856');
    if(wg) state.listPrefs.warGroup = wg;
    const ds = localStorage.getItem('slg_deploy_sort_v856');
    if(ds) state.listPrefs.deploySort = ds;
    const dg = localStorage.getItem('slg_deploy_group_v856');
    if(dg) state.listPrefs.deployGroup = dg;
  }catch(e){}
  const ws = document.getElementById('warSortSelect');
  if(ws) ws.value = state.listPrefs.warSort || 'time';
  const wg = document.getElementById('warGroupSelect');
  if(wg) wg.value = state.listPrefs.warGroup || 'none';
  const ds = document.getElementById('deploySortSelect');
  if(ds) ds.value = state.listPrefs.deploySort || 'alliance';
  const dg = document.getElementById('deployGroupSelect');
  if(dg) dg.value = state.listPrefs.deployGroup || 'none';
}

/* ============================================================
   v8.8.0：地圖庫事件綁定（獨立函式，方便維護）
   ============================================================ */
function bindMapLibraryUI(){
  /* v8.9.0：確認 circleDetect 已載入 */
  if(typeof window.SLG.detectFromImage !== 'function'){
    console.warn('[v8.9.0] circleDetect.js 未載入，節點校準將無法自動偵測');
  }

  if(MapLibrary()) MapLibrary().init();

  /* 若已登入，啟動索引監聽 */
  if(state.auth.signedIn && window.SLG.startMapLibraryIndexWatcher){
    try{ window.SLG.startMapLibraryIndexWatcher(); }catch(e){ console.warn('啟動地圖庫索引監聽失敗', e); }
  }
}

/* ============================================================
   事件綁定
   ============================================================ */
function bindUI(){
  document.querySelectorAll('.top-nav button').forEach(btn => {
    btn.addEventListener('click', function(){
      document.querySelectorAll('.top-nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const tabId = this.dataset.tab;
      const tabEl = document.getElementById(tabId);
      if(tabEl) tabEl.classList.add('active');

      if(window.innerWidth <= 768){
        const sidebar = document.getElementById('sidebar');
        if(sidebar) sidebar.classList.remove('open');
      }
      if(tabId === 'tab-cities'){
        R().renderCities();
        if(window.SLG.CityManager) window.SLG.CityManager.render();
        if(window.SLG.RouteManager) window.SLG.RouteManager.render();
        if(window.SLG.renderOverview) window.SLG.renderOverview();
      }
      if(tabId === 'tab-alliances'){
        R().renderAlliances();
        if(R().renderMatrix) R().renderMatrix();
      }
      if(tabId === 'tab-dyn'){ DYN().setRows(state.dynRows); DYN().populateCityFilters(); }
      if(tabId === 'tab-narrative'){ R().renderNarrative(state.narrativeLines); }
      if(tabId === 'tab-map'){ switchMapView(currentMapView); }
      if(tabId === 'tab-params'){ syncAIParamsToUI(); syncTroopTiersToUI(); }
      if(tabId === 'tab-summary'){
        if(window.SLG.Summary) window.SLG.Summary.render(window.SLG.Summary.getLast());
      }
      if(tabId === 'tab-sandbox'){ refreshSandboxList(); }
      if(tabId === 'tab-accounts'){
        if(Auth() && (Auth().isSuperAdmin() || Auth().isAdmin())){ window.SLG.Accounts.refresh(); }
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

  const hamburger = document.getElementById('hamburger');
  if(hamburger){
    hamburger.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      if(sidebar) sidebar.classList.toggle('open');
    });
  }
  const sidebarClose = document.getElementById('sidebarClose');
  if(sidebarClose){
    sidebarClose.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      if(sidebar) sidebar.classList.remove('open');
    });
  }
  document.addEventListener('click', (e) => {
    if(window.innerWidth > 768) return;
    const sidebar = document.getElementById('sidebar');
    const hamburgerEl = document.getElementById('hamburger');
    if(!sidebar || !sidebar.classList.contains('open')) return;
    if(sidebar.contains(e.target)) return;
    if(hamburgerEl && hamburgerEl.contains(e.target)) return;
    sidebar.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){
      const sidebar = document.getElementById('sidebar');
      if(sidebar) sidebar.classList.remove('open');
    }
  });

  document.querySelectorAll('.map-view-tab').forEach(tab => {
    tab.addEventListener('click', function(){ switchMapView(this.dataset.mapView); });
  });

  if(window.SLG.initCitySubtabs) window.SLG.initCitySubtabs();
  initListPrefs();
  if(window.SLG.DistanceTool) window.SLG.DistanceTool.init();

  const mapZoneSel = document.getElementById('mapZoneSelect');
  if(mapZoneSel && !mapZoneSel.dataset.bound){
    mapZoneSel.dataset.bound = '1';
    mapZoneSel.addEventListener('change', function(){
      if(window.SLG.GameMap && window.SLG.GameMap.setZoneFilter){ window.SLG.GameMap.setZoneFilter(this.value); }
    });
  }
  const cityMatrixZoneSel = document.getElementById('cityMatrixZone');
  if(cityMatrixZoneSel){ cityMatrixZoneSel.addEventListener('change', () => { if(R().renderCityMatrix) R().renderCityMatrix(); }); }
  const cityMatrixFilterSel = document.getElementById('cityMatrixFilter');
  if(cityMatrixFilterSel){ cityMatrixFilterSel.addEventListener('change', () => { if(R().renderCityMatrix) R().renderCityMatrix(); }); }

  const btnResetOrder = document.getElementById('btnResetAllianceOrder');
  if(btnResetOrder){
    btnResetOrder.addEventListener('click', () => {
      if(!requirePerm(() => effectiveCanEditData(), '重置盟排序')) return;
      showConfirm('重置盟排序', '確定要依「陣營 + 建立時間」重新排序嗎？', () => {
        if(resetAllianceOrder) resetAllianceOrder();
        R().renderAlliances();
        if(R().renderMatrix) R().renderMatrix();
        if(window.SLG.renderOverview) window.SLG.renderOverview();
        logSystem('🔄 盟排序已重置');
      });
    });
  }

  const btnSwitchMode = document.getElementById('btnSwitchMode');
  if(btnSwitchMode) btnSwitchMode.addEventListener('click', requestSwitchMode);

  if(window.SLG.bindAuthUI) window.SLG.bindAuthUI();

  bindSyncSettingsUI();
  bindTroopTierUI();

  /* v8.8.0：地圖庫 UI */
  bindMapLibraryUI();

  const btnLogout = document.getElementById('btnLogout');
  if(btnLogout && !btnLogout.dataset.bound){
    btnLogout.dataset.bound = '1';
    btnLogout.addEventListener('click', async () => {
      if(!isOnline()){ alert('離線中，無法登出。請先恢復網路連線。'); return; }
      const modal = document.getElementById('logoutConfirmModal');
      if(modal) modal.classList.add('show');
    });
  }
  const logoutConfirm = document.getElementById('logoutConfirm');
  if(logoutConfirm && !logoutConfirm.dataset.bound){
    logoutConfirm.dataset.bound = '1';
    logoutConfirm.addEventListener('click', async () => {
      try{ await Auth().performLogout(); }
      catch(e){ console.warn('登出失敗', e); alert('登出失敗：' + e.message); }
    });
  }
  const logoutCancel = document.getElementById('logoutCancel');
  if(logoutCancel && !logoutCancel.dataset.bound){
    logoutCancel.dataset.bound = '1';
    logoutCancel.addEventListener('click', () => {
      document.getElementById('logoutConfirmModal').classList.remove('show');
    });
  }

  const nameInput = document.getElementById('commanderName');
  if(nameInput) nameInput.addEventListener('input', function(){
    state.commanderName = this.value.trim();
    saveState();
  });

  const btnCreateRoom = document.getElementById('btnCreateRoom');
  if(btnCreateRoom) btnCreateRoom.addEventListener('click', async () => {
    if(!requirePerm(() => Auth() && Auth().canCreateRoom(), '建立房間')) return;
    if(!isOnline()){ alert('離線中，無法建立房間'); return; }
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

  const btnJoinRoom = document.getElementById('btnJoinRoom');
  if(btnJoinRoom) btnJoinRoom.addEventListener('click', () => {
    if(!requirePerm(() => state.auth.signedIn, '請先登入才能加入房間')) return;
    if(!isOnline()){ alert('離線中，無法加入房間'); return; }
    const name = nameInput.value.trim();
    if(!name){ alert('請先填寫指揮官名稱'); return; }
    const code = document.getElementById('roomCode').value.trim();
    if(code.length !== 6){ alert('請輸入6位數房間碼'); return; }
    state.commanderName = name;
    window.SLG.connectFirebase(code, false);
    saveState();
  });

  const btnDisconnect = document.getElementById('btnDisconnect');
  if(btnDisconnect) btnDisconnect.addEventListener('click', () => { window.SLG.requestDisconnect(); });

  document.querySelectorAll('[data-exit-choice]').forEach(btn => {
    if(!btn.dataset.bound){
      btn.dataset.bound = '1';
      btn.addEventListener('click', function(){
        if(typeof window.SLG.confirmExit === 'function'){ window.SLG.confirmExit(this.dataset.exitChoice); }
      });
    }
  });
  const exitRoomCancel = document.getElementById('exitRoomCancel');
  if(exitRoomCancel && !exitRoomCancel.dataset.bound){
    exitRoomCancel.dataset.bound = '1';
    exitRoomCancel.addEventListener('click', () => {
      document.getElementById('exitRoomModal').classList.remove('show');
    });
  }

  const btnUploadSandbox = document.getElementById('btnUploadSandboxToRoom');
  if(btnUploadSandbox) btnUploadSandbox.addEventListener('click', uploadMySandboxToRoom);
  const btnDownloadRoomSandbox = document.getElementById('btnDownloadRoomSandbox');
  if(btnDownloadRoomSandbox) btnDownloadRoomSandbox.addEventListener('click', downloadRoomSandbox);

  const btnRequestRoomEdit = document.getElementById('btnRequestRoomEdit');
  if(btnRequestRoomEdit) btnRequestRoomEdit.addEventListener('click', () => { window.SLG.requestRoomEditAccess(); });

  const btnReviewClose = document.getElementById('editRequestReviewClose');
  if(btnReviewClose) btnReviewClose.addEventListener('click', () => {
    document.getElementById('editRequestReviewModal').classList.remove('show');
  });

  document.querySelectorAll('[data-room-action]').forEach(btn => {
    btn.addEventListener('click', function(){
      const action = this.dataset.roomAction;
      if(action === 'uploadMine'){ uploadMySandboxToRoom(); }
      else if(action === 'pickFromList'){ hideRoomEmptyPrompt(); openSandboxPicker(); }
      else if(action === 'stayEmpty'){ hideRoomEmptyPrompt(); }
    });
  });
  const roomEmptyCancel = document.getElementById('roomEmptyCancel');
  if(roomEmptyCancel) roomEmptyCancel.addEventListener('click', hideRoomEmptyPrompt);

  const sandboxPickerCancel = document.getElementById('sandboxPickerCancel');
  if(sandboxPickerCancel) sandboxPickerCancel.addEventListener('click', () => {
    document.getElementById('sandboxPickerModal').classList.remove('show');
  });

  const btnSandboxRefresh = document.getElementById('btnSandboxesRefresh');
  if(btnSandboxRefresh) btnSandboxRefresh.addEventListener('click', refreshSandboxList);

  const btnSandboxHistory = document.getElementById('btnSandboxHistory');
  if(btnSandboxHistory){
    btnSandboxHistory.addEventListener('click', async () => {
      if(!state.auth.signedIn){ alert('請先登入'); return; }
      if(!isOnline()){ alert('離線中，無法讀取歷史'); return; }
      const modal = document.getElementById('historyModal');
      if(modal) modal.classList.add('show');
      if(window.SLG.renderHistoryList) await window.SLG.renderHistoryList();
    });
  }
  const historyClose = document.getElementById('historyClose');
  if(historyClose){
    historyClose.addEventListener('click', () => {
      document.getElementById('historyModal').classList.remove('show');
    });
  }

  const btnSandboxForceSync = document.getElementById('btnSandboxForceSync');
  if(btnSandboxForceSync){
    btnSandboxForceSync.addEventListener('click', async () => {
      if(!state.auth.signedIn){ alert('請先登入'); return; }
      if(!isOnline()){ alert('離線中，無法上傳'); return; }
      try{
        await performCloudUpload('manual-button');
        alert('✅ 已上傳到雲端');
        if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
      }catch(e){ alert('❌ 上傳失敗：' + e.message); }
    });
  }

  const btnRescue = document.getElementById('btnRescueRoom');
  if(btnRescue){
    btnRescue.addEventListener('click', async () => {
      if(!isOnline()){ alert('離線中，無法救援'); return; }
      const roomCode = document.getElementById('rescueRoomCode').value.trim();
      const statusEl = document.getElementById('rescueStatus');
      if(!roomCode || roomCode.length !== 6){ alert('請輸入 6 位數房間碼'); return; }
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
      }finally{ btnRescue.disabled = false; }
    });
  }

  const btnSaveSettings = document.getElementById('btnSaveSettings');
  if(btnSaveSettings) btnSaveSettings.addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '修改戰鬥參數')) return;
    const attackRequireRouteEl = document.getElementById('globalAttackRequireRoute');
    const crossZoneWarEl = document.getElementById('globalCrossZoneWar');
    window.SLG.updateSettings({
      timeLimitMin: parseInt(document.getElementById('globalTimeLimit').value) || 120,
      consumeMinPerMin: parseFloat(document.getElementById('globalConsumeMinPerMin').value) || 10,
      consumeMaxPerMin: parseFloat(document.getElementById('globalConsumeMaxPerMin').value) || 30,
      siegeEfficiency: parseFloat(document.getElementById('globalSiegeEfficiency').value) || 1,
      marchTimeSec: parseInt(document.getElementById('globalMarchTimeSec').value) || 0,
      maxLossRatio: (parseFloat(document.getElementById('globalMaxLossRatio').value) || 90) / 100,
      minLossRatio: (parseFloat(document.getElementById('globalMinLossRatio').value) || 10) / 100,
      attackRequireRoute: attackRequireRouteEl ? !!attackRequireRouteEl.checked : false,
      crossZoneWarAllowed: crossZoneWarEl ? !!crossZoneWarEl.checked : false,
    });
    if(R().renderMatrix) R().renderMatrix();
    if(R().renderCityMatrix) R().renderCityMatrix();
    if(window.SLG.WarManager) window.SLG.WarManager.render();
    if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
      window.SLG.GameMap.refreshZoneSelector();
    }
    alert('戰鬥參數已儲存');
  });

  const btnResetAll = document.getElementById('btnResetAll');
  if(btnResetAll) btnResetAll.addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '重置資料')) return;
    showConfirm('重置所有數據', '⚠️ 這將清除本機所有資料，並重置雲端沙盤！確定嗎？', async () => {
      localStorage.removeItem(LS_PREFIX + 'state');
      localStorage.removeItem(AI_LS_KEY);
      try{
        const db = window.SLG.getDb();
        if(db && state.auth.accountUid && isOnline()){
          state.settings = {
            timeLimitMin:120, consumeMinPerMin:10, consumeMaxPerMin:30,
            siegeEfficiency:1, marchTimeSec:0, maxLossRatio:0.9, minLossRatio:0.1,
            attackRequireRoute: false, crossZoneWarAllowed: false,
          };
          state.alliances = []; state.zones = []; state.cities = []; state.routes = [];
          await window.SLG.saveMySandbox();
        }
      }catch(e){}
      location.reload();
    });
  });

  const btnAISave = document.getElementById('btnAISave');
  if(btnAISave) btnAISave.addEventListener('click', function(){
    if(!requirePerm(() => Auth() && Auth().canEditSettings(), '修改 AI 參數')) return;
    window.SLG.AI.setParams(readAIParamsFromUI());
    window.SLG.AI.saveParams();
    alert('AI 參數已儲存');
  });
  const btnAIReset = document.getElementById('btnAIReset');
  if(btnAIReset) btnAIReset.addEventListener('click', function(){
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

  const allyMC = document.getElementById('allyMemberCount');
  const allyTP = document.getElementById('allyTotalPower');
  if(allyMC) allyMC.addEventListener('input', window.SLG.updateAllianceAvgPowerPreview);
  if(allyTP) allyTP.addEventListener('input', window.SLG.updateAllianceAvgPowerPreview);

  const btnSaveAlliance = document.getElementById('btnSaveAlliance');
  if(btnSaveAlliance) btnSaveAlliance.addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '編輯同盟')) return;
    const name = document.getElementById('allyName').value.trim();
    if(!name){ alert('請輸入同盟名稱'); return; }
    const icon = document.getElementById('allyIcon').value.trim();
    const side = document.getElementById('allySide').value;
    const memberCount = parseFloat(document.getElementById('allyMemberCount').value) || 0;
    const pInput = parseFloat(document.getElementById('allyTotalPower').value) || 0;
    const totalPower = Math.round(pInput * 1e8);
    if(memberCount <= 0){ alert('總人數必須大於 0'); return; }
    const isEditingId = state.editingAllianceId || null;
    if(icon && isAllianceIconUsed && isAllianceIconUsed(icon, isEditingId)){
      alert('❌ 此盟徽已被其他盟使用，請更換'); return;
    }
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
    const existing = state.alliances.find(a => a.id === id);
    let order = existing ? existing.order : null;
    if(typeof order !== 'number'){
      const maxOrder = state.alliances.reduce((m, a) =>
        Math.max(m, typeof a.order === 'number' ? a.order : -1), -1);
      order = maxOrder + 1;
    }
    window.SLG.upsertEntity('alliance', {
      id, name, icon, side, memberCount, totalPower, avgPower, power: totalPower,
      order, createdAt: existing ? existing.createdAt : Date.now(),
    });
    window.SLG.resetAllianceForm();
    R().renderAlliances();
    if(R().renderMatrix) R().renderMatrix();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    saveState();
  });
  const btnCancelAllianceEdit = document.getElementById('btnCancelAllianceEdit');
  if(btnCancelAllianceEdit) btnCancelAllianceEdit.addEventListener('click', window.SLG.resetAllianceForm);

  const allianceTbody = document.getElementById('allianceTableBody');
  if(allianceTbody) allianceTbody.addEventListener('click', e => {
    const saveInline = e.target.closest('[data-action="save-alliance-inline"]');
    if(saveInline){
      if(!requirePerm(() => effectiveCanEditData(), '編輯同盟')) return;
      if(window.SLG.saveInlineEditAlliance) window.SLG.saveInlineEditAlliance(saveInline.dataset.id);
      return;
    }
    const cancelInline = e.target.closest('[data-action="cancel-alliance-inline"]');
    if(cancelInline){ if(window.SLG.cancelInlineEditAlliance) window.SLG.cancelInlineEditAlliance(); return; }
    const editBtn = e.target.closest('[data-action="edit-alliance"]');
    if(editBtn){
      if(!requirePerm(() => effectiveCanEditData(), '編輯同盟')) return;
      if(window.SLG.startInlineEditAlliance) window.SLG.startInlineEditAlliance(editBtn.dataset.id);
      return;
    }
    const delBtn = e.target.closest('[data-action="del-alliance"]');
    if(delBtn){
      if(!requirePerm(() => effectiveCanEditData(), '刪除同盟')) return;
      const a = state.alliances.find(x => x.id === delBtn.dataset.id);
      if(!a) return;
      showConfirm('刪除同盟', `確定刪除「${a.name}」？`, () => {
        if(state.editingAllianceId === a.id) window.SLG.resetAllianceForm();
        window.SLG.deleteEntity('alliance', a.id);
        R().renderAlliances();
        if(R().renderMatrix) R().renderMatrix();
        if(window.SLG.renderOverview) window.SLG.renderOverview();
        saveState();
      });
    }
  });

  const btnAddZone = document.getElementById('btnAddZone');
  if(btnAddZone) btnAddZone.addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '新增戰區')) return;
    const name = document.getElementById('newZoneName').value.trim();
    if(!name) return;
    window.SLG.upsertEntity('zone', { id: uid(), name });
    document.getElementById('newZoneName').value = '';
    R().renderZones(); R().renderCities();
    if(R().populateCityMatrixFilters) R().populateCityMatrixFilters();
    if(R().renderCityMatrix) R().renderCityMatrix();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
      window.SLG.GameMap.refreshZoneSelector();
    }
    saveState();
  });

  const zoneListEl = document.getElementById('zoneList');
  if(zoneListEl) zoneListEl.addEventListener('click', e => {
    const editBtn = e.target.closest('[data-action="edit-zone"]');
    if(editBtn){
      if(!requirePerm(() => effectiveCanEditData(), '編輯戰區名稱')) return;
      const zone = state.zones.find(z => z.id === editBtn.dataset.id);
      if(!zone) return;
      const newName = prompt('編輯戰區名稱：', zone.name);
      if(newName === null) return;
      const trimmed = String(newName).trim();
      if(!trimmed){ alert('戰區名稱不能為空'); return; }
      if(trimmed.length > 20){ alert('戰區名稱最多 20 字'); return; }
      if(trimmed === zone.name) return;
      if(state.zones.some(z => z.name === trimmed && z.id !== zone.id)){
        alert('已有同名戰區，請改用其他名稱'); return;
      }
      const oldName = zone.name;
      zone.name = trimmed;
      window.SLG.upsertEntity('zone', zone);
      R().renderZones();
      R().renderCities();
      if(window.SLG.CityManager) window.SLG.CityManager.render();
      if(R().populateCityMatrixFilters) R().populateCityMatrixFilters();
      if(R().renderCityMatrix) R().renderCityMatrix();
      if(window.SLG.renderOverview) window.SLG.renderOverview();
      if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
        window.SLG.GameMap.refreshZoneSelector();
      }
      if(window.SLG.R && window.SLG.R.renderCities) window.SLG.R.renderCities();
      saveState();
      logSystem(`✏️ 戰區已更名：${oldName} → ${trimmed}`);
      return;
    }
    const btn = e.target.closest('[data-action="del-zone"]');
    if(!btn) return;
    if(!requirePerm(() => effectiveCanEditData(), '刪除戰區')) return;
    showConfirm('刪除戰區', '確定刪除？', () => {
      window.SLG.deleteEntity('zone', btn.dataset.id);
      R().renderZones(); R().renderCities();
      if(window.SLG.CityManager) window.SLG.CityManager.render();
      if(R().populateCityMatrixFilters) R().populateCityMatrixFilters();
      if(R().renderCityMatrix) R().renderCityMatrix();
      if(window.SLG.renderOverview) window.SLG.renderOverview();
      if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
        window.SLG.GameMap.refreshZoneSelector();
      }
      saveState();
    });
  });

  const btnOpenNewCity = document.getElementById('btnOpenNewCity');
  if(btnOpenNewCity) btnOpenNewCity.addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '新增城池')) return;
    window.SLG.openCityModal(null);
  });

  const cityListEl = document.getElementById('cityList');
  if(cityListEl) cityListEl.addEventListener('click', e => {
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
        if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
        R().renderCities();
        if(window.SLG.CityManager) window.SLG.CityManager.render();
        if(R().renderCityMatrix) R().renderCityMatrix();
        if(window.SLG.renderOverview) window.SLG.renderOverview();
        saveState();
      });
    }
  });

  const cityModalCancel = document.getElementById('cityModalCancel');
  if(cityModalCancel) cityModalCancel.addEventListener('click', window.SLG.closeCityModal);
  const cityModalSave = document.getElementById('cityModalSave');
  if(cityModalSave) cityModalSave.addEventListener('click', () => {
    if(!requirePerm(() => effectiveCanEditData(), '儲存城池')) return;
    window.SLG.saveCityFromModal();
  });

  ['cm_totalPower'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', () => { window.SLG.updateAutoCalcFields(); });
  });

  if(window.SLG.RouteManager) window.SLG.RouteManager.init();
  if(window.SLG.WarManager) window.SLG.WarManager.init();
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.init();
  if(window.SLG.GameMap) window.SLG.GameMap.init();

  const btnExportMapRoutes = document.getElementById('btnExportMapRoutesCSV');
  if(btnExportMapRoutes) btnExportMapRoutes.addEventListener('click', window.SLG.exportMapRoutesCSV);
  const btnExportAlliances = document.getElementById('btnExportAlliancesCSV');
  if(btnExportAlliances) btnExportAlliances.addEventListener('click', window.SLG.exportAlliancesCSV);

  const btnSimulate = document.getElementById('btnSimulate');
  if(btnSimulate) btnSimulate.addEventListener('click', () => {
    if(!requirePerm(() => Auth() && Auth().canRunSim(), '請先登入')) return;
    const zoneId = document.getElementById('simZoneSelect').value;
    if(!window.SLG.isConnected()){
      logSystem('⚠️ 未連線，僅本地推演');
      executeSimulation(zoneId);
      return;
    }
    window.SLG.publish({
      type:'trigger_simulate', zoneId,
      clientId:state.myClientId, name:state.commanderName
    });
    logSystem(`⚡ ${state.commanderName} 啟動推演`);
    if(state.isHost) executeSimulation(zoneId);
  });

  const modalCancel = document.getElementById('modalCancel');
  if(modalCancel) modalCancel.addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('show');
    confirmCb = null;
  });
  const modalConfirm = document.getElementById('modalConfirm');
  if(modalConfirm) modalConfirm.addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('show');
    if(confirmCb) confirmCb();
    confirmCb = null;
  });

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
  const btnImpAll = document.getElementById('excelImportAlliancesBtn');
  if(btnImpAll) btnImpAll.addEventListener('click', window.SLG.doImportAlliances);
  const btnImpCities = document.getElementById('excelImportCitiesBtn');
  if(btnImpCities) btnImpCities.addEventListener('click', window.SLG.doImportCities);
  const btnImpMapRoutes = document.getElementById('excelImportMapRoutesBtn');
  if(btnImpMapRoutes) btnImpMapRoutes.addEventListener('click', window.SLG.doImportMapRoutes);
  const btnImpRoutes = document.getElementById('excelImportRoutesBtn');
  if(btnImpRoutes) btnImpRoutes.addEventListener('click', window.SLG.doImportRoutes);
  ['excelAlliancesText','excelCitiesText','excelMapRoutesText','excelRoutesText'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', window.SLG.updateExcelPreview);
  });
  document.querySelectorAll('[data-excel-upload]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.excelUpload;
      const fileInput = document.getElementById(which === 'cities' ? 'excelCitiesFile' :
                       which === 'routes' ? 'excelRoutesFile' :
                       which === 'alliances' ? 'excelAlliancesFile' :
                       which === 'mapRoutes' ? 'excelMapRoutesFile' : null);
      if(fileInput) fileInput.click();
    });
  });
  document.querySelectorAll('[data-excel-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.excelClear;
      const textarea = document.getElementById(which === 'cities' ? 'excelCitiesText' :
                       which === 'routes' ? 'excelRoutesText' :
                       which === 'alliances' ? 'excelAlliancesText' :
                       which === 'mapRoutes' ? 'excelMapRoutesText' : null);
      if(textarea){ textarea.value = ''; window.SLG.updateExcelPreview(); }
    });
  });
  const fileMap = {
    excelCitiesFile: 'excelCitiesText',
    excelRoutesFile: 'excelRoutesText',
    excelAlliancesFile: 'excelAlliancesText',
    excelMapRoutesFile: 'excelMapRoutesText',
  };
  Object.keys(fileMap).forEach(fileId => {
    const fileEl = document.getElementById(fileId);
    if(!fileEl) return;
    fileEl.addEventListener('change', function(){
      if(!this.files || !this.files[0]) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const textareaId = fileMap[fileId];
        const ta = document.getElementById(textareaId);
        if(ta) ta.value = e.target.result;
        window.SLG.updateExcelPreview();
      };
      reader.readAsText(this.files[0], 'UTF-8');
      this.value = '';
    });
  });

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

  window.addEventListener('beforeunload', () => {
    saveState();
    try{ releaseWorker(); }catch(e){}
    /* v8.9.0：釋放 circleDetect Worker */
    try{
      if(typeof window.SLG.releaseCdWorker === 'function') window.SLG.releaseCdWorker();
    }catch(e){}
  });

  DEPLOY().init();
  if(window.SLG.Accounts) window.SLG.Accounts.init();
}

/* ============================================================
   非同步載入沙盤清單
   ============================================================ */
async function refreshSandboxList(){
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  try{
    const all = await window.SLG.fetchAllSandboxes();
    state.sandboxesList = all || {};
    emit(EVT.SANDBOXES_LIST_UPDATED);
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    logSystem(`📊 已載入 ${Object.keys(state.sandboxesList).length} 個沙盤`);
  }catch(e){ console.warn('載入沙盤清單失敗', e); }
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
    if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus();

    /* v8.8.0：登入後啟動地圖庫索引監聽；登出後停止 */
    if(state.auth.signedIn){
      if(window.SLG.startMapLibraryIndexWatcher){
        try{ window.SLG.startMapLibraryIndexWatcher(); }catch(e){}
      }
      if(MapLibrary()){ MapLibrary().renderSelect(); MapLibrary().renderGallery(); }
    } else {
      if(window.SLG.stopAllMapLibraryWatchers){
        try{ window.SLG.stopAllMapLibraryWatchers(); }catch(e){}
      }
      state.mapLibrary.index = {};
      state.mapLibrary.loaded = {};
      state.mapLibrary.activeMapId = '';
      if(MapLibrary()){ MapLibrary().renderSelect(); MapLibrary().renderGallery(); }
      if(window.SLG.GameMap) window.SLG.GameMap.onMapLibraryChanged();
    }

    if(!state.auth.signedIn){ hideAllTabContent(); }
    else {
      const roomBtn = document.querySelector('.top-nav button[data-tab="tab-room"]');
      if(roomBtn && roomBtn.style.display !== 'none'){ roomBtn.click(); }
    }
    if(state.auth.signedIn && Auth() && (Auth().isSuperAdmin() || Auth().isAdmin())){
      const accTab = document.getElementById('tab-accounts');
      if(accTab && accTab.classList.contains('active')){ window.SLG.Accounts.refresh(); }
    }
  });

  on(EVT.CONN, () => {
    R().renderHealth(); R().renderHost();
    updateModeBar();
    applyPermissions();
    if(window.SLG.isConnected() && !state.roomHasSnapshot){
      setTimeout(() => {
        if(window.SLG.isInRoom() && !state.roomHasSnapshot){ showRoomEmptyPrompt(); }
      }, 1500);
    }
  });

  on(EVT.MEMBERS, () => R().renderMembers());
  on(EVT.HOST, () => { R().renderHost(); updateModeBar(); applyPermissions(); });
  on(EVT.MODE, () => { updateModeBar(); applyPermissions(); });

  on(EVT.LOCKS, () => {
    R().renderCities();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
    if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY().render();
  });

  on(EVT.NETWORK, handleNetworkChange);
  on(EVT.SYNC_STATE, () => { if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus(); });

  on(EVT.TROOP_TIERS, () => {
    syncTroopTiersToUI();
    R().renderCities();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
  });

  on(EVT.DATA, () => {
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    R().renderAlliances();
    R().renderZones();
    R().renderCities();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
    if(window.SLG.WarManager){
      window.SLG.WarManager.render();
      if(window.SLG.WarManager.renderAddForm) window.SLG.WarManager.renderAddForm();
    }
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
    if(window.SLG.RouteManager) window.SLG.RouteManager.render();
    if(R().renderMatrix) R().renderMatrix();
    if(R().populateCityMatrixFilters) R().populateCityMatrixFilters();
    if(R().renderCityMatrix) R().renderCityMatrix();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    if(window.SLG.GameMap){
      window.SLG.GameMap.reset();
      if(window.SLG.GameMap.refreshZoneSelector){ window.SLG.GameMap.refreshZoneSelector(); }
      const mapTab = document.getElementById('tab-map');
      if(mapTab && mapTab.classList.contains('active')){ window.SLG.GameMap.activate(); }
    }
    if(window.SLG.DistanceTool && state.distanceResult){ window.SLG.DistanceTool.renderResult(); }

    const gt = document.getElementById('globalTimeLimit');
    if(gt) gt.value = state.settings.timeLimitMin;
    const gc1 = document.getElementById('globalConsumeMinPerMin');
    if(gc1) gc1.value = state.settings.consumeMinPerMin;
    const gc2 = document.getElementById('globalConsumeMaxPerMin');
    if(gc2) gc2.value = state.settings.consumeMaxPerMin;
    const gse = document.getElementById('globalSiegeEfficiency');
    if(gse) gse.value = state.settings.siegeEfficiency;
    const gmt = document.getElementById('globalMarchTimeSec');
    if(gmt) gmt.value = state.settings.marchTimeSec;
    const gml = document.getElementById('globalMaxLossRatio');
    if(gml) gml.value = Math.round(state.settings.maxLossRatio * 100);
    const gmn = document.getElementById('globalMinLossRatio');
    if(gmn) gmn.value = Math.round(state.settings.minLossRatio * 100);
    const garr = document.getElementById('globalAttackRequireRoute');
    if(garr) garr.checked = !!state.settings.attackRequireRoute;
    const gczwEv = document.getElementById('globalCrossZoneWar');
    if(gczwEv) gczwEv.checked = !!state.settings.crossZoneWarAllowed;

    if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY().render();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  });

  on(EVT.DYN_RESULT, () => { DYN().setRows(state.dynRows); DYN().populateCityFilters(); });

  on(EVT.ROUTES_UPDATED, () => {
    if(window.SLG.RouteManager) window.SLG.RouteManager.render();
    if(window.SLG.GameMap){
      window.SLG.GameMap.reset();
      if(window.SLG.GameMap.refreshZoneSelector){ window.SLG.GameMap.refreshZoneSelector(); }
      const mapTab = document.getElementById('tab-map');
      if(mapTab && mapTab.classList.contains('active')){ window.SLG.GameMap.activate(); }
    }
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    if(window.SLG.WarManager){
      window.SLG.WarManager.render();
      if(window.SLG.WarManager.renderAddForm) window.SLG.WarManager.renderAddForm();
    }
    if(window.SLG.DistanceTool && state.distanceResult){ window.SLG.DistanceTool.renderResult(); }
  });

  on(EVT.SIM_TRIGGER, payload => {
    if(payload.name && payload.clientId !== state.myClientId){
      logSystem(`⚡ ${payload.name} 啟動推演`);
    }
    if(state.isHost){
      const sel = document.getElementById('simZoneSelect');
      if(sel) sel.value = payload.zoneId || 'all';
      executeSimulation(payload.zoneId || 'all');
    }
  });

  on(EVT.ROOM_GRANTS, () => {
    if(window.SLG.updateRoomEditButton) window.SLG.updateRoomEditButton();
    applyPermissions();
    R().renderCities(); R().renderAlliances(); R().renderZones();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
  });

  on(EVT.ROOM_PENDING, () => { renderEditRequestReview(); });

  on(EVT.ROOM_SNAPSHOT_UPDATED, () => {
    if(window.SLG.updateRoomSandboxActions) window.SLG.updateRoomSandboxActions();
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    if(state.roomHasSnapshot) hideRoomEmptyPrompt();
  });

  on(EVT.MY_SANDBOX_UPDATED, () => {
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
    if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus();
  });

  on(EVT.SANDBOXES_LIST_UPDATED, () => {
    if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
  });

  /* v8.8.0：地圖庫事件 */
  on(EVT.MAP_LIBRARY_UPDATED, () => {
    applyPermissions();
  });
}

function hideAllTabContent(){
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.top-nav button').forEach(b => b.classList.remove('active'));
}

/* ============================================================
   啟動
   ============================================================ */
function boot(){
  initNetworkWatcher();
  if(!isOnline()) showNetworkOverlay();

  loadState();

  const cn = document.getElementById('commanderName');
  if(cn) cn.value = state.commanderName || '';
  const rc = document.getElementById('roomCode');
  if(rc) rc.value = state.roomCode || '';
  const gt = document.getElementById('globalTimeLimit');
  if(gt) gt.value = state.settings.timeLimitMin;
  const gc1 = document.getElementById('globalConsumeMinPerMin');
  if(gc1) gc1.value = state.settings.consumeMinPerMin;
  const gc2 = document.getElementById('globalConsumeMaxPerMin');
  if(gc2) gc2.value = state.settings.consumeMaxPerMin;
  const gse = document.getElementById('globalSiegeEfficiency');
  if(gse) gse.value = state.settings.siegeEfficiency;
  const gmt = document.getElementById('globalMarchTimeSec');
  if(gmt) gmt.value = state.settings.marchTimeSec;
  const gml = document.getElementById('globalMaxLossRatio');
  if(gml) gml.value = Math.round(state.settings.maxLossRatio * 100);
  const gmn = document.getElementById('globalMinLossRatio');
  if(gmn) gmn.value = Math.round(state.settings.minLossRatio * 100);
  const garr = document.getElementById('globalAttackRequireRoute');
  if(garr) garr.checked = !!state.settings.attackRequireRoute;
  const gczw = document.getElementById('globalCrossZoneWar');
  if(gczw) gczw.checked = !!state.settings.crossZoneWarAllowed;
  syncAIParamsToUI();
  syncTroopTiersToUI();

  window.SLG.initFirebase();

  if(window.SLG.EntryGate){
    window.SLG.EntryGate.init();
    window.SLG.EntryGate.show();
  }

  window.SLG.registerCloudSync(() => {
    if(state.auth.signedIn){
      window.SLG.saveMySandbox().catch(e => console.warn('雲端同步失敗', e));
    }
  });
  window.SLG.registerRoomSnapshotSync(() => {
    if(state.isHost){ window.SLG.publishRoomSnapshot().catch(e => console.warn('房間快照同步失敗', e)); }
  });

  window.SLG.registerSender(patches => {
    if(!state.connected) return;
    window.SLG.publish({
      type:'sync_patch', clientId:state.myClientId,
      lamport:state.lamport, patches
    });
  });

  bindUI();
  bindEvents();
  bindSyncWatchers();

  viz().init();
  DYN().init();
  window.SLG.resetAllianceForm();
  if(window.SLG.Summary) window.SLG.Summary.init();
  if(window.SLG.CityManager) window.SLG.CityManager.init();

  if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
  R().renderAll();
  DYN().setRows(state.dynRows);
  DYN().populateCityFilters();
  R().renderNarrative(state.narrativeLines);
  R().renderChat();
  R().renderChatBadge();
  R().renderProgress(0);
  if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus();
  DEPLOY().populateZoneFilter();
  updateModeBar();
  if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.WarManager){
    window.SLG.WarManager.render();
    if(window.SLG.WarManager.renderAddForm) window.SLG.WarManager.renderAddForm();
  }
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  if(R().renderMatrix) R().renderMatrix();
  if(R().populateCityMatrixFilters) R().populateCityMatrixFilters();
  if(R().renderCityMatrix) R().renderCityMatrix();
  if(window.SLG.DistanceTool) window.SLG.DistanceTool.render();
  if(window.SLG.renderOverview) window.SLG.renderOverview();
  if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
    window.SLG.GameMap.refreshZoneSelector();
  }
  if(MapLibrary()) MapLibrary().renderSelect();
  if(MapLibrary()) MapLibrary().renderGallery();
  applyPermissions();

  (async () => {
    let ok = false;
    if(window.SLG.Auth && isOnline()){ ok = await window.SLG.Auth.initFirebaseAuth(); }
    let loggedIn = false;
    if(ok){ loggedIn = await window.SLG.Auth.restoreSession(); }

    if(loggedIn){
      if(window.SLG.EntryGate) window.SLG.EntryGate.hide();
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
      R().renderAll();
      if(window.SLG.WarManager){
        window.SLG.WarManager.render();
        if(window.SLG.WarManager.renderAddForm) window.SLG.WarManager.renderAddForm();
      }
      if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
      if(R().renderMatrix) R().renderMatrix();
      if(R().renderCityMatrix) R().renderCityMatrix();
      if(window.SLG.DistanceTool) window.SLG.DistanceTool.render();
      if(window.SLG.renderOverview) window.SLG.renderOverview();
      if(window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
        window.SLG.GameMap.refreshZoneSelector();
      }
      if(window.SLG.renderSyncStatus) window.SLG.renderSyncStatus();

      /* v8.8.0：登入後啟動地圖庫 */
      try{
        if(window.SLG.startMapLibraryIndexWatcher){
          window.SLG.startMapLibraryIndexWatcher();
        }
        await refreshMapLibraryIndex();
      }catch(e){ console.warn('地圖庫初始化失敗', e); }
      if(window.SLG.MapLibrary){ window.SLG.MapLibrary.renderSelect(); window.SLG.MapLibrary.renderGallery(); }

      logSystem('🚪 已自動登入，跳過入口');
      if(document.getElementById('tab-sandbox')?.classList.contains('active')){ refreshSandboxList(); }
    } else {
      hideAllTabContent();
      if(window.SLG.EntryGate) window.SLG.EntryGate.showForm();
      if(window.SLG.renderAuthUI) window.SLG.renderAuthUI();
      applyPermissions();
  })();

  
  /* v8.9.0：診斷資訊 */
  console.log('%c[沙盤 v8.9.0] 地圖庫 + 菱形偵測 + 智慧命名就緒', 'color:#22ff88;font-weight:bold;font-size:14px');
  console.log('%c  · Cloudinary 上傳：' + (typeof window.SLG.uploadMapImageToCloudinary === 'function' ? '✅' : '❌'), 'color:#94a3b8;font-size:12px');
  console.log('%c  · 菱形偵測：' + (typeof window.SLG.detectFromImage === 'function' ? '✅' : '❌'), 'color:#94a3b8;font-size:12px');
  console.log('%c  · 節點校準：' + (typeof window.SLG.NodeCalibration === 'object' ? '✅' : '❌'), 'color:#94a3b8;font-size:12px');
  console.log('%c  · 模糊匹配：' + (typeof window.SLG.FuzzyMatch === 'object' ? '✅' : '❌'), 'color:#94a3b8;font-size:12px');
}

/* v8.8.0：初次載入地圖庫索引 */
async function refreshMapLibraryIndex(){
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  try{
    const idx = await window.SLG.fetchMapLibraryIndex();
    state.mapLibrary.index = idx || {};
    emit(EVT.MAP_LIBRARY_UPDATED, { type: 'index-loaded' });
    logSystem(`🗺️ 已載入地圖庫索引（${Object.keys(idx || {}).length} 張地圖）`);
  }catch(e){
    console.warn('載入地圖庫索引失敗', e);
  }
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  showConfirm, applyPermissions, requirePerm, togglePerm,
  effectiveCanEditData, effectiveCanImportExcel, effectiveCanEditMapLibrary,
  loadSandboxFromList, uploadMySandboxToRoom, openSandboxPicker,
  downloadRoomSandbox, refreshSandboxList, backupCurrentSandbox,
  showRoomEmptyPrompt, hideRoomEmptyPrompt,
  switchMapView, executeSimulation, renderEditRequestReview,
  showNetworkOverlay, hideNetworkOverlay, handleNetworkChange,
  showSyncOverlay, hideSyncOverlay,
  bindSyncWatchers, bindSyncSettingsUI, bindTroopTierUI,
  bindMapLibraryUI,
  refreshMapLibraryIndex,
});

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
