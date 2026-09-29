/* ============================================================================
 * data.js — Excel/CSV 匯入匯出
 * v8.8.0：新增城池編號欄位 + 匯入後自動觸發地圖節點匹配
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, emit, EVT,
  uid, esc, logSystem,
  SIDE_LABELS,
  clamp,
  markDirty, tickLamport, flushPatches,
  saveState, saveStateImportant,
  getAllianceByName, ensureNpcAlliance,
  NPC_ALLIANCE_NAME, NPC_ALLIANCE_ICON,
  findRoute, addRoute,
  POWER_YI, POWER_WAN,
  parsePowerInput, migratePower, getAlliancesSorted,
  calcTeamsFromTiers,
  /* v8.8.0：模糊比對 */
  matchCityToMapNode,
  getActiveMap,
} = window.SLG;

/* ============================================================
   通用：解析分隔符文字
   ============================================================ */
function parseDelimited(text){
  text = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const useTab = firstLine.includes('\t');
  const delim = useTab ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else { field += c; }
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === delim){ row.push(field); field = ''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if(c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c != null && String(c).trim() !== ''));
}

function normalizeHeader(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,''); }
function findFieldIndex(headers, aliases){
  for(let i = 0; i < headers.length; i++){
    const h = normalizeHeader(headers[i]);
    if(aliases.includes(h)) return i;
  }
  return -1;
}

/* ============================================================
   v8.6.8：匯入模式工具
   ============================================================ */
const IMPORT_MODE_LABELS = {
  merge: '🔄 合併',
  append: '➕ 新增',
  overwrite: '💥 覆蓋',
};
const IMPORT_MODE_HINTS = {
  merge: '同名會更新、新的加入、其他保留',
  append: '同名會跳過、新的加入、其他保留',
  overwrite: '清空後重建（⚠️ 會刪除所有現有資料）',
};
function getImportMode(modeKey){
  const el = document.getElementById(modeKey);
  return el ? el.value : 'merge';
}
function confirmImport(mode, count, typeLabel){
  const modeLabel = IMPORT_MODE_LABELS[mode] || mode;
  const hint = IMPORT_MODE_HINTS[mode] || '';
  return confirm(
    `即將以「${modeLabel}」模式匯入 ${count} 個${typeLabel}。\n\n` +
    `模式說明：${hint}\n\n` +
    (mode === 'overwrite' ? '⚠️ 覆蓋模式會清空所有現有資料！\n\n' : '') +
    `確定執行？`
  );
}

/* ============================================================
   欄位別名
   ============================================================ */
const ALLIANCE_FIELD_ALIASES = {
  name:        ['盟名稱','同盟名稱','名稱','盟名','name','alliancename'],
  icon:        ['盟徽','icon','徽章'],
  memberCount: ['人數','成員數','總人數','membercount','members'],
  totalPower:  ['總戰力','戰力','totalpower','power','總戰力（億）','總戰力(億)','總戰力億','戰力（億）','戰力(億)'],
  side:        ['陣營','side','faction'],
  order:       ['順序','排序','order','sort'],
};

/* v8.8.0：新增 code 欄位（城池編號） */
const CITY_FIELD_ALIASES = {
  name:        ['城池名稱','城池','城名','名稱','name','cityname','city'],
  code:        ['城池編號','編號','城編號','代碼','code','citycode','id'],
  zone:        ['戰區','分區','區域','zone','zoneid','region'],
  alliance:    ['同盟','盟','盟名稱','盟名','alliancename','alliance'],
  side:        ['陣營','陣營關係','side','faction'],
  level:       ['等級','level','lv','級別'],
  memberCount: ['人數','成員數','總人數','membercount','members','member'],
  totalPower:  ['總戰力','戰力','totalpower','power','總戰力（億）','總戰力(億)','總戰力億','戰力（億）','戰力(億)'],
  totalTeams:  ['總隊數','隊數','兵力','隊伍數','totalteams','teams'],
  cooldownMin: ['冷卻','冷卻分鐘','冷卻復活','冷卻(分)','cooldownmin','cooldown'],
  wallMin:     ['城牆','城牆耐久','城牆分鐘','城牆(分)','wallmin','wall'],
  isCapital:   ['首都','盟首都','主城','iscapital','capital'],
};

/* v8.6.9：分級欄位別名 */
const TIER_FIELD_ALIASES = {
  tier1: ['人≤17','人(≤17)','低階','人17以下','tier1','人小於17','人小於等於17','人17以下'],
  tier2: ['人18-20','人(18-20)','中階','人18到20','tier2','人18至20'],
  tier3: ['人21-24','人(21-24)','高階','人21到24','tier3','人21至24'],
  tier4: ['人≥25','人(≥25)','頂階','人25以上','tier4','人大於25','人大於等於25','人25以上'],
};

const ROUTE_FIELD_ALIASES = {
  src:             ['出兵城','進攻城','來源城','出兵','src','srccity','from'],
  tgt:             ['目標城','目標','tgt','tgtcity','to'],
  type:            ['類型','行動','type','action'],
  pre:             ['戰前%','戰前','戰前派兵%','pre','prewar','prewarpercent'],
  post:            ['復活%','復活','復活後派兵%','post','postrevive','postrevivepercent'],
  priority:        ['順序','優先順序','優先','priority','pr'],
  attackStartTime: ['進攻開始時間','進攻時間','開始時間','attackstarttime','attackstart','starttime','start'],
};

const SIDE_PARSE_MAP = {
  '本方':'self','自己':'self','self':'self','我方':'self','我軍':'self',
  '同盟':'ally','盟友':'ally','ally':'ally','友方':'ally',
  '敵方':'enemy','敵':'enemy','enemy':'enemy','敵軍':'enemy',
  '共同敵方':'common_enemy','共同敵':'common_enemy','common_enemy':'common_enemy','common':'common_enemy',
  'npc':'npc','NPC':'npc','中立':'npc','中立城':'npc',
};
const TRUTHY_SET = new Set(['是','y','yes','true','1','✓','√','v','有','首都','主城']);

/* ============================================================
   時間正規化
   ============================================================ */
