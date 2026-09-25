/* ============================================================================
 * core.js — 全域狀態、事件匯流排、工具、持久化、模式管理、AI、房間權限判斷
 * v8.1 P6
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

/* 引用 simulation.js 已暴露的工具 */
const {
  hhmmToMinutes, minutesToHHMM, fmtSimTime, clamp, yieldToMain, computeAllocation,
  COMBAT_TICK, SIM_CHUNK, VIZ_SNAPSHOT_INTERVAL, DYN_ROUTE_SAMPLE_SEC
} = window.SLG;

/* ============================================================
   常量
   ============================================================ */
const LS_PREFIX = 'slg_sandtable_v75_';
const AI_LS_KEY = 'slg_ai_params';
const ACCOUNT_UID_KEY = 'slg_sandtable_v75_accountUid';
const HOST_TIMEOUT = 15000;
const EDIT_LOCK_TTL = 30000;

const PERCENT_OPTIONS = [0, 17, 33, 50, 67, 84, 100];

const ATTACK_RULES = {
  self:['enemy','common_enemy','npc'], ally:['enemy','common_enemy','npc'],
  enemy:['self','ally','npc','common_enemy'], common_enemy:['self','ally','npc','enemy'],
  npc:['self','ally','enemy','common_enemy'],
};
const DEFEND_RULES = { self:['self','ally'], ally:['self','ally'], enemy:[], common_enemy:[], npc:[] };
const SIDE_LABELS = { self:'本方', ally:'同盟', enemy:'敵方', common_enemy:'共同敵方', npc:'NPC' };
const ALLIANCE_SIDE_LABELS = { self:'本方', ally:'同盟', enemy:'敵方' };

const ROLE = {
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  OFFICER: 'officer',
  MEMBER: 'member',
  GUEST: 'guest',
};
const ROLE_LABELS = {
  superadmin: '👑 超級管理員',
  admin: '🛡️ 管理員',
  officer: '⚔️ 幹部',
  member: '🙋 成員',
  guest: '👻 訪客',
};
const ROLE_CLASS = {
  superadmin: 'role-superadmin',
  admin: 'role-admin',
  officer: 'role-officer',
  member: 'role-member',
  guest: 'role-guest',
};

const EVT = {
  MEMBERS:'members', LOCKS:'locks', DATA:'data',
  CONN:'conn', HOST:'host', CHAT_NEW:'chat:new',
  SIM_TRIGGER:'sim:trigger', DEBUG:'debug',
  VIZ_SNAPSHOTS:'viz:snapshots', VIZ_RESET:'viz:reset',
  DYN_RESULT:'dyn:result',
  PUSH_REQUEST:'push:request',
  PUSH_RESPONSE:'push:response',
  MODE:'mode',
  AUTH:'auth',
  ROOM_GRANTS:'room:grants',
  ROOM_PENDING:'room:pending',
};

/* ============================================================
   工具函式
   ============================================================ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const nowTime = () => new Date().toTimeString().slice(0,8);
const esc = s => s == null ? '' : String(s)
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');
const sideLabel = s => SIDE_LABELS[s] || s;
const allianceSideLabel = s => ALLIANCE_SIDE_LABELS[s] || s;
const sideClass = s => (s==='self') ? 'self'
  : (s==='ally') ? 'ally'
  : (s==='enemy'||s==='common_enemy') ? 'enemy'
  : 'npc';
const logSystem = text => console.log('[系統] ' + text);

/* ============================================================
   AI 佈兵助手
   ============================================================ */
