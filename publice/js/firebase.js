/* ============================================================================
 * firebase.js — Firebase 連線 / 個人沙盤 / 房間沙盤 / 聊天 / 編輯權限 / 退出
 *                + v8.8.0 地圖庫（Cloudinary 上傳 + RTDB CRUD + 即時監聽）
 *                + v8.9.4 手動備份 API + 寫入地圖庫節點 API
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, on, emit, EVT,
  uid, nowTime, esc, logSystem,
  saveState, tickLamport, isNewer,
  buildFullSnapshot, applyFullSnapshot, applyPatch,
  buildSandboxData, applySandboxData,
  enterRoomMode, exitRoomMode, updateModeBar,
  HOST_TIMEOUT, EDIT_LOCK_TTL, ROLE,
  isOnline,
} = window.SLG;

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDjfakubDKBpCi4xi1l_W_M6f9MdNC0oe0",
  authDomain: "ya-sandbox.firebaseapp.com",
  databaseURL: "https://ya-sandbox-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ya-sandbox",
  storageBucket: "ya-sandbox.firebasestorage.app",
  messagingSenderId: "648660430942",
  appId: "1:648660430942:web:bb09124cbb3a2dc72f44cf"
};

const SANDBOX_HISTORY_LIMIT = 20;

/* v8.8.0：Cloudinary 設定 */
const CLOUDINARY_CLOUD_NAME = 'qom5g2ar';
const CLOUDINARY_UPLOAD_PRESET = 'slg_map_upload';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
const MAP_IMAGE_MAX_SIZE = 50 * 1024 * 1024;   /* 50 MB */

let fbApp = null;
let fbDb = null;
let fbConnected = false;
let presenceRef = null;
let eventsRef = null;
let locksRef = null;
let chatRef = null;
let grantsRef = null;
let pendingEditRef = null;
let latestSnapshotRef = null;
let presenceWatchRef = null;
let connWatchRef = null;
let lastSeenTimer = null;
let lockRenewTimer = null;
const fbEventHandlers = [];
const myEditLocks = new Set();
let connectTime = Date.now();
let connectWaitTimer = null;

/* v8.8.0：地圖庫監聽 */
let mapLibraryIndexRef = null;
let mapLibraryIndexHandler = null;
let mapLibraryMapRef = null;
let mapLibraryMapHandler = null;
let currentWatchedMapId = '';

const isConnected = () => fbConnected && !!fbDb && !!state.roomCode;

/* ============================================================
   初始化
   ============================================================ */
function initFirebase(){
  try{
    if(!fbApp){
      fbApp = firebase.initializeApp(FIREBASE_CONFIG);
      fbDb = firebase.database();
    }
    return true;
  }catch(e){
    console.warn('Firebase 初始化失敗', e);
    return false;
  }
}
function getDb(){ return fbDb; }
function getApp(){ return fbApp; }

/* ============================================================
   個人雲端沙盤 API
   ============================================================ */
function sandboxRef(u){ return fbDb.ref(`userSandboxes/${u}`); }

async function fetchUserSandbox(u){
  if(!fbDb) return null;
  try{
    const snap = await sandboxRef(u).once('value');
    return snap.val() || null;
  }catch(e){ console.warn(`讀取 ${u} 沙盤失敗`, e); return null; }
}

async function fetchAllSandboxes(){
  if(!fbDb) return {};
  try{
    const snap = await fbDb.ref('userSandboxes').once('value');
    return snap.val() || {};
  }catch(e){ console.warn('讀取沙盤清單失敗', e); return {}; }
}

/**
 * v8.6.9：儲存個人雲端沙盤
 * - 上傳前先存歷史（v8.6.9：空白版本也備份）
 * - v8.9.4：加上 updatedAt fallback（避免舊資料無 updatedAt 時不備份）
 */
async function saveMySandbox(){
  if(!fbDb) return false;
  if(!state.auth.signedIn) return false;
  if(!isOnline()){ console.warn('[sync] 離線中，跳過雲端儲存'); return false; }
  const u = state.auth.accountUid;
  if(!u) return false;

  const payload = {
    username: state.auth.username,
    displayName: state.auth.displayName,
    updatedAt: Date.now(),
    data: buildSandboxData(),
  };

  try{
    state.mySandbox.saving = true;

    /* v8.6.9：歷史備份 */
    try{
      const prevSnap = await sandboxRef(u).once('value');
      const prev = prevSnap.val();
      if(prev && prev.data){
        /* v8.9.4：updatedAt fallback */
        const ts = prev.updatedAt || Date.now() - 1000;
        await sandboxRef(u).child(`history/${ts}`).set({
          updatedAt: ts,
          citiesCount: prev.data.cities?.length || 0,
          alliancesCount: prev.data.alliances?.length || 0,
          zonesCount: prev.data.zones?.length || 0,
          data: prev.data,
        });
        /* 保留最新 20 筆 */
        const histSnap = await sandboxRef(u).child('history').once('value');
        const hist = histSnap.val() || {};
        const keys = Object.keys(hist).sort();
        while(keys.length > SANDBOX_HISTORY_LIMIT){
          const k = keys.shift();
          try{ await sandboxRef(u).child(`history/${k}`).remove(); }catch(e){}
        }
      }
    }catch(e){ console.warn('[sync] 歷史備份失敗（不影響主流程）', e); }

    await sandboxRef(u).set(payload);
    state.mySandbox.updatedAt = payload.updatedAt;
    state.mySandbox.loaded = true;
    state.mySandbox.saving = false;
    emit(EVT.MY_SANDBOX_UPDATED);
    if(window.SLG.clearCloudDirty) window.SLG.clearCloudDirty();
    return true;
  }catch(e){
    state.mySandbox.saving = false;
    console.warn('儲存個人沙盤失敗', e);
    throw e;
  }
}

async function loadMySandbox(){
  if(!fbDb) return false;
  if(!state.auth.signedIn) return false;
  if(!isOnline()){
    console.warn('[sync] 離線中，無法載入雲端沙盤');
    state.mySandbox.cloudLoaded = true;
    return false;
  }
  const u = state.auth.accountUid;
  if(!u) return false;

  state.mySandbox.loading = true;
  emit(EVT.MY_SANDBOX_UPDATED);

  try{
    const data = await fetchUserSandbox(u);
    const hasCloudData = !!(data && data.data);
    const cloudCities = data?.data?.cities?.length || 0;
    const cloudAlliances = data?.data?.alliances?.length || 0;
    const cloudZones = data?.data?.zones?.length || 0;
    const localCities = state.cities.length || 0;
    const localAlliances = state.alliances.length || 0;

    if(hasCloudData){
      applySandboxData(data.data);
      state.mySandbox.updatedAt = data.updatedAt || 0;
      state.mySandbox.loaded = true;
      logSystem(`☁️ 已載入雲端沙盤（${cloudCities} 城 / ${cloudAlliances} 盟 / ${cloudZones} 戰區）`);
    } else {
      state.mySandbox.loaded = true;
      state.mySandbox.updatedAt = 0;
      logSystem('☁️ 雲端無沙盤');
      if(localCities > 0 || localAlliances > 0){
        logSystem(`📤 本機有 ${localCities} 城 / ${localAlliances} 盟，自動上傳到雲端`);
        try{
          await saveMySandbox();
          logSystem('✅ 已將本機資料上傳為雲端初始沙盤');
        }catch(e){ console.warn('自動上傳失敗', e); }
      }
    }

    state.mySandbox.loading = false;
    state.mySandbox.cloudLoaded = true;
    emit(EVT.MY_SANDBOX_UPDATED);
    if(window.SLG.startSyncTimer && state.auth.signedIn){
      window.SLG.startSyncTimer();
    }
    return true;
  }catch(e){
    state.mySandbox.loading = false;
    state.mySandbox.cloudLoaded = true;
    console.warn('載入個人沙盤失敗', e);
    return false;
  }
}