function normalizeTimeString(s){
  if(!s) return '';
  s = String(s).trim();
  if(/^\d{1,2}:\d{2}$/.test(s)){
    const [h, m] = s.split(':');
    return String(parseInt(h,10)).padStart(2,'0') + ':' + m.padStart(2,'0');
  }
  if(/^\d{4}$/.test(s)) return s.slice(0,2) + ':' + s.slice(2,4);
  if(/^\d{6}$/.test(s)) return s.slice(0,2) + ':' + s.slice(2,4);
  if(/^\d{1,2}:\d{2}:\d{2}$/.test(s)){
    const [h, m] = s.split(':');
    return String(parseInt(h,10)).padStart(2,'0') + ':' + m.padStart(2,'0');
  }
  return '';
}

/* ============================================================
   戰力解析
   ============================================================ */
function parsePowerFromImport(raw){
  const s = String(raw == null ? '' : raw).trim();
  if(s === '') return 0;
  const n = parseFloat(s);
  if(isNaN(n) || n < 0) return 0;
  if(n >= 1e6) return Math.round(n);
  return Math.round(n * POWER_YI);
}
function powerToYiStr(num){
  const n = Number(num) || 0;
  if(n === 0) return '0.00';
  return (n / POWER_YI).toFixed(2);
}
function powerToWanStr(num){
  const n = Number(num) || 0;
  if(n === 0) return '0';
  return String(Math.round(n / POWER_WAN));
}

/* ============================================================
   解析：盟名單
   ============================================================ */
