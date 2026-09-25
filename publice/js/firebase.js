/* ============================================================================
 * firebase.js — Firebase 連線 / 個人沙盤 / 房間沙盤 / 聊天 / 編輯權限 / 退出
 * v8.2
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
} = window.SLG;

/* ============================================================
   Firebase 設定
   ============================================================ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDjfakubDKBpCi4xi1l_W_M6f9MdNC0oe0",
  authDomain: "ya-sandbox.firebaseapp.com",
  databaseURL: "https://ya-sandbox-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ya-sandbox",
  storageBucket: "ya-sandbox.firebasestorage.app",
  messagingSenderId: "648660430942",
  appId: "1:648660430942:web:bb09124cbb3a2dc72f44cf"
};

/* ============================================================
   模組內部狀態
   ============================================================ */
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
   ★ v8.2：個人雲端沙盤 API
   ============================================================ */
function sandboxRef(uid){
  return fbDb.ref(`userSandboxes/${uid}`);
}

/**
 * 讀取指定帳號的雲端沙盤
 * @returns Promise<{ username, displayName, updatedAt, data } | null>
 */
async function fetchUserSandbox(uid){
  if(!fbDb) return null;
  try{
    const snap = await sandboxRef(uid).once('value');
    return snap.val() || null;
  }catch(e){
    console.warn(`讀取 ${uid} 沙盤失敗`, e);
    return null;
  }
}

/**
 * 讀取所有沙盤清單（個人沙盤）
 * @returns Promise<{ [uid]: sandboxData }>
 */
async function fetchAllSandboxes(){
  if(!fbDb) return {};
  try{
    const snap = await fbDb.ref('userSandboxes').once('value');
    return snap.val() || {};
  }catch(e){
    console.warn('讀取沙盤清單失敗', e);
    return {};
  }
}

/**
 * 儲存當前 state 到自己的雲端沙盤
 */
async function saveMySandbox(){
  if(!fbDb) return false;
  if(!state.auth.signedIn) return false;
  const uid = state.auth.accountUid;
  if(!uid) return false;

  const payload = {
    username: state.auth.username,
    displayName: state.auth.displayName,
    updatedAt: Date.now(),
    data: buildSandboxData(),
  };

  try{
    state.mySandbox.saving = true;
    await sandboxRef(uid).set(payload);
    state.mySandbox.updatedAt = payload.updatedAt;
    state.mySandbox.loaded = true;
    state.mySandbox.saving = false;
    emit(EVT.MY_SANDBOX_UPDATED);
    return true;
  }catch(e){
    state.mySandbox.saving = false;
    console.warn('儲存個人沙盤失敗', e);
    return false;
  }
}

/**
 * 載入自己的雲端沙盤到 state
 */
async function loadMySandbox(){
  if(!fbDb) return false;
  if(!state.auth.signedIn) return false;
  const uid = state.auth.accountUid;
  if(!uid) return false;

  state.mySandbox.loading = true;
  emit(EVT.MY_SANDBOX_UPDATED);

  try{
    const data = await fetchUserSandbox(uid);
    if(data && data.data){
      applySandboxData(data.data);
      state.mySandbox.updatedAt = data.updatedAt || 0;
      state.mySandbox.loaded = true;
      logSystem('☁️ 已載入個人雲端沙盤');
    } else {
      /* 雲端沒資料：把本機現有資料上傳作為初始沙盤 */
      state.mySandbox.loaded = true;
      state.mySandbox.updatedAt = 0;
      logSystem('☁️ 雲端無沙盤，將使用本機資料');
      if(state.alliances.length || state.zones.length || state.cities.length){
        await saveMySandbox();
      }
    }
    state.mySandbox.loading = false;
    emit(EVT.MY_SANDBOX_UPDATED);
    return true;
  }catch(e){
    state.mySandbox.loading = false;
    console.warn('載入個人沙盤失敗', e);
    return false;
  }
}

/* ============================================================
   ★ v8.2：房間沙盤 API
   ============================================================ */
function roomSnapshotPath(){
  return `rooms/${state.roomCode}/latestSnapshot`;
}

/**
 * 讀取指定房間的 latestSnapshot
 */
