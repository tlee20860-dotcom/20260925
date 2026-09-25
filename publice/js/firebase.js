/* ============================================================================
 * firebase.js — Firebase 連線 / 聊天室 / 推送申請 / 房間退出 / 房間編輯權限
 * v8.1 P6
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, on, emit, EVT,
  uid, nowTime, esc, logSystem,
  saveState, loadState, tickLamport, isNewer,
  buildFullSnapshot, applyFullSnapshot, applyPatch,
  enterRoomMode, exitRoomMode, updateModeBar,
  HOST_TIMEOUT, EDIT_LOCK_TTL,
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
   初始化（供 main.js 呼叫）
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

function onFirebaseConnected(asHost){
  fbConnected = true;
  state.connected = true;
  state.connecting = false;

  enterRoomMode();

  emit(EVT.CONN);
  emit(EVT.DEBUG, {msg:'🟢 已連線至 Firebase！'});

  const now = Date.now();
  state.isHost = !!asHost;
  state.hostName = asHost ? state.commanderName : '';

  /* Presence */
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

  /* Events */
  eventsRef = fbDb.ref(`rooms/${state.roomCode}/events`);
  const evHandler = eventsRef.limitToLast(200).on('child_added', snap => {
    const p = snap.val();
    if(!p) return;
    if(p._from === state.myClientId) return;
    if(p._ts && p._ts < connectTime) return;
    handleIncoming(p);
  });
  fbEventHandlers.push({ ref: eventsRef, evt:'child_added', fn: evHandler });

  /* Locks */
  locksRef = fbDb.ref(`rooms/${state.roomCode}/locks`);
  locksRef.on('value', snap => {
    state.editLocks = snap.val() || {};
    emit(EVT.LOCKS);
  });

  /* ★ P6：編輯授權監聽 */
  grantsRef = fbDb.ref(`rooms/${state.roomCode}/editGrants`);
  const grantsHandler = grantsRef.on('value', snap => {
    state.roomEditGrants = snap.val() || {};
    /* 檢查自己是否已獲得授權 */
    if(state.auth.accountUid && state.roomEditGrants[state.auth.accountUid]){
      state.myEditRequestStatus = 'granted';
    } else if(state.myEditRequestStatus === 'granted'){
      state.myEditRequestStatus = 'idle';
    }
    emit(EVT.ROOM_GRANTS);
  });
  fbEventHandlers.push({ ref: grantsRef, evt:'value', fn: grantsHandler });

  /* ★ P6：待審核申請監聽 */
  pendingEditRef = fbDb.ref(`rooms/${state.roomCode}/pendingEditRequests`);
  const pendingEditHandler = pendingEditRef.on('value', snap => {
    state.pendingEditRequests = snap.val() || {};
    /* 檢查自己是否有 pending 申請 */
    if(state.auth.accountUid && state.pendingEditRequests[state.auth.accountUid]){
      state.myEditRequestStatus = 'pending';
    } else if(state.myEditRequestStatus === 'pending'){
      state.myEditRequestStatus = 'idle';
    }
    emit(EVT.ROOM_PENDING);
  });
  fbEventHandlers.push({ ref: pendingEditRef, evt:'value', fn: pendingEditHandler });

  /* Chat */
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

  /* 同步模式決定 */
  decideSyncMode();

  startEditLockRenew();
  if(typeof window.SLG.updatePushButtonState === 'function'){
    window.SLG.updatePushButtonState();
  }
  if(typeof window.SLG.updateRoomEditButton === 'function'){
    window.SLG.updateRoomEditButton();
  }
}

