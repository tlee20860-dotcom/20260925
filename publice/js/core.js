/* ============================================================================
 * core.js — 全域狀態、事件匯流排、工具、持久化、模式管理、AI、網路監控、同步
 * v8.9.9：新增 zone.mapId、地圖關聯工具、routeRequireSameMap / warRequireSameMap
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

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
const SYNC_PREFS_KEY = 'slg_sync_prefs';
const TROOP_TIERS_LS_KEY = 'slg_troop_tiers';
const ACCOUNT_UID_KEY = 'slg_sandtable_v82_accountUid';
const HOST_TIMEOUT = 15000;
const EDIT_LOCK_TTL = 30000;

const SANDBOX_SYNC_DEBOUNCE = 1500;
const ROOM_SNAPSHOT_DEBOUNCE = 2000;
const NETWORK_HEARTBEAT_INTERVAL = 15000;

const NPC_ALLIANCE_NAME = 'NPC';
const NPC_ALLIANCE_ICON = '🏰';

const POWER_YI = 1e8;
const POWER_WAN = 1e4;
const POWER_MIGRATE_THRESHOLD = 1e6;

const DEFAULT_TROOP_TIERS = {
  tiers: [
    { maxLevel: 17, teamsPerPlayer: 3 },
    { maxLevel: 20, teamsPerPlayer: 4 },
    { maxLevel: 24, teamsPerPlayer: 5 },
    { maxLevel: Infinity, teamsPerPlayer: 6 },
  ],
  autoCalcOnImport: true,
  preserveOldTotal: false,
};

const DEFAULT_ALLIANCE_ICONS = [
  '⚔️','🗡️','🏹','🔱','🪓','🛡️','⚒️','🔨','🪃','⚜️','🏰','🚩',
  '🎯','🔫','🚁','✈️','🚢','🛩️','🚀','💣','🧨','🛰️','🪖','🎖️',
  '🐉','🦅','🐺','🦁','💀','🦂','🐍','🦈','🐻',
  '👑','🌟','💎','✨','☀️','🌙','⭐','💫','🏴','🏳️','🎌',
  '⚡','🔥','❄️','🌊','🌪️','🌋','🏔️','🌲','🍀',
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
const DEFEND_RULES = { self:['self','ally'], ally:['self','ally'], enemy:[], common_enemy:[], npc:[] };
const SIDE_LABELS = { self:'本方', ally:'同盟', enemy:'敵方', common_enemy:'共同敵方', npc:'NPC' };
const ALLIANCE_SIDE_LABELS = { self:'本方', ally:'同盟', enemy:'敵方' };

const ROLE = { SUPERADMIN: 'superadmin', ADMIN: 'admin', OFFICER: 'officer', MEMBER: 'member', GUEST: 'guest' };
const ROLE_LABELS = {
  superadmin: '👑 超級管理員', admin: '🛡️ 管理員', officer: '⚔️ 幹部',
  member: '🙋 成員', guest: '👻 訪客',
};
const ROLE_CLASS = {
  superadmin: 'role-superadmin', admin: 'role-admin', officer: 'role-officer',
  member: 'role-member', guest: 'role-guest',
};
const ROLE_ORDER = { superadmin:0, admin:1, officer:2, member:3, guest:4 };

const EVT = {
  MEMBERS:'members', LOCKS:'locks', DATA:'data', CONN:'conn', HOST:'host',
  CHAT_NEW:'chat:new', SIM_TRIGGER:'sim:trigger', DEBUG:'debug',
  VIZ_SNAPSHOTS:'viz:snapshots', VIZ_RESET:'viz:reset', DYN_RESULT:'dyn:result',
  MODE:'mode', AUTH:'auth', ROOM_GRANTS:'room:grants', ROOM_PENDING:'room:pending',
  MY_SANDBOX_UPDATED:'sandbox:mine', SANDBOXES_LIST_UPDATED:'sandbox:list',
  ROOM_SNAPSHOT_UPDATED:'room:snapshot', ROUTES_UPDATED:'routes:updated',
  DISTANCE_HIGHLIGHT:'distance:highlight', DISTANCE_CLEAR:'distance:clear',
  NETWORK:'network', SYNC_STATE:'sync:state', TROOP_TIERS:'troop:tiers',
  MAP_LIBRARY_UPDATED:'map:library',
  MAP_MATCH_RESULT:'map:match',
};

/* ============================================================
   工具函式
   ============================================================ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const nowTime = () => new Date().toTimeString().slice(0,8);
const esc = s => s == null ? '' : String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const sideLabel = s => SIDE_LABELS[s] || s;
const allianceSideLabel = s => ALLIANCE_SIDE_LABELS[s] || s;
const sideClass = s => (s==='self') ? 'self' : (s==='ally') ? 'ally'
  : (s==='enemy'||s==='common_enemy') ? 'enemy' : 'npc';
const logSystem = text => console.log('[系統] ' + text);

function formatDateCompact(ts){
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
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

function formatPower(num){
  const n = Number(num) || 0;
  if(n === 0) return '0.00 億';
  return (n / POWER_YI).toFixed(2) + ' 億';
}
function formatAvgPower(num){
  const n = Number(num) || 0;
  if(n === 0) return '0 萬';
  return Math.round(n / POWER_WAN).toLocaleString() + ' 萬';
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

function getAllianceIcons(){ return DEFAULT_ALLIANCE_ICONS.slice(); }
function isAllianceIconUsed(icon, excludeId){
  if(!icon) return false;
  return state.alliances.some(a => a.icon === icon && a.id !== excludeId);
}
function getAvailableAllianceIcons(excludeId){
  return DEFAULT_ALLIANCE_ICONS.filter(icon => !isAllianceIconUsed(icon, excludeId));
}

/* ============================================================
   隊數分級工具
   ============================================================ */
function calcTeamsFromTiers(tierCounts, customTiers){
  const tiers = customTiers || state.troopTiers.tiers || DEFAULT_TROOP_TIERS.tiers;
  const counts = [
    Number(tierCounts?.tier1) || 0,
    Number(tierCounts?.tier2) || 0,
    Number(tierCounts?.tier3) || 0,
    Number(tierCounts?.tier4) || 0,
  ];
  let totalMembers = 0;
  let totalTeams = 0;
  const breakdown = [];
  for(let i = 0; i < tiers.length; i++){
    const n = Math.max(0, counts[i] || 0);
    const per = Math.max(0, Number(tiers[i].teamsPerPlayer) || 0);
    const t = n * per;
    totalMembers += n;
    totalTeams += t;
    breakdown.push({
      tier: i + 1,
      maxLevel: tiers[i].maxLevel,
      count: n,
      teamsPerPlayer: per,
      teams: t,
    });
  }
  return { totalMembers, totalTeams, breakdown };
}