async function fetchRoomSnapshot(roomCode){
  if(!fbDb) return null;
  try{
    const snap = await fbDb.ref(`rooms/${roomCode}/latestSnapshot`).once('value');
    return snap.val() || null;
  }catch(e){
    console.warn(`讀取房間 ${roomCode} 沙盤失敗`, e);
    return null;
  }
}

/**
 * 讀取所有房間沙盤（僅 meta + updatedAt）
 */
async function fetchAllRoomSnapshots(){
  if(!fbDb) return {};
  try{
    const snap = await fbDb.ref('rooms').once('value');
    const all = snap.val() || {};
    const result = {};
    for(const code in all){
      const room = all[code];
      if(room && room.latestSnapshot){
        result[code] = room.latestSnapshot;
      }
    }
    return result;
  }catch(e){
    console.warn('讀取房間沙盤清單失敗', e);
    return {};
  }
}

/**
 * 將目前 state 寫入房間 latestSnapshot
 */
async function publishRoomSnapshot(){
  if(!fbDb || !state.roomCode) return false;
  if(!window.SLG.canEditRoomData || !window.SLG.canEditRoomData()) return false;

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
  }catch(e){
    console.warn('寫入房間快照失敗', e);
    return false;
  }
}

/**
 * 手動上載指定沙盤資料到房間
 */