function clearLocalSandbox(){
  try{
    localStorage.removeItem(window.SLG.LS_PREFIX + 'state');
    logSystem('🗑️ 已清空本機沙盤');
    return true;
  }catch(e){ console.warn('清空本機沙盤失敗', e); return false; }
}

/* ============================================================
   沙盤歷史備份工具
   ============================================================ */
async function listSandboxHistory(){
  if(!fbDb) return [];
  if(!state.auth.signedIn) return [];
  const u = state.auth.accountUid;
  if(!u) return [];
  try{
    const snap = await sandboxRef(u).child('history').once('value');
    const all = snap.val() || {};
    return Object.entries(all).map(([ts, item]) => ({
      ts: parseInt(ts, 10),
      citiesCount: item.citiesCount || item.data?.cities?.length || 0,
      alliancesCount: item.alliancesCount || item.data?.alliances?.length || 0,
      data: item.data,
      savedAt: item.updatedAt,
    })).sort((a, b) => b.ts - a.ts);
  }catch(e){ console.warn('讀取歷史失敗', e); return []; }
}

async function restoreFromHistory(ts){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!state.auth.signedIn) throw new Error('請先登入');
  const u = state.auth.accountUid;
  const snap = await sandboxRef(u).child(`history/${ts}`).once('value');
  const item = snap.val();
  if(!item || !item.data){ throw new Error('找不到此歷史版本'); }
  const cities = item.data.cities?.length || 0;
  const alliances = item.data.alliances?.length || 0;
  const when = new Date(ts).toLocaleString();
  const ok = confirm(
    `確定要還原此版本嗎？\n\n時間：${when}\n內容：${cities} 城 / ${alliances} 盟\n\n` +
    `⚠️ 目前的本機資料會被覆蓋（會先存到歷史備份）`
  );
  if(!ok) return false;
  try{ await saveMySandbox(); }catch(e){}

  applySandboxData(item.data);
  state.mySandbox.cloudLoaded = true;
  state.mySandbox.loaded = true;
  state.mySandbox.updatedAt = item.updatedAt || ts;

  if(window.SLG.R){
    window.SLG.R.renderAlliances();
    window.SLG.R.renderZones();
  }
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.renderOverview) window.SLG.renderOverview();
  saveState();
  logSystem(`✅ 已從歷史還原：${cities} 城 / ${alliances} 盟`);
  return true;
}

async function previewHistory(ts){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!state.auth.signedIn) throw new Error('請先登入');
  const u = state.auth.accountUid;
  const snap = await sandboxRef(u).child(`history/${ts}`).once('value');
  const item = snap.val();
  if(!item || !item.data) throw new Error('找不到此歷史版本');
  return item.data;
}

/* ============================================================
   v8.9.4：手動建立備份（不覆蓋主體，只寫入 history）
   用途：當使用者從未上傳兩次、導致歷史為空時，可手動建立
   ============================================================ */
async function createSandboxBackup(){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法備份');
  const u = state.auth.accountUid;
  if(!u) throw new Error('缺少 accountUid');

  const now = Date.now();
  const data = buildSandboxData();
  const payload = {
    updatedAt: now,
    citiesCount: data.cities?.length || 0,
    alliancesCount: data.alliances?.length || 0,
    zonesCount: data.zones?.length || 0,
    data,
  };

  try{
    await sandboxRef(u).child(`history/${now}`).set(payload);
    logSystem(`💾 已建立手動備份：${payload.citiesCount} 城 / ${payload.alliancesCount} 盟`);

    /* 清理超過 20 筆 */
    try{
      const histSnap = await sandboxRef(u).child('history').once('value');
      const hist = histSnap.val() || {};
      const keys = Object.keys(hist).sort();
      while(keys.length > SANDBOX_HISTORY_LIMIT){
        const k = keys.shift();
        try{ await sandboxRef(u).child(`history/${k}`).remove(); }catch(e){}
      }
    }catch(e){ console.warn('清理歷史失敗', e); }

    return {
      ts: now,
      citiesCount: payload.citiesCount,
      alliancesCount: payload.alliancesCount,
      zonesCount: payload.zonesCount,
    };
  }catch(e){
    console.error('[History] 手動備份失敗', e);
    throw new Error('備份失敗：' + (e.message || e));
  }
}

/* ============================================================
   房間沙盤 API
   ============================================================ */
function roomSnapshotPath(){ return `rooms/${state.roomCode}/latestSnapshot`; }

async function fetchRoomSnapshot(roomCode){
  if(!fbDb) return null;
  try{
    const snap = await fbDb.ref(`rooms/${roomCode}/latestSnapshot`).once('value');
    return snap.val() || null;
  }catch(e){ console.warn(`讀取房間 ${roomCode} 沙盤失敗`, e); return null; }
}

async function fetchAllRoomSnapshots(){
  if(!fbDb) return {};
  try{
    const snap = await fbDb.ref('rooms').once('value');
    const all = snap.val() || {};
    const result = {};
    for(const code in all){
      if(all[code] && all[code].latestSnapshot) result[code] = all[code].latestSnapshot;
    }
    return result;
  }catch(e){ console.warn('讀取房間沙盤清單失敗', e); return {}; }
}

async function publishRoomSnapshot(){
  if(!fbDb || !state.roomCode) return false;
  if(!window.SLG.canEditRoomData || !window.SLG.canEditRoomData()) return false;
  if(!isOnline()) return false;
  const payload = {
    updatedAt: Date.now(),
    updatedBy: state.auth.accountUid || 'unknown',
    updatedByName: state.auth.displayName || state.commanderName || '未知',
    data: buildSandboxData(),
  };
  try{
    await fbDb.ref(roomSnapshotPath()).set(payload);
    state.roomHasSnapshot = true;
    state.roomSnapshot = payload;
    emit(EVT.ROOM_SNAPSHOT_UPDATED);
    return true;
  }catch(e){ console.warn('寫入房間快照失敗', e); return false; }
}

async function uploadSandboxToRoom(sandboxData, sourceName){
  if(!fbDb || !state.roomCode) return false;
  if(!isOnline()){ alert('離線中，無法上載'); return false; }
  if(!window.SLG.canUploadSandboxToRoom || !window.SLG.canUploadSandboxToRoom()){
    alert('您沒有上載沙盤到此房間的權限');
    return false;
  }
  if(!sandboxData){ alert('沙盤資料為空'); return false; }
  const payload = {
    updatedAt: Date.now(),
    updatedBy: state.auth.accountUid || 'unknown',
    updatedByName: state.auth.displayName || state.commanderName || '未知',
    sourceName: sourceName || '未知來源',
    data: JSON.parse(JSON.stringify(sandboxData)),
  };
  try{
    await fbDb.ref(roomSnapshotPath()).set(payload);
    state.roomSnapshot = payload;
    state.roomHasSnapshot = true;
    applySandboxData(sandboxData);
    saveState();
    emit(EVT.DATA);
    publish(buildFullSnapshot());
    emit(EVT.ROOM_SNAPSHOT_UPDATED);
    logSystem(`📤 已上載沙盤到房間：${sourceName || '未知'}`);
    return true;
  }catch(e){
    console.warn('上載沙盤失敗', e);
    alert('上載失敗：' + e.message);
    return false;
  }
}

