/* ============================================================================
 * data.js — Excel/CSV 匯入匯出（v8.2：移除 JSON 匯入匯出與分享連結）
 * v8.2
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

const CITY_FIELD_ALIASES = {
  name:        ['城池名稱','城池','城名','名稱','name','cityname','city'],
  zone:        ['戰區','分區','區域','zone','zoneid','region'],
  alliance:    ['同盟','盟','盟名稱','盟名','alliance','alliancename'],
  side:        ['陣營','陣營關係','side','faction'],
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

const SIDE_PARSE_MAP = {
  '本方':'self','自己':'self','self':'self','我方':'self','我軍':'self',
  '同盟':'ally','盟友':'ally','ally':'ally','友方':'ally',
  '敵方':'enemy','敵':'enemy','enemy':'enemy','敵軍':'enemy',
  '共同敵方':'common_enemy','共同敵':'common_enemy','common_enemy':'common_enemy','common':'common_enemy',
  'npc':'npc','中立':'npc','中立城':'npc',
};
const TRUTHY_SET = new Set(['是','y','yes','true','1','✓','√','v','有','首都','主城']);

/* ============================================================
   解析：城池表
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
    const getName = idx.name >= 0 ? String(r[idx.name]||'').trim() : '';
    if(!getName){ errors.push(`第 ${i+1} 列缺少城池名稱，略過`); continue; }

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
    const totalPower = parseFloat(get('totalPower', '0')) || 0;
    const totalTeams = parseFloat(get('totalTeams', '0')) || 0;
    const cooldownMin = parseFloat(get('cooldownMin', '5')) || 5;
    const wallMin = parseFloat(get('wallMin', '30')) || 30;
    const defStartTime = get('defStartTime', '19:00');
    const capRaw = String(get('isCapital', '')).toLowerCase().trim();
    const isCapital = TRUTHY_SET.has(capRaw);

    if(totalTeams <= 0){
      errors.push(`第 ${i+1} 列「${getName}」總隊數必須大於 0，略過`);
      continue;
    }

    neededZones.add(zoneName);
    if(allianceName){
      const aSide = (side === 'self' || side === 'ally') ? side : 'enemy';
      neededAlliances.set(allianceName, aSide);
    }

    cities.push({
      name: getName, zoneName, allianceName, side,
      totalPower, totalTeams, cooldownMin, wallMin, defStartTime, isCapital,
    });
  }

  return {
    cities, errors,
    neededZones: [...neededZones],
    neededAlliances: [...neededAlliances.entries()]
  };
}

/* ============================================================
   解析：路線表
   ============================================================ */
