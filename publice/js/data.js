/* ============================================================================
 * data.js — Excel/CSV 匯入匯出（v8.5）
 * v8.5：盟名單 / 地圖路線 / 城池等級 / 手動選擇匯入
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
  saveState,
  getAllianceByName,
  ensureNpcAlliance,
  NPC_ALLIANCE_NAME,
  NPC_ALLIANCE_ICON,
  findRoute,
  addRoute,
} = window.SLG;

/* ============================================================
   通用：解析分隔符文字（自動偵測逗號或 Tab）
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
      } else {
        field += c;
      }
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
   欄位別名（v8.5：加入 level / allianceName）
   ============================================================ */
const ALLIANCE_FIELD_ALIASES = {
  name:        ['盟名稱','同盟名稱','名稱','盟名','name','alliancename'],
  icon:        ['盟徽','icon','徽章'],
  memberCount: ['人數','成員數','總人數','membercount','members'],
  totalPower:  ['總戰力','戰力','totalpower','power'],
  side:        ['陣營','side','faction'],
};

const CITY_FIELD_ALIASES = {
  name:        ['城池名稱','城池','城名','名稱','name','cityname','city'],
  zone:        ['戰區','分區','區域','zone','zoneid','region'],
  alliance:    ['同盟','盟','盟名稱','盟名','alliancename','alliance'],
  side:        ['陣營','陣營關係','side','faction'],
  level:       ['等級','level','lv','級別'],
  memberCount: ['人數','成員數','總人數','membercount','members','member'],
  totalPower:  ['總戰力','戰力','totalpower','power'],
  totalTeams:  ['總隊數','隊數','兵力','隊伍數','totalteams','teams'],
  cooldownMin: ['冷卻','冷卻分鐘','冷卻復活','冷卻(分)','cooldownmin','cooldown'],
  wallMin:     ['城牆','城牆耐久','城牆分鐘','城牆(分)','wallmin','wall'],
  defStartTime:['防守開始','防守開始時間','開始時間','防守時間','defstarttime','defstart'],
  isCapital:   ['首都','盟首都','主城','iscapital','capital'],
};

const ROUTE_FIELD_ALIASES = {
  src:      ['出兵城','進攻城','來源城','出兵','src','srccity','from'],
  tgt:      ['目標城','目標','tgt','tgtcity','to'],
  type:     ['類型','行動','type','action'],
  pre:      ['戰前%','戰前','戰前派兵%','pre','prewar','prewarpercent'],
  post:     ['復活%','復活','復活後派兵%','post','postrevive','postrevivepercent'],
  priority: ['順序','優先順序','優先','priority','pr'],
};

const MAP_ROUTE_FIELD_ALIASES = {
  cityA: ['城池a','城池A','城a','城A','citya','citya','城池1','城1'],
  cityB: ['城池b','城池B','城b','城B','cityb','cityb','城池2','城2'],
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
    const totalPower = parseFloat(get('totalPower', '20000')) || 20000;
    const sideRaw = get('side', '敵方');
    const sideNorm = normalizeHeader(sideRaw);
    const side = SIDE_PARSE_MAP[sideRaw] || SIDE_PARSE_MAP[sideNorm] || 'enemy';

    alliances.push({
      name,
      icon: icon || NPC_ALLIANCE_ICON,
      memberCount,
      totalPower,
      side,
    });
  }

  return { alliances, errors };
}

/* ============================================================
   解析：城池表（v8.5：加入 level、盟名稱查找）
   ============================================================ */