/* ============================================================
   連線
   ============================================================ */
function connectFirebase(roomCode, asHost){
  if(!isOnline()){ emit(EVT.DEBUG, {msg:'❌ 離線中，無法連線房間', err:true}); alert('目前無網路連線，請稍後再試'); return; }
  if(!roomCode || roomCode.length !== 6){ emit(EVT.DEBUG, {msg:'❌ 房間碼必須為6位數', err:true}); return; }
  if(!state.commanderName){ emit(EVT.DEBUG, {msg:'❌ 請先填寫指揮官名稱', err:true}); return; }
  if(fbConnected || state.connecting) disconnectFirebase();

  state.roomCode = roomCode;
  state.myClientId = 'slg_' + uid();
  state.connecting = true;
  state.connected = false;
  connectTime = Date.now();
  emit(EVT.CONN);
  emit(EVT.DEBUG, {msg:'🟡 正在連線至 Firebase...'});

  if(!fbDb){ state.connecting = false; emit(EVT.CONN); emit(EVT.DEBUG, {msg:'❌ Firebase 未初始化', err:true}); return; }

  clearTimeout(connectWaitTimer);
  connectWaitTimer = setTimeout(() => {
    if(!fbConnected){
      state.connecting = false;
      emit(EVT.CONN);
      emit(EVT.DEBUG, {msg:'⏱️ Firebase 連線超時，請檢查網路或資料庫規則', err:true});
    }
  }, 10000);

  connWatchRef = fbDb.ref('.info/connected');
  connWatchRef.on('value', snap => {
    const connected = snap.val() === true;
    if(connected && !fbConnected){
      clearTimeout(connectWaitTimer);
      onFirebaseConnected(asHost);
    } else if(!connected && fbConnected){
      fbConnected = false;
      state.connected = false;
      emit(EVT.CONN);
      emit(EVT.DEBUG, {msg:'🔴 Firebase 連線中斷，嘗試自動重連...', err:true});
    }
  });
}

