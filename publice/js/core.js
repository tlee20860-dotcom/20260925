/* ============================================================================
 * core.js — 全域狀態、事件匯流排、工具、持久化、模式管理、AI
 * v8.6.0：盟徽擴充 + 拖曳排序 + 距離計算（BFS）
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

const SANDBOX_SYNC_DEBOUNCE = 1500;
const ROOM_SNAPSHOT_DEBOUNCE = 2000;

const NPC_ALLIANCE_NAME = 'NPC';
const NPC_ALLIANCE_ICON = '🏰';

/* v8.5.6：戰力單位換算 */
const POWER_YI = 1e8;
const POWER_WAN = 1e4;
const POWER_MIGRATE_THRESHOLD = 1e6;

/* v8.6.0：盟徽清單（取消文字圖案，擴充兵種 emoji） */
const DEFAULT_ALLIANCE_ICONS = [
  /* ── 古代兵種 ── */
  '⚔️','🗡️','🏹','🔱','🪓','🛡️','⚒️','🔨','🪃','⚜️','🏰','🚩',
  /* ── 現代兵種 ── */
  '🎯','🔫','🚁','✈️','🚢','🛩️','🚀','💣','🧨','🛰️','🪖','🎖️',
  /* ── 動物 ── */
  '🐉','🦅','🐺','🦁','💀','🦂','🐍','🦈','🐻',
  /* ── 神話 / 旗幟 ── */
  '👑','🌟','💎','✨','☀️','🌙','⭐','💫','🏴','🏳️','🎌',
  /* ── 自然 ── */
  '⚡','🔥','❄️','🌊','🌪️','🌋','🏔️','🌲','🍀',
  /* ── 特殊 ── */
  '🎪','🎭','🎨','🎵','☯️'
];

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
  ROUTES_UPDATED:'routes:updated',
  /* v8.6.0：距離計算高亮 */
  DISTANCE_HIGHLIGHT:'distance:highlight',
  DISTANCE_CLEAR:'distance:clear',
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
   v8.5.6：戰力單位換算工具
   ============================================================ */
function formatPower(num){
  const n = Number(num) || 0;
  if(n === 0) return '0.00 億';
  const yi = n / POWER_YI;
  return yi.toFixed(2) + ' 億';
}

function formatAvgPower(num){
  const n = Number(num) || 0;
  if(n === 0) return '0 萬';
  const wan = Math.round(n / POWER_WAN);
  return wan.toLocaleString() + ' 萬';
}

function parsePowerInput(input){
  const n = parseFloat(input);
  if(isNaN(n) || n < 0) return 0;
  return Math.round(n * POWER_YI);
}

function migratePower(num){
  const n = Number(num) || 0;
  if(n === 0) return 0;
  if(n < POWER_MIGRATE_THRESHOLD) return Math.round(n * POWER_YI);
  return n;
}

function powerToYiInput(num){
  const n = Number(num) || 0;
  if(n === 0) return '0.00';
  return (n / POWER_YI).toFixed(2);
}

/* ============================================================
   v8.6.0：盟徽工具
   ============================================================ */
function getAllianceIcons(){
  return DEFAULT_ALLIANCE_ICONS.slice();
}

/**
 * 檢查盟徽是否已被使用
 * @param {string} icon
 * @param {string} excludeAllianceId - 排除此盟（編輯時用）
 * @returns {boolean}
 */
function isAllianceIconUsed(icon, excludeAllianceId){
  if(!icon) return false;
  return state.alliances.some(a =>
    a.icon === icon && a.id !== excludeAllianceId
  );
}

/**
 * 取得未被使用的盟徽清單
 */
function getAvailableAllianceIcons(excludeAllianceId){
  return DEFAULT_ALLIANCE_ICONS.filter(icon =>
    !isAllianceIconUsed(icon, excludeAllianceId)
  );
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
    siegeEfficiency:1, marchTimeSec:0, maxLossRatio:0.9, minLossRatio:0.1,
    attackRequireRoute: false,
  },
  alliances:[], zones:[], cities:[],
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
  listPrefs: {
    warSort: 'time',
    warGroup: 'none',
    deploySort: 'alliance',
    deployGroup: 'none',
  },
  /* v8.6.0：距離計算狀態 */
  distanceResult: null,
  distanceView: 'number',  /* number | path | map */
  distanceHighlight: null, /* 要高亮的 { cityIds:[], routeKeys:[] } */
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
      listPrefs: state.listPrefs,
    }));
  }catch(e){ console.warn('儲存失敗', e); }
  if(state.mode === 'local'){
    triggerCloudSync();
  }
  if(state.mode === 'room' && state.isHost){
    triggerRoomSnapshotSync();
  }
}

