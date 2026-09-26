/* ============================================================================
 * core.js — 全域狀態、事件匯流排、工具、持久化、模式管理、AI
 * v8.5
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
const LS_PREFIX = 'slg_sandtable_v82_';
const LS_LEGACY_PREFIX = 'slg_sandtable_v75_';
const AI_LS_KEY = 'slg_ai_params';
const ACCOUNT_UID_KEY = 'slg_sandtable_v82_accountUid';
const HOST_TIMEOUT = 15000;
const EDIT_LOCK_TTL = 30000;

/* v8.2 雲端同步 debounce */
const SANDBOX_SYNC_DEBOUNCE = 1500;
const ROOM_SNAPSHOT_DEBOUNCE = 2000;

/* v8.5：NPC 預設盟名稱 */
const NPC_ALLIANCE_NAME = 'NPC';
const NPC_ALLIANCE_ICON = '🏰';

const PERCENT_OPTIONS = [0, 17, 33, 50, 67, 84, 100];

const ATTACK_RULES = {
  self:['enemy','common_enemy','npc'],
  ally:['enemy','common_enemy','npc'],
  enemy:['self','ally','npc','common_enemy'],
  common_enemy:['self','ally','npc','enemy'],
  npc:['self','ally','enemy','common_enemy'],
};
const DEFEND_RULES = {
  self:['self','ally'],
  ally:['self','ally'],
  enemy:[],
  common_enemy:[],
  npc:[],
};
const SIDE_LABELS = {
  self:'本方',
  ally:'同盟',
  enemy:'敵方',
  common_enemy:'共同敵方',
  npc:'NPC',
};
const ALLIANCE_SIDE_LABELS = {
  self:'本方',
  ally:'同盟',
  enemy:'敵方',
};

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
const ROLE_ORDER = { superadmin:0, admin:1, officer:2, member:3, guest:4 };