function getTroopTiers(){
  return {
    tiers: state.troopTiers.tiers.map(t => ({ ...t })),
    autoCalcOnImport: !!state.troopTiers.autoCalcOnImport,
    preserveOldTotal: !!state.troopTiers.preserveOldTotal,
  };
}

function setTroopTiers(patch){
  if(patch.tiers && Array.isArray(patch.tiers)){
    state.troopTiers.tiers = patch.tiers.map(t => ({
      maxLevel: t.maxLevel === Infinity ? Infinity : (parseInt(t.maxLevel, 10) || 0),
      teamsPerPlayer: Math.max(0, parseInt(t.teamsPerPlayer, 10) || 0),
    }));
  }
  if(typeof patch.autoCalcOnImport === 'boolean') state.troopTiers.autoCalcOnImport = patch.autoCalcOnImport;
  if(typeof patch.preserveOldTotal === 'boolean') state.troopTiers.preserveOldTotal = patch.preserveOldTotal;
  saveTroopTiers();
  emit(EVT.TROOP_TIERS, state.troopTiers);
}

function resetTroopTiers(){
  state.troopTiers = {
    tiers: DEFAULT_TROOP_TIERS.tiers.map(t => ({ ...t })),
    autoCalcOnImport: DEFAULT_TROOP_TIERS.autoCalcOnImport,
    preserveOldTotal: DEFAULT_TROOP_TIERS.preserveOldTotal,
  };
  saveTroopTiers();
  emit(EVT.TROOP_TIERS, state.troopTiers);
}

function loadTroopTiers(){
  try{
    const raw = localStorage.getItem(TROOP_TIERS_LS_KEY);
    if(!raw) return;
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed.tiers) && parsed.tiers.length === 4){
      state.troopTiers.tiers = parsed.tiers.map(t => ({
        maxLevel: t.maxLevel === 'Infinity' || t.maxLevel === null ? Infinity : (parseInt(t.maxLevel, 10) || 0),
        teamsPerPlayer: Math.max(0, parseInt(t.teamsPerPlayer, 10) || 0),
      }));
    }
    if(typeof parsed.autoCalcOnImport === 'boolean') state.troopTiers.autoCalcOnImport = parsed.autoCalcOnImport;
    if(typeof parsed.preserveOldTotal === 'boolean') state.troopTiers.preserveOldTotal = parsed.preserveOldTotal;
  }catch(e){ console.warn('載入分級設定失敗', e); }
}
function saveTroopTiers(){
  try{
    const data = {
      tiers: state.troopTiers.tiers.map(t => ({
        maxLevel: t.maxLevel === Infinity ? 'Infinity' : t.maxLevel,
        teamsPerPlayer: t.teamsPerPlayer,
      })),
      autoCalcOnImport: state.troopTiers.autoCalcOnImport,
      preserveOldTotal: state.troopTiers.preserveOldTotal,
    };
    localStorage.setItem(TROOP_TIERS_LS_KEY, JSON.stringify(data));
  }catch(e){ console.warn('儲存分級設定失敗', e); }
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
    signedIn: false, accountUid: '', username: '', displayName: '',
    role: 'guest', status: 'active',
    extraPerms: {
      canEditData: false, canImportExcel: false, canRunSim: false,
      canKick: false, canEditSettings: false, canEditMapLibrary: false,
    },
  },
  commanderName:'', roomCode:'', isHost:false, hostName:'',
  connected:false, connecting:false, myClientId:'',
  members:{}, editLocks:{}, isSimulating:false,
  settings:{
    timeLimitMin:120, consumeMinPerMin:10, consumeMaxPerMin:30,
    siegeEfficiency:1, marchTimeSec:0, maxLossRatio:0.9, minLossRatio:0.1,
    attackRequireRoute: false,
    crossZoneWarAllowed: false,
    /* v8.9.9：地圖關聯規則 */
    routeRequireSameMap: true,
    warRequireSameMap: true,
  },
  alliances:[], zones:[], cities:[], routes: [],
  lamport:0, settingsRev:0,
  entityRev:{ alliance:{}, zone:{}, city:{} },
  dirty:{
    settings:false,
    alliance:new Set(), zone:new Set(), city:new Set(),
    allianceDeleted:new Set(), zoneDeleted:new Set(), cityDeleted:new Set()
  },
  roomEpoch:'', simBaseMin: 0, dynRows: [], editingAllianceId: null,
  narrativeLines: [], chatMessages: [], unreadChat: 0,
  roomEditGrants: {}, pendingEditRequests: {}, myEditRequestStatus: 'idle',
  mySandbox: { loading: false, loaded: false, cloudLoaded: false, updatedAt: 0, saving: false },
  sandboxesList: {}, roomSnapshot: null, roomHasSnapshot: false,
  pendingUploadSandbox: null,
  listPrefs: { warSort:'time', warGroup:'none', deploySort:'alliance', deployGroup:'none' },
  distanceResult: null, distanceView: 'number', distanceHighlight: null,
  network: { online: true, lastChange: 0, lastCheck: 0, initialized: false },
  sync: {
    dirty: false,
    dirtyCount: 0,
    lastUploadAt: 0,
    lastUploadReason: '',
    uploading: false,
    lastError: '',
    nextUploadAt: 0,
    timer: null,
    _allowClose: false,
    prefs: {
      intervalMin: 5,
      importantImmediate: true,
      visibilitySync: true,
      beforeUnloadSync: true,
    },
  },
  troopTiers: {
    tiers: DEFAULT_TROOP_TIERS.tiers.map(t => ({ ...t })),
    autoCalcOnImport: DEFAULT_TROOP_TIERS.autoCalcOnImport,
    preserveOldTotal: DEFAULT_TROOP_TIERS.preserveOldTotal,
  },
  /* 地圖庫（獨立於沙盤，雲端專屬） */
  mapLibrary: {
    index: {},
    loaded: {},
    activeMapId: '',
    viewMode: 'single',
    loading: false,
    lastError: '',
  },
  mapMatching: {
    autoAcceptThreshold: 0.95,
    candidatesThreshold: 0.5,
    maxCandidates: 5,
  },
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
   網路監控
   ============================================================ */
let networkHeartbeatTimer = null;

function isOnline(){
  return state.network.online && navigator.onLine !== false;
}

function setNetworkStatus(online, reason){
  const prev = state.network.online;
  if(prev === online && state.network.initialized) return;
  state.network.online = online;
  state.network.lastChange = Date.now();
  state.network.lastCheck = Date.now();
  state.network.initialized = true;
  console.log(`[網路] ${online ? '🟢 已恢復連線' : '🔴 連線中斷'}${reason ? ' (' + reason + ')' : ''}`);
  emit(EVT.NETWORK, { online, prev, reason, timestamp: Date.now() });
}