/* v8.5.6：遷移盟 / 城戰力單位 */
function migratePowerInState(){
  if(Array.isArray(state.alliances)){
    for(const a of state.alliances){
      const oldTotal = Number(a.totalPower) || 0;
      a.totalPower = migratePower(oldTotal);
      const mc = Number(a.memberCount) || 0;
      a.avgPower = mc > 0 ? (a.totalPower / mc) : 0;
      if(typeof a.power === 'number') a.power = a.totalPower;
    }
  }
  if(Array.isArray(state.cities)){
    for(const c of state.cities){
      const oldTotal = Number(c.totalPower) || 0;
      c.totalPower = migratePower(oldTotal);
      const tt = Number(c.totalTeams) || 0;
      c.avgPower = tt > 0 ? Math.floor(c.totalPower / tt) : 0;
    }
  }
}

/* v8.6.0：遷移盟排序（舊盟無 order 時，依陣營 + createdAt 給值） */
function migrateAllianceOrder(){
  if(!Array.isArray(state.alliances)) return;
  let hasAnyOrder = state.alliances.some(a => typeof a.order === 'number');
  if(hasAnyOrder) return;  /* 已遷移 */
  const sorted = [...state.alliances].sort((a, b) => {
    const sideOrder = { self: 0, ally: 1, enemy: 2, common_enemy: 3, npc: 4 };
    const oa = sideOrder[a.side] ?? 9;
    const ob = sideOrder[b.side] ?? 9;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  sorted.forEach((a, i) => {
    a.order = i;
  });
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
    if(typeof state.settings.attackRequireRoute !== 'boolean'){
      state.settings.attackRequireRoute = false;
    }

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
        /* v8.6.0：order 欄位（若無，稍後由 migrate 補）*/
        if(typeof a.order !== 'number') a.order = null;
        return a;
      });
    }
    if(Array.isArray(d.zones)) state.zones = d.zones;

    if(Array.isArray(d.cities)){
      state.cities = d.cities.map(c => {
        if(!c.defStartTime) c.defStartTime = '19:00';
        if(typeof c.level !== 'number') c.level = 1;
        const migrate = arr => (arr||[]).map(t => ({
          cityId: t.cityId,
          preWarPercent: t.preWarPercent !== undefined
            ? t.preWarPercent
            : (t.teams ? Math.round(t.teams / (c.totalTeams||100) * 100) : 50),
          postRevivePercent: t.postRevivePercent !== undefined ? t.postRevivePercent : 50,
          priority: t.priority !== undefined ? t.priority : 1,
          attackStartTime: t.attackStartTime || '19:00',
        }));
        c.attackTargets = migrate(c.attackTargets);
        c.defendTargets = migrate(c.defendTargets);
        return c;
      });
    }

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

    if(d.listPrefs){
      state.listPrefs = Object.assign(state.listPrefs, d.listPrefs);
    }

    /* v8.5.6：遷移戰力單位 */
    migratePowerInState();
    /* v8.6.0：遷移盟排序 */
    migrateAllianceOrder();
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
  migratePowerInState();
  migrateAllianceOrder();
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
  if(typeof state.settings.attackRequireRoute !== 'boolean'){
    state.settings.attackRequireRoute = false;
  }
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
  migratePowerInState();
  migrateAllianceOrder();
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
   盟查找 / NPC 預設
   ============================================================ */
function getAllianceByName(name){
  if(!name) return null;
  return state.alliances.find(a => a.name === name) || null;
}

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
    order: 9999,
  };
  state.alliances.push(npc);
  logSystem('已建立預設 NPC 盟');
  return npc;
}

/* ============================================================
   v8.6.0：盟排序
   ============================================================ */
/**
 * 取得排序後的盟清單
 * - 有 order 者依 order
 * - 無 order 者依 createdAt
 */