async function onFirebaseConnected(asHost){
  fbConnected = true;
  state.connected = true;
  state.connecting = false;
  enterRoomMode();
  emit(EVT.CONN);
  emit(EVT.DEBUG, {msg:'🟢 已連線至 Firebase！'});

  const now = Date.now();
  state.isHost = !!asHost;
  state.hostName = asHost ? state.commanderName : '';

  emit(EVT.DEBUG, {msg:'📥 讀取房間沙盤...'});
  try{
    const roomSnap = await fetchRoomSnapshot(state.roomCode);
    if(roomSnap && roomSnap.data){
      state.roomSnapshot = roomSnap;
      state.roomHasSnapshot = true;
      applySandboxData(roomSnap.data);
      saveState();
      emit(EVT.DATA);
      emit(EVT.ROOM_SNAPSHOT_UPDATED);
      emit(EVT.DEBUG, {msg:'📥 已載入房間沙盤'});
    } else {
      state.roomSnapshot = null;
      state.roomHasSnapshot = false;
      emit(EVT.ROOM_SNAPSHOT_UPDATED);
      emit(EVT.DEBUG, {msg:'📭 房間尚無沙盤'});
    }
  }catch(e){ console.warn('讀取房間沙盤失敗', e); }

  presenceRef = fbDb.ref(`rooms/${state.roomCode}/presence/${state.myClientId}`);
  presenceRef.set({ name: state.commanderName, joinTime: now, isHost: state.isHost, lastSeen: now });
  presenceRef.onDisconnect().remove();

  clearInterval(lastSeenTimer);
  lastSeenTimer = setInterval(() => {
    if(fbConnected && presenceRef && isOnline()) presenceRef.update({ lastSeen: Date.now() });
  }, 5000);

  presenceWatchRef = fbDb.ref(`rooms/${state.roomCode}/presence`);
  presenceWatchRef.on('value', snap => {
    const presence = snap.val() || {};
    state.members = {};
    const nowTs = Date.now();
    for(const cid in presence){
      const m = presence[cid];
      if(!m) continue;
      if(nowTs - (m.lastSeen||0) < HOST_TIMEOUT){
        state.members[cid] = { name:m.name, joinTime:m.joinTime, isHost:!!m.isHost, lastSeen:m.lastSeen };
      }
    }
    emit(EVT.MEMBERS);
    checkHostHealthFirebase();
  });

  eventsRef = fbDb.ref(`rooms/${state.roomCode}/events`);
  const evHandler = eventsRef.limitToLast(200).on('child_added', snap => {
    const p = snap.val();
    if(!p) return;
    if(p._from === state.myClientId) return;
    if(p._ts && p._ts < connectTime) return;
    handleIncoming(p);
  });
  fbEventHandlers.push({ ref: eventsRef, evt:'child_added', fn: evHandler });

  locksRef = fbDb.ref(`rooms/${state.roomCode}/locks`);
  locksRef.on('value', snap => { state.editLocks = snap.val() || {}; emit(EVT.LOCKS); });

  grantsRef = fbDb.ref(`rooms/${state.roomCode}/editGrants`);
  const grantsHandler = grantsRef.on('value', snap => {
    state.roomEditGrants = snap.val() || {};
    if(state.auth.accountUid && state.roomEditGrants[state.auth.accountUid]){
      state.myEditRequestStatus = 'granted';
    } else if(state.myEditRequestStatus === 'granted'){
      state.myEditRequestStatus = 'idle';
    }
    emit(EVT.ROOM_GRANTS);
  });
  fbEventHandlers.push({ ref: grantsRef, evt:'value', fn: grantsHandler });

  pendingEditRef = fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests`);
  const pendingEditHandler = pendingEditRef.on('value', snap => {
    state.pendingEditRequests = snap.val() || {};
    if(state.auth.accountUid && state.pendingEditRequests[state.auth.accountUid]){
      state.myEditRequestStatus = 'pending';
    } else if(state.myEditRequestStatus === 'pending'){
      state.myEditRequestStatus = 'idle';
    }
    emit(EVT.ROOM_PENDING);
  });
  fbEventHandlers.push({ ref: pendingEditRef, evt:'value', fn: pendingEditHandler });

  latestSnapshotRef = fbDb.ref(roomSnapshotPath());
  const latestSnapshotHandler = latestSnapshotRef.on('value', snap => {
    const val = snap.val();
    if(val && val.data){
      const prevUpdatedAt = state.roomSnapshot ? state.roomSnapshot.updatedAt : 0;
      state.roomSnapshot = val;
      state.roomHasSnapshot = true;
      if(val.updatedAt > prevUpdatedAt && val.updatedBy !== state.auth.accountUid){
        applySandboxData(val.data);
        saveState();
        emit(EVT.DATA);
      }
      emit(EVT.ROOM_SNAPSHOT_UPDATED);
    } else {
      state.roomSnapshot = null;
      state.roomHasSnapshot = false;
      emit(EVT.ROOM_SNAPSHOT_UPDATED);
    }
  });
  fbEventHandlers.push({ ref: latestSnapshotRef, evt:'value', fn: latestSnapshotHandler });

  chatRef = fbDb.ref(`rooms/${state.roomCode}/chat`);
  const chatHandler = chatRef.limitToLast(200).on('child_added', snap => {
    const m = snap.val();
    if(!m) return;
    const isSelf = (m._from === state.myClientId);
    const isSystem = !!m.isSystem;
    addChatMessage({
      id: snap.key, sender: m.sender || '系統', text: m.text, time: m.time, isSelf, isSystem,
    });
    if(!isSelf && !isSystem){
      const chatTab = document.getElementById('tab-chat');
      if(!chatTab || !chatTab.classList.contains('active')){
        state.unreadChat++;
        if(typeof window.SLG.renderChatBadge === 'function') window.SLG.renderChatBadge();
      }
    }
  });
  fbEventHandlers.push({ ref: chatRef, evt:'child_added', fn: chatHandler });

  saveState();
  emit(EVT.HOST);
  startEditLockRenew();
  if(typeof window.SLG.updatePushButtonState === 'function') window.SLG.updatePushButtonState();
  if(typeof window.SLG.updateRoomEditButton === 'function') window.SLG.updateRoomEditButton();
  if(typeof window.SLG.updateRoomSandboxActions === 'function') window.SLG.updateRoomSandboxActions();
}

function checkHostHealthFirebase(){
  if(!fbConnected) return;
  const now = Date.now();
  let hostAlive = false;
  const online = [];
  for(const cid in state.members){
    const m = state.members[cid];
    if(now - (m.lastSeen||0) < HOST_TIMEOUT){
      online.push({cid, m});
      if(m.isHost) hostAlive = true;
    }
  }
  if(!hostAlive && online.length > 0 && !state.isHost){
    online.sort((a,b) => a.m.joinTime - b.m.joinTime);
    const heir = online[0];
    if(heir.cid === state.myClientId){
      state.isHost = true;
      state.hostName = state.commanderName;
      state.roomEpoch = uid();
      if(presenceRef) presenceRef.update({ isHost: true });
      emit(EVT.HOST);
      logSystem('👑 你已成為房主');
      saveState();
      if(typeof window.SLG.updatePushButtonState === 'function') window.SLG.updatePushButtonState();
      if(typeof window.SLG.updateRoomEditButton === 'function') window.SLG.updateRoomEditButton();
      if(typeof window.SLG.updateRoomSandboxActions === 'function') window.SLG.updateRoomSandboxActions();
    }
  }
}

function disconnectFirebase(){
  clearTimeout(connectWaitTimer);
  clearInterval(lastSeenTimer);
  clearInterval(lockRenewTimer);

  for(const h of fbEventHandlers){
    try{ h.ref.off(h.evt, h.fn); }catch(e){}
  }
  fbEventHandlers.length = 0;

  if(locksRef && myEditLocks.size > 0){
    for(const cityId of myEditLocks){ try{ locksRef.child(cityId).remove(); }catch(e){} }
    myEditLocks.clear();
  }
  if(presenceRef){ try{ presenceRef.onDisconnect().cancel(); presenceRef.remove(); }catch(e){} }
  if(locksRef){ try{ locksRef.off(); }catch(e){} }
  if(chatRef){ try{ chatRef.off(); }catch(e){} }
  if(grantsRef){ try{ grantsRef.off(); }catch(e){} }
  if(pendingEditRef){ try{ pendingEditRef.off(); }catch(e){} }
  if(latestSnapshotRef){ try{ latestSnapshotRef.off(); }catch(e){} }
  if(presenceWatchRef){ try{ presenceWatchRef.off(); }catch(e){} }
  if(connWatchRef){ try{ connWatchRef.off(); }catch(e){} }

  presenceRef = locksRef = chatRef = grantsRef = pendingEditRef = null;
  latestSnapshotRef = presenceWatchRef = connWatchRef = eventsRef = null;

  fbConnected = false;
  state.connected = false;
  state.connecting = false;
  state.isHost = false;
  state.hostName = '';
  state.members = {};
  state.editLocks = {};
  state.roomCode = '';
  state.roomSnapshot = null;
  state.roomHasSnapshot = false;
  state.pendingUploadSandbox = null;

  if(window.SLG.resetRoomEditState) window.SLG.resetRoomEditState();

  ['exitRoomModal','editRequestReviewModal','roomEmptyPromptModal','sandboxPickerModal'].forEach(id => {
    const m = document.getElementById(id);
    if(m) m.classList.remove('show');
  });

  exitRoomMode();
  emit(EVT.CONN); emit(EVT.MEMBERS); emit(EVT.HOST); emit(EVT.LOCKS);
  emit(EVT.DEBUG, {msg:'🔴 已中斷連線'});
  saveState();
  if(typeof window.SLG.updatePushButtonState === 'function') window.SLG.updatePushButtonState();
  if(typeof window.SLG.updateRoomEditButton === 'function') window.SLG.updateRoomEditButton();
  if(typeof window.SLG.updateRoomSandboxActions === 'function') window.SLG.updateRoomSandboxActions();
}

/* ============================================================
   發送事件
   ============================================================ */
function publish(payload){
  if(!fbConnected || !fbDb || !state.roomCode) return;
  if(!isOnline()) return;
  try{
    fbDb.ref(`rooms/${state.roomCode}/events`).push({
      ...payload, _from: state.myClientId, _ts: Date.now(),
    });
  }catch(e){ console.warn('Firebase 發送失敗', e); }
}

/* ============================================================
   編輯鎖
   ============================================================ */
function acquireEditLock(cityId){
  if(!fbConnected || !fbDb || !state.roomCode) return;
  if(!isOnline()) return;
  const ref = fbDb.ref(`rooms/${state.roomCode}/locks/${cityId}`);
  ref.set({ clientId: state.myClientId, name: state.commanderName, expiresAt: Date.now() + EDIT_LOCK_TTL });
  ref.onDisconnect().remove();
  myEditLocks.add(cityId);
}
function releaseEditLock(cityId){
  if(!fbDb || !state.roomCode || !myEditLocks.has(cityId)) return;
  try{ fbDb.ref(`rooms/${state.roomCode}/locks/${cityId}`).remove(); }catch(e){}
  myEditLocks.delete(cityId);
}
function startEditLockRenew(){
  clearInterval(lockRenewTimer);
  lockRenewTimer = setInterval(() => {
    if(!fbConnected || !locksRef) return;
    if(!isOnline()) return;
    for(const cityId of myEditLocks){
      try{ locksRef.child(cityId).update({ expiresAt: Date.now() + EDIT_LOCK_TTL }); }catch(e){}
    }
  }, 10000);
}

/* ============================================================
   接收事件
   ============================================================ */
function handleIncoming(payload){
  if(!payload || !payload.type) return;
  switch(payload.type){
    case 'sync_patch': {
      let changed = false;
      for(const p of payload.patches || []) if(applyPatch(p)) changed = true;
      if(changed){ emit(EVT.DATA); saveState(); }
      break;
    }
    case 'sync_snapshot': {
      if(applyFullSnapshot(payload)){
        emit(EVT.DATA); saveState();
        emit(EVT.DEBUG, {msg:'🔄 已同步房主快照'});
      }
      break;
    }
    case 'trigger_simulate': emit(EVT.SIM_TRIGGER, payload); break;
    case 'viz_payload': {
      if(payload.data && window.SLG.viz){
        try{
          const parsed = payload.data;
          if(parsed.baseMin !== undefined) state.simBaseMin = parsed.baseMin;
          for(const [sec, snap] of parsed.snapEntries) window.SLG.viz.ingestSnapshot(sec, snap);
          window.SLG.viz.finalize();
        }catch(e){ console.warn('viz 解析失敗', e); }
      }
      break;
    }
    case 'dyn_payload': {
      if(payload.rows){ state.dynRows = payload.rows; emit(EVT.DYN_RESULT); }
      break;
    }
    case 'room_snapshot_updated': {
      if(state.auth.accountUid === payload.updatedBy) break;
      if(latestSnapshotRef){
        latestSnapshotRef.once('value').then(snap => {
          const val = snap.val();
          if(val && val.data){
            state.roomSnapshot = val;
            state.roomHasSnapshot = true;
            applySandboxData(val.data);
            saveState();
            emit(EVT.DATA);
            emit(EVT.ROOM_SNAPSHOT_UPDATED);
          }
        });
      }
      break;
    }
  }
}

/* ============================================================
   聊天室
   ============================================================ */
function addChatMessage(msg){
  if(msg.id && state.chatMessages.some(m => m.id === msg.id)) return;
  state.chatMessages.push(msg);
  if(state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-200);
  if(typeof window.SLG.renderChat === 'function') window.SLG.renderChat();
  if(typeof window.SLG.renderChatBadge === 'function') window.SLG.renderChatBadge();
  saveState();
}

function sendChatMessage(text){
  text = (text || '').trim();
  if(!text) return;
  if(!state.commanderName){ alert('請先設定指揮官名稱'); return; }
  if(!isConnected() || !isOnline()){
    addChatMessage({ id: uid(), sender: state.commanderName, text, time: nowTime(), isSelf: true, isSystem: false });
    return;
  }
  try{
    fbDb.ref(`rooms/${state.roomCode}/chat`).push({
      sender: state.commanderName, text, time: nowTime(),
      _from: state.myClientId, _ts: Date.now(),
    });
  }catch(e){
    console.warn('聊天發送失敗', e);
    addChatMessage({ id: uid(), sender: state.commanderName, text, time: nowTime(), isSelf: true, isSystem: false });
  }
}

function sendSystemChat(text){
  if(!isConnected()) return;
  if(!isOnline()) return;
  try{
    fbDb.ref(`rooms/${state.roomCode}/chat`).push({
      sender: '系統', text, time: nowTime(),
      _from: state.myClientId, _ts: Date.now(), isSystem: true,
    });
  }catch(e){}
}

/* ============================================================
   房間編輯權限
   ============================================================ */
function requestRoomEditAccess(){
  if(!isConnected()){ alert('請先加入房間'); return; }
  if(!isOnline()){ alert('離線中，無法送出申請'); return; }
  if(window.SLG.canEditRoomData && window.SLG.canEditRoomData()){ alert('您已擁有編輯權限'); return; }
  if(state.myEditRequestStatus === 'pending'){ alert('已送出申請，等待審核中'); return; }
  if(!state.auth.signedIn){ alert('請先登入'); return; }
  const myUid = state.auth.accountUid;
  const ref = fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests/${myUid}`);
  ref.set({
    username: state.auth.username,
    displayName: state.auth.displayName,
    requestedAt: Date.now(),
  }).then(() => {
    state.myEditRequestStatus = 'pending';
    if(typeof window.SLG.updateRoomEditButton === 'function') window.SLG.updateRoomEditButton();
    logSystem('📝 已送出編輯權限申請');
    alert('✅ 申請已送出，等待房主或管理員審核。');
  }).catch(e => { console.warn('申請失敗', e); alert('❌ 申請失敗：' + e.message); });
}