async function uploadSandboxToRoom(sandboxData, sourceName){
  if(!fbDb || !state.roomCode) return false;
  if(!window.SLG.canUploadSandboxToRoom || !window.SLG.canUploadSandboxToRoom()){
    alert('您沒有上載沙盤到此房間的權限');
    return false;
  }
  if(!sandboxData){
    alert('沙盤資料為空');
    return false;
  }

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

    /* 同時把沙盤內容套用到本機，並透過 events 廣播給其他成員 */
    applySandboxData(sandboxData);
    saveState();
    emit(EVT.DATA);

    /* 廣播完整快照給在線的其他人 */
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
  if(!roomCode || roomCode.length !== 6){
    emit(EVT.DEBUG, {msg:'❌ 房間碼必須為6位數', err:true});
    return;
  }
  if(!state.commanderName){
    emit(EVT.DEBUG, {msg:'❌ 請先填寫指揮官名稱', err:true});
    return;
  }

  if(fbConnected || state.connecting) disconnectFirebase();

  state.roomCode = roomCode;
  state.myClientId = 'slg_' + uid();
  state.connecting = true;
  state.connected = false;
  connectTime = Date.now();
  emit(EVT.CONN);
  emit(EVT.DEBUG, {msg:'🟡 正在連線至 Firebase...'});

  if(!fbDb){
    state.connecting = false;
    emit(EVT.CONN);
    emit(EVT.DEBUG, {msg:'❌ Firebase 未初始化', err:true});
    return;
  }

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

  /* 1. 先讀取房間 latestSnapshot */
  emit(EVT.DEBUG, {msg:'📥 讀取房間沙盤...'});
  try{
    const roomSnap = await fetchRoomSnapshot(state.roomCode);
    if(roomSnap && roomSnap.data){
      state.roomSnapshot = roomSnap;
      state.roomHasSnapshot = true;
      /* 自動套用房間沙盤到本機 */
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
  }catch(e){
    console.warn('讀取房間沙盤失敗', e);
  }

  /* 2. Presence */
  presenceRef = fbDb.ref(`rooms/${state.roomCode}/presence/${state.myClientId}`);
  presenceRef.set({
    name: state.commanderName,
    joinTime: now,
    isHost: state.isHost,
    lastSeen: now,
  });
  presenceRef.onDisconnect().remove();

  clearInterval(lastSeenTimer);
  lastSeenTimer = setInterval(() => {
    if(fbConnected && presenceRef) presenceRef.update({ lastSeen: Date.now() });
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
        state.members[cid] = {
          name:m.name, joinTime:m.joinTime,
          isHost:!!m.isHost, lastSeen:m.lastSeen
        };
      }
    }
    emit(EVT.MEMBERS);
    checkHostHealthFirebase();
  });

  /* 3. Events */
  eventsRef = fbDb.ref(`rooms/${state.roomCode}/events`);
  const evHandler = eventsRef.limitToLast(200).on('child_added', snap => {
    const p = snap.val();
    if(!p) return;
    if(p._from === state.myClientId) return;
    if(p._ts && p._ts < connectTime) return;
    handleIncoming(p);
  });
  fbEventHandlers.push({ ref: eventsRef, evt:'child_added', fn: evHandler });

  /* 4. Locks */
  locksRef = fbDb.ref(`rooms/${state.roomCode}/locks`);
  locksRef.on('value', snap => {
    state.editLocks = snap.val() || {};
    emit(EVT.LOCKS);
  });

  /* 5. P6：編輯授權 */
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

  /* 6. P6：待審核申請 */
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

  /* 7. ★ v8.2：房間 latestSnapshot 監聽 */
  latestSnapshotRef = fbDb.ref(roomSnapshotPath());
  const latestSnapshotHandler = latestSnapshotRef.on('value', snap => {
    const val = snap.val();
    if(val && val.data){
      const prevUpdatedAt = state.roomSnapshot ? state.roomSnapshot.updatedAt : 0;
      state.roomSnapshot = val;
      state.roomHasSnapshot = true;
      /* 若快照比本機新，且不是自己發的 → 套用 */
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

  /* 8. Chat */
  chatRef = fbDb.ref(`rooms/${state.roomCode}/chat`);
  const chatHandler = chatRef.limitToLast(200).on('child_added', snap => {
    const m = snap.val();
    if(!m) return;
    const isSelf = (m._from === state.myClientId);
    const isSystem = !!m.isSystem;
    addChatMessage({
      id: snap.key,
      sender: m.sender || '系統',
      text: m.text,
      time: m.time,
      isSelf,
      isSystem,
    });
    if(!isSelf && !isSystem){
      const chatTab = document.getElementById('tab-chat');
      if(!chatTab || !chatTab.classList.contains('active')){
        state.unreadChat++;
        if(typeof window.SLG.renderChatBadge === 'function'){
          window.SLG.renderChatBadge();
        }
      }
    }
  });
  fbEventHandlers.push({ ref: chatRef, evt:'child_added', fn: chatHandler });

  saveState();
  emit(EVT.HOST);

  startEditLockRenew();
  if(typeof window.SLG.updatePushButtonState === 'function'){
    window.SLG.updatePushButtonState();
  }
  if(typeof window.SLG.updateRoomEditButton === 'function'){
    window.SLG.updateRoomEditButton();
  }
  if(typeof window.SLG.updateRoomSandboxActions === 'function'){
    window.SLG.updateRoomSandboxActions();
  }
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
      if(typeof window.SLG.updatePushButtonState === 'function'){
        window.SLG.updatePushButtonState();
      }
      if(typeof window.SLG.updateRoomEditButton === 'function'){
        window.SLG.updateRoomEditButton();
      }
      if(typeof window.SLG.updateRoomSandboxActions === 'function'){
        window.SLG.updateRoomSandboxActions();
      }
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
    for(const cityId of myEditLocks){
      try{ locksRef.child(cityId).remove(); }catch(e){}
    }
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

  presenceRef = null; locksRef = null; chatRef = null;
  grantsRef = null; pendingEditRef = null; latestSnapshotRef = null;
  presenceWatchRef = null; connWatchRef = null; eventsRef = null;

  fbConnected = false;
  state.connected = false;
  state.connecting = false;
  state.isHost = false;
  state.hostName = '';
  state.members = {};
  state.editLocks = {};
  state.roomCode = '';

  /* ★ v8.2：清除房間狀態 */
  state.roomSnapshot = null;
  state.roomHasSnapshot = false;
  state.pendingUploadSandbox = null;

  if(window.SLG.resetRoomEditState) window.SLG.resetRoomEditState();

  const exitModal = document.getElementById('exitRoomModal');
  if(exitModal) exitModal.classList.remove('show');
  const reviewModal = document.getElementById('editRequestReviewModal');
  if(reviewModal) reviewModal.classList.remove('show');
  const emptyModal = document.getElementById('roomEmptyPromptModal');
  if(emptyModal) emptyModal.classList.remove('show');
  const pickerModal = document.getElementById('sandboxPickerModal');
  if(pickerModal) pickerModal.classList.remove('show');

  exitRoomMode();

  emit(EVT.CONN); emit(EVT.MEMBERS); emit(EVT.HOST); emit(EVT.LOCKS);
  emit(EVT.DEBUG, {msg:'🔴 已中斷連線'});
  saveState();
  if(typeof window.SLG.updatePushButtonState === 'function'){
    window.SLG.updatePushButtonState();
  }
  if(typeof window.SLG.updateRoomEditButton === 'function'){
    window.SLG.updateRoomEditButton();
  }
  if(typeof window.SLG.updateRoomSandboxActions === 'function'){
    window.SLG.updateRoomSandboxActions();
  }
}

/* ============================================================
   發送事件
   ============================================================ */
function publish(payload){
  if(!fbConnected || !fbDb || !state.roomCode) return;
  try{
    fbDb.ref(`rooms/${state.roomCode}/events`).push({
      ...payload,
      _from: state.myClientId,
      _ts: Date.now(),
    });
  }catch(e){
    console.warn('Firebase 發送失敗', e);
  }
}

/* ============================================================
   編輯鎖
   ============================================================ */
function acquireEditLock(cityId){
  if(!fbConnected || !fbDb || !state.roomCode) return;
  const ref = fbDb.ref(`rooms/${state.roomCode}/locks/${cityId}`);
  ref.set({
    clientId: state.myClientId,
    name: state.commanderName,
    expiresAt: Date.now() + EDIT_LOCK_TTL,
  });
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
        emit(EVT.DATA);
        saveState();
        emit(EVT.DEBUG, {msg:'🔄 已同步房主快照'});
      }
      break;
    }
    case 'trigger_simulate':
      emit(EVT.SIM_TRIGGER, payload);
      break;
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
      if(payload.rows){
        state.dynRows = payload.rows;
        emit(EVT.DYN_RESULT);
      }
      break;
    }
    /* ★ v8.2：房間沙盤更新廣播 */
    case 'room_snapshot_updated': {
      /* 房主已上載新沙盤，其他成員拉取 */
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
  if(state.chatMessages.length > 200){
    state.chatMessages = state.chatMessages.slice(-200);
  }
  if(typeof window.SLG.renderChat === 'function') window.SLG.renderChat();
  if(typeof window.SLG.renderChatBadge === 'function') window.SLG.renderChatBadge();
  saveState();
}