function getAlliancesSorted(){
  return [...state.alliances].sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : 9999;
    const ob = typeof b.order === 'number' ? b.order : 9999;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/**
 * 依給定的 ID 順序重新分配 order
 * @param {string[]} orderedIds
 */
function reorderAlliances(orderedIds){
  if(!Array.isArray(orderedIds)) return;
  orderedIds.forEach((id, i) => {
    const a = state.alliances.find(x => x.id === id);
    if(!a) return;
    if(a.order === i) return;
    a.order = i;
    state.entityRev.alliance[id] = (state.entityRev.alliance[id] || 0) + 1;
    markDirty('alliance', id);
  });
  tickLamport();
  flushPatches();
  saveState();
  logSystem('🤝 盟排序已更新');
}

/**
 * 重設盟排序：依陣營 + createdAt
 */
function resetAllianceOrder(){
  const sideOrder = { self: 0, ally: 1, enemy: 2, common_enemy: 3, npc: 4 };
  const sorted = [...state.alliances].sort((a, b) => {
    const oa = sideOrder[a.side] ?? 9;
    const ob = sideOrder[b.side] ?? 9;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  sorted.forEach((a, i) => {
    a.order = i;
    state.entityRev.alliance[a.id] = (state.entityRev.alliance[a.id] || 0) + 1;
    markDirty('alliance', a.id);
  });
  tickLamport();
  flushPatches();
  saveState();
  logSystem('🔄 盟排序已重置');
}

/* ============================================================
   路線 CRUD
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
   v8.5.5：防守開始時間推算
   ============================================================ */
function computeDefStartTimes(cities){
  const list = cities || state.cities;
  for(const city of list){
    const incomingTimes = [];
    for(const o of list){
      for(const t of (o.attackTargets || [])){
        if(t.cityId === city.id && t.attackStartTime){
          incomingTimes.push(t.attackStartTime);
        }
      }
    }
    if(incomingTimes.length > 0){
      incomingTimes.sort();
      city.defStartTime = incomingTimes[0];
    } else {
      if(!city.defStartTime) city.defStartTime = '19:00';
    }
  }
}

/* ============================================================
   v8.6.0：距離計算（BFS）
   ============================================================ */

/**
 * 判斷某城是否為 NPC 城（side = 'npc' 或盟名為 NPC）
 */
function isNpcCity(city){
  if(!city) return false;
  if(city.side === 'npc') return true;
  const a = state.alliances.find(al => al.id === city.allianceId);
  if(a && a.name === NPC_ALLIANCE_NAME) return true;
  return false;
}

/**
 * 判斷某城是否為起點盟的城
 */
function isSrcAllianceCity(city, srcAllianceId){
  if(!city || !srcAllianceId) return false;
  return (city.allianceId || '') === srcAllianceId;
}

/**
 * BFS 搜尋最短路徑
 * @param {string} srcId
 * @param {string} tgtId
 * @param {Function} passableFn - 判斷中途城是否可通行
 * @returns {string[]|null} - 城 ID 陣列，或 null
 */
function bfsPath(srcId, tgtId, passableFn){
  if(srcId === tgtId) return [srcId];
  const visited = new Set([srcId]);
  const queue = [{ id: srcId, path: [srcId] }];

  while(queue.length > 0){
    const { id, path } = queue.shift();
    const neighbors = getReachableCityIds(id);
    for(const nid of neighbors){
      if(visited.has(nid)) continue;
      const city = state.cities.find(c => c.id === nid);
      if(!city) continue;

      /* 目標城永遠可通行（終點）*/
      if(nid === tgtId){
        return [...path, nid];
      }
      /* 中途城需通過 passableFn */
      if(!passableFn(city)) continue;
      visited.add(nid);
      queue.push({ id: nid, path: [...path, nid] });
    }
  }
  return null;
}

/**
 * 計算兩城之間的距離（BFS）
 * @param {string} srcId
 * @param {string} tgtId
 * @returns {Object|null}
 */
function computeCityDistance(srcId, tgtId){
  if(!srcId || !tgtId) return null;
  const src = state.cities.find(c => c.id === srcId);
  const tgt = state.cities.find(c => c.id === tgtId);
  if(!src || !tgt) return null;
  if(srcId === tgtId) return null;

  const srcAllianceId = src.allianceId || '';

  /* 條件一：可通行路徑（中途城 = 起點盟 or NPC） */
  const passableFn = (city) => {
    if(isSrcAllianceCity(city, srcAllianceId)) return true;
    if(isNpcCity(city)) return true;
    return false;
  };

  /* 條件二：征服路徑（中途城任意） */
  const conquerFn = () => true;

  const passablePath = bfsPath(srcId, tgtId, passableFn);
  const conquerPath = bfsPath(srcId, tgtId, conquerFn);

  /* 組裝結果 */
  const buildResult = (path, mode) => {
    if(!path) return { found: false, path: [], steps: 0, nodes: [], conquerNodes: [] };
    const nodes = path.map(id => {
      const c = state.cities.find(x => x.id === id);
      return c ? {
        id: c.id,
        name: c.name,
        side: c.side,
        allianceId: c.allianceId,
        allianceName: (state.alliances.find(a => a.id === c.allianceId)?.name || ''),
        isNpc: isNpcCity(c),
        isSrcAlliance: isSrcAllianceCity(c, srcAllianceId),
        isSrc: id === srcId,
        isTgt: id === tgtId,
      } : null;
    }).filter(Boolean);

    /* 計算需打下的城 */
    const conquerNodes = [];
    if(mode === 'passable'){
      /* 可通行模式：NPC 城需要佔領 */
      for(let i = 0; i < nodes.length; i++){
        const n = nodes[i];
        if(n.isSrc || n.isTgt) continue;
        if(n.isNpc) conquerNodes.push(n.id);
      }
    } else {
      /* 征服模式：非同盟 + 非 NPC 需要打下 */
      for(let i = 0; i < nodes.length; i++){
        const n = nodes[i];
        if(n.isSrc || n.isTgt) continue;
        if(n.isNpc) continue;
        if(n.isSrcAlliance) continue;
        conquerNodes.push(n.id);
      }
    }

    return {
      found: true,
      path: path.slice(),
      steps: path.length - 1,
      nodes,
      conquerNodes,
    };
  };

  return {
    src: {
      id: src.id,
      name: src.name,
      side: src.side,
      allianceId: src.allianceId,
      allianceName: (state.alliances.find(a => a.id === src.allianceId)?.name || ''),
    },
    tgt: {
      id: tgt.id,
      name: tgt.name,
      side: tgt.side,
      allianceId: tgt.allianceId,
      allianceName: (state.alliances.find(a => a.id === tgt.allianceId)?.name || ''),
    },
    passable: buildResult(passablePath, 'passable'),
    conquer: buildResult(conquerPath, 'conquer'),
  };
}

/**
 * 設定距離計算高亮（給 GameMap 用）
 */
function setDistanceHighlight(result){
  if(!result || !result.passable || !result.passable.found){
    state.distanceHighlight = null;
    emit(EVT.DISTANCE_CLEAR);
    return;
  }
  const path = result.passable.path;
  const cityIds = path.slice();
  const routeKeys = [];
  for(let i = 0; i < path.length - 1; i++){
    const a = path[i], b = path[i+1];
    routeKeys.push([a, b].sort().join('|'));
  }
  state.distanceHighlight = { cityIds, routeKeys };
  emit(EVT.DISTANCE_HIGHLIGHT, state.distanceHighlight);
}

function clearDistanceHighlight(){
  state.distanceHighlight = null;
  emit(EVT.DISTANCE_CLEAR);
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

  /* v8.5.6：戰力單位常量 */
  POWER_YI, POWER_WAN, POWER_MIGRATE_THRESHOLD,

  /* v8.6.0：盟徽清單 */
  DEFAULT_ALLIANCE_ICONS,

  uid, nowTime, esc, sideLabel, allianceSideLabel, sideClass, logSystem,
  formatDateCompact, timeAgo, buildSandboxFileName,

  /* v8.5.6：戰力單位工具 */
  formatPower, formatAvgPower, parsePowerInput, migratePower, powerToYiInput,

  /* v8.6.0：盟徽工具 */
  getAllianceIcons, isAllianceIconUsed, getAvailableAllianceIcons,

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

  /* 路線 API */
  findRoute,
  addRoute,
  removeRoute,
  getReachableCityIds,

  /* v8.5.5：防守時間推算 */
  computeDefStartTimes,

  /* v8.5.6：遷移 */
  migratePowerInState,

  /* v8.6.0：盟排序 */
  getAlliancesSorted,
  reorderAlliances,
  resetAllianceOrder,
  migrateAllianceOrder,

  /* v8.6.0：距離計算 */
  isNpcCity,
  isSrcAllianceCity,
  bfsPath,
  computeCityDistance,
  setDistanceHighlight,
  clearDistanceHighlight,
});

})();