function decideSyncMode(){
  if(state.isHost){
    state.roomEpoch = uid();
    fbDb.ref(`rooms/${state.roomCode}/events`).limitToLast(1).once('value')
      .then(snap => {
        const hasEvents = snap.exists() && snap.numChildren() > 0;
        if(!hasEvents){
          if(state.alliances.length || state.zones.length || state.cities.length){
            setTimeout(() => {
              publish(buildFullSnapshot());
              emit(EVT.DEBUG, {msg:'📤 新房間，已推送本機沙盤'});
            }, 400);
          } else {
            emit(EVT.DEBUG, {msg:'📭 新房間，本機無資料'});
          }
        } else {
          emit(EVT.DEBUG, {msg:'⚠️ 房間已有資料，改為拉取模式'});
          if(typeof window.SLG.backupLocalBeforeJoin === 'function'){
            window.SLG.backupLocalBeforeJoin();
          }
          setTimeout(() => {
            publish({ type:'sync_request', clientId:state.myClientId, name:state.commanderName });
          }, 400);
        }
      })
      .catch(() => {
        emit(EVT.DEBUG, {msg:'⚠️ 無法探測房間狀態，略過推送', err:true});
      });
  } else {
    if(typeof window.SLG.backupLocalBeforeJoin === 'function'){
      window.SLG.backupLocalBeforeJoin();
    }
    setTimeout(() => {
      publish({ type:'sync_request', clientId:state.myClientId, name:state.commanderName });
    }, 400);
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
  if(presenceWatchRef){ try{ presenceWatchRef.off(); }catch(e){} }
  if(connWatchRef){ try{ connWatchRef.off(); }catch(e){} }

  presenceRef = null; locksRef = null; chatRef = null;
  grantsRef = null; pendingEditRef = null;
  presenceWatchRef = null; connWatchRef = null; eventsRef = null;

  fbConnected = false;
  state.connected = false;
  state.connecting = false;
  state.isHost = false;
  state.hostName = '';
  state.members = {};
  state.editLocks = {};
  state.roomCode = '';

  state.pushRequestStatus = 'idle';
  state.pendingPushRequest = null;

  /* ★ P6：清除房間編輯權限狀態 */
  if(window.SLG.resetRoomEditState) window.SLG.resetRoomEditState();

  const pushModal = document.getElementById('pushRequestModal');
  if(pushModal) pushModal.classList.remove('show');
  const exitModal = document.getElementById('exitRoomModal');
  if(exitModal) exitModal.classList.remove('show');
  const reviewModal = document.getElementById('editRequestReviewModal');
  if(reviewModal) reviewModal.classList.remove('show');

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
        emit(EVT.DEBUG, {msg:'🔄 已同步房主快照（本機資料被覆蓋）'});
      }
      break;
    }
    case 'sync_request': {
      if(!state.isHost) return;
      logSystem(`🔄 ${payload.name||'盟友'} 請求同步，傳送快照...`);
      publish(buildFullSnapshot());
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
    case 'push_request': {
      if(!state.isHost) return;
      handlePushRequestFromMember(payload);
      break;
    }
    case 'push_response': {
      if(payload.targetClientId !== state.myClientId) return;
      handlePushResponse(payload);
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
   推送申請
   ============================================================ */
function requestPushToRoom(){
  if(!isConnected()){ alert('請先加入房間'); return; }
  if(state.isHost){ alert('房主不需申請推送'); return; }
  if(state.pushRequestStatus === 'pending'){ alert('已有申請等待房主回應'); return; }

  const hasData = state.alliances.length || state.zones.length || state.cities.length;
  if(!hasData){ alert('本機沒有任何資料可推送'); return; }

  state.pushRequestStatus = 'pending';
  if(typeof window.SLG.updatePushButtonState === 'function'){
    window.SLG.updatePushButtonState();
  }
  saveState();

  publish({
    type: 'push_request',
    clientId: state.myClientId,
    name: state.commanderName,
    stats: {
      cities: state.cities.length,
      alliances: state.alliances.length,
      zones: state.zones.length,
    },
  });
  logSystem('📤 已向房主發送推送申請...');
}

function handlePushRequestFromMember(payload){
  if(state.pendingPushRequest){
    logSystem(`⏸️ ${payload.name} 的推送申請被忽略（已有進行中的申請）`);
    return;
  }
  state.pendingPushRequest = payload;

  const info = `${payload.name} 想要推送本機資料到房間：\n\n` +
    `🏰 城池：${payload.stats.cities} 座\n` +
    `🤝 同盟：${payload.stats.alliances} 個\n` +
    `🗺️ 戰區：${payload.stats.zones} 個`;

  document.getElementById('pushRequestInfo').textContent = info;
  document.getElementById('pushRequestModal').classList.add('show');
  logSystem(`📥 收到 ${payload.name} 的推送申請`);
}

function approvePush(){
  const req = state.pendingPushRequest;
  if(!req) return;
  publish({
    type: 'push_response',
    targetClientId: req.clientId,
    approved: true,
    hostName: state.commanderName,
  });
  logSystem(`✅ 已同意 ${req.name} 的推送申請`);
  sendSystemChat(`✅ 房主同意了 ${req.name} 的推送申請`);
  state.pendingPushRequest = null;
  document.getElementById('pushRequestModal').classList.remove('show');
}

function rejectPush(){
  const req = state.pendingPushRequest;
  if(!req) return;
  publish({
    type: 'push_response',
    targetClientId: req.clientId,
    approved: false,
    hostName: state.commanderName,
  });
  logSystem(`❌ 已拒絕 ${req.name} 的推送申請`);
  state.pendingPushRequest = null;
  document.getElementById('pushRequestModal').classList.remove('show');
}

function handlePushResponse(payload){
  if(payload.approved){
    logSystem(`✅ 房主 ${payload.hostName || ''} 同意推送，開始上傳...`);
    state.pushRequestStatus = 'idle';
    if(typeof window.SLG.updatePushButtonState === 'function'){
      window.SLG.updatePushButtonState();
    }
    saveState();

    try{
      publish(buildFullSnapshot());
      sendSystemChat(`📤 ${state.commanderName} 已覆蓋房間資料`);
      alert('✅ 房主已接受，您的資料已推送到房間。');
    }catch(e){
      console.error('推送失敗', e);
      alert('❌ 推送失敗：' + e.message);
    }
  } else {
    logSystem(`❌ 房主拒絕了推送申請`);
    state.pushRequestStatus = 'idle';
    if(typeof window.SLG.updatePushButtonState === 'function'){
      window.SLG.updatePushButtonState();
    }
    saveState();
    alert('❌ 房主拒絕了您的推送申請，房間資料未變更。');
  }
}

function updatePushButtonState(){
  const row = document.getElementById('pushRequestRow');
  const btn = document.getElementById('btnRequestPush');
  if(!row || !btn) return;

  if(!isConnected() || state.isHost){
    row.style.display = 'none';
    return;
  }
  row.style.display = '';

  const hasData = state.alliances.length || state.zones.length || state.cities.length;
  if(state.pushRequestStatus === 'pending'){
    btn.disabled = true;
    btn.textContent = '⏳ 等待房主回應...';
    btn.classList.remove('btn-warning');
    btn.classList.add('btn-ghost');
  } else if(!hasData){
    btn.disabled = true;
    btn.textContent = '📭 本機無資料可推送';
    btn.classList.remove('btn-warning');
    btn.classList.add('btn-ghost');
  } else {
    btn.disabled = false;
    btn.textContent = '📤 申請推送本機資料到房間';
    btn.classList.add('btn-warning');
    btn.classList.remove('btn-ghost');
  }
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
  if(!state.auth.signedIn || state.auth.isGuest){
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
   退出房間
   ============================================================ */
function requestDisconnect(){
  if(!isConnected()){
    disconnectFirebase();
    return;
  }

  const hasBackup = !!localStorage.getItem(window.SLG.LS_PREFIX + 'localBackup');
  const hasRoomData = state.alliances.length || state.zones.length || state.cities.length;

  if(!hasBackup || !hasRoomData){
    const msg = hasRoomData
      ? '確定要中斷與盟友的連線嗎？（目前房間資料會保留在本機）'
      : '確定要中斷與盟友的連線嗎？';
    if(typeof window.SLG.showConfirm === 'function'){
      window.SLG.showConfirm('中斷連線', msg, () => disconnectFirebase());
    } else {
      if(confirm(msg)) disconnectFirebase();
    }
    return;
  }

  let backupInfo = '';
  try{
    const b = JSON.parse(localStorage.getItem(window.SLG.LS_PREFIX + 'localBackup'));
    backupInfo = `（${(b.cities||[]).length} 座城 · ${b.backedUpAt ? new Date(b.backedUpAt).toLocaleString() : '未知時間'}）`;
  }catch(e){}

  const desc = document.getElementById('exitRestoreDesc');
  if(desc) desc.textContent = '還原成加入房間前的本機資料 ' + backupInfo;

  document.getElementById('exitRoomModal').classList.add('show');
}

function confirmExit(choice){
  document.getElementById('exitRoomModal').classList.remove('show');

  if(choice === 'restore'){
    const raw = localStorage.getItem(window.SLG.LS_PREFIX + 'localBackup');
    if(raw){
      try{
        const backup = JSON.parse(raw);
        state.alliances = backup.alliances || [];
        state.zones     = backup.zones     || [];
        state.cities    = backup.cities    || [];
        if(backup.settings) Object.assign(state.settings, backup.settings);
        logSystem('↩️ 已恢復進入房間前的本機資料');
      }catch(e){
        console.warn('恢復備份失敗', e);
      }
    }
  } else {
    localStorage.removeItem(window.SLG.LS_PREFIX + 'localBackup');
    logSystem('🔒 已保留房間資料到本機（本機備份已清除）');
  }

  disconnectFirebase();

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
  requestPushToRoom,
  handlePushRequestFromMember,
  approvePush,
  rejectPush,
  handlePushResponse,
  updatePushButtonState,
  requestDisconnect,
  confirmExit,
  /* P6 */
  requestRoomEditAccess,
  approveEditRequest,
  rejectEditRequest,
});

})();