function parseCitiesTable(rows){
  if(!rows || rows.length < 2) return { cities: [], errors: ['城池表至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(CITY_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
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

    const zoneName = get('zone', '未分配');
    const allianceName = get('alliance', '');
    const sideRaw = get('side', '本方');
    const sideNorm = normalizeHeader(sideRaw);
    const side = SIDE_PARSE_MAP[sideRaw] || SIDE_PARSE_MAP[sideNorm] || 'self';

    const level = parseInt(get('level', '1')) || 1;
    const memberCount = parseFloat(get('memberCount', '0')) || 0;
    const totalPower = parseFloat(get('totalPower', '0')) || 0;
    const totalTeams = parseFloat(get('totalTeams', '0')) || 0;
    const cooldownMin = parseFloat(get('cooldownMin', '5')) || 5;
    const wallMin = parseFloat(get('wallMin', '30')) || 30;
    const defStartTime = get('defStartTime', '19:00');
    const capRaw = String(get('isCapital', '')).toLowerCase().trim();
    const isCapital = TRUTHY_SET.has(capRaw);

    if(totalTeams < 0){
      errors.push(`第 ${i+1} 列「${name}」總隊數不可為負數，略過`);
      continue;
    }

    neededZones.add(zoneName);
    if(allianceName){
      const aSide = (side === 'self' || side === 'ally') ? side : 'enemy';
      neededAlliances.set(allianceName, aSide);
    }

    cities.push({
      name, zoneName, allianceName, side,
      level, memberCount, totalPower, totalTeams,
      cooldownMin, wallMin, defStartTime, isCapital,
    });
  }

  return {
    cities, errors,
    neededZones: [...neededZones],
    neededAlliances: [...neededAlliances.entries()]
  };
}

/* ============================================================
   解析：宣戰路線表（沿用現有）
   ============================================================ */
function parseRoutesTable(rows){
  if(!rows || rows.length < 2) return { routes: [], errors: ['宣戰表至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(ROUTE_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
  if(idx.src < 0 || idx.tgt < 0){
    return { routes: [], errors: ['宣戰表缺少「出兵城」或「目標城」欄位'] };
  }

  const routes = [];
  const errors = [];
  const TYPE_MAP = {
    '攻':'attack','進攻':'attack','attack':'attack','a':'attack','攻擊':'attack',
    '防':'defend','防守':'defend','協防':'defend','defend':'defend','d':'defend','守':'defend',
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

    routes.push({
      srcName: src, tgtName: tgt, isAttack: type === 'attack',
      preWarPercent: pre, postRevivePercent: post,
      priority: Math.max(1, priority),
    });
  }

  return { routes, errors };
}

/* ============================================================
   解析：地圖路線表（v8.5 新增）
   格式 1：城池A-城池B（一行一條）
   格式 2：城池A,城池B（CSV）
   ============================================================ */
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

    if(!cityA || !cityB){
      errors.push(`第 ${i+1} 行格式錯誤：${raw}`);
      continue;
    }

    if(cityA === cityB){
      errors.push(`第 ${i+1} 行兩城相同：${raw}`);
      continue;
    }

    routes.push({ cityAName: cityA, cityBName: cityB });
  }

  return { routes, errors };
}

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
      if(result.errors.length > 0){
        html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      }
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
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(result.neededZones.length > 0){
        const newZones = result.neededZones.filter(z => !state.zones.some(x => x.name === z));
        if(newZones.length > 0){
          html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">將自動新增戰區：${esc(newZones.join('、'))}</div>`;
        }
      }
      if(result.neededAlliances.length > 0){
        const newAlliances = result.neededAlliances.filter(([name]) => !getAllianceByName(name) && name !== NPC_ALLIANCE_NAME);
        if(newAlliances.length > 0){
          html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">將自動新增同盟：${newAlliances.map(([n]) => esc(n)).join('、')}</div>`;
        }
      }
      if(citiesStatus) citiesStatus.textContent = `${n} 座`;
    } else {
      html += `<div><span class="err">❌ 城池表：解析失敗</span></div>`;
      if(result.errors.length > 0){
        html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      }
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
      if(result.errors.length > 0){
        html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      }
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
      if(result.errors.length > 0){
        html += `<div style="font-size:10px;color:var(--text-dim);margin-left:12px;">${esc(result.errors[0])}</div>`;
      }
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
  updateExcelPreview();
  const modal = document.getElementById('excelImportModal');
  if(modal) modal.classList.add('show');
}
function closeExcelImportModal(){
  const modal = document.getElementById('excelImportModal');
  if(modal) modal.classList.remove('show');
}

/* ============================================================
   v8.5：手動選擇匯入（4 個獨立按鈕）
   ============================================================ */