const EVT = {
  MEMBERS:'members',
  LOCKS:'locks',
  DATA:'data',
  CONN:'conn',
  HOST:'host',
  CHAT_NEW:'chat:new',
  SIM_TRIGGER:'sim:trigger',
  DEBUG:'debug',
  VIZ_SNAPSHOTS:'viz:snapshots',
  VIZ_RESET:'viz:reset',
  DYN_RESULT:'dyn:result',
  MODE:'mode',
  AUTH:'auth',
  ROOM_GRANTS:'room:grants',
  ROOM_PENDING:'room:pending',
  MY_SANDBOX_UPDATED:'sandbox:mine',
  SANDBOXES_LIST_UPDATED:'sandbox:list',
  ROOM_SNAPSHOT_UPDATED:'room:snapshot',
  /* v8.5：路線事件 */
  ROUTES_UPDATED:'routes:updated',
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

function formatDateCompact(ts){
  const d = ts ? new Date(ts) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}

function timeAgo(ts){
  if(!ts) return '—';
  const diff = Date.now() - ts;
  if(diff < 60000) return '剛剛';
  if(diff < 3600000) return Math.floor(diff/60000) + ' 分前';
  if(diff < 86400000) return Math.floor(diff/3600000) + ' 小時前';
  if(diff < 604800000) return Math.floor(diff/86400000) + ' 天前';
  const d = new Date(ts);
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function buildSandboxFileName(displayName, updatedAt){
  const safe = (displayName || '匿名').replace(/[\\/:*?"<>|]/g, '_');
  return `${safe}_${formatDateCompact(updatedAt)}`;
}

/* ============================================================
   AI 佈兵助手
   ============================================================ */
const AI = (() => {
  const DEFAULT_PARAMS = {
    r25: 25, r20: 33, r15: 50, r12: 60, r10: 70, r08: 84, r06: 95, r00: 100,
    teamFactor: 0.4, wallFactor1: 1.10, wallFactor2: 1.15,
    defendFactor: 0.70, minPct: 17,
  };
  let params = Object.assign({}, DEFAULT_PARAMS);
  const OPTIONS = [17, 33, 50, 67, 84, 100];

  function loadParams(){
    try{
      const raw = localStorage.getItem(AI_LS_KEY);
      if (raw) params = Object.assign({}, DEFAULT_PARAMS, JSON.parse(raw));
    }catch(e){}
  }
  function saveParams(){ try{ localStorage.setItem(AI_LS_KEY, JSON.stringify(params)); }catch(e){} }
  function resetParams(){ params = Object.assign({}, DEFAULT_PARAMS); saveParams(); }
  function setParams(p){ params = Object.assign({}, params, p); }
  function getParams(){ return Object.assign({}, params); }

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
  /* v8.5：地圖路線（無向圖） */
  routes: [],
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
  roomEditGrants: {},
  pendingEditRequests: {},
  myEditRequestStatus: 'idle',
  mySandbox: {
    loading: false,
    loaded: false,
    updatedAt: 0,
    saving: false,
  },
  sandboxesList: {},
  roomSnapshot: null,
  roomHasSnapshot: false,
  pendingUploadSandbox: null,
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
let cloudSyncTimer = null;
let cloudSyncFn = null;

function registerCloudSync(fn){ cloudSyncFn = fn; }

function triggerCloudSync(delay){
  if(!cloudSyncFn) return;
  if(!state.auth.signedIn) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    try{ cloudSyncFn(); }catch(e){ console.warn('雲端同步失敗', e); }
  }, delay || SANDBOX_SYNC_DEBOUNCE);
}

function saveState(){
  try{
    localStorage.setItem(LS_PREFIX+'state', JSON.stringify({
      commanderName: state.commanderName,
      roomCode: state.roomCode,
      settings: state.settings,
      settingsRev: state.settingsRev,
      lamport: state.lamport,
      entityRev: state.entityRev,
      roomEpoch: state.roomEpoch,
      alliances: state.alliances,
      zones: state.zones,
      cities: state.cities,
      routes: state.routes,
      dynRows: state.dynRows.slice(-5000),
      narrativeLines: state.narrativeLines.slice(-1000),
      chatMessages: state.chatMessages.slice(-200),
    }));
  }catch(e){ console.warn('儲存失敗', e); }
  if(state.mode === 'local'){
    triggerCloudSync();
  }
  if(state.mode === 'room' && state.isHost){
    triggerRoomSnapshotSync();
  }
}

function loadState(){
  try{
    migrateLegacyState();
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
        /* v8.5：舊沙盤相容：level 預設 1 */
        if(typeof c.level !== 'number') c.level = 1;
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

    /* v8.5：舊沙盤相容：routes 預設空 */
    if(Array.isArray(d.routes)){
      state.routes = d.routes.map(r => ({
        id: r.id || uid(),
        cityAId: r.cityAId || '',
        cityBId: r.cityBId || '',
      })).filter(r => r.cityAId && r.cityBId);
    }

    if(Array.isArray(d.dynRows)) state.dynRows = d.dynRows.slice(-5000);
    if(Array.isArray(d.narrativeLines)) state.narrativeLines = d.narrativeLines.slice(-1000);
    if(Array.isArray(d.chatMessages)) state.chatMessages = d.chatMessages.slice(-200);
  }catch(e){ console.warn('讀取失敗', e); }
}

function migrateLegacyState(){
  try{
    const newKey = LS_PREFIX + 'state';
    if(localStorage.getItem(newKey)) return;
    const oldKey = LS_LEGACY_PREFIX + 'state';
    const oldRaw = localStorage.getItem(oldKey);
    if(!oldRaw) return;
    localStorage.setItem(newKey, oldRaw);
    console.log('[遷移] 已將舊 key 資料遷移到新 key');
  }catch(e){ console.warn('遷移失敗', e); }
}

/* ============================================================
   同步補丁
   ============================================================ */
function buildSettingsPatch(){
  return {
    kind:'settings', rev:state.settingsRev, lamport:state.lamport,
    op:'upsert', data:Object.assign({}, state.settings)
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

function upsertEntity(kind, entity, opts){
  opts = opts || {};
  const silent = !!opts.silent;
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
function deleteEntity(kind, id, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones
             : state.cities;
  const idx = coll.findIndex(x => x.id === id);
  if(idx<0) return;
  coll.splice(idx,1);
  state.entityRev[kind][id] = (state.entityRev[kind][id] || 0) + 1;
  if(!silent){ markDirty(kind+'Deleted', id); tickLamport(); flushPatches(); }
}
function updateSettings(patch, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  Object.assign(state.settings, patch);
  state.settingsRev++;
  if(!silent){ markDirty('settings'); tickLamport(); flushPatches(); }
}
function applyPatch(patch){
  if(!patch || !patch.kind) return false;
  tickLamport(patch.lamport || 0);
  const kind = patch.kind, id = patch.id, rev = patch.rev, op = patch.op, data = patch.data;

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
    if(idx>=0) coll[idx] = Object.assign({}, coll[idx], data);
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
    triggerRoomSnapshotSync();
  }, 60);
}

let roomSnapshotTimer = null;
let roomSnapshotFn = null;
function registerRoomSnapshotSync(fn){ roomSnapshotFn = fn; }
function triggerRoomSnapshotSync(){
  if(!roomSnapshotFn) return;
  if(state.mode !== 'room') return;
  if(!window.SLG.canEditRoomData || !window.SLG.canEditRoomData()) return;
  clearTimeout(roomSnapshotTimer);
  roomSnapshotTimer = setTimeout(() => {
    try{ roomSnapshotFn(); }catch(e){ console.warn('房間快照同步失敗', e); }
  }, ROOM_SNAPSHOT_DEBOUNCE);
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
    settings: Object.assign({}, state.settings),
    entityRev: JSON.parse(JSON.stringify(state.entityRev)),
    alliances: JSON.parse(JSON.stringify(state.alliances)),
    zones: JSON.parse(JSON.stringify(state.zones)),
    cities: JSON.parse(JSON.stringify(state.cities)),
    routes: JSON.parse(JSON.stringify(state.routes)),
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
  state.routes    = JSON.parse(JSON.stringify(snap.routes    || []));
  state.entityRev = { alliance:{}, zone:{}, city:{} };
  for(const item of [
    ['alliance', state.alliances],
    ['zone',     state.zones],
    ['city',     state.cities]
  ]){
    const kind = item[0], arr = item[1];
    for(const ent of arr){
      state.entityRev[kind][ent.id] = (snap.entityRev && snap.entityRev[kind] && snap.entityRev[kind][ent.id]) || 0;
    }
  }
  tickLamport(snap.lamport || 0);
  return true;
}

function buildSandboxData(){
  return {
    settings: JSON.parse(JSON.stringify(state.settings)),
    alliances: JSON.parse(JSON.stringify(state.alliances)),
    zones: JSON.parse(JSON.stringify(state.zones)),
    cities: JSON.parse(JSON.stringify(state.cities)),
    routes: JSON.parse(JSON.stringify(state.routes)),
  };
}

function applySandboxData(data){
  if(!data) return false;
  if(data.settings) Object.assign(state.settings, data.settings);
  state.alliances = JSON.parse(JSON.stringify(data.alliances || []));
  state.zones     = JSON.parse(JSON.stringify(data.zones     || []));
  state.cities    = JSON.parse(JSON.stringify(data.cities    || []));
  state.routes    = JSON.parse(JSON.stringify(data.routes    || []));
  state.entityRev = { alliance:{}, zone:{}, city:{} };
  for(const item of [
    ['alliance', state.alliances],
    ['zone',     state.zones],
    ['city',     state.cities]
  ]){
    const kind = item[0], arr = item[1];
    for(const ent of arr){
      state.entityRev[kind][ent.id] = 1;
    }
  }
  return true;
}

function getAllianceDist(allianceId){
  const allocatedPower = state.cities
    .filter(c => c.allianceId === allianceId)
    .reduce((s, c) => s + (Number(c.totalPower) || 0), 0);
  const allocatedTeams = state.cities
    .filter(c => c.allianceId === allianceId)
    .reduce((s, c) => s + (Number(c.totalTeams) || 0), 0);
  return { allocatedPower, allocatedTeams };
}

/* ============================================================
   v8.5：盟查找 / NPC 預設
   ============================================================ */
function getAllianceByName(name){
  if(!name) return null;
  return state.alliances.find(a => a.name === name) || null;
}

/**
 * 確保有 NPC 盟存在，若無則建立
 * @returns {Object} NPC 盟物件
 */
function ensureNpcAlliance(){
  let npc = getAllianceByName(NPC_ALLIANCE_NAME);
  if(npc) return npc;
  npc = {
    id: uid(),
    name: NPC_ALLIANCE_NAME,
    icon: NPC_ALLIANCE_ICON,
    side: 'enemy',
    memberCount: 0,
    totalPower: 0,
    avgPower: 0,
    power: 0,
  };
  state.alliances.push(npc);
  logSystem('已建立預設 NPC 盟');
  return npc;
}

/* ============================================================
   v8.5：路線 CRUD
   ============================================================ */
function findRoute(cityAId, cityBId){
  return state.routes.find(r =>
    (r.cityAId === cityAId && r.cityBId === cityBId) ||
    (r.cityAId === cityBId && r.cityBId === cityAId)
  ) || null;
}

function addRoute(cityAId, cityBId){
  if(!cityAId || !cityBId || cityAId === cityBId) return null;
  if(findRoute(cityAId, cityBId)) return null;
  const route = { id: uid(), cityAId, cityBId };
  state.routes.push(route);
  emit(EVT.ROUTES_UPDATED);
  return route;
}

function removeRoute(routeId){
  const idx = state.routes.findIndex(r => r.id === routeId);
  if(idx < 0) return false;
  state.routes.splice(idx, 1);
  emit(EVT.ROUTES_UPDATED);
  return true;
}

function getReachableCityIds(cityId){
  const ids = [];
  for(const r of state.routes){
    if(r.cityAId === cityId) ids.push(r.cityBId);
    else if(r.cityBId === cityId) ids.push(r.cityAId);
  }
  return ids;
}

/* ============================================================
   模式管理
   ============================================================ */
function enterRoomMode(){
  if(state.mode === 'room') return;
  state.mode = 'room';
  emit(EVT.MODE, state.mode);
  updateModeBar();
  logSystem('已切換為房間模式');
}
function exitRoomMode(){
  if(state.mode === 'local') return;
  state.mode = 'local';
  emit(EVT.MODE, state.mode);
  updateModeBar();
  logSystem('已切換為本機模式');
}
function updateModeBar(){
  const bar = document.getElementById('modeBar');
  const indicator = document.getElementById('modeIndicator');
  const detail = document.getElementById('modeDetail');
  const btn = document.getElementById('btnSwitchMode');
  if(!bar || !indicator || !detail || !btn) return;

  const a = state.auth;
  let userLabel = '';
  if(a.signedIn){
    const roleIcon = (ROLE_LABELS[a.role] || '').split(' ')[0] || '';
    userLabel = (a.displayName || a.username) + (roleIcon ? ' ' + roleIcon : '');
  }

  if(state.mode === 'room' && state.connected){
    bar.className = 'mode-bar room';
    indicator.textContent = '房間模式';
    const host = state.hostName ? ' / 房主：' + state.hostName : '';
    const user = userLabel ? ' / ' + userLabel : '';
    detail.textContent = '房間 ' + (state.roomCode || '') + host + user;
    btn.textContent = '離開房間';
  } else if(state.mode === 'room' && state.connecting){
    bar.className = 'mode-bar room';
    indicator.textContent = '連線中...';
    const user = userLabel ? ' / ' + userLabel : '';
    detail.textContent = '正在連線至房間 ' + (state.roomCode || '') + user;
    btn.textContent = '取消連線';
  } else {
    bar.className = 'mode-bar local';
    indicator.textContent = '本機模式';
    detail.textContent = userLabel ? userLabel + ' / 尚未進入房間' : '尚未進入房間';
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
    const createBtn = document.getElementById('btnCreateRoom');
    const firebaseCard = createBtn ? createBtn.closest('.card') : null;
    if(firebaseCard){
      setTimeout(() => {
        firebaseCard.scrollIntoView({behavior:'smooth', block:'center'});
        firebaseCard.style.transition = 'box-shadow .5s';
        firebaseCard.style.boxShadow = '0 0 24px rgba(68,170,255,.5)';
        setTimeout(() => { firebaseCard.style.boxShadow = ''; }, 1500);
      }, 100);
    }
    logSystem('請點「創建房間」或「加入盟友房間」');
  }
}

/* ============================================================
   房間編輯權限判斷
   ============================================================ */
function isInRoom(){
  return state.mode === 'room' && state.connected;
}
function canEditRoomData(){
  if(!state.auth.signedIn) return false;
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
   沙盤權限判斷
   ============================================================ */
function canViewSandboxes(){
  if(!state.auth.signedIn) return false;
  return true;
}

function canViewSandboxOf(targetUid, targetRole){
  if(!state.auth.signedIn) return false;
  if(targetUid === state.auth.accountUid) return true;
  if(window.SLG.Auth && (window.SLG.Auth.isAdmin() || state.auth.role === ROLE.OFFICER)){
    return true;
  }
  if(state.auth.role === ROLE.MEMBER && targetRole === ROLE.MEMBER) return true;
  return false;
}

function canViewRoomSandboxes(){
  if(!state.auth.signedIn) return false;
  return window.SLG.Auth && (window.SLG.Auth.isAdmin() || state.auth.role === ROLE.OFFICER);
}

function canUploadSandboxToRoom(){
  if(!isInRoom()) return false;
  if(!state.auth.signedIn) return false;
  return window.SLG.Auth && (window.SLG.Auth.isAdmin() || window.SLG.Auth.isOfficer());
}

function canUseRescueTool(){
  if(!state.auth.signedIn) return false;
  return window.SLG.Auth && window.SLG.Auth.isAdmin();
}

/* ============================================================
   AI 參數 UI
   ============================================================ */
function syncAIParamsToUI(){
  const p = AI.getParams();
  const ids = ['aiR25','aiR20','aiR15','aiR12','aiR10','aiR08','aiR06','aiR00',
    'aiTeamFactor','aiWallFactor1','aiWallFactor2','aiDefendFactor','aiMinPct'];
  const keys = ['r25','r20','r15','r12','r10','r08','r06','r00',
    'teamFactor','wallFactor1','wallFactor2','defendFactor','minPct'];
  for(let i = 0; i < ids.length; i++){
    const el = document.getElementById(ids[i]);
    if(el) el.value = p[keys[i]];
  }
}
function readAIParamsFromUI(){
  const ids = ['aiR25','aiR20','aiR15','aiR12','aiR10','aiR08','aiR06','aiR00',
    'aiTeamFactor','aiWallFactor1','aiWallFactor2','aiDefendFactor','aiMinPct'];
  const keys = ['r25','r20','r15','r12','r10','r08','r06','r00',
    'teamFactor','wallFactor1','wallFactor2','defendFactor','minPct'];
  const defaults = [25, 33, 50, 60, 70, 84, 95, 100, 0.4, 1.10, 1.15, 0.70, 17];
  const result = {};
  for(let i = 0; i < ids.length; i++){
    const el = document.getElementById(ids[i]);
    const val = el ? parseFloat(el.value) : NaN;
    result[keys[i]] = isNaN(val) ? defaults[i] : val;
  }
  return result;
}

/* ============================================================
   暴露到全域
   ============================================================ */
Object.assign(window.SLG, {
  LS_PREFIX, LS_LEGACY_PREFIX, AI_LS_KEY, ACCOUNT_UID_KEY,
  HOST_TIMEOUT, EDIT_LOCK_TTL,
  SANDBOX_SYNC_DEBOUNCE, ROOM_SNAPSHOT_DEBOUNCE,
  PERCENT_OPTIONS,
  NPC_ALLIANCE_NAME, NPC_ALLIANCE_ICON,
  ATTACK_RULES, DEFEND_RULES, SIDE_LABELS, ALLIANCE_SIDE_LABELS,
  ROLE, ROLE_LABELS, ROLE_CLASS, ROLE_ORDER, EVT,

  uid, nowTime, esc, sideLabel, allianceSideLabel, sideClass, logSystem,
  formatDateCompact, timeAgo, buildSandboxFileName,

  AI,

  state, on, emit,

  tickLamport, isNewer, markDirty, clearDirty,

  saveState, loadState, migrateLegacyState,
  registerCloudSync, triggerCloudSync,
  registerRoomSnapshotSync, triggerRoomSnapshotSync,

  buildSettingsPatch, buildEntityPatch, buildDeletePatch, collectDirtyPatches,
  upsertEntity, deleteEntity, updateSettings, applyPatch,
  registerSender, flushPatches,
  buildFullSnapshot, applyFullSnapshot,
  buildSandboxData, applySandboxData,

  enterRoomMode, exitRoomMode, updateModeBar, requestSwitchMode,

  isInRoom,
  canEditRoomData,
  getEffectiveEditPermission,
  getEffectiveImportExcelPermission,
  resetRoomEditState,

  canViewSandboxes,
  canViewSandboxOf,
  canViewRoomSandboxes,
  canUploadSandboxToRoom,
  canUseRescueTool,

  syncAIParamsToUI, readAIParamsFromUI,

  getAllianceDist,
  getAllianceByName,
  ensureNpcAlliance,

  /* v8.5：路線 API */
  findRoute,
  addRoute,
  removeRoute,
  getReachableCityIds,
});

})();