function initNetworkWatcher(){
  if(state.network.initialized) return;
  state.network.online = navigator.onLine !== false;
  state.network.lastChange = Date.now();
  state.network.lastCheck = Date.now();
  state.network.initialized = true;
  console.log(`[網路] 初始狀態：${state.network.online ? '🟢 在線' : '🔴 離線'}`);
  window.addEventListener('online', () => setNetworkStatus(true, 'online event'));
  window.addEventListener('offline', () => setNetworkStatus(false, 'offline event'));
  clearInterval(networkHeartbeatTimer);
  networkHeartbeatTimer = setInterval(() => {
    state.network.lastCheck = Date.now();
    const navOnline = navigator.onLine !== false;
    if(navOnline !== state.network.online) setNetworkStatus(navOnline, 'heartbeat');
  }, NETWORK_HEARTBEAT_INTERVAL);
}

/* ============================================================
   雲端同步管理（含 Promise 上傳鎖）
   ============================================================ */
let cloudSyncFn = null;
let cloudSyncTimer = null;
let syncCountdownTimer = null;
let uploadPromise = null;

function loadSyncPrefs(){
  try{
    const raw = localStorage.getItem(SYNC_PREFS_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      Object.assign(state.sync.prefs, parsed);
    }
  }catch(e){ console.warn('載入同步設定失敗', e); }
}
function saveSyncPrefs(){
  try{ localStorage.setItem(SYNC_PREFS_KEY, JSON.stringify(state.sync.prefs)); }
  catch(e){ console.warn('儲存同步設定失敗', e); }
}
function getSyncPrefs(){ return Object.assign({}, state.sync.prefs); }
function setSyncPrefs(patch){
  Object.assign(state.sync.prefs, patch);
  saveSyncPrefs();
  if(state.auth.signedIn) startSyncTimer();
}

function markCloudDirty(reason){
  state.sync.dirty = true;
  state.sync.dirtyCount++;
  emit(EVT.SYNC_STATE, state.sync);
  if(reason === 'important' && state.sync.prefs.importantImmediate){
    scheduleUpload(SANDBOX_SYNC_DEBOUNCE, 'important');
  }
}
function clearCloudDirty(){
  state.sync.dirty = false;
  state.sync.dirtyCount = 0;
  state.sync.lastError = '';
  emit(EVT.SYNC_STATE, state.sync);
}
function resetSyncState(){
  state.sync.dirty = false;
  state.sync.dirtyCount = 0;
  state.sync.lastUploadAt = 0;
  state.sync.lastUploadReason = '';
  state.sync.uploading = false;
  state.sync.lastError = '';
  state.sync.nextUploadAt = 0;
  state.sync._allowClose = false;
  if(state.sync.timer){ clearTimeout(state.sync.timer); state.sync.timer = null; }
  clearTimeout(cloudSyncTimer);
  clearInterval(syncCountdownTimer);
  syncCountdownTimer = null;
  uploadPromise = null;
  emit(EVT.SYNC_STATE, state.sync);
}

function scheduleUpload(delayMs, reason){
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  if(!state.mySandbox.cloudLoaded) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    performCloudUpload(reason || 'scheduled').catch(e => console.warn('[sync]', e));
  }, delayMs || SANDBOX_SYNC_DEBOUNCE);
}

async function performCloudUpload(reason){
  if(!state.auth.signedIn) return false;
  if(!isOnline()) return false;
  if(!state.mySandbox.cloudLoaded){
    console.warn('[sync] 雲端尚未載入，跳過上傳');
    return false;
  }
  if(uploadPromise){
    console.log(`[sync] 已有上傳進行中，沿用既有 Promise（${reason}）`);
    return uploadPromise;
  }

  const fn = cloudSyncFn || (window.SLG && window.SLG.saveMySandbox);
  if(typeof fn !== 'function'){
    console.warn('[sync] 無上傳函式');
    return false;
  }

  state.sync.uploading = true;
  state.sync.lastError = '';
  emit(EVT.SYNC_STATE, state.sync);

  uploadPromise = (async () => {
    try{
      await fn();
      state.sync.dirty = false;
      state.sync.dirtyCount = 0;
      state.sync.lastUploadAt = Date.now();
      state.sync.lastUploadReason = reason || 'unknown';
      const interval = state.sync.prefs.intervalMin || 5;
      state.sync.nextUploadAt = Date.now() + interval * 60 * 1000;
      logSystem('☁️ 雲端已同步（' + reason + '）');
      return true;
    }catch(e){
      state.sync.lastError = e.message || '同步失敗';
      console.warn('[sync] 上傳失敗', e);
      return false;
    }finally{
      state.sync.uploading = false;
      uploadPromise = null;
      emit(EVT.SYNC_STATE, state.sync);
    }
  })();

  return uploadPromise;
}

function startSyncTimer(){
  stopSyncTimer();
  if(!state.auth.signedIn) return;
  const intervalMin = state.sync.prefs.intervalMin;
  if(!intervalMin || intervalMin <= 0) return;

  const intervalMs = intervalMin * 60 * 1000;
  const now = Date.now();
  if(!state.sync.nextUploadAt || state.sync.nextUploadAt < now + 1000){
    state.sync.nextUploadAt = now + intervalMs;
  }
  const delay = Math.max(1000, state.sync.nextUploadAt - now);

  state.sync.timer = setTimeout(async () => {
    state.sync.timer = null;
    if(!state.auth.signedIn) return;
    if(!isOnline()){
      state.sync.nextUploadAt = Date.now() + intervalMs;
      startSyncTimer();
      return;
    }
    if(state.sync.dirty){
      await performCloudUpload('timer');
    } else {
      state.sync.nextUploadAt = Date.now() + intervalMs;
    }
    startSyncTimer();
  }, delay);

  emit(EVT.SYNC_STATE, state.sync);
}
function stopSyncTimer(){
  if(state.sync.timer){
    clearTimeout(state.sync.timer);
    state.sync.timer = null;
  }
}