const AI = (() => {
  const DEFAULT_PARAMS = {
    r25: 25, r20: 33, r15: 50, r12: 60, r10: 70, r08: 84, r06: 95, r00: 100,
    teamFactor: 0.4, wallFactor1: 1.10, wallFactor2: 1.15,
    defendFactor: 0.70, minPct: 17,
  };
  let params = { ...DEFAULT_PARAMS };
  const OPTIONS = [17, 33, 50, 67, 84, 100];

  function loadParams(){
    try{
      const raw = localStorage.getItem(AI_LS_KEY);
      if (raw) params = { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
    }catch(e){}
  }
  function saveParams(){ try{ localStorage.setItem(AI_LS_KEY, JSON.stringify(params)); }catch(e){} }
  function resetParams(){ params = { ...DEFAULT_PARAMS }; saveParams(); }
  function setParams(p){ params = { ...params, ...p }; }
  function getParams(){ return { ...params }; }

  function calcBaseRatio(myPower, enemyPower){
    const ratio = myPower / Math.max(1, enemyPower);
    if (ratio >= 2.5) return params.r25;
    if (ratio >= 2.0) return params.r20;
    if (ratio >= 1.5) return params.r15;
    if (ratio >= 1.2) return params.r12;
    if (ratio >= 1.0) return params.r10;
    if (ratio >= 0.8) return params.r08;
    if (ratio >= 0.6) return params.r06;
    return params.r00;
  }
  function snapToOption(v){
    let closest = OPTIONS[0], minDiff = Infinity;
    for (const o of OPTIONS){
      const diff = Math.abs(o - v);
      if (diff < minDiff){ minDiff = diff; closest = o; }
    }
    return closest;
  }
  function suggestForTarget(myCity, targetCity, isAttack){
    const myAvg = myCity.avgPower || 1;
    const tgtAvg = targetCity.avgPower || 1;
    let base = calcBaseRatio(myAvg, tgtAvg);
    const myTeams = myCity.totalTeams || 1;
    const tgtTeams = targetCity.totalTeams || 0;
    const teamRatio = tgtTeams / myTeams;
    if (teamRatio > 1) base = base * (1 + (teamRatio - 1) * params.teamFactor);
    const wallMin = targetCity.wallMin || 0;
    if (wallMin > 30) base *= params.wallFactor1;
    if (wallMin > 60) base *= params.wallFactor2;
    if (!isAttack) base *= params.defendFactor;
    return snapToOption(base);
  }
  function suggestForCity(city, allCities){
    const result = { atk: [], def: [] };
    if (!city.totalTeams) return result;
    let totalPre = 0;
    for (const t of (city.attackTargets || [])){
      const tgt = allCities.find(c => c.id === t.cityId);
      if (!tgt) continue;
      const pre = suggestForTarget(city, tgt, true);
      result.atk.push({ cityId: t.cityId, preWarPercent: pre, postRevivePercent: pre, priority: t.priority || 1 });
      totalPre += pre;
    }
    for (const t of (city.defendTargets || [])){
      const tgt = allCities.find(c => c.id === t.cityId);
      if (!tgt) continue;
      const pre = suggestForTarget(city, tgt, false);
      result.def.push({ cityId: t.cityId, preWarPercent: pre, postRevivePercent: pre, priority: t.priority || 1 });
      totalPre += pre;
    }
    if (totalPre > 100){
      const scale = 100 / totalPre;
      const adjust = arr => arr.forEach(s => {
        const raw = Math.max(s.preWarPercent * scale, params.minPct);
        const snapped = snapToOption(raw);
        s.preWarPercent = snapped;
        s.postRevivePercent = snapped;
      });
      adjust(result.atk);
      adjust(result.def);
    }
    return result;
  }

  loadParams();
  return {
    suggestForCity, suggestForTarget,
    loadParams, saveParams, resetParams, setParams, getParams,
    DEFAULT_PARAMS
  };
})();

/* ============================================================
   state
   ============================================================ */
const state = {
  mode: 'local',

  auth: {
    signedIn: false,
    isGuest: false,
    accountUid: '',
    username: '',
    displayName: '',
    role: 'guest',
    status: 'active',
    extraPerms: {
      canEditData: false,
      canImportExcel: false,
      canRunSim: false,
      canKick: false,
      canEditSettings: false,
    },
  },

  commanderName:'', roomCode:'', isHost:false, hostName:'',
  connected:false, connecting:false, myClientId:'',
  members:{}, editLocks:{}, isSimulating:false,
  settings:{
    timeLimitMin:120, consumeMinPerMin:10, consumeMaxPerMin:30,
    siegeEfficiency:1, marchTimeSec:0, maxLossRatio:0.9, minLossRatio:0.1
  },
  alliances:[], zones:[], cities:[],
  lamport:0, settingsRev:0,
  entityRev:{ alliance:{}, zone:{}, city:{} },
  dirty:{
    settings:false,
    alliance:new Set(), zone:new Set(), city:new Set(),
    allianceDeleted:new Set(), zoneDeleted:new Set(), cityDeleted:new Set()
  },
  roomEpoch:'', simBaseMin: 0, dynRows: [], editingAllianceId: null,
  narrativeLines: [],
  chatMessages: [],
  unreadChat: 0,
  pushRequestStatus: 'idle',
  pendingPushRequest: null,
  /* ★ P6：房間編輯權限 */
  roomEditGrants: {},
  pendingEditRequests: {},
  myEditRequestStatus: 'idle',
};

/* ============================================================
   事件匯流排
   ============================================================ */
const bus = new Map();
function on(evt, fn){
  if(!bus.has(evt)) bus.set(evt, new Set());
  bus.get(evt).add(fn);
  return () => bus.get(evt)?.delete(fn);
}
function emit(evt, data){
  const s = bus.get(evt);
  if(!s) return;
  for(const fn of s){
    try{ fn(data); }catch(e){ console.error('[emit]', evt, e); }
  }
}

/* ============================================================
   Lamport 時鐘 / dirty 標記
   ============================================================ */
function tickLamport(r=0){ state.lamport = Math.max(state.lamport, r) + 1; return state.lamport; }
function isNewer(r, l){ return (r||0) > (l||0); }
function markDirty(kind, id){
  if(kind === 'settings'){ state.dirty.settings = true; return; }
  state.dirty[kind]?.add(id);
}
function clearDirty(){
  state.dirty.settings = false;
  for(const k of ['alliance','zone','city','allianceDeleted','zoneDeleted','cityDeleted']){
    state.dirty[k].clear();
  }
}

/* ============================================================
   持久化
   ============================================================ */
function saveState(){
  if(state.auth && state.auth.isGuest) return;
  try{
    localStorage.setItem(LS_PREFIX+'state', JSON.stringify({
      commanderName:state.commanderName, roomCode:state.roomCode,
      settings:state.settings, settingsRev:state.settingsRev, lamport:state.lamport,
      entityRev:state.entityRev,
      roomEpoch:state.roomEpoch,
      alliances:state.alliances, zones:state.zones, cities:state.cities,
      dynRows: state.dynRows.slice(-5000),
      narrativeLines: state.narrativeLines.slice(-1000),
      chatMessages: state.chatMessages.slice(-200),
      pushRequestStatus: state.pushRequestStatus,
    }));
  }catch(e){ console.warn('儲存失敗', e); }
}

function loadState(){
  if(state.auth && state.auth.isGuest) return;
  try{
    const raw = localStorage.getItem(LS_PREFIX+'state');
    if(!raw) return;
    const d = JSON.parse(raw);

    for(const k of ['commanderName','roomCode','settingsRev','lamport','roomEpoch']){
      if(d[k]!==undefined) state[k]=d[k];
    }
    if(d.settings) Object.assign(state.settings, d.settings);
    if(typeof state.settings.consumeMinPerMin !== 'number') state.settings.consumeMinPerMin = 10;
    if(typeof state.settings.consumeMaxPerMin !== 'number') state.settings.consumeMaxPerMin = 30;
    delete state.settings.consumePerMin;
    if(typeof state.settings.maxLossRatio !== 'number') state.settings.maxLossRatio = 0.9;
    if(typeof state.settings.minLossRatio !== 'number') state.settings.minLossRatio = 0.1;
    if(typeof state.settings.marchTimeSec !== 'number') state.settings.marchTimeSec = 0;

    if(d.entityRev) state.entityRev = d.entityRev;

    if(Array.isArray(d.alliances)){
      state.alliances = d.alliances.map(a => {
        if(typeof a.memberCount !== 'number') a.memberCount = 100;
        if(typeof a.totalPower !== 'number'){
          if(typeof a.power === 'number') a.totalPower = a.power;
          else if(typeof a.avgPower === 'number') a.totalPower = a.memberCount * a.avgPower;
          else a.totalPower = 20000;
        }
        a.avgPower = a.memberCount > 0 ? (a.totalPower / a.memberCount) : 0;
        if(!['self','ally','enemy'].includes(a.side)) a.side = 'ally';
        if(typeof a.icon !== 'string') a.icon = '';
        return a;
      });
    }
    if(Array.isArray(d.zones)) state.zones = d.zones;

    if(Array.isArray(d.cities)){
      state.cities = d.cities.map(c => {
        if(!c.defStartTime) c.defStartTime = '19:00';
        const migrate = arr => (arr||[]).map(t => ({
          cityId: t.cityId,
          preWarPercent: t.preWarPercent !== undefined
            ? t.preWarPercent
            : (t.teams ? Math.round(t.teams / (c.totalTeams||100) * 100) : 50),
          postRevivePercent: t.postRevivePercent !== undefined ? t.postRevivePercent : 50,
          priority: t.priority !== undefined ? t.priority : 1,
        }));
        c.attackTargets = migrate(c.attackTargets);
        c.defendTargets = migrate(c.defendTargets);
        return c;
      });
    }

    if(Array.isArray(d.dynRows)) state.dynRows = d.dynRows.slice(-5000);
    if(Array.isArray(d.narrativeLines)) state.narrativeLines = d.narrativeLines.slice(-1000);
    if(Array.isArray(d.chatMessages)) state.chatMessages = d.chatMessages.slice(-200);
    if(d.pushRequestStatus && ['idle','pending','rejected'].includes(d.pushRequestStatus)){
      state.pushRequestStatus = d.pushRequestStatus;
    }
  }catch(e){ console.warn('讀取失敗', e); }
}

/* ============================================================
   同步補丁
   ============================================================ */
function buildSettingsPatch(){
  return {
    kind:'settings', rev:state.settingsRev, lamport:state.lamport,
    op:'upsert', data:{...state.settings}
  };
}
function buildEntityPatch(kind, id){
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones
             : state.cities;
  const entity = coll.find(x => x.id === id);
  if(!entity) return null;
  return {
    kind, id,
    rev: state.entityRev[kind][id] || 0,
    lamport: state.lamport,
    op:'upsert',
    data: JSON.parse(JSON.stringify(entity))
  };
}
function buildDeletePatch(kind, id){
  return {
    kind, id,
    rev: state.entityRev[kind][id] || 0,
    lamport: state.lamport,
    op:'delete'
  };
}
function collectDirtyPatches(){
  const patches = [];
  if(state.dirty.settings) patches.push(buildSettingsPatch());
  for(const kind of ['alliance','zone','city']){
    for(const id of state.dirty[kind]){
      const p = buildEntityPatch(kind, id);
      if(p) patches.push(p);
    }
    for(const id of state.dirty[kind+'Deleted']){
      patches.push(buildDeletePatch(kind, id));
    }
  }
  return patches;
}

function upsertEntity(kind, entity, {silent=false}={}){
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones
             : state.cities;
  const idx = coll.findIndex(x => x.id === entity.id);
  state.entityRev[kind][entity.id] = (state.entityRev[kind][entity.id] || 0) + 1;
  if(idx>=0) coll[idx] = entity;
  else coll.push(entity);
  if(!silent){ markDirty(kind, entity.id); tickLamport(); flushPatches(); }
  return entity;
}
function deleteEntity(kind, id, {silent=false}={}){
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones
             : state.cities;
  const idx = coll.findIndex(x => x.id === id);
  if(idx<0) return;
  coll.splice(idx,1);
  state.entityRev[kind][id] = (state.entityRev[kind][id] || 0) + 1;
  if(!silent){ markDirty(kind+'Deleted', id); tickLamport(); flushPatches(); }
}
function updateSettings(patch, {silent=false}={}){
  Object.assign(state.settings, patch);
  state.settingsRev++;
  if(!silent){ markDirty('settings'); tickLamport(); flushPatches(); }
}
function applyPatch(patch){
  if(!patch || !patch.kind) return false;
  tickLamport(patch.lamport || 0);
  const { kind, id, rev, op, data } = patch;

  if(kind === 'settings'){
    if(!isNewer(rev, state.settingsRev)) return false;
    Object.assign(state.settings, data);
    state.settingsRev = rev;
    return true;
  }

  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones
             : kind==='city'     ? state.cities
             : null;
  if(!coll) return false;

  const localRev = state.entityRev[kind][id] || 0;
  if(!isNewer(rev, localRev)) return false;
  const idx = coll.findIndex(x => x.id === id);

  if(op==='delete'){ if(idx>=0) coll.splice(idx,1); state.entityRev[kind][id] = rev; return true; }
  if(op==='upsert'){
    if(idx>=0) coll[idx] = {...coll[idx], ...data};
    else coll.push(data);
    state.entityRev[kind][id] = rev;
    return true;
  }
  return false;
}

let sender = null;
function registerSender(fn){ sender = fn; }

let flushTimer = null;
function flushPatches(){
  if(!sender) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const patches = collectDirtyPatches();
    if(patches.length === 0) return;
    sender(patches);
    clearDirty();
  }, 60);
}