function parseAlliancesTable(rows){
  if(!rows || rows.length < 2) return { alliances: [], errors: ['盟名單至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(ALLIANCE_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
  if(idx.name < 0) return { alliances: [], errors: ['盟名單缺少「盟名稱」欄位'] };

  const alliances = [];
  const errors = [];

  for(let i = 1; i < rows.length; i++){
    const r = rows[i];
    const name = String(r[idx.name]||'').trim();
    if(!name){ errors.push(`第 ${i+1} 列缺少盟名稱，略過`); continue; }

    const get = (field, def) => {
      const j = idx[field];
      if(j < 0) return def;
      const v = String(r[j]||'').trim();
      return v !== '' ? v : def;
    };

    const icon = get('icon', '');
    const memberCount = parseFloat(get('memberCount', '100')) || 100;
    const totalPowerRaw = get('totalPower', '2');
    const totalPower = parsePowerFromImport(totalPowerRaw);
    const sideRaw = get('side', '敵方');
    const sideNorm = normalizeHeader(sideRaw);
    const side = SIDE_PARSE_MAP[sideRaw] || SIDE_PARSE_MAP[sideNorm] || 'enemy';

    let order = null;
    if(idx.order >= 0){
      const v = String(r[idx.order] || '').trim();
      if(v !== ''){
        const n = parseInt(v, 10);
        if(!isNaN(n) && n >= 0) order = n;
      }
    }
    alliances.push({ name, icon: icon || NPC_ALLIANCE_ICON, memberCount, totalPower, side, order, _rowIdx: i - 1 });
  }
  alliances.forEach((a, i) => { if(a.order === null) a.order = i; });
  return { alliances, errors };
}

/* ============================================================
   v8.8.0：解析城池表（支援編號 + 分級）
   ============================================================ */
function parseCitiesTable(rows){
  if(!rows || rows.length < 2) return { cities: [], errors: ['城池表至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(CITY_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
  const tierIdx = {};
  for(const [field, aliases] of Object.entries(TIER_FIELD_ALIASES)){
    tierIdx[field] = findFieldIndex(headers, aliases);
  }
  const hasTierFields = tierIdx.tier1 >= 0 || tierIdx.tier2 >= 0 || tierIdx.tier3 >= 0 || tierIdx.tier4 >= 0;

  if(idx.name < 0) return { cities: [], errors: ['城池表缺少「城池名稱」欄位'] };

  const cities = [];
  const errors = [];
  const neededZones = new Set();
  const neededAlliances = new Map();

  for(let i = 1; i < rows.length; i++){
    const r = rows[i];
    const name = String(r[idx.name]||'').trim();
    if(!name){ errors.push(`第 ${i+1} 列缺少城池名稱，略過`); continue; }

    const get = (field, def) => {
      const j = idx[field];
      if(j < 0) return def;
      const v = String(r[j]||'').trim();
      return v !== '' ? v : def;
    };

    /* v8.8.0：城池編號 + v8.8.1：從名稱自動拆分編號 */
    let code = (idx.code >= 0) ? String(r[idx.code] || '').trim() : '';
    let cleanName = name;
    /* 只匹配「(英文開頭的編號)」→ (L98)、(M28)、(N2) 等
       不會拆「(待確認)」這種中文內容 */
    const nameM = name.match(/^(.+?)\s*[（(]\s*([A-Za-z][A-Za-z0-9_\-]*)\s*[)）]\s*$/);
    if(nameM){
      cleanName = nameM[1].trim();
      if(!code) code = nameM[2].trim();
    }

    const zoneName = get('zone', '未分配');
    const allianceName = get('alliance', '');
    const sideRaw = get('side', '本方');
    const sideNorm = normalizeHeader(sideRaw);
    const side = SIDE_PARSE_MAP[sideRaw] || SIDE_PARSE_MAP[sideNorm] || 'self';
    const level = parseInt(get('level', '1')) || 1;
    const totalPower = parsePowerFromImport(get('totalPower', '0'));
    const cooldownMin = parseFloat(get('cooldownMin', '5')) || 5;
    const wallMin = parseFloat(get('wallMin', '30')) || 30;
    const capRaw = String(get('isCapital', '')).toLowerCase().trim();
    const isCapital = TRUTHY_SET.has(capRaw);

    let memberCount = 0;
    let totalTeams = 0;
    let tierCounts = null;

    if(hasTierFields){
      const t1 = tierIdx.tier1 >= 0 ? (parseFloat(r[tierIdx.tier1]) || 0) : 0;
      const t2 = tierIdx.tier2 >= 0 ? (parseFloat(r[tierIdx.tier2]) || 0) : 0;
      const t3 = tierIdx.tier3 >= 0 ? (parseFloat(r[tierIdx.tier3]) || 0) : 0;
      const t4 = tierIdx.tier4 >= 0 ? (parseFloat(r[tierIdx.tier4]) || 0) : 0;
      tierCounts = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };
      const calc = calcTeamsFromTiers(tierCounts);
      memberCount = calc.totalMembers;
      totalTeams = calc.totalTeams;
    } else {
      memberCount = parseFloat(get('memberCount', '0')) || 0;
      totalTeams = parseFloat(get('totalTeams', '0')) || 0;
    }

    if(totalTeams < 0){ errors.push(`第 ${i+1} 列「${name}」總隊數不可為負數，略過`); continue; }

    neededZones.add(zoneName);
    if(allianceName){
      const aSide = (side === 'self' || side === 'ally') ? side : 'enemy';
      neededAlliances.set(allianceName, aSide);
    }

    cities.push({
      name: cleanName,   /* ★ 改用拆分後的乾淨名稱 */
      code,
      zoneName, allianceName, side,
      level, memberCount, totalPower, totalTeams,
      cooldownMin, wallMin, isCapital,
      tierCounts,
      _usedTiers: hasTierFields,
    });
  }
  return { cities, errors, neededZones: [...neededZones], neededAlliances: [...neededAlliances.entries()], hasTierFields };
}

function parseRoutesTable(rows){
  if(!rows || rows.length < 2) return { routes: [], errors: ['宣戰表至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(ROUTE_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
  if(idx.src < 0 || idx.tgt < 0) return { routes: [], errors: ['宣戰表缺少「出兵城」或「目標城」欄位'] };

  const routes = [];
  const errors = [];
  const TYPE_MAP = {
    '攻':'attack','進攻':'attack','attack':'attack','a':'attack','攻擊':'attack',
    '防':'assist','防守':'assist','協防':'assist','defend':'assist','d':'assist','assist':'assist','守':'assist',
  };
  for(let i = 1; i < rows.length; i++){
    const r = rows[i];
    const src = String(r[idx.src]||'').trim();
    const tgt = String(r[idx.tgt]||'').trim();
    if(!src || !tgt){ errors.push(`第 ${i+1} 列缺少出兵城或目標城，略過`); continue; }
    const typeRaw = idx.type >= 0 ? String(r[idx.type]||'').trim().toLowerCase() : 'attack';
    const type = TYPE_MAP[typeRaw] || TYPE_MAP[typeRaw.charAt(0)] || 'attack';
    const getNum = (field, def) => {
      const j = idx[field];
      if(j < 0) return def;
      const v = parseFloat(String(r[j]||'').trim());
      return isNaN(v) ? def : v;
    };
    const pre = clamp(getNum('pre', 50), 0, 100);
    const post = idx.post >= 0 ? clamp(getNum('post', pre), 0, 100) : pre;
    const priority = idx.priority >= 0 ? Math.floor(getNum('priority', 1)) : 1;
    let attackStartTime = '';
    if(idx.attackStartTime >= 0){
      attackStartTime = normalizeTimeString(String(r[idx.attackStartTime] || '').trim());
    }
    if(type === 'attack' && !attackStartTime) attackStartTime = '19:00';
    if(type === 'assist') attackStartTime = '';
    routes.push({
      srcName: src, tgtName: tgt, isAttack: type === 'attack',
      preWarPercent: pre, postRevivePercent: post,
      priority: Math.max(1, priority),
      attackStartTime,
    });
  }
  return { routes, errors };
}

function parseMapRoutesTable(text){
  if(!text) return { routes: [], errors: [] };
  const lines = String(text).split(/\r?\n/);
  const routes = [];
  const errors = [];
  for(let i = 0; i < lines.length; i++){
    const raw = lines[i].trim();
    if(!raw) continue;
    let cityA = '', cityB = '';
    if(raw.includes('-')){
      const parts = raw.split('-').map(s => s.trim()).filter(Boolean);
      if(parts.length >= 2){ cityA = parts[0]; cityB = parts[1]; }
    } else if(raw.includes(',') || raw.includes('\t')){
      const parts = raw.split(/[,\t]/).map(s => s.trim()).filter(Boolean);
      if(parts.length >= 2){ cityA = parts[0]; cityB = parts[1]; }
    }
    if(!cityA || !cityB){ errors.push(`第 ${i+1} 行格式錯誤：${raw}`); continue; }
    if(cityA === cityB){ errors.push(`第 ${i+1} 行兩城相同：${raw}`); continue; }
    routes.push({ cityAName: cityA, cityBName: cityB });
  }
  return { routes, errors };
}

/* ====== 中場休息：第 1/2 段結束 ====== */
/* ============================================================
   Excel 匯入 UI
   ============================================================ */
function updateExcelPreview(){
  const preview = document.getElementById('excelPreview');
  if(!preview) return;
  const citiesText = document.getElementById('excelCitiesText')?.value.trim() || '';
  const routesText = document.getElementById('excelRoutesText')?.value.trim() || '';
  const alliancesText = document.getElementById('excelAlliancesText')?.value.trim() || '';
  const mapRoutesText = document.getElementById('excelMapRoutesText')?.value.trim() || '';

  const citiesStatus = document.getElementById('excelCitiesStatus');
  const routesStatus = document.getElementById('excelRoutesStatus');
  const alliancesStatus = document.getElementById('excelAlliancesStatus');
  const mapRoutesStatus = document.getElementById('excelMapRoutesStatus');

  if(!citiesText && !routesText && !alliancesText && !mapRoutesText){
    preview.className = 'excel-preview';
    preview.innerHTML = '<span class="text-dim">請在任一區塊填入資料</span>';
    if(citiesStatus) citiesStatus.textContent = '尚未填入';
    if(routesStatus) routesStatus.textContent = '尚未填入';
    if(alliancesStatus) alliancesStatus.textContent = '尚未填入';
    if(mapRoutesStatus) mapRoutesStatus.textContent = '尚未填入';
    return;
  }

  preview.className = 'excel-preview has-data';
  let html = '';

  if(alliancesText){
    const rows = parseDelimited(alliancesText);
    const result = parseAlliancesTable(rows);
    const n = result.alliances.length;
    if(n > 0){
      html += `<div><span class="ok">✅ 盟名單：${n} 個</span>`;
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(alliancesStatus) alliancesStatus.textContent = `${n} 個`;
    } else {
      html += `<div><span class="err">❌ 盟名單：解析失敗</span></div>`;
      if(result.errors.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      if(alliancesStatus) alliancesStatus.textContent = '解析失敗';
    }
  } else {
    if(alliancesStatus) alliancesStatus.textContent = '（未填）';
  }

  if(citiesText){
    const rows = parseDelimited(citiesText);
    const result = parseCitiesTable(rows);
    const n = result.cities.length;
    if(n > 0){
      html += `<div><span class="ok">✅ 城池表：${n} 座</span>`;
      if(result.hasTierFields) html += ` <span class="ok">（分級模式）</span>`;
      const withCode = result.cities.filter(c => c.code).length;
      if(withCode > 0) html += ` <span class="ok">（含編號 ${withCode}）</span>`;
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(result.neededZones.length > 0){
        const newZones = result.neededZones.filter(z => !state.zones.some(x => x.name === z));
        if(newZones.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">將自動新增戰區：${esc(newZones.join('、'))}</div>`;
      }
      if(result.neededAlliances.length > 0){
        const newAlliances = result.neededAlliances.filter(([name]) => !getAllianceByName(name) && name !== NPC_ALLIANCE_NAME);
        if(newAlliances.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">將自動新增同盟：${newAlliances.map(([n]) => esc(n)).join('、')}</div>`;
      }
      if(citiesStatus) citiesStatus.textContent = `${n} 座`;
    } else {
      html += `<div><span class="err">❌ 城池表：解析失敗</span></div>`;
      if(result.errors.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      if(citiesStatus) citiesStatus.textContent = '解析失敗';
    }
  } else {
    if(citiesStatus) citiesStatus.textContent = '（未填）';
  }

  if(mapRoutesText){
    const result = parseMapRoutesTable(mapRoutesText);
    const n = result.routes.length;
    if(n > 0){
      html += `<div><span class="ok">✅ 地圖路線：${n} 條</span>`;
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(mapRoutesStatus) mapRoutesStatus.textContent = `${n} 條`;
    } else {
      html += `<div><span class="err">❌ 地圖路線：解析失敗</span></div>`;
      if(result.errors.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      if(mapRoutesStatus) mapRoutesStatus.textContent = '解析失敗';
    }
  } else {
    if(mapRoutesStatus) mapRoutesStatus.textContent = '（未填）';
  }

  if(routesText){
    const rows = parseDelimited(routesText);
    const result = parseRoutesTable(rows);
    const n = result.routes.length;
    if(n > 0){
      html += `<div><span class="ok">✅ 宣戰表：${n} 條</span>`;
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(routesStatus) routesStatus.textContent = `${n} 條`;
    } else {
      html += `<div><span class="err">❌ 宣戰表：解析失敗</span></div>`;
      if(result.errors.length > 0) html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      if(routesStatus) routesStatus.textContent = '解析失敗';
    }
  } else {
    if(routesStatus) routesStatus.textContent = '（未填）';
  }

  preview.innerHTML = html;
}

function openExcelImportModal(){
  const ids = ['excelAlliancesText','excelCitiesText','excelMapRoutesText','excelRoutesText'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  ['excelAlliancesMode','excelCitiesMode','excelMapRoutesMode','excelRoutesMode'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.value = 'merge';
  });
  updateExcelPreview();
  const modal = document.getElementById('excelImportModal');
  if(modal) modal.classList.add('show');
}
function closeExcelImportModal(){
  const modal = document.getElementById('excelImportModal');
  if(modal) modal.classList.remove('show');
}

/* ============================================================
   ① 匯入盟名單
   ============================================================ */
function doImportAlliances(){
  const text = document.getElementById('excelAlliancesText')?.value.trim() || '';
  if(!text){ alert('請填入盟名單'); return; }
  const rows = parseDelimited(text);
  const result = parseAlliancesTable(rows);
  if(result.alliances.length === 0){ alert('❌ 盟名單解析失敗：\n' + result.errors.slice(0,5).join('\n')); return; }

  const mode = getImportMode('excelAlliancesMode');
  if(!confirmImport(mode, result.alliances.length, '盟')) return;

  const sorted = [...result.alliances].sort((a, b) => (a.order || 0) - (b.order || 0));
  let added = 0, updated = 0, skipped = 0;

  if(mode === 'overwrite'){
    state.alliances.length = 0;
    sorted.forEach((a, i) => {
      const id = uid();
      const entity = {
        id, name: a.name, icon: a.icon, side: a.side,
        memberCount: a.memberCount, totalPower: a.totalPower,
        avgPower: a.memberCount > 0 ? (a.totalPower / a.memberCount) : 0,
        power: a.totalPower, order: i, createdAt: Date.now() + i,
      };
      state.alliances.push(entity);
      state.entityRev.alliance[id] = (state.entityRev.alliance[id] || 0) + 1;
      markDirty('alliance', id);
      added++;
    });
  } else {
    const nameMap = new Map();
    for(const a of state.alliances) nameMap.set(a.name, a);
    sorted.forEach((a, i) => {
      const existing = nameMap.get(a.name);
      if(existing){
        if(mode === 'append'){ skipped++; return; }
        existing.icon = a.icon || existing.icon;
        existing.side = a.side;
        existing.memberCount = a.memberCount;
        existing.totalPower = a.totalPower;
        existing.avgPower = a.memberCount > 0 ? (a.totalPower / a.memberCount) : 0;
        existing.power = a.totalPower;
        if(typeof existing.order !== 'number') existing.order = a.order;
        state.entityRev.alliance[existing.id] = (state.entityRev.alliance[existing.id] || 0) + 1;
        markDirty('alliance', existing.id);
        updated++;
      } else {
        const id = uid();
        const maxOrder = state.alliances.reduce((m, al) =>
          Math.max(m, typeof al.order === 'number' ? al.order : -1), -1);
        const entity = {
          id, name: a.name, icon: a.icon, side: a.side,
          memberCount: a.memberCount, totalPower: a.totalPower,
          avgPower: a.memberCount > 0 ? (a.totalPower / a.memberCount) : 0,
          power: a.totalPower, order: maxOrder + 1 + i, createdAt: Date.now() + i,
        };
        state.alliances.push(entity);
        nameMap.set(a.name, entity);
        state.entityRev.alliance[id] = (state.entityRev.alliance[id] || 0) + 1;
        markDirty('alliance', id);
        added++;
      }
    });
  }

  tickLamport(); flushPatches(); saveStateImportant();
  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.renderMatrix) window.SLG.renderMatrix();
  if(window.SLG.renderOverview) window.SLG.renderOverview();

  const summary = mode === 'overwrite'
    ? `已覆蓋：${added} 個盟`
    : (mode === 'append'
        ? `新增完成：新增 ${added}${skipped > 0 ? `，跳過 ${skipped}` : ''}`
        : `合併完成：新增 ${added}，更新 ${updated}`);
  alert(`✅ ${summary}`);
  logSystem(`📥 盟名單匯入完成（${IMPORT_MODE_LABELS[mode]}）：${summary}`);
}

/* ============================================================
   v8.8.0：匯入後自動觸發地圖節點匹配
   ============================================================ */
/**
 * 嘗試把系統城池與當前地圖節點自動匹配
 * - 精確（編號 / 名稱 / 正規化）→ 自動套用
 * - 模糊多候選 → 交給 UI 彈 Modal 讓使用者選
 * - 完全無候選 → 列入 unmatched
 * @param {Array} cities - 匯入的城池（含 code）
 * @returns {Object} { matched, fuzzyAuto, needChoice:[{cityId, cityName, candidates}], unmatched:[{cityId, cityName}] }
 */
function tryAutoMatchCitiesToMap(cities){
  const result = {
    matched: 0,
    fuzzyAuto: 0,
    needChoice: [],
    unmatched: [],
    skipped: 0,
  };

  /* 若無啟用中的地圖，跳過 */
  const activeMap = getActiveMap ? getActiveMap() : null;
  if(!activeMap || !activeMap.nodes || Object.keys(activeMap.nodes).length === 0){
    result.skipped = cities.length;
    return result;
  }

  const nodes = activeMap.nodes;

  for(const city of cities){
    const r = matchCityToMapNode({ name: city.name, code: city.code || '' }, nodes);
    if(r.autoAccepted && r.node){
      /* 精確 / 正規化 / 模糊自動 → 寫入 city.mapNode */
      city.mapNode = {
        nodeId: r.nodeId,
        x: r.node.x,
        y: r.node.y,
        method: r.method,
      };
      if(r.method === 'fuzzy-auto') result.fuzzyAuto++;
      else result.matched++;
    } else if(r.needsUserChoice && r.candidates && r.candidates.length > 0){
      result.needChoice.push({
        cityId: city.id,
        cityName: city.name,
        cityCode: city.code || '',
        candidates: r.candidates,
      });
    } else {
      result.unmatched.push({ cityId: city.id, cityName: city.name, cityCode: city.code || '' });
    }
  }

  return result;
}

/**
 * 在城池陣列中，依 mapNode 資訊寫入地圖節點對應（存回 entity）
 */
function applyMapNodeToCity(city, nodeId, x, y, method){
  if(!city) return;
  city.mapNode = { nodeId, x, y, method: method || 'manual' };
  state.entityRev.city[city.id] = (state.entityRev.city[city.id] || 0) + 1;
  markDirty('city', city.id);
}

/* ============================================================
   ② 匯入城池表（v8.8.0：支援編號 + 地圖節點匹配）
   ============================================================ */
function doImportCities(){
  const text = document.getElementById('excelCitiesText')?.value.trim() || '';
  if(!text){ alert('請填入城池表'); return; }
  const rows = parseDelimited(text);
  const result = parseCitiesTable(rows);
  if(result.cities.length === 0){ alert('❌ 城池表解析失敗：\n' + result.errors.slice(0,5).join('\n')); return; }

  const mode = getImportMode('excelCitiesMode');
  if(!confirmImport(mode, result.cities.length, '城池')) return;

  const zoneMap = new Map();
  for(const z of state.zones) zoneMap.set(z.name, z.id);
  const ensureZone = (name) => {
    if(!name) name = '未分配';
    if(zoneMap.has(name)) return zoneMap.get(name);
    const id = uid();
    state.zones.push({ id, name });
    state.entityRev.zone[id] = (state.entityRev.zone[id] || 0) + 1;
    markDirty('zone', id);
    zoneMap.set(name, id);
    return id;
  };

  const allianceByName = new Map();
  for(const a of state.alliances) allianceByName.set(a.name, a.id);

  let added = 0, updated = 0, skipped = 0;

  if(mode === 'overwrite'){
    const oldIds = state.cities.map(c => c.id);
    state.cities.length = 0;
    for(const id of oldIds){
      state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
      markDirty('cityDeleted', id);
    }
  }

  const cityByName = new Map();
  if(mode !== 'overwrite'){
    for(const c of state.cities) cityByName.set(c.name, c);
  }

  const preserveOld = !!state.troopTiers.preserveOldTotal;
  const autoCalc = !!state.troopTiers.autoCalcOnImport;

  /* v8.8.0：記錄本次匯入涉及的城池物件（用於地圖節點匹配） */
  const touchedCities = [];

  for(const cd of result.cities){
    const zoneId = ensureZone(cd.zoneName);
    let allianceId = '';
    let side = cd.side;
    if(cd.allianceName){
      const aid = allianceByName.get(cd.allianceName);
      if(aid){
        allianceId = aid;
        const a = state.alliances.find(x => x.id === aid);
        if(a && a.side) side = a.side;
      } else {
        const npc = ensureNpcAlliance();
        allianceId = npc.id;
        side = 'npc';
      }
    } else {
      const npc = ensureNpcAlliance();
      allianceId = npc.id;
      side = 'npc';
    }

    const avgPower = cd.totalTeams > 0 ? Math.floor(cd.totalPower / cd.totalTeams) : 0;
    const existing = (mode !== 'overwrite') ? cityByName.get(cd.name) : null;

    let finalMemberCount = cd.memberCount;
    let finalTotalTeams = cd.totalTeams;

    if(preserveOld && existing && existing.totalTeams > 0 && cd._usedTiers && autoCalc){
      finalTotalTeams = existing.totalTeams;
      finalMemberCount = existing.memberCount || cd.memberCount;
    }

    if(existing){
      if(mode === 'append'){ skipped++; continue; }
      existing.zoneId = zoneId;
      existing.allianceId = allianceId;
      existing.side = side;
      existing.level = cd.level;
      existing.memberCount = finalMemberCount;
      existing.totalPower = cd.totalPower;
      existing.totalTeams = finalTotalTeams;
      existing.avgPower = finalTotalTeams > 0 ? Math.floor(cd.totalPower / finalTotalTeams) : 0;
      existing.cooldownMin = cd.cooldownMin;
      existing.wallMin = cd.wallMin;
      existing.isCapital = cd.isCapital;
      /* v8.8.0：儲存編號 */
      if(cd.code) existing.code = cd.code;
      if(cd.tierCounts) existing.tierCounts = cd.tierCounts;
      state.entityRev.city[existing.id] = (state.entityRev.city[existing.id] || 0) + 1;
      markDirty('city', existing.id);
      touchedCities.push(existing);
      updated++;
    } else {
      const id = uid();
      const entity = {
        id, name: cd.name, zoneId, allianceId, side,
        level: cd.level, memberCount: finalMemberCount,
        totalPower: cd.totalPower, totalTeams: finalTotalTeams,
        avgPower: finalTotalTeams > 0 ? Math.floor(cd.totalPower / finalTotalTeams) : 0,
        cooldownMin: cd.cooldownMin, wallMin: cd.wallMin,
        defStartTime: '19:00', isCapital: cd.isCapital,
        attackTargets: [], defendTargets: [],
      };
      /* v8.8.0：儲存編號 */
      if(cd.code) entity.code = cd.code;
      if(cd.tierCounts) entity.tierCounts = cd.tierCounts;
      state.cities.push(entity);
      cityByName.set(cd.name, entity);
      state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
      markDirty('city', id);
      touchedCities.push(entity);
      added++;
    }
  }

  tickLamport(); flushPatches(); saveStateImportant();
  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();
  if(window.SLG.renderCityMatrix) window.SLG.renderCityMatrix();
  if(window.SLG.renderOverview) window.SLG.renderOverview();

  const summary = mode === 'overwrite'
    ? `已覆蓋：${added} 座城池`
    : (mode === 'append'
        ? `新增完成：新增 ${added}${skipped > 0 ? `，跳過 ${skipped}` : ''}`
        : `合併完成：新增 ${added}，更新 ${updated}（宣戰關係已保留）`);

  let msg = `✅ ${summary}`;
  if(result.hasTierFields) msg += '\n\n📊 已使用分級欄位自動計算總隊數';

  /* v8.8.0：自動觸發地圖節點匹配 */
  const matchResult = tryAutoMatchCitiesToMap(touchedCities);
  if(matchResult.skipped === touchedCities.length && touchedCities.length > 0){
    msg += '\n\n🗺️ 未設定使用中的地圖，跳過節點匹配。';
  } else if(matchResult.matched > 0 || matchResult.fuzzyAuto > 0 || matchResult.needChoice.length > 0 || matchResult.unmatched.length > 0){
    const parts = [];
    if(matchResult.matched > 0) parts.push(`✅ 精確匹配 ${matchResult.matched}`);
    if(matchResult.fuzzyAuto > 0) parts.push(`🔍 模糊自動 ${matchResult.fuzzyAuto}`);
    if(matchResult.needChoice.length > 0) parts.push(`❓ 待確認 ${matchResult.needChoice.length}`);
    if(matchResult.unmatched.length > 0) parts.push(`⚠️ 未匹配 ${matchResult.unmatched.length}`);
    msg += '\n\n🗺️ 地圖節點匹配：' + parts.join(' · ');

    if(matchResult.needChoice.length > 0 || matchResult.unmatched.length > 0){
      msg += '\n（將開啟匹配確認視窗）';
    }
  }

  alert(msg);
  logSystem(`📥 城池表匯入完成（${IMPORT_MODE_LABELS[mode]}）：${summary}`);

  /* 保存結果供後續 UI 處理 */
  if(window.SLG.onCityImportMatched){
    try{
      window.SLG.onCityImportMatched({
        touchedCities,
        matchResult,
        mode,
      });
    }catch(e){ console.warn('[匯入] 節點匹配後處理失敗', e); }
  }
}

/* ============================================================
   ③ 匯入地圖路線表
   ============================================================ */
function doImportMapRoutes(){
  const text = document.getElementById('excelMapRoutesText')?.value.trim() || '';
  if(!text){ alert('請填入地圖路線表'); return; }
  const result = parseMapRoutesTable(text);
  if(result.routes.length === 0){ alert('❌ 地圖路線解析失敗：\n' + result.errors.slice(0,5).join('\n')); return; }

  const mode = getImportMode('excelMapRoutesMode');
  if(!confirmImport(mode, result.routes.length, '地圖路線')) return;

  const cityByName = new Map();
  for(const c of state.cities) cityByName.set(c.name, c.id);

  let added = 0, skipped = 0, notFound = 0;
  if(mode === 'overwrite') state.routes.length = 0;

  for(const r of result.routes){
    const aId = cityByName.get(r.cityAName);
    const bId = cityByName.get(r.cityBName);
    if(!aId || !bId){ notFound++; continue; }
    if(aId === bId){ skipped++; continue; }
    if(findRoute(aId, bId)){ skipped++; continue; }
    addRoute(aId, bId);
    added++;
  }

  saveStateImportant();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();
  if(window.SLG.renderOverview) window.SLG.renderOverview();

  const summary = mode === 'overwrite'
    ? `已覆蓋：${added} 條`
    : `新增完成：新增 ${added}${skipped > 0 ? `，跳過 ${skipped}` : ''}${notFound > 0 ? `，找不到城池 ${notFound}` : ''}`;
  alert(`✅ ${summary}`);
  logSystem(`📥 地圖路線匯入完成（${IMPORT_MODE_LABELS[mode]}）：${summary}`);
}

/* ============================================================
   ④ 匯入宣戰表
   ============================================================ */
function doImportRoutes(){
  const text = document.getElementById('excelRoutesText')?.value.trim() || '';
  if(!text){ alert('請填入宣戰表'); return; }
  const rows = parseDelimited(text);
  const result = parseRoutesTable(rows);
  if(result.routes.length === 0){ alert('❌ 宣戰表解析失敗：\n' + result.errors.slice(0,5).join('\n')); return; }

  const mode = getImportMode('excelRoutesMode');
  if(!confirmImport(mode, result.routes.length, '宣戰指示')) return;

  if(mode === 'overwrite'){
    for(const c of state.cities){
      c.attackTargets = [];
      c.defendTargets = [];
      state.entityRev.city[c.id] = (state.entityRev.city[c.id] || 0) + 1;
      markDirty('city', c.id);
    }
  }

  const cityByName = new Map();
  for(const c of state.cities) cityByName.set(c.name, c.id);

  const allowCrossZone = !!state.settings.crossZoneWarAllowed;

  let added = 0, updated = 0, skipped = 0, crossZoneSkipped = 0, notFound = 0;
  const crossZoneList = [];

  for(const route of result.routes){
    const srcCityId = cityByName.get(route.srcName);
    const tgtCityId = cityByName.get(route.tgtName);
    if(!srcCityId || !tgtCityId){ notFound++; continue; }
    const srcCity = state.cities.find(c => c.id === srcCityId);
    const tgtCity = state.cities.find(c => c.id === tgtCityId);
    if(!srcCity || !tgtCity){ notFound++; continue; }

    if(!allowCrossZone){
      const srcZone = srcCity.zoneId || '';
      const tgtZone = tgtCity.zoneId || '';
      if(srcZone !== tgtZone){
        crossZoneSkipped++;
        const srcZoneName = state.zones.find(z => z.id === srcZone)?.name || '未分配';
        const tgtZoneName = state.zones.find(z => z.id === tgtZone)?.name || '未分配';
        crossZoneList.push(`${srcCity.name}(${srcZoneName}) → ${tgtCity.name}(${tgtZoneName})`);
        continue;
      }
    }

    const arr = route.isAttack ? 'attackTargets' : 'defendTargets';
    if(!srcCity[arr]) srcCity[arr] = [];
    const existingIdx = srcCity[arr].findIndex(t => t.cityId === tgtCityId);

    if(existingIdx >= 0){
      if(mode === 'append'){ skipped++; continue; }
      const existing = srcCity[arr][existingIdx];
      existing.preWarPercent = route.preWarPercent;
      existing.postRevivePercent = route.postRevivePercent;
      existing.priority = route.priority;
      existing.attackStartTime = route.isAttack ? (route.attackStartTime || '19:00') : '';
      state.entityRev.city[srcCityId] = (state.entityRev.city[srcCityId] || 0) + 1;
      markDirty('city', srcCityId);
      updated++;
    } else {
      srcCity[arr].push({
        cityId: tgtCityId,
        preWarPercent: route.preWarPercent,
        postRevivePercent: route.postRevivePercent,
        priority: route.priority,
        attackStartTime: route.isAttack ? (route.attackStartTime || '19:00') : '',
      });
      state.entityRev.city[srcCityId] = (state.entityRev.city[srcCityId] || 0) + 1;
      markDirty('city', srcCityId);
      added++;
    }
  }

  if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);

  tickLamport(); flushPatches(); saveStateImportant();
  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();

  let summary;
  if(mode === 'overwrite') summary = `已覆蓋：${added} 條`;
  else if(mode === 'append') summary = `新增完成：新增 ${added}${skipped > 0 ? `，跳過 ${skipped}` : ''}`;
  else summary = `合併完成：新增 ${added}，更新 ${updated}`;
  if(notFound > 0) summary += `，找不到城池 ${notFound}`;

  let msg = `✅ ${summary}`;
  if(crossZoneSkipped > 0){
    msg += `\n\n⚠️ 跨戰區限制：略過 ${crossZoneSkipped} 條`;
    msg += `\n${crossZoneList.slice(0, 8).join('\n')}`;
    if(crossZoneList.length > 8) msg += `\n…及其他 ${crossZoneList.length - 8} 條`;
    msg += `\n\n（可至 ⚙️ 參數設定 → 🎯 宣戰規則 → 勾選「允許跨戰區宣戰」）`;
  }
  alert(msg);
  logSystem(`📥 宣戰表匯入完成（${IMPORT_MODE_LABELS[mode]}）：${summary}`);
}

/* ============================================================
   下載 CSV
   ============================================================ */
function downloadCSV(csv, filename){
  const blob = new Blob(['\uFEFF' + csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* v8.8.0：匯出城池表（含編號 + 分級欄位） */
function exportCitiesCSV(){
  if(state.cities.length === 0){ alert('目前沒有任何城池'); return; }
  const headers = ['城池名稱','城池編號','戰區','同盟','陣營','等級','人≤17','人18-20','人21-24','人≥25','總戰力（億）','均戰（萬）','總隊數','冷卻','城牆','首都'];
  const rows = state.cities.map(c => {
    const zone = state.zones.find(z => z.id === c.zoneId);
    const alliance = state.alliances.find(a => a.id === c.allianceId);
    const avgPower = c.totalTeams > 0 ? Math.floor((Number(c.totalPower) || 0) / c.totalTeams) : 0;
    const tc = c.tierCounts || { tier1:'', tier2:'', tier3:'', tier4:'' };
    return [
      c.name, c.code || '', zone ? zone.name : '', alliance ? alliance.name : '',
      SIDE_LABELS[c.side] || c.side,
      c.level || 1,
      tc.tier1 !== undefined && c.tierCounts ? tc.tier1 : '',
      tc.tier2 !== undefined && c.tierCounts ? tc.tier2 : '',
      tc.tier3 !== undefined && c.tierCounts ? tc.tier3 : '',
      tc.tier4 !== undefined && c.tierCounts ? tc.tier4 : '',
      powerToYiStr(c.totalPower), powerToWanStr(avgPower),
      c.totalTeams || '', c.cooldownMin, c.wallMin,
      c.isCapital ? '是' : '',
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `城池表_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem('📤 已匯出城池表 CSV');
}

function exportAlliancesCSV(){
  if(state.alliances.length === 0){ alert('目前沒有任何盟'); return; }
  const headers = ['順序','盟名稱','盟徽','人數','總戰力（億）','平均戰力（萬）','陣營'];
  const sorted = getAlliancesSorted ? getAlliancesSorted() : [...state.alliances];
  const rows = sorted.map((a, i) => {
    const avgPower = a.memberCount > 0 ? (Number(a.totalPower) || 0) / a.memberCount : 0;
    return [i, a.name, a.icon || '', a.memberCount || 0, powerToYiStr(a.totalPower), powerToWanStr(avgPower), SIDE_LABELS[a.side] || a.side];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `盟名單_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem('📤 已匯出盟名單 CSV');
}

function exportMapRoutesCSV(){
  if(state.routes.length === 0){ alert('目前沒有任何地圖路線'); return; }
  const cityById = new Map(state.cities.map(c => [c.id, c]));
  const rows = state.routes.map(r => {
    const a = cityById.get(r.cityAId);
    const b = cityById.get(r.cityBId);
    if(!a || !b) return null;
    return [a.name, b.name];
  }).filter(Boolean);
  const csv = ['城池A,城池B', ...rows.map(r => r.join(','))].join('\n');
  downloadCSV(csv, `地圖路線_${new Date().toISOString().slice(0,10)}.csv`);
}

function exportRoutesCSV(){
  const headers = ['出兵城','目標城','類型','戰前%','復活%','順序','開始時間'];
  const rows = [];
  const cityById = new Map(state.cities.map(c => [c.id, c]));
  for(const src of state.cities){
    for(const t of (src.attackTargets || [])){
      if(!t.cityId) continue;
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '進攻', t.preWarPercent, t.postRevivePercent, t.priority, t.attackStartTime || '19:00']);
    }
    for(const t of (src.defendTargets || [])){
      if(!t.cityId) continue;
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '協防', t.preWarPercent, t.postRevivePercent, t.priority, '']);
    }
  }
  if(rows.length === 0){ alert('目前沒有任何宣戰指示'); return; }
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `宣戰表_${new Date().toISOString().slice(0,10)}.csv`);
}

function downloadExcelTemplate(){
  const template = `【v8.8.0：城池表欄位說明】
城池表支援兩種格式 + 編號欄位：

【格式 A - 分級模式（推薦）】
城池名稱,城池編號,戰區,同盟,陣營,等級,人≤17,人18-20,人21-24,人≥25,總戰力（億）,冷卻,城牆,首都
南秦,L98,南中,帝盟,敵方,10,50,30,20,10,10.00,5,30,是
句町,L75,南中,秦盟,敵方,9,40,20,10,5,8.00,5,20,

■ 只需填各級人數，系統自動算總隊數
■ 分級規則（可在參數設定自訂）：
  ・≤17 級：每人 3 隊
  ・18~20 級：每人 4 隊
  ・21~24 級：每人 5 隊
  ・≥25 級：每人 6 隊
■ 城池編號欄位別名：城池編號 / 編號 / 城編號 / 代碼 / code

【格式 B - 傳統模式（相容）】
城池名稱,城池編號,戰區,同盟,陣營,等級,人數,總戰力（億）,總隊數,冷卻,城牆,首都
南秦,L98,南中,帝盟,敵方,10,100,10.00,100,5,30,是

─────────────────────────────────────────────

【匯入模式說明】
🔄 合併 = 同名的更新、新的加入、其他保留（推薦）
➕ 新增 = 同名的跳過、新的加入、其他保留
💥 覆蓋 = 清空後重建

─────────────────────────────────────────────

【盟名單】
順序,盟名稱,盟徽,人數,總戰力（億）,陣營
0,帝盟,⚔️,100,2.00,敵方
■ 盟徽不可重複使用

─────────────────────────────────────────────

【地圖路線】
南秦-句町
■ 一行一條，用「-」分隔，無向圖

─────────────────────────────────────────────

【宣戰表】
出兵城,目標城,類型,戰前%,復活%,順序,開始時間
南秦,句町,進攻,50,50,1,19:00
南秦西,南秦,協防,30,30,1,
■ 開始時間 = 目標城防守開始時間
■ 協防的開始時間留空
■ 跨戰區預設略過

─────────────────────────────────────────────

【v8.8.0 地圖節點自動匹配】
匯入城池表後，若已設定使用中的地圖：
1. 系統優先以「城池編號」精確匹配
2. 次以「城池名稱」精確匹配
3. 再以「正規化名稱」匹配（去掉城/關/寨等後綴）
4. 最後以模糊比對（相似度 ≥ 0.5 列出候選讓你選）
5. 完全無匹配 → 列入未匹配清單
`;
  const blob = new Blob(['\uFEFF' + template], {type:'text/plain;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Excel匯入說明.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  parseDelimited, normalizeHeader, findFieldIndex,
  normalizeTimeString,
  parsePowerFromImport,
  powerToYiStr, powerToWanStr,
  parseAlliancesTable, parseCitiesTable, parseRoutesTable, parseMapRoutesTable,
  updateExcelPreview,
  openExcelImportModal, closeExcelImportModal,
  doImportAlliances, doImportCities, doImportMapRoutes, doImportRoutes,
  downloadCSV,
  exportCitiesCSV, exportAlliancesCSV, exportMapRoutesCSV, exportRoutesCSV,
  downloadExcelTemplate,
  getImportMode, confirmImport,
  IMPORT_MODE_LABELS, IMPORT_MODE_HINTS,
  TIER_FIELD_ALIASES,

  /* v8.8.0：地圖節點匹配 */
  tryAutoMatchCitiesToMap,
  applyMapNodeToCity,
});

})();