function registerCloudSync(fn){ cloudSyncFn = fn; }
function triggerCloudSync(delay){
  if(!state.auth.signedIn) return;
  if(!isOnline()) return;
  if(!state.mySandbox.cloudLoaded) return;
  scheduleUpload(delay, 'legacy');
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
function saveState(reason){
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
      troopTiers: {
        tiers: state.troopTiers.tiers.map(t => ({
          maxLevel: t.maxLevel === Infinity ? 'Infinity' : t.maxLevel,
          teamsPerPlayer: t.teamsPerPlayer,
        })),
        autoCalcOnImport: state.troopTiers.autoCalcOnImport,
        preserveOldTotal: state.troopTiers.preserveOldTotal,
      },
      mapLibrary: {
        activeMapId: state.mapLibrary.activeMapId,
        viewMode: state.mapLibrary.viewMode,
      },
      mapMatching: {
        autoAcceptThreshold: state.mapMatching.autoAcceptThreshold,
        candidatesThreshold: state.mapMatching.candidatesThreshold,
        maxCandidates: state.mapMatching.maxCandidates,
      },
    }));
  }catch(e){ console.warn('儲存失敗', e); }

  if(state.mode === 'local' && state.auth.signedIn){
    markCloudDirty(reason || 'auto');
  }
  if(state.mode === 'room' && state.isHost){
    triggerRoomSnapshotSync();
  }
}
function saveStateImportant(){ saveState('important'); }

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