function parseRoutesTable(rows){
  if(!rows || rows.length < 2) return { routes: [], errors: ['路線表至少需要表頭 + 1 筆資料'] };
  const headers = rows[0].map(h => String(h||'').trim());
  const idx = {};
  for(const [field, aliases] of Object.entries(ROUTE_FIELD_ALIASES)){
    idx[field] = findFieldIndex(headers, aliases);
  }
  if(idx.src < 0 || idx.tgt < 0){
    return { routes: [], errors: ['路線表缺少「出兵城」或「目標城」欄位'] };
  }

  const routes = [];
  const errors = [];
  const TYPE_MAP = {
    '攻':'attack','進攻':'attack','attack':'attack','a':'attack','攻擊':'attack',
    '防':'defend','協防':'defend','defend':'defend','d':'defend','守':'defend',
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
   Excel 匯入 UI
   ============================================================ */
function updateExcelPreview(){
  const preview = document.getElementById('excelPreview');
  if(!preview) return;
  const citiesText = document.getElementById('excelCitiesText').value.trim();
  const routesText = document.getElementById('excelRoutesText').value.trim();
  const citiesStatus = document.getElementById('excelCitiesStatus');
  const routesStatus = document.getElementById('excelRoutesStatus');

  if(!citiesText && !routesText){
    preview.className = 'excel-preview';
    preview.innerHTML = '<span class="text-dim">請在任一區塊填入資料</span>';
    if(citiesStatus) citiesStatus.textContent = '尚未填入';
    if(routesStatus) routesStatus.textContent = '尚未填入';
    return;
  }

  preview.className = 'excel-preview has-data';
  let html = '';

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
        const newAlliances = result.neededAlliances.filter(([name]) => !state.alliances.some(x => x.name === name));
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

  if(routesText){
    const rows = parseDelimited(routesText);
    const result = parseRoutesTable(rows);
    const n = result.routes.length;
    if(n > 0){
      html += `<div><span class="ok">✅ 路線表：${n} 條</span>`;
      if(result.errors.length > 0) html += ` <span class="warn">（${result.errors.length} 筆警告）</span>`;
      html += `</div>`;
      if(routesStatus) routesStatus.textContent = `${n} 條`;
    } else {
      html += `<div><span class="err">❌ 路線表：解析失敗</span></div>`;
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
  document.getElementById('excelCitiesText').value = '';
  document.getElementById('excelRoutesText').value = '';
  const def = document.querySelector('input[name="excelMode"][value="merge"]');
  if(def) def.checked = true;
  updateExcelPreview();
  document.getElementById('excelImportModal').classList.add('show');
}
function closeExcelImportModal(){
  document.getElementById('excelImportModal').classList.remove('show');
}

function doExcelImport(){
  const citiesText = document.getElementById('excelCitiesText').value.trim();
  const routesText = document.getElementById('excelRoutesText').value.trim();
  const mode = document.querySelector('input[name="excelMode"]:checked')?.value || 'merge';

  if(!citiesText && !routesText){ alert('請至少填入一個區塊'); return; }

  let cityResult = null;
  let routeResult = null;

  if(citiesText){
    const rows = parseDelimited(citiesText);
    cityResult = parseCitiesTable(rows);
    if(cityResult.cities.length === 0){
      alert('❌ 城池表解析失敗：\n' + cityResult.errors.slice(0,5).join('\n'));
      return;
    }
  }

  if(routesText){
    const rows = parseDelimited(routesText);
    routeResult = parseRoutesTable(rows);
    if(routeResult.routes.length === 0){
      alert('❌ 路線表解析失敗：\n' + routeResult.errors.slice(0,5).join('\n'));
      return;
    }
  }

  const summary = [];
  if(cityResult) summary.push(`城池：${cityResult.cities.length} 座`);
  if(routeResult) summary.push(`路線：${routeResult.routes.length} 條`);
  const modeLabel = { overwrite:'覆蓋', merge:'合併', append:'追加' }[mode];
  const ok = confirm(`即將以「${modeLabel}」模式匯入：\n\n${summary.join('\n')}\n\n確定執行？`);
  if(!ok) return;

  executeExcelImport(cityResult, routeResult, mode);
}

function executeExcelImport(cityResult, routeResult, mode){
  let newCities = 0, updatedCities = 0, conflictCities = 0;
  let newRoutes = 0, updatedRoutes = 0, skippedRoutes = 0;

  const zoneMap = new Map();
  for(const z of state.zones) zoneMap.set(z.name, z.id);
  const ensureZone = (name) => {
    if(!name) name = '未分配';
    if(zoneMap.has(name)) return zoneMap.get(name);
    const id = uid();
    const entity = { id, name };
    state.zones.push(entity);
    state.entityRev.zone[id] = (state.entityRev.zone[id] || 0) + 1;
    markDirty('zone', id);
    zoneMap.set(name, id);
    return id;
  };

  const allianceMap = new Map();
  for(const a of state.alliances) allianceMap.set(a.name, a.id);
  const ensureAlliance = (name, side) => {
    if(!name) return '';
    if(allianceMap.has(name)) return allianceMap.get(name);
    const id = uid();
    const entity = {
      id, name, icon:'', side,
      memberCount: 100, totalPower: 20000, avgPower: 200, power: 20000,
    };
    state.alliances.push(entity);
    state.entityRev.alliance[id] = (state.entityRev.alliance[id] || 0) + 1;
    markDirty('alliance', id);
    allianceMap.set(name, id);
    return id;
  };

  if(mode === 'overwrite' && cityResult){
    const oldIds = state.cities.map(c => c.id);
    state.cities.length = 0;
    for(const id of oldIds){
      state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
      markDirty('cityDeleted', id);
    }
  }

  const cityByName = new Map(state.cities.map(c => [c.name, c]));

  if(cityResult){
    for(const cd of cityResult.cities){
      const zoneId = ensureZone(cd.zoneName);
      const allianceId = ensureAlliance(cd.allianceName, cd.side);
      const avgPower = cd.totalTeams > 0 ? Math.floor(cd.totalPower / cd.totalTeams) : 0;
      const existing = cityByName.get(cd.name);

      if(existing){
        if(mode === 'append'){ conflictCities++; continue; }
        existing.zoneId = zoneId;
        existing.allianceId = allianceId;
        existing.side = cd.side;
        existing.totalPower = cd.totalPower;
        existing.totalTeams = cd.totalTeams;
        existing.avgPower = avgPower;
        existing.cooldownMin = cd.cooldownMin;
        existing.wallMin = cd.wallMin;
        existing.defStartTime = cd.defStartTime;
        existing.isCapital = cd.isCapital;
        state.entityRev.city[existing.id] = (state.entityRev.city[existing.id] || 0) + 1;
        markDirty('city', existing.id);
        updatedCities++;
      } else {
        const id = uid();
        const entity = {
          id, name: cd.name, zoneId, allianceId, side: cd.side,
          totalPower: cd.totalPower, totalTeams: cd.totalTeams, avgPower,
          cooldownMin: cd.cooldownMin, wallMin: cd.wallMin,
          defStartTime: cd.defStartTime, isCapital: cd.isCapital,
          attackTargets: [], defendTargets: [],
        };
        state.cities.push(entity);
        cityByName.set(cd.name, entity);
        state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
        markDirty('city', id);
        newCities++;
      }
    }
  }

  if(routeResult && routeResult.routes.length > 0){
    if(mode === 'overwrite'){
      for(const c of state.cities){
        if(c.attackTargets.length || c.defendTargets.length){
          c.attackTargets = [];
          c.defendTargets = [];
          state.entityRev.city[c.id] = (state.entityRev.city[c.id] || 0) + 1;
          markDirty('city', c.id);
        }
      }
    }

    const cityByNameNow = new Map(state.cities.map(c => [c.name, c]));

    for(const route of routeResult.routes){
      const srcCity = cityByNameNow.get(route.srcName);
      const tgtCity = cityByNameNow.get(route.tgtName);
      if(!srcCity || !tgtCity){ skippedRoutes++; continue; }

      const arr = route.isAttack ? srcCity.attackTargets : srcCity.defendTargets;
      const existingIdx = arr.findIndex(t => t.cityId === tgtCity.id);
      const newRoute = {
        cityId: tgtCity.id,
        preWarPercent: route.preWarPercent,
        postRevivePercent: route.postRevivePercent,
        priority: route.priority,
      };

      if(existingIdx >= 0){
        if(mode === 'append'){ skippedRoutes++; continue; }
        arr[existingIdx] = newRoute;
        updatedRoutes++;
      } else {
        arr.push(newRoute);
        newRoutes++;
      }
      state.entityRev.city[srcCity.id] = (state.entityRev.city[srcCity.id] || 0) + 1;
      markDirty('city', srcCity.id);
    }
  }

  tickLamport();
  flushPatches();
  saveState();

  if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
  if(typeof window.SLG.populateCityFilters === 'function') window.SLG.populateCityFilters();
  if(typeof window.SLG.populateZoneFilter === 'function') window.SLG.populateZoneFilter();
  if(typeof window.SLG.deployRender === 'function'
     && document.getElementById('tab-deploy').classList.contains('active')){
    window.SLG.deployRender();
  }

  closeExcelImportModal();

  const lines = [];
  if(newCities > 0) lines.push(`✅ 新增城池 ${newCities} 座`);
  if(updatedCities > 0) lines.push(`✅ 更新城池 ${updatedCities} 座`);
  if(newRoutes > 0) lines.push(`✅ 新增路線 ${newRoutes} 條`);
  if(updatedRoutes > 0) lines.push(`✅ 更新路線 ${updatedRoutes} 條`);
  if(conflictCities > 0) lines.push(`⚠️ 城池衝突 ${conflictCities} 筆（追加模式不覆蓋）`);
  if(skippedRoutes > 0) lines.push(`⚠️ 路線略過 ${skippedRoutes} 條（找不到城池或衝突）`);

  alert('📥 匯入完成！\n\n' + (lines.length ? lines.join('\n') : '（無變更）'));
  logSystem('📥 Excel 匯入完成');
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

function exportCitiesCSV(){
  if(state.cities.length === 0){ alert('目前沒有任何城池'); return; }
  const headers = ['城池名稱','戰區','同盟','陣營','總戰力','總隊數','冷卻','城牆','防守開始','首都'];
  const rows = state.cities.map(c => {
    const zone = state.zones.find(z => z.id === c.zoneId);
    const alliance = state.alliances.find(a => a.id === c.allianceId);
    return [
      c.name,
      zone ? zone.name : '',
      alliance ? alliance.name : '',
      SIDE_LABELS[c.side] || c.side,
      c.totalPower, c.totalTeams, c.cooldownMin, c.wallMin,
      c.defStartTime || '19:00',
      c.isCapital ? '是' : '',
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `城池表_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem('📤 已匯出城池表 CSV');
}

function exportRoutesCSV(){
  const headers = ['出兵城','目標城','類型','戰前%','復活%','順序'];
  const rows = [];
  const cityById = new Map(state.cities.map(c => [c.id, c]));
  for(const src of state.cities){
    for(const t of (src.attackTargets || [])){
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '攻', t.preWarPercent, t.postRevivePercent, t.priority]);
    }
    for(const t of (src.defendTargets || [])){
      const tgt = cityById.get(t.cityId);
      if(!tgt) continue;
      rows.push([src.name, tgt.name, '防', t.preWarPercent, t.postRevivePercent, t.priority]);
    }
  }
  if(rows.length === 0){ alert('目前沒有任何路線指示'); return; }
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadCSV(csv, `路線表_${new Date().toISOString().slice(0,10)}.csv`);
  logSystem(`📤 已匯出路線表 CSV（${rows.length} 條）`);
}

function downloadExcelTemplate(){
  const template = `【城池表欄位說明】
城池名稱,戰區,同盟,陣營,總戰力,總隊數,冷卻,城牆,防守開始,首都
主城,北境,我方盟,本方,100000,100,5,30,19:00,是
敵城1,北境,敵盟A,敵方,80000,80,5,20,19:00,
友城A,北境,我方盟,同盟,60000,60,5,25,19:00,
中立城,北境,,NPC,30000,30,5,15,19:00,

■ 陣營可填：本方 / 同盟 / 敵方 / 共同敵方 / NPC
■ 首都可填：是 / Y / 1（空白為否）
■ 防守開始：HH:MM 格式，如 19:00
■ 冷卻 / 城牆：單位為分鐘
■ 戰區 / 同盟：不存在的會自動建立
■ 欄位順序不拘，程式會自動識別表頭

─────────────────────────────────────────────

【路線表欄位說明】
出兵城,目標城,類型,戰前%,復活%,順序
主城,敵城1,攻,50,50,1
友城A,敵城1,防,30,30,1

■ 類型：攻（進攻）/ 防（協防）
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
  parseCitiesTable, parseRoutesTable,
  updateExcelPreview, openExcelImportModal, closeExcelImportModal,
  doExcelImport, executeExcelImport,
  downloadCSV, exportCitiesCSV, exportRoutesCSV, downloadExcelTemplate,
});

})();