/* ① 匯入盟名單 */
function doImportAlliances(){
  const text = document.getElementById('excelAlliancesText')?.value.trim() || '';
  if(!text){ alert('請填入盟名單'); return; }

  const rows = parseDelimited(text);
  const result = parseAlliancesTable(rows);
  if(result.alliances.length === 0){
    alert('❌ 盟名單解析失敗：\n' + result.errors.slice(0,5).join('\n'));
    return;
  }

  const ok = confirm(
    `即將匯入 ${result.alliances.length} 個盟。\n\n` +
    `⚠️ 此操作會覆蓋現有沙盤的「所有盟」。\n\n` +
    `確定執行？`
  );
  if(!ok) return;

  // 清空現有盟
  state.alliances.length = 0;

  for(const a of result.alliances){
    const id = uid();
    const entity = {
      id,
      name: a.name,
      icon: a.icon,
      side: a.side,
      memberCount: a.memberCount,
      totalPower: a.totalPower,
      avgPower: a.memberCount > 0 ? (a.totalPower / a.memberCount) : 0,
      power: a.totalPower,
    };
    state.alliances.push(entity);
    state.entityRev.alliance[id] = (state.entityRev.alliance[id] || 0) + 1;
    markDirty('alliance', id);
  }

  tickLamport();
  flushPatches();
  saveState();

  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.CityManager) window.SLG.CityManager.render();

  alert(`✅ 已匯入 ${result.alliances.length} 個盟`);
  logSystem(`📥 盟名單匯入完成：${result.alliances.length} 個`);
}

/* ② 匯入城池表 */
function doImportCities(){
  const text = document.getElementById('excelCitiesText')?.value.trim() || '';
  if(!text){ alert('請填入城池表'); return; }

  const rows = parseDelimited(text);
  const result = parseCitiesTable(rows);
  if(result.cities.length === 0){
    alert('❌ 城池表解析失敗：\n' + result.errors.slice(0,5).join('\n'));
    return;
  }

  const ok = confirm(
    `即將匯入 ${result.cities.length} 座城池。\n\n` +
    `⚠️ 此操作會覆蓋現有沙盤的「所有城池」。\n\n` +
    `確定執行？`
  );
  if(!ok) return;

  // 清空現有城池
  const oldIds = state.cities.map(c => c.id);
  state.cities.length = 0;
  for(const id of oldIds){
    state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
    markDirty('cityDeleted', id);
  }

  // 建立 zone 對照
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

  // 建立盟對照（找不到 → NPC）
  const allianceByName = new Map();
  for(const a of state.alliances) allianceByName.set(a.name, a.id);

  for(const cd of result.cities){
    const zoneId = ensureZone(cd.zoneName);

    // 找盟（找不到 → NPC）
    let allianceId = '';
    let side = cd.side;
    if(cd.allianceName){
      const aid = allianceByName.get(cd.allianceName);
      if(aid){
        allianceId = aid;
        const a = state.alliances.find(x => x.id === aid);
        if(a && a.side) side = a.side;
      } else {
        // 找不到 → NPC
        const npc = ensureNpcAlliance();
        allianceId = npc.id;
        side = 'npc';
      }
    } else {
      // 未指定盟 → NPC
      const npc = ensureNpcAlliance();
      allianceId = npc.id;
      side = 'npc';
    }

    const avgPower = cd.totalTeams > 0 ? Math.floor(cd.totalPower / cd.totalTeams) : 0;
    const id = uid();
    const entity = {
      id,
      name: cd.name,
      zoneId,
      allianceId,
      side,
      level: cd.level,
      memberCount: cd.memberCount,
      totalPower: cd.totalPower,
      totalTeams: cd.totalTeams,
      avgPower,
      cooldownMin: cd.cooldownMin,
      wallMin: cd.wallMin,
      defStartTime: cd.defStartTime,
      isCapital: cd.isCapital,
      attackTargets: [],
      defendTargets: [],
    };
    state.cities.push(entity);
    state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
    markDirty('city', id);
  }

  tickLamport();
  flushPatches();
  saveState();

  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();

  alert(`✅ 已匯入 ${result.cities.length} 座城池`);
  logSystem(`📥 城池表匯入完成：${result.cities.length} 座`);
}