function sendChatMessage(text){
  text = (text || '').trim();
  if(!text) return;
  if(!state.commanderName){ alert('請先設定指揮官名稱'); return; }

  if(!isConnected()){
    addChatMessage({
      id: uid(),
      sender: state.commanderName,
      text,
      time: nowTime(),
      isSelf: true,
      isSystem: false,
    });
    return;
  }

  try{
    fbDb.ref(`rooms/${state.roomCode}/chat`).push({
      sender: state.commanderName,
      text,
      time: nowTime(),
      _from: state.myClientId,
      _ts: Date.now(),
    });
  }catch(e){
    console.warn('聊天發送失敗', e);
    addChatMessage({
      id: uid(),
      sender: state.commanderName,
      text,
      time: nowTime(),
      isSelf: true,
      isSystem: false,
    });
  }
}

function sendSystemChat(text){
  if(!isConnected()) return;
  try{
    fbDb.ref(`rooms/${state.roomCode}/chat`).push({
      sender: '系統',
      text: text,
      time: nowTime(),
      _from: state.myClientId,
      _ts: Date.now(),
      isSystem: true,
    });
  }catch(e){}
}

/* ============================================================
   ★ P6：房間編輯權限申請 / 批准 / 拒絕
   ============================================================ */
function requestRoomEditAccess(){
  if(!isConnected()){ alert('請先加入房間'); return; }
  if(window.SLG.canEditRoomData && window.SLG.canEditRoomData()){
    alert('您已擁有編輯權限');
    return;
  }
  if(state.myEditRequestStatus === 'pending'){
    alert('已送出申請，等待審核中');
    return;
  }
  if(!state.auth.signedIn){
    alert('請先登入');
    return;
  }

  const myUid = state.auth.accountUid;
  const ref = fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests/${myUid}`);
  ref.set({
    username: state.auth.username,
    displayName: state.auth.displayName,
    requestedAt: Date.now(),
  }).then(() => {
    state.myEditRequestStatus = 'pending';
    if(typeof window.SLG.updateRoomEditButton === 'function'){
      window.SLG.updateRoomEditButton();
    }
    logSystem('📝 已送出編輯權限申請');
    alert('✅ 申請已送出，等待房主或管理員審核。');
  }).catch(e => {
    console.warn('申請失敗', e);
    alert('❌ 申請失敗：' + e.message);
  });
}

function approveEditRequest(uid){
  const isAdmin = window.SLG.Auth && window.SLG.Auth.isAdmin();
  if(!state.isHost && !isAdmin){
    alert('權限不足');
    return;
  }
  const req = state.pendingEditRequests[uid];
  if(!req) return;

  const updates = {};
  updates[`rooms/${state.roomCode}/editGrants/${uid}`] = {
    username: req.username,
    displayName: req.displayName,
    grantedAt: Date.now(),
    grantedBy: state.auth.accountUid,
    grantedByName: state.auth.displayName,
  };
  updates[`rooms/${state.roomCode}/pendingEditRequests/${uid}`] = null;

  fbDb.ref().update(updates).then(() => {
    logSystem(`✅ 已批准 ${req.displayName} 的編輯權限`);
    sendSystemChat(`✅ ${req.displayName} 已獲得此房間的編輯權限`);
  }).catch(e => {
    console.warn('批准失敗', e);
    alert('❌ 批准失敗：' + e.message);
  });
}

function rejectEditRequest(uid){
  const isAdmin = window.SLG.Auth && window.SLG.Auth.isAdmin();
  if(!state.isHost && !isAdmin){
    alert('權限不足');
    return;
  }
  const req = state.pendingEditRequests[uid];
  if(!req) return;

  fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests/${uid}`).remove()
    .then(() => {
      logSystem(`❌ 已拒絕 ${req.displayName} 的編輯權限申請`);
    })
    .catch(e => {
      console.warn('拒絕失敗', e);
      alert('❌ 拒絕失敗：' + e.message);
    });
}