function approveEditRequest(u){
  const isAdmin = window.SLG.Auth && window.SLG.Auth.isAdmin();
  if(!state.isHost && !isAdmin){ alert('權限不足'); return; }
  const req = state.pendingEditRequests[u];
  if(!req) return;
  const updates = {};
  updates[`rooms/${state.roomCode}/editGrants/${u}`] = {
    username: req.username, displayName: req.displayName,
    grantedAt: Date.now(), grantedBy: state.auth.accountUid, grantedByName: state.auth.displayName,
  };
  updates[`rooms/${state.roomCode}/pendingEditRequests/${u}`] = null;
  fbDb.ref().update(updates).then(() => {
    logSystem(`✅ 已批准 ${req.displayName} 的編輯權限`);
    sendSystemChat(`✅ ${req.displayName} 已獲得此房間的編輯權限`);
  }).catch(e => { console.warn('批准失敗', e); alert('❌ 批准失敗：' + e.message); });
}

function rejectEditRequest(u){
  const isAdmin = window.SLG.Auth && window.SLG.Auth.isAdmin();
  if(!state.isHost && !isAdmin){ alert('權限不足'); return; }
  const req = state.pendingEditRequests[u];
  if(!req) return;
  fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests/${u}`).remove()
    .then(() => logSystem(`❌ 已拒絕 ${req.displayName} 的編輯權限申請`))
    .catch(e => { console.warn('拒絕失敗', e); alert('❌ 拒絕失敗：' + e.message); });
}

/* ====== 中場休息：第 1/2 段結束 ====== */
/* ============================================================
   資料救援
   ============================================================ */
async function rescueRoomSnapshot(roomCode){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!isOnline()) throw new Error('離線中，無法救援');
  if(!window.SLG.canUseRescueTool || !window.SLG.canUseRescueTool()) throw new Error('您沒有救援權限');
  if(!roomCode || roomCode.length !== 6) throw new Error('房間碼必須為 6 位數');

  const snap = await fbDb.ref(`rooms/${roomCode}/events`).once('value');
  const all = snap.val() || {};
  const events = Object.entries(all).map(([k, v]) => ({ key:k, ...v }))
    .filter(e => e && e._ts).sort((a, b) => a._ts - b._ts);

  if(events.length === 0) throw new Error('此房間沒有任何事件');

  const reconstructed = {
    settings: {}, alliances: [], zones: [], cities: [],
    entityRev: { alliance:{}, zone:{}, city:{} },
  };
  let lastSnapshotTs = 0;
  let patchCount = 0;

  for(const evt of events){
    if(evt.type === 'sync_snapshot'){
      reconstructed.settings = JSON.parse(JSON.stringify(evt.settings || {}));
      reconstructed.alliances = JSON.parse(JSON.stringify(evt.alliances || []));
      reconstructed.zones = JSON.parse(JSON.stringify(evt.zones || []));
      reconstructed.cities = JSON.parse(JSON.stringify(evt.cities || []));
      reconstructed.entityRev = JSON.parse(JSON.stringify(evt.entityRev || { alliance:{}, zone:{}, city:{} }));
      lastSnapshotTs = evt._ts;
    } else if(evt.type === 'sync_patch'){
      if(!evt.patches) continue;
      for(const p of evt.patches) applyPatchToReconstructed(reconstructed, p);
      patchCount += (evt.patches || []).length;
    }
  }

  if(reconstructed.cities.length === 0 && reconstructed.alliances.length === 0) throw new Error('重播後無任何資料');

  const payload = {
    updatedAt: Date.now(),
    updatedBy: state.auth.accountUid,
    updatedByName: state.auth.displayName,
    sourceName: `救援重建（${events.length} 事件 / ${patchCount} 補丁）`,
    data: {
      settings: reconstructed.settings,
      alliances: reconstructed.alliances,
      zones: reconstructed.zones,
      cities: reconstructed.cities,
    },
  };
  await fbDb.ref(`rooms/${roomCode}/latestSnapshot`).set(payload);

  return {
    eventsCount: events.length, patchesCount: patchCount, lastSnapshotTs,
    citiesCount: reconstructed.cities.length, alliancesCount: reconstructed.alliances.length,
  };
}

function applyPatchToReconstructed(rec, patch){
  if(!patch || !patch.kind) return;
  const { kind, id, op, data } = patch;
  if(kind === 'settings'){ Object.assign(rec.settings, data || {}); return; }
  const key = kind === 'alliance' ? 'alliances' : kind === 'zone' ? 'zones' : kind === 'city' ? 'cities' : null;
  if(!key) return;
  const arr = rec[key];
  const idx = arr.findIndex(x => x.id === id);
  if(op === 'delete'){ if(idx >= 0) arr.splice(idx, 1); return; }
  if(op === 'upsert'){
    if(idx >= 0) arr[idx] = { ...arr[idx], ...(data || {}) };
    else arr.push(data);
  }
}

/* ============================================================
   退出房間
   ============================================================ */
function requestDisconnect(){
  if(!isConnected()){ disconnectFirebase(); return; }
  const hasRoomData = state.alliances.length || state.zones.length || state.cities.length;
  if(!hasRoomData){
    if(typeof window.SLG.showConfirm === 'function'){
      window.SLG.showConfirm('中斷連線', '確定要中斷與盟友的連線嗎？', () => disconnectFirebase());
    } else if(confirm('確定要中斷與盟友的連線嗎？')){ disconnectFirebase(); }
    return;
  }
  const desc = document.getElementById('exitRestoreDesc');
  if(desc) desc.textContent = '還原成加入房間前的個人沙盤（會從雲端重新載入）';
  document.getElementById('exitRoomModal').classList.add('show');
}

async function confirmExit(choice){
  document.getElementById('exitRoomModal').classList.remove('show');
  if(choice === 'keepRoom'){
    logSystem('💾 正在將房間資料寫入個人沙盤...');
    try{ await saveMySandbox(); logSystem('✅ 房間資料已寫入個人沙盤'); }
    catch(e){ console.warn('寫入個人沙盤失敗', e); }
  } else {
    logSystem('↩️ 正在從雲端重新載入個人沙盤...');
    disconnectFirebase();
    try{ await loadMySandbox(); logSystem('✅ 已恢復個人沙盤'); }
    catch(e){ console.warn('恢復沙盤失敗', e); }
  }
  if(choice === 'keepRoom') disconnectFirebase();
  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
}

/* ============================================================
   v8.8.0：地圖庫（Map Library）
   ============================================================ */

/* ── 路徑輔助 ── */
function mapIndexRef(){ return fbDb.ref('mapLibraryIndex'); }
function mapRef(mapId){ return fbDb.ref(`mapLibrary/${mapId}`); }

/* ── 權限檢查（v8.9.4：所有人皆可編輯）── */
function canEditMapLibrary(){
  /* v8.9.4：只要登入即可編輯地圖庫 */
  return !!state.auth.signedIn;
}

/* ── Cloudinary 上傳 ── */
function uploadMapImageToCloudinary(file, onProgress){
  return new Promise((resolve, reject) => {
    if(!file){ reject(new Error('未選擇檔案')); return; }
    if(file.size > MAP_IMAGE_MAX_SIZE){
      reject(new Error(`檔案過大（${(file.size/1024/1024).toFixed(1)} MB），上限 ${MAP_IMAGE_MAX_SIZE/1024/1024} MB`));
      return;
    }
    if(!/^image\//.test(file.type)){
      reject(new Error('僅支援圖片檔案（PNG / JPG / WebP）'));
      return;
    }
    if(!isOnline()){
      reject(new Error('離線中，無法上傳'));
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder', 'slg_maps');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', CLOUDINARY_UPLOAD_URL, true);

    xhr.upload.onprogress = (e) => {
      if(e.lengthComputable && typeof onProgress === 'function'){
        const percent = Math.round((e.loaded / e.total) * 100);
        try{ onProgress(percent); }catch(_){}
      }
    };

    xhr.onload = () => {
      if(xhr.status >= 200 && xhr.status < 300){
        try{
          const res = JSON.parse(xhr.responseText);
          if(!res.secure_url){
            reject(new Error('Cloudinary 未回傳 secure_url'));
            return;
          }
          resolve({
            secureUrl: res.secure_url,
            width: res.width || 0,
            height: res.height || 0,
            publicId: res.public_id || '',
            bytes: res.bytes || 0,
            format: res.format || '',
          });
        }catch(e){
          reject(new Error('解析 Cloudinary 回應失敗：' + e.message));
        }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try{
          const err = JSON.parse(xhr.responseText);
          if(err && err.error && err.error.message) msg = err.error.message;
        }catch(_){}
        reject(new Error('Cloudinary 上傳失敗：' + msg));
      }
    };

    xhr.onerror = () => reject(new Error('網路錯誤，Cloudinary 上傳失敗'));
    xhr.ontimeout = () => reject(new Error('Cloudinary 上傳逾時'));
    xhr.timeout = 120000;

    xhr.send(formData);
  });
}

/* ── 地圖庫 CRUD ── */
async function fetchMapLibraryIndex(){
  if(!fbDb) return {};
  if(!state.auth.signedIn) return {};
  if(!isOnline()) return state.mapLibrary.index || {};
  try{
    const snap = await mapIndexRef().once('value');
    return snap.val() || {};
  }catch(e){
    console.warn('讀取地圖庫索引失敗', e);
    return {};
  }
}

async function fetchMapLibraryMap(mapId){
  if(!fbDb || !mapId) return null;
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法讀取地圖');
  try{
    const snap = await mapRef(mapId).once('value');
    return snap.val() || null;
  }catch(e){
    console.warn(`讀取地圖 ${mapId} 失敗`, e);
    throw e;
  }
}

async function saveMapLibraryMap(mapId, payload){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法儲存');
  if(!payload || !payload.name) throw new Error('缺少地圖名稱');

  const id = mapId || ('map_' + uid());
  const now = Date.now();

  const fullData = {
    name: String(payload.name).trim().slice(0, 30),
    imageUrl: payload.imageUrl || '',
    imageWidth: Number(payload.imageWidth) || 0,
    imageHeight: Number(payload.imageHeight) || 0,
    nodes: payload.nodes || {},
    updatedAt: now,
    updatedBy: state.auth.accountUid || '',
    updatedByName: state.auth.displayName || '',
  };

  const prevSnap = await mapRef(id).once('value');
  const prev = prevSnap.val();
  if(prev && prev.createdAt){
    fullData.createdAt = prev.createdAt;
    fullData.createdBy = prev.createdBy || '';
    fullData.createdByName = prev.createdByName || '';
  } else {
    fullData.createdAt = now;
    fullData.createdBy = state.auth.accountUid || '';
    fullData.createdByName = state.auth.displayName || '';
  }

  const nodeCount = Object.keys(fullData.nodes || {}).length;
  const updates = {};
  updates[`mapLibrary/${id}`] = fullData;
  updates[`mapLibraryIndex/${id}`] = {
    name: fullData.name,
    updatedAt: fullData.updatedAt,
    imageWidth: fullData.imageWidth,
    imageHeight: fullData.imageHeight,
    imageUrl: fullData.imageUrl,
    nodeCount,
    createdByName: fullData.createdByName,
    updatedByName: fullData.updatedByName,
  };

  await fbDb.ref().update(updates);
  logSystem(`💾 已儲存地圖：${fullData.name}（${nodeCount} 節點）`);
  return id;
}

async function updateMapNodes(mapId, nodes, meta){
  if(!fbDb || !mapId) throw new Error('缺少 mapId');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法儲存');

  const now = Date.now();
  const updates = {};
  updates[`mapLibrary/${mapId}/nodes`] = nodes || {};
  updates[`mapLibrary/${mapId}/updatedAt`] = now;
  updates[`mapLibrary/${mapId}/updatedBy`] = state.auth.accountUid || '';
  updates[`mapLibrary/${mapId}/updatedByName`] = state.auth.displayName || '';

  const nodeCount = Object.keys(nodes || {}).length;
  updates[`mapLibraryIndex/${mapId}/updatedAt`] = now;
  updates[`mapLibraryIndex/${mapId}/nodeCount`] = nodeCount;
  updates[`mapLibraryIndex/${mapId}/updatedByName`] = state.auth.displayName || '';

  if(meta){
    if(typeof meta.name === 'string' && meta.name.trim()){
      const trimmed = meta.name.trim().slice(0, 30);
      updates[`mapLibrary/${mapId}/name`] = trimmed;
      updates[`mapLibraryIndex/${mapId}/name`] = trimmed;
    }
    if(typeof meta.imageUrl === 'string'){
      updates[`mapLibrary/${mapId}/imageUrl`] = meta.imageUrl;
      updates[`mapLibraryIndex/${mapId}/imageUrl`] = meta.imageUrl;
    }
    if(typeof meta.imageWidth === 'number'){
      updates[`mapLibrary/${mapId}/imageWidth`] = meta.imageWidth;
      updates[`mapLibraryIndex/${mapId}/imageWidth`] = meta.imageWidth;
    }
    if(typeof meta.imageHeight === 'number'){
      updates[`mapLibrary/${mapId}/imageHeight`] = meta.imageHeight;
      updates[`mapLibraryIndex/${mapId}/imageHeight`] = meta.imageHeight;
    }
  }

  await fbDb.ref().update(updates);
  logSystem(`💾 已更新地圖節點（${nodeCount} 節點）`);
}

/**
 * v8.9.5：從地圖庫同步節點座標到城池的 mapNode
 * 用於手動修復、或全域校準後批次同步
 * @param {string} mapId
 * @returns {Promise<{synced:number, failed:number}>}
 */
async function syncMapNodesToCities(mapId){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!mapId) throw new Error('缺少 mapId');
  if(!isOnline()) throw new Error('離線中，無法同步');

  const mapData = state.mapLibrary.loaded[mapId];
  if(!mapData || !mapData.nodes){
    throw new Error('地圖尚未載入，請先選擇地圖');
  }
  const nodes = mapData.nodes;

  let synced = 0;
  let failed = 0;
  for(const nid in nodes){
    const node = nodes[nid];
    if(!node) continue;

    /* 找對應城池 */
    let city = null;
    if(node.namedCityId){
      city = state.cities.find(c => c.id === node.namedCityId);
    }
    if(!city && node.code){
      city = state.cities.find(c => c.code && c.code === node.code);
    }
    if(!city && node.name){
      city = state.cities.find(c => c.name === node.name);
    }
    if(!city){ failed++; continue; }

    city.mapNode = {
      mapId: mapId,
      nodeId: nid,
      x: node.x,
      y: node.y,
      method: node.source || 'manual',
    };
    state.entityRev.city[city.id] = (state.entityRev.city[city.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', city.id);
    synced++;
  }

  if(synced > 0){
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState('important');
  }

  logSystem(`🔄 已從地圖庫同步 ${synced} 個城池座標${failed > 0 ? `（${failed} 個找不到對應）` : ''}`);
  return { synced, failed };
}

/**
 * v8.9.5：清除城池中所有「非當前地圖」的 mapNode
 * 用於換地圖時，避免舊座標干擾
 * @param {string} currentMapId
 * @returns {number} 清除數量
 */
function clearStaleMapNodes(currentMapId){
  let cleared = 0;
  for(const city of state.cities){
    if(city.mapNode && city.mapNode.mapId && city.mapNode.mapId !== currentMapId){
      delete city.mapNode;
      state.entityRev.city[city.id] = (state.entityRev.city[city.id] || 0) + 1;
      if(window.SLG.markDirty) window.SLG.markDirty('city', city.id);
      cleared++;
    }
  }
  if(cleared > 0){
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState('important');
    logSystem(`🧹 已清除 ${cleared} 個過期 mapNode`);
  }
  return cleared;
}

/**
 * v8.9.4：寫入單一節點到地圖庫（用於新增城池時帶座標）
 * @param {string} mapId
 * @param {string} nodeId  - 節點 ID（通常為城池編號或 n_<cityId>）
 * @param {Object} node    - { name, code, x, y, source }
 */
async function writeNodeToMapLibrary(mapId, nodeId, node){
  if(!fbDb || !mapId || !nodeId) throw new Error('缺少 mapId 或 nodeId');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法儲存');
  if(!node || typeof node.x !== 'number' || typeof node.y !== 'number'){
    throw new Error('節點座標無效');
  }

  const now = Date.now();
  const updates = {};
  updates[`mapLibrary/${mapId}/nodes/${nodeId}`] = {
    name: String(node.name || '').slice(0, 30),
    code: String(node.code || '').slice(0, 20),
    x: Math.round(node.x),
    y: Math.round(node.y),
    source: node.source || 'manual',
  };
  updates[`mapLibrary/${mapId}/updatedAt`] = now;
  updates[`mapLibrary/${mapId}/updatedBy`] = state.auth.accountUid || '';
  updates[`mapLibrary/${mapId}/updatedByName`] = state.auth.displayName || '';

  /* 更新索引的 nodeCount（需要先讀取目前數量） */
  try{
    const snap = await mapRef(mapId).child('nodes').once('value');
    const allNodes = snap.val() || {};
    const count = Object.keys(allNodes).length;
    updates[`mapLibraryIndex/${mapId}/nodeCount`] = count;
    updates[`mapLibraryIndex/${mapId}/updatedAt`] = now;
    updates[`mapLibraryIndex/${mapId}/updatedByName`] = state.auth.displayName || '';
  }catch(e){ /* 忽略索引更新失敗 */ }

  await fbDb.ref().update(updates);
  logSystem(`📍 已寫入節點：${node.name}（${nodeId}）`);
}

/**
 * v8.9.1：儲存地圖路線（獨立節點）
 */
async function saveMapRoutes(mapId, routes){
  if(!fbDb || !mapId) throw new Error('缺少 mapId');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!isOnline()) throw new Error('離線中，無法儲存');

  const now = Date.now();
  const updates = {};
  updates[`mapLibrary/${mapId}/routes`] = routes || [];
  updates[`mapLibrary/${mapId}/routesUpdatedAt`] = now;
  updates[`mapLibraryIndex/${mapId}/routeCount`] = (routes || []).length;
  updates[`mapLibraryIndex/${mapId}/updatedAt`] = now;

  await fbDb.ref().update(updates);
  logSystem(`💾 已儲存 ${(routes || []).length} 條路線`);
}

async function deleteMapLibraryMap(mapId){
  if(!fbDb || !mapId) throw new Error('缺少 mapId');
  if(!state.auth.signedIn) throw new Error('請先登入');
  if(!(window.SLG.Auth && window.SLG.Auth.isSuperAdmin())){
    throw new Error('只有超級管理員可以刪除地圖');
  }
  if(!isOnline()) throw new Error('離線中，無法刪除');

  const updates = {};
  updates[`mapLibrary/${mapId}`] = null;
  updates[`mapLibraryIndex/${mapId}`] = null;
  await fbDb.ref().update(updates);

  delete state.mapLibrary.index[mapId];
  delete state.mapLibrary.loaded[mapId];
  if(state.mapLibrary.activeMapId === mapId){
    state.mapLibrary.activeMapId = '';
    if(window.SLG.saveMapLibraryPrefs) window.SLG.saveMapLibraryPrefs();
  }
  emit(EVT.MAP_LIBRARY_UPDATED, { type: 'deleted', mapId });
  logSystem(`🗑️ 已刪除地圖：${mapId}`);
}

/* ── 即時監聽 ── */
function startMapLibraryIndexWatcher(){
  if(!fbDb) return;
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  stopMapLibraryIndexWatcher();

  mapLibraryIndexRef = mapIndexRef();
  mapLibraryIndexHandler = mapLibraryIndexRef.on('value', snap => {
    const val = snap.val() || {};
    state.mapLibrary.index = val;
    emit(EVT.MAP_LIBRARY_UPDATED, { type: 'index-updated' });
  }, err => {
    console.warn('地圖庫索引監聽失敗', err);
  });
}

function stopMapLibraryIndexWatcher(){
  if(mapLibraryIndexRef && mapLibraryIndexHandler){
    try{ mapLibraryIndexRef.off('value', mapLibraryIndexHandler); }catch(e){}
  }
  mapLibraryIndexRef = null;
  mapLibraryIndexHandler = null;
}

function startMapLibraryMapWatcher(mapId){
  if(!fbDb || !mapId) return;
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  stopMapLibraryMapWatcher();
  currentWatchedMapId = mapId;

  mapLibraryMapRef = mapRef(mapId);
  mapLibraryMapHandler = mapLibraryMapRef.on('value', snap => {
    const val = snap.val();
    if(!val){
      delete state.mapLibrary.loaded[mapId];
      if(state.mapLibrary.activeMapId === mapId){
        state.mapLibrary.activeMapId = '';
        if(window.SLG.saveMapLibraryPrefs) window.SLG.saveMapLibraryPrefs();
      }
    } else {
      const existing = state.mapLibrary.loaded[mapId] || {};
      state.mapLibrary.loaded[mapId] = Object.assign({}, existing, val);
      if(existing.imageUrl !== val.imageUrl){
        loadMapImageElement(mapId, val.imageUrl);
      }
    }
    emit(EVT.MAP_LIBRARY_UPDATED, { type: 'map-updated', mapId });
  }, err => {
    console.warn('地圖監聽失敗', err);
  });
}

function stopMapLibraryMapWatcher(){
  if(mapLibraryMapRef && mapLibraryMapHandler){
    try{ mapLibraryMapRef.off('value', mapLibraryMapHandler); }catch(e){}
  }
  mapLibraryMapRef = null;
  mapLibraryMapHandler = null;
  currentWatchedMapId = '';
}

function stopAllMapLibraryWatchers(){
  stopMapLibraryIndexWatcher();
  stopMapLibraryMapWatcher();
}

/* ── 底圖 Image 元素快取 ── */
function loadMapImageElement(mapId, url){
  return new Promise((resolve, reject) => {
    if(!url){ reject(new Error('缺少圖片 URL')); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const map = state.mapLibrary.loaded[mapId];
      if(map){
        map.imageEl = img;
        if(!map.imageWidth) map.imageWidth = img.naturalWidth;
        if(!map.imageHeight) map.imageHeight = img.naturalHeight;
      }
      emit(EVT.MAP_LIBRARY_UPDATED, { type: 'image-loaded', mapId });
      resolve(img);
    };
    img.onerror = (e) => {
      console.warn(`載入底圖失敗：${mapId}`, url);
      reject(new Error('圖片載入失敗'));
    };
    img.src = url;
  });
}

async function ensureMapLoaded(mapId){
  if(!mapId) throw new Error('缺少 mapId');
  if(!state.auth.signedIn) throw new Error('請先登入');

  let map = state.mapLibrary.loaded[mapId];

  if(!map || !map.nodes || !map.imageUrl){
    if(!isOnline()) throw new Error('離線中，無法載入地圖');
    const data = await fetchMapLibraryMap(mapId);
    if(!data) throw new Error('地圖不存在');
    map = Object.assign({}, state.mapLibrary.loaded[mapId] || {}, data);
    state.mapLibrary.loaded[mapId] = map;
  }

  if(!map.imageEl && map.imageUrl){
    try{
      await loadMapImageElement(mapId, map.imageUrl);
    }catch(e){
      console.warn('底圖載入失敗', e);
    }
  }

  return map;
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  FIREBASE_CONFIG, SANDBOX_HISTORY_LIMIT,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_UPLOAD_PRESET, CLOUDINARY_UPLOAD_URL,
  MAP_IMAGE_MAX_SIZE,
  initFirebase, getDb, getApp, isConnected,
  connectFirebase, disconnectFirebase, publish,
  acquireEditLock, releaseEditLock,
  handleIncoming, addChatMessage, sendChatMessage, sendSystemChat,
  sandboxRef, fetchUserSandbox, fetchAllSandboxes,
  saveMySandbox, loadMySandbox, clearLocalSandbox,
  roomSnapshotPath, fetchRoomSnapshot, fetchAllRoomSnapshots,
  publishRoomSnapshot, uploadSandboxToRoom,
  rescueRoomSnapshot,
  listSandboxHistory, restoreFromHistory, previewHistory,
  createSandboxBackup,        /* v8.9.4：手動建立備份 */
  requestRoomEditAccess, approveEditRequest, rejectEditRequest,
  requestDisconnect, confirmExit,

  /* v8.8.0：地圖庫 */
  canEditMapLibrary,
  uploadMapImageToCloudinary,
  fetchMapLibraryIndex,
  fetchMapLibraryMap,
  saveMapLibraryMap,
  updateMapNodes,
  saveMapRoutes,
  writeNodeToMapLibrary,      /* v8.9.4：寫入單一節點 */
  deleteMapLibraryMap,
  startMapLibraryIndexWatcher,
  stopMapLibraryIndexWatcher,
  startMapLibraryMapWatcher,
  stopMapLibraryMapWatcher,
  stopAllMapLibraryWatchers,
  loadMapImageElement,
  ensureMapLoaded,
  mapIndexRef, mapRef,
  /* v8.9.5：座標同步工具 */
syncMapNodesToCities,
clearStaleMapNodes,
});

})();