/* ③ 匯入地圖路線表 */
function doImportMapRoutes(){
  const text = document.getElementById('excelMapRoutesText')?.value.trim() || '';
  if(!text){ alert('請填入地圖路線表'); return; }

  const result = parseMapRoutesTable(text);
  if(result.routes.length === 0){
    alert('❌ 地圖路線解析失敗：\n' + result.errors.slice(0,5).join('\n'));
    return;
  }

  const ok = confirm(
    `即將匯入 ${result.routes.length} 條地圖路線。\n\n` +
    `⚠️ 此操作會覆蓋現有沙盤的「所有地圖路線」。\n\n` +
    `確定執行？`
  );
  if(!ok) return;

  // 建立城池名稱 → id 對照
  const cityByName = new Map();
  for(const c of state.cities) cityByName.set(c.name, c.id);

  // 清空現有路線
  state.routes.length = 0;

  let added = 0, skipped = 0;
  for(const r of result.routes){
    const aId = cityByName.get(r.cityAName);
    const bId = cityByName.get(r.cityBName);
    if(!aId || !bId){ skipped++; continue; }
    if(aId === bId){ skipped++; continue; }
    if(findRoute(aId, bId)){ skipped++; continue; }
    addRoute(aId, bId);
    added++;
  }

  saveState();

  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();

  alert(`✅ 已匯入 ${added} 條地圖路線${skipped > 0 ? `（${skipped} 條略過）` : ''}`);
  logSystem(`📥 地圖路線匯入完成：${added} 條`);
}

/* ④ 匯入宣戰表 */
function doImportRoutes(){
  const text = document.getElementById('excelRoutesText')?.value.trim() || '';
  if(!text){ alert('請填入宣戰表'); return; }

  const rows = parseDelimited(text);
  const result = parseRoutesTable(rows);
  if(result.routes.length === 0){
    alert('❌ 宣戰表解析失敗：\n' + result.errors.slice(0,5).join('\n'));
    return;
  }

  const ok = confirm(
    `即將匯入 ${result.routes.length} 條宣戰指示。\n\n` +
    `⚠️ 此操作會覆蓋現有沙場的「所有宣戰指示」。\n\n` +
    `確定執行？`
  );
  if(!ok) return;

  // 清空所有城的宣戰
  for(const c of state.cities){
    c.attackTargets = [];
    c.defendTargets = [];
    state.entityRev.city[c.id] = (state.entityRev.city[c.id] || 0) + 1;
    markDirty('city', c.id);
  }

  // 建立城池名稱 → id 對照
  const cityByName = new Map();
  for(const c of state.cities) cityByName.set(c.name, c.id);

  let added = 0, skipped = 0;
  for(const route of result.routes){
    const srcCity = state.cities.find(c => c.id === cityByName.get(route.srcName));
    const tgtCityId = cityByName.get(route.tgtName);
    if(!srcCity || !tgtCityId){ skipped++; continue; }

    const arr = route.isAttack ? srcCity.attackTargets : srcCity.defendTargets;
    const newRoute = {
      cityId: tgtCityId,
      preWarPercent: route.preWarPercent,
      postRevivePercent: route.postRevivePercent,
      priority: route.priority,
    };
    const existingIdx = arr.findIndex(t => t.cityId === tgtCityId);
    if(existingIdx >= 0) arr[existingIdx] = newRoute;
    else arr.push(newRoute);

    state.entityRev.city[srcCity.id] = (state.entityRev.city[srcCity.id] || 0) + 1;
    markDirty('city', srcCity.id);
    added++;
  }

  tickLamport();
  flushPatches();
  saveState();

  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();

  alert(`✅ 已匯入 ${added} 條宣戰指示${skipped > 0 ? `（${skipped} 條略過）` : ''}`);
  logSystem(`📥 宣戰表匯入完成：${added} 條`);
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

/* v8.5：加入「等級」欄位 */
function exportCitiesCSV(){
  if(state.cities.length === 0){ alert('目前沒有任何城池'); return; }
  const headers = ['城池名稱','戰區','同盟','陣營','等級','人數','總戰力','總隊數','冷卻','城牆','防守開始','首都'];
  const rows = state.cities.map(c => {
    const zone = state.zones.find(z => z.id === c.zoneId);
    const alliance = state.alliances.find(a => a.id === c.allianceId);
    return [
      c.name,
      zone ? zone.name : '',
      alliance ? alliance.name : '',
      SIDE_LABELS[c.side] || c.side,
      c.level || 1,
      c.memberCount || '',
      c.totalPower || '',
      c.totalTeams || '',
      c.cooldownMin,
      c.wallMin,
      c.defStartTime || '19:00',
      c.isCapital ? '是' : '',
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `城池表_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem('📤 已匯出城池表 CSV');
}

/* v8.5：匯出盟名單 */
function exportAlliancesCSV(){
  if(state.alliances.length === 0){ alert('目前沒有任何盟'); return; }
  const headers = ['盟名稱','盟徽','人數','總戰力','陣營'];
  const rows = state.alliances.map(a => [
    a.name,
    a.icon || '',
    a.memberCount || 0,
    a.totalPower || 0,
    ALLIANCE_SIDE_LABELS[a.side] || a.side,
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `盟名單_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem('📤 已匯出盟名單 CSV');
}

/* v8.5：匯出地圖路線 */
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
  logSystem(`📤 已匯出地圖路線 CSV（${rows.length} 條）`);
}

function exportRoutesCSV(){
  const headers = ['出兵城','目標城','類型','戰前%','復活%','順序'];
  const rows = [];
  const cityById = new Map(state.cities.map(c => [c.id, c]));
  for(const src of state.cities){
    for(const t of (src.attackTargets || [])){
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '進攻', t.preWarPercent, t.postRevivePercent, t.priority]);
    }
    for(const t of (src.defendTargets || [])){
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '防守', t.preWarPercent, t.postRevivePercent, t.priority]);
    }
  }
  if(rows.length === 0){ alert('目前沒有任何宣戰指示'); return; }
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `宣戰表_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem(`📤 已匯出宣戰表 CSV（${rows.length} 條）`);
}

/* v8.5：更新範本說明 */
function downloadExcelTemplate(){
  const template = `【盟名單欄位說明】