/* ============================================================
   ★ v8.2：資料救援工具（僅管理員/超管）
   ============================================================ */
async function rescueRoomSnapshot(roomCode){
  if(!fbDb) throw new Error('Firebase 未就緒');
  if(!window.SLG.canUseRescueTool || !window.SLG.canUseRescueTool()){
    throw new Error('您沒有救援權限');
  }
  if(!roomCode || roomCode.length !== 6){
    throw new Error('房間碼必須為 6 位數');
  }

  /* 讀取所有 events */
  const snap = await fbDb.ref(`rooms/${roomCode}/events`).once('value');
  const all = snap.val() || {};
  const events = Object.entries(all)
    .map(([k, v]) => ({ key:k, ...v }))
    .filter(e => e && e._ts)
    .sort((a, b) => a._ts - b._ts);

  if(events.length === 0){
    throw new Error('此房間沒有任何事件');
  }

  /* 重播：套用所有 sync_snapshot 和 sync_patch */
  const reconstructed = {
    settings: {},
    alliances: [],
    zones: [],
    cities: [],
    entityRev: { alliance:{}, zone:{}, city:{} },
  };

  let lastSnapshotTs = 0;
  let patchCount = 0;

  for(const evt of events){
    if(evt.type === 'sync_snapshot'){
      /* 完整快照 → 直接覆蓋 */
      reconstructed.settings = JSON.parse(JSON.stringify(evt.settings || {}));
      reconstructed.alliances = JSON.parse(JSON.stringify(evt.alliances || []));
      reconstructed.zones = JSON.parse(JSON.stringify(evt.zones || []));
      reconstructed.cities = JSON.parse(JSON.stringify(evt.cities || []));
      reconstructed.entityRev = JSON.parse(JSON.stringify(evt.entityRev || { alliance:{}, zone:{}, city:{} }));
      lastSnapshotTs = evt._ts;
    } else if(evt.type === 'sync_patch'){
      if(!evt.patches) continue;
      for(const p of evt.patches){
        applyPatchToReconstructed(reconstructed, p);
      }
      patchCount += p_count(evt.patches);
    }
  }

  if(reconstructed.cities.length === 0 && reconstructed.alliances.length === 0){
    throw new Error('重播後無任何資料');
  }

  /* 寫入 latestSnapshot */
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
    eventsCount: events.length,
    patchesCount: patchCount,
    lastSnapshotTs,
    citiesCount: reconstructed.cities.length,
    alliancesCount: reconstructed.alliances.length,
  };
}