function migrateAllianceOrder(){
  if(!Array.isArray(state.alliances)) return;
  const hasAnyOrder = state.alliances.some(a => typeof a.order === 'number');
  if(hasAnyOrder) return;
  const sideOrder = { self: 0, ally: 1, enemy: 2, common_enemy: 3, npc: 4 };
  const sorted = [...state.alliances].sort((a, b) => {
    const oa = sideOrder[a.side] ?? 9, ob = sideOrder[b.side] ?? 9;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  sorted.forEach((a, i) => { a.order = i; });
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
    if(typeof state.settings.attackRequireRoute !== 'boolean') state.settings.attackRequireRoute = false;
    if(typeof state.settings.crossZoneWarAllowed !== 'boolean') state.settings.crossZoneWarAllowed = false;
    /* v8.9.9：地圖關聯規則 */
    if(typeof state.settings.routeRequireSameMap !== 'boolean') state.settings.routeRequireSameMap = true;
    if(typeof state.settings.warRequireSameMap !== 'boolean') state.settings.warRequireSameMap = true;
    if(d.entityRev) state.entityRev = d.entityRev;

    if(d.troopTiers && Array.isArray(d.troopTiers.tiers) && d.troopTiers.tiers.length === 4){
      state.troopTiers.tiers = d.troopTiers.tiers.map(t => ({
        maxLevel: t.maxLevel === 'Infinity' ? Infinity : (parseInt(t.maxLevel, 10) || 0),
        teamsPerPlayer: Math.max(0, parseInt(t.teamsPerPlayer, 10) || 0),
      }));
      if(typeof d.troopTiers.autoCalcOnImport === 'boolean') state.troopTiers.autoCalcOnImport = d.troopTiers.autoCalcOnImport;
      if(typeof d.troopTiers.preserveOldTotal === 'boolean') state.troopTiers.preserveOldTotal = d.troopTiers.preserveOldTotal;
    }

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
        if(typeof a.order !== 'number') a.order = null;
        return a;
      });
    }
    if(Array.isArray(d.zones)) state.zones = d.zones;
    if(Array.isArray(d.cities)){
      state.cities = d.cities.map(c => {
        if(!c.defStartTime) c.defStartTime = '19:00';
        if(typeof c.level !== 'number') c.level = 1;
        if(c.tierCounts && typeof c.tierCounts === 'object'){
          c.tierCounts = {
            tier1: Math.max(0, parseInt(c.tierCounts.tier1, 10) || 0),
            tier2: Math.max(0, parseInt(c.tierCounts.tier2, 10) || 0),
            tier3: Math.max(0, parseInt(c.tierCounts.tier3, 10) || 0),
            tier4: Math.max(0, parseInt(c.tierCounts.tier4, 10) || 0),
          };
        }
        const migrate = arr => (arr||[]).map(t => ({
          cityId: t.cityId,
          preWarPercent: t.preWarPercent !== undefined ? t.preWarPercent
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
        id: r.id || uid(), cityAId: r.cityAId || '', cityBId: r.cityBId || '',
      })).filter(r => r.cityAId && r.cityBId);
    }
    if(Array.isArray(d.dynRows)) state.dynRows = d.dynRows.slice(-5000);
    if(Array.isArray(d.narrativeLines)) state.narrativeLines = d.narrativeLines.slice(-1000);
    if(Array.isArray(d.chatMessages)) state.chatMessages = d.chatMessages.slice(-200);
    if(d.listPrefs) state.listPrefs = Object.assign(state.listPrefs, d.listPrefs);

    if(d.mapLibrary){
      if(typeof d.mapLibrary.activeMapId === 'string') state.mapLibrary.activeMapId = d.mapLibrary.activeMapId;
      if(d.mapLibrary.viewMode === 'gallery' || d.mapLibrary.viewMode === 'single') state.mapLibrary.viewMode = d.mapLibrary.viewMode;
    }
    if(d.mapMatching){
      if(typeof d.mapMatching.autoAcceptThreshold === 'number') state.mapMatching.autoAcceptThreshold = d.mapMatching.autoAcceptThreshold;
      if(typeof d.mapMatching.candidatesThreshold === 'number') state.mapMatching.candidatesThreshold = d.mapMatching.candidatesThreshold;
      if(typeof d.mapMatching.maxCandidates === 'number') state.mapMatching.maxCandidates = d.mapMatching.maxCandidates;
    }

    migratePowerInState();
    migrateAllianceOrder();
    /* v8.9.9：遷移舊 zone 補 mapId */
    if(typeof window.SLG.migrateZonesForMap === 'function'){
      try{ window.SLG.migrateZonesForMap(); }catch(e){ console.warn('遷移 zone.mapId 失敗', e); }
    }
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
  return { kind:'settings', rev:state.settingsRev, lamport:state.lamport, op:'upsert',
    data:Object.assign({}, state.settings) };
}
function buildEntityPatch(kind, id){
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones : state.cities;
  const entity = coll.find(x => x.id === id);
  if(!entity) return null;
  return { kind, id, rev: state.entityRev[kind][id] || 0, lamport: state.lamport,
    op:'upsert', data: JSON.parse(JSON.stringify(entity)) };
}
function buildDeletePatch(kind, id){
  return { kind, id, rev: state.entityRev[kind][id] || 0, lamport: state.lamport, op:'delete' };
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
             : kind==='zone'     ? state.zones : state.cities;
  const idx = coll.findIndex(x => x.id === entity.id);
  state.entityRev[kind][entity.id] = (state.entityRev[kind][entity.id] || 0) + 1;
  if(idx>=0) coll[idx] = entity; else coll.push(entity);
  if(!silent){ markDirty(kind, entity.id); tickLamport(); flushPatches(); }
  return entity;
}
function deleteEntity(kind, id, opts){
  opts = opts || {};
  const silent = !!opts.silent;
  const coll = kind==='alliance' ? state.alliances
             : kind==='zone'     ? state.zones : state.cities;
  const idx = coll.findIndex(x => x.id === id);
  if(idx<0) return;
  coll.splice(idx,1);
  state.entityRev[kind][id] = (state.entityRev[kind][id] || 0) + 1;
  if(!silent){ markDirty(kind+'Deleted', id); tickLamport(); flushPatches(); }
}
function updateSettings(patch, opts){
  opts = opts || {};
  Object.assign(state.settings, patch);
  state.settingsRev++;
  if(!opts.silent){ markDirty('settings'); tickLamport(); flushPatches(); }
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
             : kind==='city'     ? state.cities : null;
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
  if(!isOnline()) return;
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
    type:'sync_snapshot', epoch: state.roomEpoch, lamport: state.lamport,
    settingsRev: state.settingsRev,
    settings: Object.assign({}, state.settings),
    entityRev: JSON.parse(JSON.stringify(state.entityRev)),
    alliances: JSON.parse(JSON.stringify(state.alliances)),
    zones: JSON.parse(JSON.stringify(state.zones)),
    cities: JSON.parse(JSON.stringify(state.cities)),
    routes: JSON.parse(JSON.stringify(state.routes)),
    clientId: state.myClientId, name: state.commanderName
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
  for(const [kind, arr] of [['alliance', state.alliances],['zone', state.zones],['city', state.cities]]){
    for(const ent of arr){
      state.entityRev[kind][ent.id] = (snap.entityRev && snap.entityRev[kind] && snap.entityRev[kind][ent.id]) || 0;
    }
  }
  tickLamport(snap.lamport || 0);
  if(typeof state.settings.crossZoneWarAllowed !== 'boolean') state.settings.crossZoneWarAllowed = false;
  if(typeof state.settings.routeRequireSameMap !== 'boolean') state.settings.routeRequireSameMap = true;
  if(typeof state.settings.warRequireSameMap !== 'boolean') state.settings.warRequireSameMap = true;
  migratePowerInState();
  migrateAllianceOrder();
  /* v8.9.9：遷移 zone.mapId */
  if(typeof window.SLG.migrateZonesForMap === 'function'){
    try{ window.SLG.migrateZonesForMap(); }catch(e){}
  }
  return true;
}

function buildSandboxData(){
  return {
    settings: JSON.parse(JSON.stringify(state.settings)),
    alliances: JSON.parse(JSON.stringify(state.alliances)),
    zones: JSON.parse(JSON.stringify(state.zones)),
    cities: JSON.parse(JSON.stringify(state.cities)),
    routes: JSON.parse(JSON.stringify(state.routes)),
    troopTiers: {
      tiers: state.troopTiers.tiers.map(t => ({
        maxLevel: t.maxLevel === Infinity ? 'Infinity' : t.maxLevel,
        teamsPerPlayer: t.teamsPerPlayer,
      })),
      autoCalcOnImport: state.troopTiers.autoCalcOnImport,
      preserveOldTotal: state.troopTiers.preserveOldTotal,
    },
  };
}

function applySandboxData(data){
  if(!data) return false;
  if(data.settings) Object.assign(state.settings, data.settings);
  if(typeof state.settings.attackRequireRoute !== 'boolean') state.settings.attackRequireRoute = false;
  if(typeof state.settings.crossZoneWarAllowed !== 'boolean') state.settings.crossZoneWarAllowed = false;
  if(typeof state.settings.routeRequireSameMap !== 'boolean') state.settings.routeRequireSameMap = true;
  if(typeof state.settings.warRequireSameMap !== 'boolean') state.settings.warRequireSameMap = true;
  state.alliances = JSON.parse(JSON.stringify(data.alliances || []));
  state.zones     = JSON.parse(JSON.stringify(data.zones     || []));
  state.cities    = JSON.parse(JSON.stringify(data.cities    || []));
  state.routes    = JSON.parse(JSON.stringify(data.routes    || []));
  if(data.troopTiers && Array.isArray(data.troopTiers.tiers) && data.troopTiers.tiers.length === 4){
    state.troopTiers.tiers = data.troopTiers.tiers.map(t => ({
      maxLevel: t.maxLevel === 'Infinity' ? Infinity : (parseInt(t.maxLevel, 10) || 0),
      teamsPerPlayer: Math.max(0, parseInt(t.teamsPerPlayer, 10) || 0),
    }));
    if(typeof data.troopTiers.autoCalcOnImport === 'boolean') state.troopTiers.autoCalcOnImport = data.troopTiers.autoCalcOnImport;
    if(typeof data.troopTiers.preserveOldTotal === 'boolean') state.troopTiers.preserveOldTotal = data.troopTiers.preserveOldTotal;
  }
  state.entityRev = { alliance:{}, zone:{}, city:{} };
  for(const [kind, arr] of [['alliance', state.alliances],['zone', state.zones],['city', state.cities]]){
    for(const ent of arr){ state.entityRev[kind][ent.id] = 1; }
  }
  migratePowerInState();
  migrateAllianceOrder();
  /* v8.9.9：遷移 zone.mapId */
  if(typeof window.SLG.migrateZonesForMap === 'function'){
    try{ window.SLG.migrateZonesForMap(); }catch(e){}
  }
  return true;
}

function getAllianceDist(allianceId){
  const allocatedPower = state.cities.filter(c => c.allianceId === allianceId)
    .reduce((s, c) => s + (Number(c.totalPower) || 0), 0);
  const allocatedTeams = state.cities.filter(c => c.allianceId === allianceId)
    .reduce((s, c) => s + (Number(c.totalTeams) || 0), 0);
  return { allocatedPower, allocatedTeams };
}

function getAllianceByName(name){
  if(!name) return null;
  return state.alliances.find(a => a.name === name) || null;
}

function ensureNpcAlliance(){
  let npc = getAllianceByName(NPC_ALLIANCE_NAME);
  if(npc) return npc;
  npc = {
    id: uid(), name: NPC_ALLIANCE_NAME, icon: NPC_ALLIANCE_ICON, side: 'enemy',
    memberCount: 0, totalPower: 0, avgPower: 0, power: 0, order: 9999,
  };
  state.alliances.push(npc);
  logSystem('已建立預設 NPC 盟');
  return npc;
}

function getAlliancesSorted(){
  return [...state.alliances].sort((a, b) => {
    const oa = typeof a.order === 'number' ? a.order : 9999;
    const ob = typeof b.order === 'number' ? b.order : 9999;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

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
  tickLamport(); flushPatches(); saveState();
  logSystem('🤝 盟排序已更新');
}

function resetAllianceOrder(){
  const sideOrder = { self: 0, ally: 1, enemy: 2, common_enemy: 3, npc: 4 };
  const sorted = [...state.alliances].sort((a, b) => {
    const oa = sideOrder[a.side] ?? 9, ob = sideOrder[b.side] ?? 9;
    if(oa !== ob) return oa - ob;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  sorted.forEach((a, i) => {
    a.order = i;
    state.entityRev.alliance[a.id] = (state.entityRev.alliance[a.id] || 0) + 1;
    markDirty('alliance', a.id);
  });
  tickLamport(); flushPatches(); saveState();
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
  saveStateImportant();
  return route;
}
function removeRoute(routeId){
  const idx = state.routes.findIndex(r => r.id === routeId);
  if(idx < 0) return false;
  state.routes.splice(idx, 1);
  emit(EVT.ROUTES_UPDATED);
  saveStateImportant();
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
   v8.9.9：地圖關聯工具
   ============================================================ */
function getZoneById(zoneId){
  return state.zones.find(z => z.id === zoneId) || null;
}
function getZonesByMap(mapId){
  if(!mapId) return state.zones.slice();
  return state.zones.filter(z => z.mapId === mapId);
}
function getCityMapId(city){
  if(!city) return '';
  if(city.mapNode && city.mapNode.mapId) return city.mapNode.mapId;
  const zone = getZoneById(city.zoneId);
  return zone && zone.mapId ? zone.mapId : '';
}
function citiesOnSameMap(cityA, cityB){
  const ma = getCityMapId(cityA);
  const mb = getCityMapId(cityB);
  if(!ma || !mb) return true;  /* 未綁定時不限制 */
  return ma === mb;
}
function getAllMapIds(){
  return Object.keys(state.mapLibrary.index || {});
}

/* ============================================================
   距離計算（BFS）
   ============================================================ */
function isNpcCity(city){
  if(!city) return false;
  if(city.side === 'npc') return true;
  const a = state.alliances.find(al => al.id === city.allianceId);
  if(a && a.name === NPC_ALLIANCE_NAME) return true;
  return false;
}
function isSrcAllianceCity(city, srcAllianceId){
  if(!city || !srcAllianceId) return false;
  return (city.allianceId || '') === srcAllianceId;
}
function bfsPath(srcId, tgtId, passableFn){
  if(srcId === tgtId) return [srcId];
  const visited = new Set([srcId]);
  const queue = [{ id: srcId, path: [srcId] }];
  while(queue.length > 0){
    const { id, path } = queue.shift();
    for(const nid of getReachableCityIds(id)){
      if(visited.has(nid)) continue;
      const city = state.cities.find(c => c.id === nid);
      if(!city) continue;
      if(nid === tgtId) return [...path, nid];
      if(!passableFn(city)) continue;
      visited.add(nid);
      queue.push({ id: nid, path: [...path, nid] });
    }
  }
  return null;
}
function computeCityDistance(srcId, tgtId){
  if(!srcId || !tgtId) return null;
  const src = state.cities.find(c => c.id === srcId);
  const tgt = state.cities.find(c => c.id === tgtId);
  if(!src || !tgt || srcId === tgtId) return null;
  const srcAllianceId = src.allianceId || '';
  const passableFn = (city) => isSrcAllianceCity(city, srcAllianceId) || isNpcCity(city);
  const conquerFn = () => true;
  const passablePath = bfsPath(srcId, tgtId, passableFn);
  const conquerPath = bfsPath(srcId, tgtId, conquerFn);
  const buildResult = (path, mode) => {
    if(!path) return { found: false, path: [], steps: 0, nodes: [], conquerNodes: [] };
    const nodes = path.map(id => {
      const c = state.cities.find(x => x.id === id);
      return c ? {
        id: c.id, name: c.name, side: c.side, allianceId: c.allianceId,
        allianceName: (state.alliances.find(a => a.id === c.allianceId)?.name || ''),
        isNpc: isNpcCity(c), isSrcAlliance: isSrcAllianceCity(c, srcAllianceId),
        isSrc: id === srcId, isTgt: id === tgtId,
      } : null;
    }).filter(Boolean);
    const conquerNodes = [];
    for(let i = 0; i < nodes.length; i++){
      const n = nodes[i];
      if(n.isSrc || n.isTgt) continue;
      if(mode === 'passable'){ if(n.isNpc) conquerNodes.push(n.id); }
      else { if(!n.isNpc && !n.isSrcAlliance) conquerNodes.push(n.id); }
    }
    return { found: true, path: path.slice(), steps: path.length - 1, nodes, conquerNodes };
  };
  return {
    src: { id: src.id, name: src.name, side: src.side, allianceId: src.allianceId,
      allianceName: (state.alliances.find(a => a.id === src.allianceId)?.name || '') },
    tgt: { id: tgt.id, name: tgt.name, side: tgt.side, allianceId: tgt.allianceId,
      allianceName: (state.alliances.find(a => a.id === tgt.allianceId)?.name || '') },
    passable: buildResult(passablePath, 'passable'),
    conquer: buildResult(conquerPath, 'conquer'),
  };
}
function setDistanceHighlight(result){
  if(!result || !result.passable || !result.passable.found){
    state.distanceHighlight = null;
    emit(EVT.DISTANCE_CLEAR);
    return;
  }
  const path = result.passable.path;
  const routeKeys = [];
  for(let i = 0; i < path.length - 1; i++){
    routeKeys.push([path[i], path[i+1]].sort().join('|'));
  }
  state.distanceHighlight = { cityIds: path.slice(), routeKeys };
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
    detail.textContent = '正在連線至房間 ' + (state.roomCode || '') + (userLabel ? ' / ' + userLabel : '');
    btn.textContent = '取消連線';
  } else {
    bar.className = 'mode-bar local';
    const prefs = state.sync.prefs;
    if(a.signedIn){
      if(prefs.intervalMin > 0){
        indicator.textContent = `🖥️ 同步雲端模式（每 ${prefs.intervalMin} 分鐘）`;
      } else {
        indicator.textContent = '🖥️ 本機模式（同步已停用）';
      }
    } else {
      indicator.textContent = '🖥️ 本機模式';
    }
    detail.textContent = userLabel ? userLabel + ' / 尚未進入房間' : '尚未進入房間';
    btn.textContent = '進入房間';
  }
}
function requestSwitchMode(){
  if(state.mode === 'room'){
    if(typeof window.SLG.requestDisconnect === 'function') window.SLG.requestDisconnect();
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
function isInRoom(){ return state.mode === 'room' && state.connected; }
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
  if(isInRoom()) return canEditRoomData() && window.SLG.Auth && window.SLG.Auth.canImportExcel();
  return window.SLG.Auth && window.SLG.Auth.canImportExcel();
}
function resetRoomEditState(){
  state.roomEditGrants = {};
  state.pendingEditRequests = {};
  state.myEditRequestStatus = 'idle';
}

function canViewSandboxes(){ return !!state.auth.signedIn; }
function canViewSandboxOf(targetUid, targetRole){
  if(!state.auth.signedIn) return false;
  if(targetUid === state.auth.accountUid) return true;
  if(window.SLG.Auth && (window.SLG.Auth.isAdmin() || state.auth.role === ROLE.OFFICER)) return true;
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
   分級參數 UI 同步
   ============================================================ */
function syncTroopTiersToUI(){
  const t = state.troopTiers;
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if(el) el.value = v;
  };
  if(t.tiers[0]){
    setVal('tier1Max', t.tiers[0].maxLevel === Infinity ? '' : t.tiers[0].maxLevel);
    setVal('tier1Teams', t.tiers[0].teamsPerPlayer);
  }
  if(t.tiers[1]){
    setVal('tier2Max', t.tiers[1].maxLevel === Infinity ? '' : t.tiers[1].maxLevel);
    setVal('tier2Teams', t.tiers[1].teamsPerPlayer);
  }
  if(t.tiers[2]){
    setVal('tier3Max', t.tiers[2].maxLevel === Infinity ? '' : t.tiers[2].maxLevel);
    setVal('tier3Teams', t.tiers[2].teamsPerPlayer);
  }
  if(t.tiers[3]){
    setVal('tier4Teams', t.tiers[3].teamsPerPlayer);
  }
  const autoEl = document.getElementById('tierAutoCalcOnImport');
  if(autoEl) autoEl.checked = !!t.autoCalcOnImport;
  const presEl = document.getElementById('tierPreserveOldTotal');
  if(presEl) presEl.checked = !!t.preserveOldTotal;
}

function readTroopTiersFromUI(){
  const getNum = (id, def) => {
    const el = document.getElementById(id);
    if(!el) return def;
    const n = parseInt(el.value, 10);
    return isNaN(n) ? def : n;
  };
  const tier1Max = getNum('tier1Max', 17);
  const tier2Max = getNum('tier2Max', 20);
  const tier3Max = getNum('tier3Max', 24);
  const tiers = [
    { maxLevel: tier1Max, teamsPerPlayer: getNum('tier1Teams', 3) },
    { maxLevel: tier2Max, teamsPerPlayer: getNum('tier2Teams', 4) },
    { maxLevel: tier3Max, teamsPerPlayer: getNum('tier3Teams', 5) },
    { maxLevel: Infinity, teamsPerPlayer: getNum('tier4Teams', 6) },
  ];
  const autoEl = document.getElementById('tierAutoCalcOnImport');
  const presEl = document.getElementById('tierPreserveOldTotal');
  return {
    tiers,
    autoCalcOnImport: !!autoEl?.checked,
    preserveOldTotal: !!presEl?.checked,
  };
}

/* 初始化 */
loadSyncPrefs();
loadTroopTiers();

/* ============================================================
   地圖庫工具
   ============================================================ */
const MAP_LIBRARY_LS_KEY = 'slg_map_library_prefs';

function normalizeCityName(name){
  if(!name) return '';
  return String(name)
    .trim()
    .replace(/\uFEFF/g, '')
    .replace(/[（）()【】\[\]「」『』《》<>]/g, '')
    .replace(/\s+/g, '')
    .replace(/(水寨|要塞|關卡|城池|城堡|營寨|港口|小城|大城|新村|古鎮|山寨|城|關|寨|村|鎮|港|島|營)$/g, '')
    .toLowerCase();
}

function levenshtein(a, b){
  if(!a) return b ? b.length : 0;
  if(!b) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for(let j = 0; j <= n; j++) prev[j] = j;
  for(let i = 1; i <= m; i++){
    curr[0] = i;
    for(let j = 1; j <= n; j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j-1] + 1,
        prev[j-1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function calcSimilarity(a, b){
  if(!a || !b) return 0;
  const rawA = String(a).trim();
  const rawB = String(b).trim();
  if(rawA === rawB) return 1;

  const na = normalizeCityName(rawA);
  const nb = normalizeCityName(rawB);
  if(!na || !nb) return 0;
  if(na === nb) return 0.95;

  const containsBonus = (() => {
    if(na.includes(nb) || nb.includes(na)){
      const minLen = Math.min(na.length, nb.length);
      const maxLen = Math.max(na.length, nb.length);
      return 0.6 + 0.3 * (minLen / maxLen);
    }
    return 0;
  })();

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  const editSim = maxLen > 0 ? Math.max(0, 1 - dist / maxLen) : 0;

  let prefixBonus = 0;
  const minPrefix = Math.min(na.length, nb.length, 5);
  for(let i = 0; i < minPrefix; i++){
    if(na[i] === nb[i]) prefixBonus += 0.02;
    else break;
  }

  return Math.min(1, Math.max(containsBonus, editSim + prefixBonus));
}

function matchCityToMapNode(input, nodes, opts){
  opts = opts || {};
  const autoAccept = opts.autoAccept !== undefined ? opts.autoAccept : (state.mapMatching.autoAcceptThreshold || 0.95);
  const candidatesMin = opts.candidatesMin !== undefined ? opts.candidatesMin : (state.mapMatching.candidatesThreshold || 0.5);
  const maxCandidates = opts.maxCandidates !== undefined ? opts.maxCandidates : (state.mapMatching.maxCandidates || 5);

  const result = {
    nodeId: '',
    node: null,
    score: 0,
    method: 'none',
    candidates: [],
    needsUserChoice: false,
    autoAccepted: false,
  };

  if(!input || !nodes) return result;
  const nodeEntries = Object.entries(nodes);

  const name = (input.name || '').trim();
  if(name){
    for(const [nid, n] of nodeEntries){
      if((n.name || '').trim() === name){
        result.nodeId = nid;
        result.node = n;
        result.score = 1;
        result.method = 'exact-name';
        result.autoAccepted = true;
        return result;
      }
    }
  }

  if(name){
    const nName = normalizeCityName(name);
    if(nName){
      for(const [nid, n] of nodeEntries){
        if(normalizeCityName(n.name) === nName){
          result.nodeId = nid;
          result.node = n;
          result.score = 0.95;
          result.method = 'normalized';
          result.autoAccepted = true;
          return result;
        }
      }
    }
  }

  if(name){
    const candidates = [];
    for(const [nid, n] of nodeEntries){
      const s = calcSimilarity(name, n.name || '');
      if(s >= candidatesMin){
        candidates.push({ nodeId: nid, node: n, score: s });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    result.candidates = candidates.slice(0, maxCandidates);

    if(candidates.length === 0){
      result.method = 'none';
      return result;
    }

    const best = candidates[0];
    if(best.score >= autoAccept){
      const secondScore = candidates[1] ? candidates[1].score : 0;
      if(best.score - secondScore >= 0.1){
        result.nodeId = best.nodeId;
        result.node = best.node;
        result.score = best.score;
        result.method = 'fuzzy-auto';
        result.autoAccepted = true;
        return result;
      }
    }

    result.nodeId = best.nodeId;
    result.node = best.node;
    result.score = best.score;
    result.method = 'fuzzy';
    result.needsUserChoice = true;
    return result;
  }

  return result;
}

function matchCitiesToMap(cities, nodes){
  const out = [];
  if(!Array.isArray(cities)) return out;
  for(const c of cities){
    const input = { name: c.name, code: c.code || '' };
    const r = matchCityToMapNode(input, nodes);
    out.push({ city: c, result: r });
  }
  return out;
}

function loadMapLibraryPrefs(){
  try{
    const raw = localStorage.getItem(MAP_LIBRARY_LS_KEY);
    if(!raw) return;
    const p = JSON.parse(raw);
    if(typeof p.activeMapId === 'string') state.mapLibrary.activeMapId = p.activeMapId;
    if(p.viewMode === 'gallery' || p.viewMode === 'single') state.mapLibrary.viewMode = p.viewMode;
  }catch(e){ /* ignore */ }
}
function saveMapLibraryPrefs(){
  try{
    localStorage.setItem(MAP_LIBRARY_LS_KEY, JSON.stringify({
      activeMapId: state.mapLibrary.activeMapId,
      viewMode: state.mapLibrary.viewMode,
    }));
  }catch(e){ /* ignore */ }
}

function getMapMeta(mapId){
  return state.mapLibrary.index[mapId] || null;
}
function getLoadedMap(mapId){
  return state.mapLibrary.loaded[mapId] || null;
}
function getActiveMap(){
  const id = state.mapLibrary.activeMapId;
  if(!id) return null;
  return state.mapLibrary.loaded[id] || null;
}
function setActiveMap(mapId){
  state.mapLibrary.activeMapId = mapId || '';
  saveMapLibraryPrefs();
  saveState();
  emit(EVT.MAP_LIBRARY_UPDATED, { type: 'active-changed', mapId });
}
function setMapViewMode(mode){
  if(mode !== 'single' && mode !== 'gallery') return;
  state.mapLibrary.viewMode = mode;
  saveMapLibraryPrefs();
  saveState();
  emit(EVT.MAP_LIBRARY_UPDATED, { type: 'viewmode-changed', mode });
}

function initMapLibrary(){
  loadMapLibraryPrefs();
}

initMapLibrary();

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  LS_PREFIX, LS_LEGACY_PREFIX, AI_LS_KEY, ACCOUNT_UID_KEY,
  SYNC_PREFS_KEY, TROOP_TIERS_LS_KEY,
  HOST_TIMEOUT, EDIT_LOCK_TTL,
  SANDBOX_SYNC_DEBOUNCE, ROOM_SNAPSHOT_DEBOUNCE,
  NETWORK_HEARTBEAT_INTERVAL,
  PERCENT_OPTIONS,
  NPC_ALLIANCE_NAME, NPC_ALLIANCE_ICON,
  ATTACK_RULES, DEFEND_RULES, SIDE_LABELS, ALLIANCE_SIDE_LABELS,
  ROLE, ROLE_LABELS, ROLE_CLASS, ROLE_ORDER, EVT,

  POWER_YI, POWER_WAN, POWER_MIGRATE_THRESHOLD,
  DEFAULT_ALLIANCE_ICONS, DEFAULT_TROOP_TIERS,

  uid, nowTime, esc, sideLabel, allianceSideLabel, sideClass, logSystem,
  formatDateCompact, timeAgo, buildSandboxFileName,

  formatPower, formatAvgPower, parsePowerInput, migratePower, powerToYiInput,
  getAllianceIcons, isAllianceIconUsed, getAvailableAllianceIcons,

  calcTeamsFromTiers, getTroopTiers, setTroopTiers, resetTroopTiers,
  loadTroopTiers, saveTroopTiers,
  syncTroopTiersToUI, readTroopTiersFromUI,

  AI,
  state, on, emit,

  isOnline, initNetworkWatcher, setNetworkStatus,

  loadSyncPrefs, saveSyncPrefs, getSyncPrefs, setSyncPrefs,
  markCloudDirty, clearCloudDirty, resetSyncState,
  performCloudUpload, scheduleUpload,
  startSyncTimer, stopSyncTimer,

  tickLamport, isNewer, markDirty, clearDirty,

  saveState, saveStateImportant, loadState, migrateLegacyState,
  registerCloudSync, triggerCloudSync,
  registerRoomSnapshotSync, triggerRoomSnapshotSync,

  buildSettingsPatch, buildEntityPatch, buildDeletePatch, collectDirtyPatches,
  upsertEntity, deleteEntity, updateSettings, applyPatch,
  registerSender, flushPatches,
  buildFullSnapshot, applyFullSnapshot,
  buildSandboxData, applySandboxData,

  enterRoomMode, exitRoomMode, updateModeBar, requestSwitchMode,

  isInRoom, canEditRoomData,
  getEffectiveEditPermission, getEffectiveImportExcelPermission,
  resetRoomEditState,

  canViewSandboxes, canViewSandboxOf, canViewRoomSandboxes,
  canUploadSandboxToRoom, canUseRescueTool,

  syncAIParamsToUI, readAIParamsFromUI,

  getAllianceDist, getAllianceByName, ensureNpcAlliance,

  findRoute, addRoute, removeRoute, getReachableCityIds,
  computeDefStartTimes, migratePowerInState,

  getAlliancesSorted, reorderAlliances, resetAllianceOrder, migrateAllianceOrder,

  isNpcCity, isSrcAllianceCity, bfsPath, computeCityDistance,
  setDistanceHighlight, clearDistanceHighlight,

  /* v8.9.9：地圖關聯工具 */
  getZoneById, getZonesByMap, getCityMapId, citiesOnSameMap, getAllMapIds,

  MAP_LIBRARY_LS_KEY,
  normalizeCityName, levenshtein, calcSimilarity,
  matchCityToMapNode, matchCitiesToMap,
  loadMapLibraryPrefs, saveMapLibraryPrefs,
  getMapMeta, getLoadedMap, getActiveMap,
  setActiveMap, setMapViewMode,
  initMapLibrary,
});

})();