盟名稱,盟徽,人數,總戰力,陣營
帝盟,帝,100,20000,敵方
秦盟,秦,90,18000,敵方
鼎盟,鼎,80,16000,敵方

■ 盟徽：可留空（預設 🏰），或用 emoji
■ 陣營可填：本方 / 同盟 / 敵方
■ 人數 / 總戰力：可留空

─────────────────────────────────────────────

【城池表欄位說明】
城池名稱,戰區,同盟,陣營,等級,人數,總戰力,總隊數,冷卻,城牆,防守開始,首都
洛陽,司隸,鼎盟,敵方,10,100,100000,100,5,30,19:00,是
函谷關,司隸,秦盟,敵方,9,80,80000,80,5,20,19:00,

■ 同盟：填盟名稱，會自動對應盟徽（找不到 → NPC）
■ 等級：1~10（可留空，預設 1）
■ 人數 / 總戰力 / 總隊數：可留空
■ 冷卻 / 城牆：單位為分鐘

─────────────────────────────────────────────

【地圖路線表欄位說明】
城池A-城池B
洛陽-函谷關
洛陽-洛陽北
洛陽北-洛陽西

■ 一行一條
■ 用「-」分隔（也支援逗號）
■ 無向圖（A-B 等同 B-A）

─────────────────────────────────────────────

【宣戰表欄位說明】
出兵城,目標城,類型,戰前%,復活%,順序
洛陽,函谷關,進攻,50,50,1
洛陽北,洛陽,防守,30,30,1

■ 類型：進攻 / 防守 / 協防
■ 戰前%：開局派出的兵力百分比
■ 復活%：復活後派出的兵力百分比
■ 順序：數字越小越優先
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
  parseAlliancesTable,
  parseCitiesTable,
  parseRoutesTable,
  parseMapRoutesTable,
  updateExcelPreview,
  openExcelImportModal, closeExcelImportModal,
  doImportAlliances,
  doImportCities,
  doImportMapRoutes,
  doImportRoutes,
  downloadCSV,
  exportCitiesCSV,
  exportAlliancesCSV,
  exportMapRoutesCSV,
  exportRoutesCSV,
  downloadExcelTemplate,
});

})();