function p_count(arr){ return (arr || []).length; }

function applyPatchToReconstructed(rec, patch){
  if(!patch || !patch.kind) return;
  const { kind, id, rev, op, data } = patch;

  if(kind === 'settings'){
    Object.assign(rec.settings, data || {});
    return;
  }

  const key = kind === 'alliance' ? 'alliances'
            : kind === 'zone'     ? 'zones'
            : kind === 'city'     ? 'cities'
            : null;
  if(!key) return;

  const arr = rec[key];
  const idx = arr.findIndex(x => x.id === id);

  if(op === 'delete'){
    if(idx >= 0) arr.splice(idx, 1);
    return;
  }
  if(op === 'upsert'){
    if(idx >= 0) arr[idx] = { ...arr[idx], ...(data || {}) };
    else arr.push(data);
  }
}

/* ============================================================
   ★ v8.2：退出房間（改為新邏輯）
   ============================================================ */
function requestDisconnect(){
  if(!isConnected()){
    disconnectFirebase();
    return;
  }

  const hasRoomData = state.alliances.length || state.zones.length || state.cities.length;

  if(!hasRoomData){
    if(typeof window.SLG.showConfirm === 'function'){
      window.SLG.showConfirm('中斷連線', '確定要中斷與盟友的連線嗎？', () => disconnectFirebase());
    } else if(confirm('確定要中斷與盟友的連線嗎？')){
      disconnectFirebase();
    }
    return;
  }

  /* 顯示二選一：保留房間資料 / 恢復進入前的沙盤 */
  const desc = document.getElementById('exitRestoreDesc');
  if(desc){
    desc.textContent = '還原成加入房間前的個人沙盤（會從雲端重新載入）';
  }

  document.getElementById('exitRoomModal').classList.add('show');
}

async function confirmExit(choice){
  document.getElementById('exitRoomModal').classList.remove('show');

  if(choice === 'keepRoom'){
    /* 保留房間資料 → 寫入個人雲端沙盤 */
    logSystem('💾 正在將房間資料寫入個人沙盤...');
    try{
      await saveMySandbox();
      logSystem('✅ 房間資料已寫入個人沙盤');
    }catch(e){
      console.warn('寫入個人沙盤失敗', e);
    }
  } else {
    /* 恢復進入前的沙盤 → 從雲端重新載入 */
    logSystem('↩️ 正在從雲端重新載入個人沙盤...');
    disconnectFirebase();
    try{
      await loadMySandbox();
      logSystem('✅ 已恢復個人沙盤');
    }catch(e){
      console.warn('恢復沙盤失敗', e);
    }
  }

  if(choice === 'keepRoom'){
    disconnectFirebase();
  }

  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(typeof window.SLG.populateCityFilters === 'function') window.SLG.populateCityFilters();
  if(typeof window.SLG.populateZoneFilter === 'function') window.SLG.populateZoneFilter();
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  FIREBASE_CONFIG,
  initFirebase,
  getDb,
  getApp,
  isConnected,
  connectFirebase,
  disconnectFirebase,
  publish,
  acquireEditLock,
  releaseEditLock,
  handleIncoming,
  addChatMessage,
  sendChatMessage,
  sendSystemChat,

  /* ★ v8.2：個人沙盤 API */
  sandboxRef,
  fetchUserSandbox,
  fetchAllSandboxes,
  saveMySandbox,
  loadMySandbox,

  /* ★ v8.2：房間沙盤 API */
  roomSnapshotPath,
  fetchRoomSnapshot,
  fetchAllRoomSnapshots,
  publishRoomSnapshot,
  uploadSandboxToRoom,

  /* ★ v8.2：救援 */
  rescueRoomSnapshot,

  /* P6：房間編輯權限 */
  requestRoomEditAccess,
  approveEditRequest,
  rejectEditRequest,

  /* 退出 */
  requestDisconnect,
  confirmExit,
});

})();