/* ============================================================
   快照
   ============================================================ */
function buildFullSnapshot(){
  return {
    type:'sync_snapshot',
    epoch: state.roomEpoch,
    lamport: state.lamport,
    settingsRev: state.settingsRev,
    settings: {...state.settings},
    entityRev: JSON.parse(JSON.stringify(state.entityRev)),
    alliances: JSON.parse(JSON.stringify(state.alliances)),
    zones: JSON.parse(JSON.stringify(state.zones)),
    cities: JSON.parse(JSON.stringify(state.cities)),
    clientId: state.myClientId,
    name: state.commanderName
  };
}
function applyFullSnapshot(snap){
  if(!snap) return false;
  if(snap.epoch) state.roomEpoch = snap.epoch;
  if(snap.settings){
    Object.assign(state.settings, snap.settings);
    state.settingsRev = snap.settingsRev || 0;
  }
  state.alliances = JSON.parse(JSON.stringify(snap.alliances || []));
  state.zones     = JSON.parse(JSON.stringify(snap.zones     || []));
  state.cities    = JSON.parse(JSON.stringify(snap.cities    || []));
  state.entityRev = { alliance:{}, zone:{}, city:{} };
  for(const [kind, arr] of [
    ['alliance', state.alliances],
    ['zone',     state.zones],
    ['city',     state.cities]
  ]){
    for(const ent of arr){
      state.entityRev[kind][ent.id] = snap.entityRev?.[kind]?.[ent.id] || 0;
    }
  }
  tickLamport(snap.lamport || 0);
  return true;
}

/* ============================================================
   模式管理
   ============================================================ */
function enterRoomMode(){
  if(state.mode === 'room') return;
  state.mode = 'room';
  emit(EVT.MODE, state.mode);
  updateModeBar();
  logSystem('📡 已切換為房間模式');
}
function exitRoomMode(){
  if(state.mode === 'local') return;
  state.mode = 'local';
  emit(EVT.MODE, state.mode);
  updateModeBar();
  logSystem('🖥️ 已切換為本機模式');
}
function updateModeBar(){
  const bar = document.getElementById('modeBar');
  const indicator = document.getElementById('modeIndicator');
  const detail = document.getElementById('modeDetail');
  const btn = document.getElementById('btnSwitchMode');
  if(!bar || !indicator || !detail || !btn) return;

  const a = state.auth;
  let userLabel = '';
  if(a.isGuest){
    userLabel = '👻 訪客';
  } else if(a.signedIn){
    const roleIcon = (ROLE_LABELS[a.role] || '').split(' ')[0] || '';
    userLabel = `${a.displayName || a.username}${roleIcon ? ' ' + roleIcon : ''}`;
  }

  if(state.mode === 'room' && state.connected){
    bar.className = 'mode-bar room';
    indicator.textContent = '📡 房間模式';
    const host = state.hostName ? ` · 房主：${state.hostName}` : '';
    const user = userLabel ? ` · ${userLabel}` : '';
    detail.textContent = `房間 ${state.roomCode || ''}${host}${user}`;
    btn.textContent = '離開房間';
  } else if(state.mode === 'room' && state.connecting){
    bar.className = 'mode-bar room';
    indicator.textContent = '📡 連線中...';
    const user = userLabel ? ` · ${userLabel}` : '';
    detail.textContent = `正在連線至房間 ${state.roomCode || ''}${user}`;
    btn.textContent = '取消連線';
  } else {
    bar.className = 'mode-bar local';
    indicator.textContent = '🖥️ 本機模式';
    detail.textContent = userLabel ? `${userLabel} · 尚未進入房間` : '尚未進入房間';
    btn.textContent = '進入房間';
  }
}
function requestSwitchMode(){
  if(state.mode === 'room'){
    if(typeof window.SLG.requestDisconnect === 'function'){
      window.SLG.requestDisconnect();
    }
  } else {
    document.querySelectorAll('.top-nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    const tabBtn = document.querySelector('.top-nav button[data-tab="tab-room"]');
    const tabEl = document.getElementById('tab-room');
    if(tabBtn) tabBtn.classList.add('active');
    if(tabEl) tabEl.classList.add('active');
    const firebaseCard = document.getElementById('btnCreateRoom')?.closest('.card');
    if(firebaseCard){
      setTimeout(() => {
        firebaseCard.scrollIntoView({behavior:'smooth', block:'center'});
        firebaseCard.style.transition = 'box-shadow .5s';
        firebaseCard.style.boxShadow = '0 0 24px rgba(68,170,255,.5)';
        setTimeout(() => { firebaseCard.style.boxShadow = ''; }, 1500);
      }, 100);
    }
    logSystem('💡 請點「🏠 創建房間」或「🔗 加入盟友房間」');
  }
}

/* ============================================================
   ★ P6：房間編輯權限判斷
   ============================================================ */
function isInRoom(){
  return state.mode === 'room' && state.connected;
}
function canEditRoomData(){
  if(!state.auth.signedIn) return false;
  if(state.auth.isGuest) return false;
  if(window.SLG.Auth && window.SLG.Auth.isAdmin()) return true;
  if(state.isHost) return true;
  if(state.roomEditGrants[state.auth.accountUid]) return true;
  return false;
}
function getEffectiveEditPermission(){
  if(isInRoom()) return canEditRoomData();
  return window.SLG.Auth && window.SLG.Auth.canEditData();
}
function getEffectiveImportExcelPermission(){
  if(isInRoom()){
    return canEditRoomData() && window.SLG.Auth && window.SLG.Auth.canImportExcel();
  }
  return window.SLG.Auth && window.SLG.Auth.canImportExcel();
}
function resetRoomEditState(){
  state.roomEditGrants = {};
  state.pendingEditRequests = {};
  state.myEditRequestStatus = 'idle';
}

/* ============================================================
   AI 參數 UI
   ============================================================ */
function syncAIParamsToUI(){
  const p = AI.getParams();
  document.getElementById('aiR25').value = p.r25;
  document.getElementById('aiR20').value = p.r20;
  document.getElementById('aiR15').value = p.r15;
  document.getElementById('aiR12').value = p.r12;
  document.getElementById('aiR10').value = p.r10;
  document.getElementById('aiR08').value = p.r08;
  document.getElementById('aiR06').value = p.r06;
  document.getElementById('aiR00').value = p.r00;
  document.getElementById('aiTeamFactor').value = p.teamFactor;
  document.getElementById('aiWallFactor1').value = p.wallFactor1;
  document.getElementById('aiWallFactor2').value = p.wallFactor2;
  document.getElementById('aiDefendFactor').value = p.defendFactor;
  document.getElementById('aiMinPct').value = p.minPct;
}
function readAIParamsFromUI(){
  return {
    r25: parseFloat(document.getElementById('aiR25').value) || 25,
    r20: parseFloat(document.getElementById('aiR20').value) || 33,
    r15: parseFloat(document.getElementById('aiR15').value) || 50,
    r12: parseFloat(document.getElementById('aiR12').value) || 60,
    r10: parseFloat(document.getElementById('aiR10').value) || 70,
    r08: parseFloat(document.getElementById('aiR08').value) || 84,
    r06: parseFloat(document.getElementById('aiR06').value) || 95,
    r00: parseFloat(document.getElementById('aiR00').value) || 100,
    teamFactor: parseFloat(document.getElementById('aiTeamFactor').value) || 0.4,
    wallFactor1: parseFloat(document.getElementById('aiWallFactor1').value) || 1.10,
    wallFactor2: parseFloat(document.getElementById('aiWallFactor2').value) || 1.15,
    defendFactor: parseFloat(document.getElementById('aiDefendFactor').value) || 0.70,
    minPct: parseFloat(document.getElementById('aiMinPct').value) || 17,
  };
}

/* ============================================================
   暴露到全域
   ============================================================ */
Object.assign(window.SLG, {
  /* 常量 */
  LS_PREFIX, AI_LS_KEY, ACCOUNT_UID_KEY, HOST_TIMEOUT, EDIT_LOCK_TTL,
  PERCENT_OPTIONS,
  ATTACK_RULES, DEFEND_RULES, SIDE_LABELS, ALLIANCE_SIDE_LABELS,
  ROLE, ROLE_LABELS, ROLE_CLASS, EVT,

  /* 工具 */
  uid, nowTime, esc, sideLabel, allianceSideLabel, sideClass, logSystem,

  /* AI */
  AI,

  /* state / bus */
  state, on, emit,

  /* Lamport / dirty */
  tickLamport, isNewer, markDirty, clearDirty,

  /* 持久化 */
  saveState, loadState,

  /* 補丁 / 快照 */
  buildSettingsPatch, buildEntityPatch, buildDeletePatch, collectDirtyPatches,
  upsertEntity, deleteEntity, updateSettings, applyPatch,
  registerSender, flushPatches,
  buildFullSnapshot, applyFullSnapshot,

  /* 模式管理 */
  enterRoomMode, exitRoomMode, updateModeBar, requestSwitchMode,

  /* P6：房間編輯權限 */
  isInRoom,
  canEditRoomData,
  getEffectiveEditPermission,
  getEffectiveImportExcelPermission,
  resetRoomEditState,

  /* AI 參數 UI */
  syncAIParamsToUI, readAIParamsFromUI,
});

})();