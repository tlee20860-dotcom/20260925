/* ============================================================================
 * ui.js — 所有渲染
 * v8.9.3：NodeCalibration 定點模式 + 拖曳節點 + 刪除標記
 *          GameMap 底圖開關 + 宣戰 Bug 修正 + 路線粗黑線
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, emit, EVT, on,
  uid, esc, logSystem,
  sideLabel, allianceSideLabel, sideClass,
  hhmmToMinutes, minutesToHHMM,
  computeAllocation,
  PERCENT_OPTIONS, ATTACK_RULES, DEFEND_RULES, SIDE_LABELS,
  VIZ_SNAPSHOT_INTERVAL, DYN_ROUTE_SAMPLE_SEC,
  AI, ROLE, ROLE_ORDER,
  timeAgo, buildSandboxFileName,
  getAllianceByName, findRoute, addRoute, removeRoute, getReachableCityIds,
  formatPower, formatAvgPower,
  getAlliancesSorted, reorderAlliances, resetAllianceOrder,
  getAvailableAllianceIcons, isAllianceIconUsed, getAllianceIcons,
  computeCityDistance, setDistanceHighlight, clearDistanceHighlight, isNpcCity,
  calcTeamsFromTiers,
  /* v8.8.0 */
  normalizeCityName, calcSimilarity, matchCityToMapNode,
  getMapMeta, getLoadedMap, getActiveMap, setActiveMap, setMapViewMode,
  isOnline,
} = window.SLG;

const Auth = () => window.SLG.Auth;
const hasTogglePerm = () => typeof window.SLG.togglePerm === 'function';

let editingAllianceRowId = null;
let editingCityRowId = null;
let editingCityTierId = null;

/* ============================================================
   同步狀態渲染
   ============================================================ */
let syncCountdownInterval = null;

function renderSyncStatus(){
  const el = document.getElementById('syncStatus');
  const dotEl = document.getElementById('syncDot');
  const textEl = document.getElementById('syncText');
  if(!el || !dotEl || !textEl) return;

  if(syncCountdownInterval){ clearInterval(syncCountdownInterval); syncCountdownInterval = null; }

  const s = state.sync;
  const auth = state.auth;

  el.classList.remove('state-idle','state-synced','state-pending','state-uploading','state-error');

  if(!auth.signedIn){
    dotEl.textContent = '⚪';
    textEl.textContent = '未登入';
    el.classList.add('state-idle');
    el.title = '請先登入';
    return;
  }

  if(s.uploading){
    dotEl.textContent = '⏳';
    textEl.textContent = '同步中...';
    el.classList.add('state-uploading');
    el.title = '正在上傳至雲端' + (s.lastUploadReason ? `（${s.lastUploadReason}）` : '');
    return;
  }

  if(s.lastError){
    dotEl.textContent = '🔴';
    textEl.textContent = '同步失敗';
    el.classList.add('state-error');
    el.title = '同步失敗：' + s.lastError + '\n點擊查看雲端歷史版本';
    return;
  }

  if(s.dirty){
    el.classList.add('state-pending');
    dotEl.textContent = '🟡';
    el.title = `有 ${s.dirtyCount} 筆未上傳變更\n點擊查看雲端歷史版本`;

    const updateCountdown = () => {
      if(!state.sync.dirty){ renderSyncStatus(); return; }
      if(state.sync.uploading){ renderSyncStatus(); return; }
      const remain = state.sync.nextUploadAt - Date.now();
      if(remain <= 0){
        textEl.textContent = `待上傳(${state.sync.dirtyCount})`;
        return;
      }
      const min = Math.floor(remain / 60000);
      const sec = Math.floor((remain % 60000) / 1000);
      textEl.textContent = `待上傳(${state.sync.dirtyCount}) ${min}:${String(sec).padStart(2,'0')}`;
    };
    updateCountdown();
    syncCountdownInterval = setInterval(updateCountdown, 1000);
    return;
  }

  dotEl.textContent = '🟢';
  if(s.lastUploadAt){
    const ago = timeAgo(s.lastUploadAt);
    textEl.textContent = `已同步 · ${ago}`;
    el.title = `上次同步：${new Date(s.lastUploadAt).toLocaleString()}\n` +
      (s.lastUploadReason ? `原因：${s.lastUploadReason}\n` : '') +
      `點擊查看雲端歷史版本`;
  } else {
    textEl.textContent = '已同步';
    el.title = '已同步\n點擊查看雲端歷史版本';
  }
  el.classList.add('state-synced');
}

/* ============================================================
   viz — 態勢圖
   ============================================================ */
const viz = (() => {
  const NODE_RADIUS = 14;
  let cvStatic, ctxStatic, cvLive, ctxLive, containerEl;
  let layout = { nodes:new Map(), zones:[], bounds:{w:0, h:0} };
  let snapshots = new Map();
  let snapshotSecs = [];
  let currentSec = 0;
  let vizScale = 1;
  let vizPinchStartDist = 0;
  let vizPinchStartScale = 1;
  let baseCanvasW = 0;
  let baseCanvasH = 0;

  function init(){
    containerEl = document.getElementById('vizContainer');
    if(!containerEl) return;
    cvStatic = document.getElementById('vizStatic');
    cvLive = document.getElementById('vizLive');
    ctxStatic = cvStatic.getContext('2d');
    ctxLive = cvLive.getContext('2d');
    const slider = document.getElementById('vizSlider');
    const timeLabel = document.getElementById('vizTimeLabel');
    slider.addEventListener('input', () => {
      currentSec = parseInt(slider.value, 10) || 0;
      renderLive(currentSec);
      renderClearPanel(currentSec);
      if(timeLabel) timeLabel.textContent = formatAbsTime(currentSec);
    });
    window.addEventListener('resize', () => {
      if(!containerEl.clientWidth) return;
      computeLayout(); resizeCanvases(); renderStatic(); renderLive(currentSec);
    });
    containerEl.addEventListener('touchstart', (e) => {
      if(e.touches.length === 2){
        vizPinchStartDist = touchDist(e.touches[0], e.touches[1]);
        vizPinchStartScale = vizScale;
      }
    }, { passive: true });
    containerEl.addEventListener('touchmove', (e) => {
      if(e.touches.length === 2 && vizPinchStartDist > 0){
        e.preventDefault();
        const dist = touchDist(e.touches[0], e.touches[1]);
        const newScale = Math.max(0.5, Math.min(4, vizPinchStartScale * dist / vizPinchStartDist));
        if(Math.abs(newScale - vizScale) > 0.02){ vizScale = newScale; applyVizScale(); }
      }
    }, { passive: false });
    containerEl.addEventListener('touchend', (e) => {
      if(e.touches.length < 2){ vizPinchStartDist = 0; }
    }, { passive: true });
    on(EVT.DATA, () => { computeLayout(); resizeCanvases(); renderStatic(); renderLive(currentSec); });
    on(EVT.VIZ_SNAPSHOTS, ({snapshots:s, secs}) => {
      snapshots = s; snapshotSecs = secs;
      if(secs.length > 0){
        slider.min = secs[0]; slider.max = secs[secs.length-1];
        slider.value = secs[secs.length-1];
        currentSec = secs[secs.length-1];
        slider.disabled = false;
        computeLayout(); resizeCanvases();
        renderStatic(); renderLive(currentSec); renderClearPanel(currentSec);
        if(timeLabel) timeLabel.textContent = formatAbsTime(currentSec);
      }
    });
    on(EVT.VIZ_RESET, () => {
      snapshots = new Map(); snapshotSecs = []; currentSec = 0;
      slider.disabled = true; slider.value = 0;
      if(cvLive) ctxLive.clearRect(0,0,cvLive.width, cvLive.height);
      if(timeLabel) timeLabel.textContent = '尚未推演';
      const panel = document.getElementById('clearPanel');
      if(panel) panel.innerHTML = '<div class="text-dim">尚未推演</div>';
    });
  }
  function touchDist(t1, t2){ return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY); }
  function applyVizScale(){
    if(!cvStatic || !cvLive) return;
    cvStatic.style.width = (baseCanvasW * vizScale) + 'px';
    cvStatic.style.height = (baseCanvasH * vizScale) + 'px';
    cvLive.style.width = (baseCanvasW * vizScale) + 'px';
    cvLive.style.height = (baseCanvasH * vizScale) + 'px';
  }
  function activate(){
    if(!containerEl) return;
    computeLayout(); resizeCanvases();
    renderStatic(); renderLive(currentSec); renderClearPanel(currentSec);
  }
  function formatAbsTime(sec){ return minutesToHHMM((state.simBaseMin || 0) + Math.floor(sec/60)); }
  function getSchedule(maxSec){
    const set = new Set();
    for(let s=0;s<=maxSec;s+=VIZ_SNAPSHOT_INTERVAL) set.add(s);
    set.add(maxSec);
    return [...set];
  }
  function ingestSnapshot(sec, snap){
    snapshots.set(sec, snap);
    if(!snapshotSecs.includes(sec)){ snapshotSecs.push(sec); snapshotSecs.sort((a,b) => a-b); }
  }
  function finalize(){ emit(EVT.VIZ_SNAPSHOTS, {snapshots, secs:snapshotSecs}); }
  function reset(){
    emit(EVT.VIZ_RESET);
    snapshots = new Map(); snapshotSecs = []; currentSec = 0;
  }
  function getAllSnapshots(){
    return { snapEntries:[...snapshots.entries()], secs:snapshotSecs, baseMin: state.simBaseMin };
  }
  function computeLayout(){
    layout.nodes.clear(); layout.zones = [];
    const zonesById = new Map(state.zones.map(z => [z.id, z]));
    const groups = new Map();
    for(const c of state.cities){
      const key = c.zoneId || '__unassigned__';
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const groupArr = [...groups.entries()];
    const cols = Math.max(1, Math.ceil(Math.sqrt(groupArr.length)));
    const cellW = 340, cellH = 340;
    groupArr.forEach(([zoneId, cities], gi) => {
      const col = gi % cols, row = Math.floor(gi / cols);
      const cx = col * cellW + cellW/2, cy = row * cellH + cellH/2;
      layout.zones.push({ zoneId, name: zonesById.get(zoneId)?.name || '未分配', cx, cy });
      const n = cities.length;
      const R = n === 1 ? 0 : Math.min(cellW, cellH) * 0.32;
      cities.forEach((c, i) => {
        const ang = (i/n) * Math.PI * 2 - Math.PI/2;
        layout.nodes.set(c.id, {
          x: cx + Math.cos(ang)*R, y: cy + Math.sin(ang)*R,
          zoneId, name:c.name, side:c.side, isCapital:!!c.isCapital
        });
      });
    });
    layout.bounds.w = cols * cellW;
    layout.bounds.h = Math.ceil(groupArr.length / cols) * cellH;
  }
  function resizeCanvases(){
    if(!containerEl) return;
    const w = containerEl.clientWidth;
    if(!w || w <= 0){
      [cvStatic, cvLive].forEach(cv => { cv.width = 320; cv.height = 240; });
      baseCanvasW = 320; baseCanvasH = 240;
      return;
    }
    const scale = Math.min(1, w / Math.max(layout.bounds.w, 320));
    const wS = Math.max(320, layout.bounds.w * scale);
    const hS = Math.max(240, layout.bounds.h * scale);
    baseCanvasW = wS; baseCanvasH = hS;
    [cvStatic, cvLive].forEach(cv => {
      cv.width = wS; cv.height = hS;
      cv.style.width = (wS * vizScale) + 'px';
      cv.style.height = (hS * vizScale) + 'px';
    });
    ctxStatic.setTransform(scale, 0, 0, scale, 0, 0);
    ctxLive.setTransform(scale, 0, 0, scale, 0, 0);
  }
  function renderStatic(){
    if(!ctxStatic) return;
    ctxStatic.clearRect(0, 0, cvStatic.width, cvStatic.height);
    for(const z of layout.zones){
      const r = 160;
      ctxStatic.beginPath(); ctxStatic.arc(z.cx, z.cy, r, 0, Math.PI*2);
      ctxStatic.strokeStyle = 'rgba(59,130,246,0.2)'; ctxStatic.lineWidth = 1;
      ctxStatic.setLineDash([4,6]); ctxStatic.stroke(); ctxStatic.setLineDash([]);
      ctxStatic.font = '11px sans-serif'; ctxStatic.fillStyle = 'rgba(148,163,184,0.7)';
      ctxStatic.textAlign = 'center';
      ctxStatic.fillText(z.name, z.cx, z.cy - r - 6);
    }
    for(const c of state.cities){
      const from = layout.nodes.get(c.id);
      if(!from) continue;
      for(const t of (c.attackTargets || [])){
        if((t.preWarPercent||0)<=0 || !t.cityId) continue;
        const to = layout.nodes.get(t.cityId); if(!to) continue;
        drawArrow(ctxStatic, from, to, 'rgba(255,68,102,0.35)', t.preWarPercent);
      }
      for(const t of (c.defendTargets || [])){
        if((t.preWarPercent||0)<=0 || !t.cityId) continue;
        const to = layout.nodes.get(t.cityId); if(!to) continue;
        drawArrow(ctxStatic, from, to, 'rgba(34,255,136,0.28)', t.preWarPercent);
      }
    }
    for(const c of state.cities){
      const p = layout.nodes.get(c.id); if(!p) continue;
      drawNode(ctxStatic, p, c.side, false);
    }
  }
  function drawNode(ctx, p, side, fallen){
    const color = side==='self' ? '#3b82f6' : side==='ally' ? '#10b981'
                : side==='enemy' ? '#ef4444' : side==='common_enemy' ? '#f59e0b'
                : side==='npc' ? '#a855f7' : '#64748b';
    ctx.beginPath(); ctx.arc(p.x, p.y, NODE_RADIUS, 0, Math.PI*2);
    ctx.fillStyle = fallen ? '#1a1a1a' : color; ctx.fill();
    ctx.strokeStyle = fallen ? '#7f1d1d' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2; ctx.stroke();
    if(p.isCapital){
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffcc00';
      ctx.fillText('👑', p.x, p.y - NODE_RADIUS - 10);
    }
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const label = p.name.length > 6 ? p.name.slice(0,6)+'…' : p.name;
    ctx.fillText(label, p.x, p.y + NODE_RADIUS + 12);
  }
  function drawArrow(ctx, from, to, color, pct){
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if(dist < 1) return;
    const ux = dx/dist, uy = dy/dist;
    const sx = from.x + ux*NODE_RADIUS, sy = from.y + uy*NODE_RADIUS;
    const ex = to.x - ux*NODE_RADIUS, ey = to.y - uy*NODE_RADIUS;
    const mx = (sx+ex)/2, my = (sy+ey)/2;
    const co = dist * 0.12;
    const cx = mx - uy*co, cy = my + ux*co;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, Math.min(4, pct/25));
    ctx.stroke();
    const ang = Math.atan2(ey-cy, ex-cx);
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang-0.4)*8, ey - Math.sin(ang-0.4)*8);
    ctx.lineTo(ex - Math.cos(ang+0.4)*8, ey - Math.sin(ang+0.4)*8);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  function renderLive(sec){
    if(!ctxLive) return;
    ctxLive.clearRect(0, 0, cvLive.width, cvLive.height);
    const snap = lookupSnapshot(sec);
    if(!snap) return;
    const snapById = new Map(snap.map(s => [s.id, s]));
    for(const c of state.cities){
      const p = layout.nodes.get(c.id); if(!p) continue;
      const s = snapById.get(c.id); if(!s) continue;
      if(!s.f && s.si > 0){
        ctxLive.beginPath();
        ctxLive.arc(p.x, p.y, NODE_RADIUS + 7, 0, Math.PI*2);
        ctxLive.strokeStyle = 'rgba(255,68,102,0.7)';
        ctxLive.lineWidth = 2;
        ctxLive.setLineDash([3,3]); ctxLive.stroke(); ctxLive.setLineDash([]);
      }
      let ringColor = null, ringW = 2;
      if(s.f){ ringColor = '#ef4444'; ringW = 3; }
      else if(s.w < (c.wallMin*60)*0.3){ ringColor = '#f59e0b'; ringW = 2.5; }
      else if(s.r > 0){ ringColor = '#22ff88'; ringW = 1.5; }
      if(ringColor){
        ctxLive.beginPath();
        ctxLive.arc(p.x, p.y, NODE_RADIUS+4, 0, Math.PI*2);
        ctxLive.strokeStyle = ringColor;
        ctxLive.lineWidth = ringW;
        ctxLive.stroke();
      }
      if(!s.f){
        ctxLive.font = 'bold 9px sans-serif';
        ctxLive.textAlign = 'center'; ctxLive.textBaseline = 'middle';
        ctxLive.fillStyle = '#e2e8f0';
        ctxLive.fillText(`${Math.round(s.r)}/${Math.round(s.r + s.o + s.c)}`, p.x, p.y - NODE_RADIUS - 8);
        if(s.si > 0){
          ctxLive.font = 'bold 9px sans-serif';
          ctxLive.fillStyle = '#ff4466';
          ctxLive.fillText(`⚡${Math.round(s.si)}`, p.x, p.y + NODE_RADIUS + 24);
        }
      } else {
        ctxLive.font = 'bold 10px sans-serif';
        ctxLive.textAlign = 'center'; ctxLive.textBaseline = 'middle';
        ctxLive.fillStyle = '#ef4444';
        ctxLive.fillText('✕', p.x, p.y);
      }
    }
  }
  function lookupSnapshot(sec){
    if(snapshotSecs.length === 0) return null;
    if(snapshots.has(sec)) return snapshots.get(sec);
    let lo = 0, hi = snapshotSecs.length-1, best = 0;
    while(lo <= hi){
      const mid = (lo+hi) >> 1;
      if(snapshotSecs[mid] <= sec){ best = snapshotSecs[mid]; lo = mid+1; }
      else hi = mid-1;
    }
    return snapshots.get(best);
  }
  function renderClearPanel(sec){
    const panel = document.getElementById('clearPanel');
    if(!panel) return;
    const snap = lookupSnapshot(sec);
    if(!snap){ panel.innerHTML = '<div class="text-dim">尚未推演</div>'; return; }
    const absTime = formatAbsTime(sec);
    const snapById = new Map(snap.map(s => [s.id, s]));
    let html = `<div class="clear-panel-title"><span>📊 瞬間清算</span><span class="time">${esc(absTime)}</span></div>`;
    for(const c of state.cities){
      const s = snapById.get(c.id);
      if(!s) continue;
      const fallenCls = s.f ? 'fallen' : '';
      const a = state.alliances.find(al => al.id === c.allianceId);
      const icon = (a && a.icon) ? a.icon + ' ' : '';
      html += `<div class="clear-city ${fallenCls}">
        <div class="name"><span>${c.isCapital ? '👑 ' : ''}${esc(c.name)} <span class="chip ${sideClass(c.side)}" style="font-size:9px;">${esc(icon)}${sideLabel(c.side)}</span></span>${s.f ? '<span style="color:var(--neon-red);font-size:10px;">✕ 已淪陷</span>' : ''}</div>
        <div class="stat-grid">
          <div class="stat-item"><span class="lbl">🛡️ 剩餘可戰</span><span class="val" style="color:#22ff88;">${Math.round(s.r)}</span></div>
          <div class="stat-item"><span class="lbl">⚔️ 外出</span><span class="val" style="color:#44aaff;">${Math.round(s.o)}</span></div>
          <div class="stat-item"><span class="lbl">💤 冷卻</span><span class="val" style="color:#94a3b8;">${Math.round(s.c)}</span></div>
          <div class="stat-item"><span class="lbl">🏰 城牆</span><span class="val" style="color:#ffcc00;">${(s.w/60).toFixed(1)} 分</span></div>
        </div>
      </div>`;
    }
    panel.innerHTML = html;
  }
  return {
    init, activate, getSchedule, ingestSnapshot, finalize, reset,
    getAllSnapshots, renderLive, renderClearPanel
  };
})();

/* ============================================================
   R — 渲染模組
   ============================================================ */
const R = (() => {
  function renderHealth(){
    const dot = document.getElementById('healthDot');
    const text = document.getElementById('healthText');
    let cls, label;
    if(state.connected){ cls = 'green'; label = '連線成功'; }
    else if(state.connecting){ cls = 'yellow'; label = '連線中...'; }
    else { cls = 'red'; label = '未連線'; }
    if(dot) dot.className = 'health-dot ' + cls;
    if(text) text.textContent = label;
    const cdot = document.getElementById('chatHealthDot');
    const ctxt = document.getElementById('chatHealthText');
    if(cdot) cdot.className = 'health-dot ' + cls;
    if(ctxt) ctxt.textContent = label;
    const crd = document.getElementById('chatRoomDisplay');
    if(crd) crd.textContent = state.roomCode ? `房間 ${state.roomCode}` : '';
  }
  function renderHost(){
    const el = document.getElementById('hostDisplay');
    if(el) el.textContent = state.hostName ? `房主：${state.hostName}${state.isHost ? '（你）' : ''}` : '';
  }
  function renderDebug({msg, err} = {}){
    const el = document.getElementById('debugLog');
    if(!el || !msg) return;
    const line = document.createElement('div');
    line.className = err ? 'err' : (msg.includes('🟢') ? 'ok' : '');
    const ts = window.SLG.nowTime ? window.SLG.nowTime() : '';
    line.textContent = `[${ts}] ${msg}`;
    el.appendChild(line);
    while(el.children.length > 6) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function renderMembers(){
    const el = document.getElementById('onlineMembers');
    if(!el) return;
    const list = Object.values(state.members);
    if(list.length === 0){ el.innerHTML = '<span class="text-dim">尚未連線</span>'; return; }
    el.innerHTML = list.map(m =>
      `<span class="chip ${m.isHost ? 'host' : ''}">${m.isHost ? '👑 ' : ''}${esc(m.name)}</span>`
    ).join('');
  }

  function renderAlliances(){
    const tbody = document.getElementById('allianceTableBody');
    if(!tbody) return;
    if(state.alliances.length === 0){
      tbody.innerHTML = '<tr><td colspan="7" class="ally-table-empty">尚無同盟資料</td></tr>';
      return;
    }
    const sorted = getAlliancesSorted ? getAlliancesSorted() : [...state.alliances];
    const editingId = editingAllianceRowId;

    tbody.innerHTML = sorted.map((a, idx) => {
      const isEditing = (editingId === a.id);
      const cap = state.cities.find(c => c.allianceId === a.id && c.isCapital);
      const tagCls = a.side === 'self' ? 'tag-self' : (a.side === 'ally' ? 'tag-ally' : 'tag-enemy');
      const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
      const icon = a.icon || '';
      const avgPower = a.memberCount > 0 ? (Number(a.totalPower) || 0) / a.memberCount : 0;
      const yi = (Number(a.totalPower) || 0) / 1e8;

      if(isEditing){
        const sideOpts = ['self','ally','enemy'].map(s =>
          `<option value="${s}" ${s === a.side ? 'selected' : ''}>${allianceSideLabel(s)}</option>`
        ).join('');
        return `<tr data-alliance-id="${a.id}" data-idx="${idx}" class="inline-editing">
          <td class="drag-handle" title="拖曳排序">⠿</td>
          <td class="col-name">
            <div class="inline-icon-name">
              <input type="text" class="inline-icon-input" data-inline-field="icon" value="${esc(a.icon||'')}" maxlength="8" placeholder="⚔️">
              <input type="text" class="inline-name-input" data-inline-field="name" value="${esc(a.name)}" maxlength="20" placeholder="盟名稱">
            </div>
          </td>
          <td class="inline-select-td"><select data-inline-field="side">${sideOpts}</select></td>
          <td class="col-num"><input type="number" class="inline-num-input" data-inline-field="memberCount" value="${a.memberCount || 0}" min="1" step="1"></td>
          <td class="col-num">
            <div class="inline-power-wrap">
              <input type="number" class="inline-power-input" data-inline-field="totalPowerYi" value="${yi.toFixed(2)}" step="0.01" min="0">
              <span class="inline-unit">億</span>
            </div>
          </td>
          <td class="col-num inline-avg-preview" data-inline-preview="avgPower">—</td>
          <td class="col-actions">
            <button class="btn btn-success btn-sm" data-action="save-alliance-inline" data-id="${a.id}" title="儲存">💾</button>
            <button class="btn btn-ghost btn-sm" data-action="cancel-alliance-inline" data-id="${a.id}" title="取消">✕</button>
          </td>
        </tr>`;
      }

      return `<tr data-alliance-id="${a.id}" data-idx="${idx}" draggable="true">
        <td class="drag-handle" title="拖曳排序">⠿</td>
        <td class="col-name"><span class="alliance-tag ${tagCls}"></span>${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${esc(a.name)}${cap ? ` <span style="color:var(--neon-yellow);font-size:10px;">👑 ${esc(cap.name)}</span>` : ''}</td>
        <td><span class="chip ${chipCls}">${allianceSideLabel(a.side)}</span></td>
        <td class="col-num">${(a.memberCount||0).toLocaleString()}</td>
        <td class="col-num">${formatPower(a.totalPower)}</td>
        <td class="col-num">${formatAvgPower(avgPower)}</td>
        <td class="col-actions">
          <button class="btn btn-primary btn-sm" data-action="edit-alliance" data-id="${a.id}">✏️</button>
          <button class="btn btn-danger btn-sm" data-action="del-alliance" data-id="${a.id}">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    bindAllianceDragDrop(tbody);
    bindAllianceInlineEdit(tbody);

    if(hasTogglePerm() && Auth()){
      const canEdit = window.SLG.isInRoom() ? window.SLG.canEditRoomData() : Auth().canEditData();
      document.querySelectorAll('[data-action="edit-alliance"],[data-action="del-alliance"],[data-action="save-alliance-inline"],[data-action="cancel-alliance-inline"]').forEach(b => {
        window.SLG.togglePerm(b, canEdit, '需要編輯資料權限');
      });
    }
    renderIconQuickRow();
  }

  let dragSrcId = null;

  function bindAllianceDragDrop(tbody){
    const rows = tbody.querySelectorAll('tr[data-alliance-id]:not(.inline-editing)');
    rows.forEach(tr => {
      tr.addEventListener('dragstart', (e) => {
        if(editingAllianceRowId) return;
        dragSrcId = tr.dataset.allianceId;
        tr.classList.add('dragging');
        try{ e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragSrcId); }catch(_){}
      });
      tr.addEventListener('dragend', () => {
        tr.classList.remove('dragging');
        rows.forEach(r => { r.classList.remove('drag-over-top'); r.classList.remove('drag-over-bottom'); });
        dragSrcId = null;
      });
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        if(!dragSrcId || tr.dataset.allianceId === dragSrcId) return;
        const rect = tr.getBoundingClientRect();
        const isTop = e.clientY < rect.top + rect.height/2;
        rows.forEach(r => { r.classList.remove('drag-over-top'); r.classList.remove('drag-over-bottom'); });
        tr.classList.add(isTop ? 'drag-over-top' : 'drag-over-bottom');
      });
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        if(!dragSrcId) return;
        const tgtId = tr.dataset.allianceId;
        if(tgtId === dragSrcId) return;
        const currentOrder = getAlliancesSorted ? getAlliancesSorted().map(a => a.id) : [];
        const srcIdx = currentOrder.indexOf(dragSrcId);
        let tgtIdx = currentOrder.indexOf(tgtId);
        if(srcIdx < 0 || tgtIdx < 0) return;
        const rect = tr.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height/2;
        currentOrder.splice(srcIdx, 1);
        if(srcIdx < tgtIdx) tgtIdx -= 1;
        const insertPos = insertBefore ? tgtIdx : tgtIdx + 1;
        currentOrder.splice(insertPos, 0, dragSrcId);
        if(reorderAlliances) reorderAlliances(currentOrder);
        renderAlliances();
        if(typeof renderMatrix === 'function') renderMatrix();
        if(typeof renderOverview === 'function') renderOverview();
      });
    });
  }

  function bindAllianceInlineEdit(tbody){
    tbody.querySelectorAll('tr.inline-editing').forEach(tr => {
      const mcEl = tr.querySelector('[data-inline-field="memberCount"]');
      const tpEl = tr.querySelector('[data-inline-field="totalPowerYi"]');
      const preview = tr.querySelector('[data-inline-preview="avgPower"]');
      const updatePreview = () => {
        const mc = parseFloat(mcEl?.value) || 0;
        const yi = parseFloat(tpEl?.value) || 0;
        const total = Math.round(yi * 1e8);
        const avg = mc > 0 ? total / mc : 0;
        if(preview) preview.textContent = formatAvgPower(avg);
      };
      if(mcEl) mcEl.addEventListener('input', updatePreview);
      if(tpEl) tpEl.addEventListener('input', updatePreview);
      updatePreview();
    });
    tbody.querySelectorAll('tr.inline-editing input, tr.inline-editing select').forEach(el => {
      el.addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){
          e.preventDefault();
          const tr = el.closest('tr');
          const saveBtn = tr?.querySelector('[data-action="save-alliance-inline"]');
          if(saveBtn) saveBtn.click();
        } else if(e.key === 'Escape'){
          e.preventDefault();
          const tr = el.closest('tr');
          const cancelBtn = tr?.querySelector('[data-action="cancel-alliance-inline"]');
          if(cancelBtn) cancelBtn.click();
        }
      });
    });
  }

  function renderIconQuickRow(){
    const row = document.getElementById('iconQuickRow');
    if(!row) return;
    const excludeId = state.editingAllianceId || editingAllianceRowId || null;
    const icons = getAllianceIcons ? getAllianceIcons() : [];
    let html = '<span class="icon-quick-label">快速選擇盟徽：</span>';
    for(const icon of icons){
      const used = isAllianceIconUsed ? isAllianceIconUsed(icon, excludeId) : false;
      const cls = 'icon-quick' + (used ? ' icon-used' : '');
      html += `<button type="button" class="${cls}" data-icon="${icon}" title="${used ? '此盟徽已被使用' : ''}"${used ? ' disabled' : ''}>${icon}</button>`;
    }
    row.innerHTML = html;
    if(!row.dataset.bound){
      row.dataset.bound = '1';
      row.addEventListener('click', (e) => {
        const btn = e.target.closest('.icon-quick');
        if(!btn || btn.classList.contains('icon-used') || btn.disabled) return;
        const icon = btn.dataset.icon || '';
        const inlineInput = document.querySelector('tr.inline-editing [data-inline-field="icon"]');
        if(inlineInput){ inlineInput.value = icon; inlineInput.dispatchEvent(new Event('input', { bubbles: true })); return; }
        const input = document.getElementById('allyIcon');
        if(input){ input.value = icon; input.dispatchEvent(new Event('input', { bubbles: true })); }
      });
    }
  }

  function renderMatrix(){
    const wrap = document.getElementById('allianceMatrixWrap');
    if(!wrap) return;
    const alliances = getAlliancesSorted ? getAlliancesSorted() : [...state.alliances];
    if(alliances.length < 2){
      wrap.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;">至少需要 2 個同盟才能生成矩陣</div>';
      return;
    }
    const consume = (state.settings.consumeMinPerMin + state.settings.consumeMaxPerMin) / 2;
    let html = '<table class="matrix-table"><thead><tr>';
    html += '<th>發起方 ↓ / 對手 →</th>';
    alliances.forEach(a => {
      const avg = a.memberCount > 0 ? (Number(a.totalPower) || 0) / a.memberCount : 0;
      const icon = a.icon ? a.icon + ' ' : '';
      html += `<th>${icon}${esc(a.name)}<br><span style="font-size:9px;color:var(--text-dim);">均戰 ${formatAvgPower(avg)}</span></th>`;
    });
    html += '</tr></thead><tbody>';
    alliances.forEach(y => {
      const yAvg = y.memberCount > 0 ? (Number(y.totalPower) || 0) / y.memberCount : 1;
      const yIcon = y.icon ? y.icon + ' ' : '';
      html += `<tr><td class="row-label">${yIcon}${esc(y.name)}</td>`;
      alliances.forEach(x => {
        if(y.id === x.id){ html += '<td style="color:#334155;">—</td>'; }
        else {
          const xAvg = x.memberCount > 0 ? (Number(x.totalPower) || 0) / x.memberCount : 1;
          const total = yAvg + xAvg;
          const val = total > 0 ? (xAvg / total) * consume : 0;
          html += `<td>${val.toFixed(2)}</td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function renderCityMatrix(){
    const wrap = document.getElementById('cityMatrixWrap');
    if(!wrap) return;
    const zoneSel = document.getElementById('cityMatrixZone');
    const filterSel = document.getElementById('cityMatrixFilter');
    const zoneId = zoneSel ? zoneSel.value : 'all';
    const filter = filterSel ? filterSel.value : 'warOnly';

    let cities = state.cities.slice();
    if(zoneId !== 'all'){ cities = cities.filter(c => c.zoneId === zoneId); }
    if(filter === 'warOnly'){
      const citySet = new Set();
      for(const c of state.cities){
        const hasOutAtk = (c.attackTargets || []).some(t => t.cityId);
        const hasOutDef = (c.defendTargets || []).some(t => t.cityId);
        if(hasOutAtk || hasOutDef) citySet.add(c.id);
        for(const o of state.cities){
          for(const t of (o.attackTargets || [])){ if(t.cityId === c.id) citySet.add(c.id); }
          for(const t of (o.defendTargets || [])){ if(t.cityId === c.id) citySet.add(c.id); }
        }
      }
      cities = cities.filter(c => citySet.has(c.id));
    }
    if(cities.length < 2){
      wrap.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;">' +
        (cities.length === 0 ? '無符合條件的城池' : '至少需要 2 座城池才能生成矩陣') + '</div>';
      return;
    }
    cities.sort((a, b) => {
      if(a.zoneId !== b.zoneId) return (a.zoneId || '').localeCompare(b.zoneId || '');
      return a.name.localeCompare(b.name, 'zh-Hant');
    });
    const consume = (state.settings.consumeMinPerMin + state.settings.consumeMaxPerMin) / 2;
    let html = '<table class="matrix-table"><thead><tr>';
    html += '<th>發起城 ↓ / 對手 →</th>';
    cities.forEach(c => {
      const a = state.alliances.find(al => al.id === c.allianceId);
      const icon = (a && a.icon) ? a.icon + ' ' : '';
      const avg = c.totalTeams > 0 ? (Number(c.totalPower) || 0) / c.totalTeams : 0;
      html += `<th>${icon}${esc(c.name)}<br><span style="font-size:9px;color:var(--text-dim);">均戰 ${formatAvgPower(avg)}（${c.totalTeams || 0} 隊）</span></th>`;
    });
    html += '</tr></thead><tbody>';
    cities.forEach(y => {
      const yAvg = y.totalTeams > 0 ? (Number(y.totalPower) || 0) / y.totalTeams : 1;
      const ya = state.alliances.find(al => al.id === y.allianceId);
      const yIcon = (ya && ya.icon) ? ya.icon + ' ' : '';
      html += `<tr><td class="row-label">${yIcon}${esc(y.name)}</td>`;
      cities.forEach(x => {
        if(y.id === x.id){ html += '<td style="color:#334155;">—</td>'; }
        else {
          const xAvg = x.totalTeams > 0 ? (Number(x.totalPower) || 0) / x.totalTeams : 1;
          const total = yAvg + xAvg;
          const val = total > 0 ? (xAvg / total) * consume : 0;
          html += `<td>${val.toFixed(2)}</td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  function populateCityMatrixFilters(){
    const zoneSel = document.getElementById('cityMatrixZone');
    if(zoneSel){
      const cur = zoneSel.value;
      zoneSel.innerHTML = '<option value="all">全部</option>' +
        state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
      zoneSel.value = cur && state.zones.find(z => z.id === cur) ? cur : 'all';
    }
  }

  function renderZones(){
    const el = document.getElementById('zoneList');
    if(!el) return;
    el.innerHTML = state.zones.map(z =>
      `<span class="chip">${esc(z.name)} <button class="btn btn-primary btn-sm" style="padding:0 4px;margin-left:4px;" data-action="edit-zone" data-id="${z.id}" title="編輯名稱">✏️</button><button class="btn btn-danger btn-sm" style="padding:0 4px;margin-left:2px;" data-action="del-zone" data-id="${z.id}" title="刪除">✕</button></span>`
    ).join('') || '<span class="text-dim">尚無戰區</span>';

    const sim = document.getElementById('simZoneSelect');
    if(sim){
      const cur = sim.value;
      sim.innerHTML = '<option value="all">🌐 全戰區同時推演</option>' +
        state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
      sim.value = cur || 'all';
    }
    if(hasTogglePerm() && Auth()){
      const canEdit = window.SLG.isInRoom() ? window.SLG.canEditRoomData() : Auth().canEditData();
      document.querySelectorAll('[data-action="del-zone"],[data-action="edit-zone"]').forEach(b => {
        window.SLG.togglePerm(b, canEdit, '需要編輯資料權限');
      });
    }
  }

  function renderCities(){
    const el = document.getElementById('cityList');
    if(!el) return;
    if(state.cities.length === 0){
      el.innerHTML = '<div class="card"><div class="text-dim">尚無城池資料。</div></div>';
      return;
    }
    const grouped = {};
    for(const c of state.cities){
      const z = state.zones.find(z => z.id === c.zoneId);
      const key = z ? z.name : '未分配戰區';
      (grouped[key] ||= []).push(c);
    }
    let html = '';
    for(const zoneName in grouped){
      html += `<div class="card"><div class="card-title">🗺️ ${esc(zoneName)}</div>`;
      for(const c of grouped[zoneName]){
        const lock = state.editLocks[c.id];
        const locked = !!lock && lock.clientId !== state.myClientId;
        const alliance = state.alliances.find(a => a.id === c.allianceId);
        const alloc = computeAllocation(c);
        const overCls = alloc.over ? 'overdraft' : '';
        const capCls = c.isCapital ? 'capital' : '';
        const defStart = c.defStartTime || '19:00';
        const defEnd = minutesToHHMM(hhmmToMinutes(defStart) + state.settings.timeLimitMin);
        const allianceIcon = (alliance && alliance.icon) ? alliance.icon : '';
        html += `<div class="city-card ${locked ? 'locked' : ''} ${overCls} ${capCls}">`;
        html += `<div class="flex-row" style="justify-content:space-between;margin-bottom:6px;"><strong style="font-size:13px;">${c.isCapital ? '👑 ' : ''}${esc(c.name)} <span style="font-size:10px;color:var(--text-dim);">Lv.${c.level||1}</span>${c.code ? ` <span style="font-size:10px;color:var(--neon-blue);">[${esc(c.code)}]</span>` : ''}</strong><span class="chip ${sideClass(c.side)}">${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${sideLabel(c.side)}</span></div>`;
        if(alliance){
          html += `<div class="text-dim" style="margin-bottom:4px;">同盟：${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${esc(alliance.name)}</div>`;
        }
        html += `<div class="flex-row" style="margin-bottom:4px;"><span class="chip time">🕐 防守 ${esc(defStart)} – ${esc(defEnd)}</span></div>`;
        html += `<div class="flex-row" style="font-size:11px;color:var(--text-secondary);gap:12px;"><span>戰力 ${formatPower(c.totalPower)}</span><span>隊數 ${c.totalTeams}</span><span>均戰 ${formatAvgPower(c.avgPower)}</span></div>`;

        if(c.tierCounts){
          const tiers = state.troopTiers.tiers;
          const breakdown = [];
          if(c.tierCounts.tier1 > 0) breakdown.push(`≤${tiers[0].maxLevel}級: <b>${c.tierCounts.tier1}</b>人`);
          if(c.tierCounts.tier2 > 0) breakdown.push(`≤${tiers[1].maxLevel}級: <b>${c.tierCounts.tier2}</b>人`);
          if(c.tierCounts.tier3 > 0) breakdown.push(`≤${tiers[2].maxLevel}級: <b>${c.tierCounts.tier3}</b>人`);
          if(c.tierCounts.tier4 > 0) breakdown.push(`≥25級: <b>${c.tierCounts.tier4}</b>人`);
          if(breakdown.length > 0){
            html += `<div class="city-tier-detail">${breakdown.map(b => `<span>${b}</span>`).join('')}</div>`;
          }
        }

        if(alloc.over){
          html += `<div class="flex-row" style="font-size:11px;margin-top:4px;"><span class="text-warn">⚠️ 戰前派兵合計 ${alloc.allocated} 隊 ＞ 總隊數 ${alloc.totalTeams} 隊</span></div>`;
        } else {
          html += `<div class="flex-row" style="font-size:11px;gap:12px;margin-top:4px;"><span style="color:#ff8fa3;">⚔️ 戰前 ${alloc.atkSum} 隊</span><span style="color:#8fffb0;">🛡️ 協防 ${alloc.defSum} 隊</span><span style="color:#8ecbff;">🏰 留守 ${alloc.reserve} 隊</span></div>`;
        }
        html += `<div class="flex-row" style="font-size:11px;color:var(--text-dim);gap:12px;margin-top:4px;"><span>冷卻 ${c.cooldownMin}分</span><span>城牆 ${c.wallMin}分</span></div>`;
        if(c.attackTargets?.length){
          const list = c.attackTargets.filter(t => (t.preWarPercent||0)>0 && t.cityId).map(t => {
            const tgt = state.cities.find(cc => cc.id === t.cityId);
            return tgt ? `<span class="chip enemy">${esc(tgt.name)} 戰${t.preWarPercent}% 復${t.postRevivePercent}% #${t.priority}${t.attackStartTime ? ' @'+t.attackStartTime : ''}</span>` : null;
          }).filter(Boolean);
          if(list.length) html += `<div style="margin-top:4px;">⚔️ ${list.join(' ')}</div>`;
        }
        if(c.defendTargets?.length){
          const list = c.defendTargets.filter(t => (t.preWarPercent||0)>0 && t.cityId).map(t => {
            const tgt = state.cities.find(cc => cc.id === t.cityId);
            return tgt ? `<span class="chip ally">${esc(tgt.name)} 戰${t.preWarPercent}% 復${t.postRevivePercent}% #${t.priority}</span>` : null;
          }).filter(Boolean);
          if(list.length) html += `<div style="margin-top:4px;">🛡️ ${list.join(' ')}</div>`;
        }
        html += `<div class="flex-row mt-8"><button class="btn btn-primary btn-sm" data-action="edit-city" data-id="${c.id}">✏️ 編輯</button><button class="btn btn-danger btn-sm" data-action="del-city" data-id="${c.id}">🗑️ 刪除</button></div></div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;
    if(hasTogglePerm() && Auth()){
      const canEdit = window.SLG.isInRoom() ? window.SLG.canEditRoomData() : Auth().canEditData();
      document.querySelectorAll('[data-action="edit-city"],[data-action="del-city"]').forEach(b => {
        window.SLG.togglePerm(b, canEdit, '需要編輯資料權限');
      });
    }
  }

  function renderNarrative(lines){
    const el = document.getElementById('narrativeOutput');
    if(!el) return;
    if(!lines || lines.length === 0){
      el.innerHTML = '<span class="text-dim">尚未推演，或無關鍵事件。</span>';
      return;
    }
    el.innerHTML = lines.map(l => {
      const cls = l.type === 'warn' ? 'event-warn'
                : l.type === 'capture' ? 'event-capture'
                : l.type === 'revive' ? 'event-revive' : 'event-info';
      return `<div class="narrative-line ${cls}">${esc(l.text)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function renderChat(){
    const el = document.getElementById('chatMessages');
    if(!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const frag = document.createDocumentFragment();
    for(const m of state.chatMessages){
      const div = document.createElement('div');
      div.className = 'msg ' + (m.isSystem ? 'system' : (m.isSelf ? 'self' : 'other'));
      if(m.isSystem){ div.textContent = m.text; }
      else {
        div.innerHTML = `<div class="sender">${esc(m.sender)}</div><div>${esc(m.text)}</div><div class="time">${esc(m.time || '')}</div>`;
      }
      frag.appendChild(div);
    }
    el.innerHTML = '';
    el.appendChild(frag);
    if(atBottom) el.scrollTop = el.scrollHeight;
  }

  function renderChatBadge(){
    const badge = document.getElementById('chatBadge');
    if(!badge) return;
    if(state.unreadChat > 0){
      badge.textContent = state.unreadChat > 99 ? '99+' : state.unreadChat;
      badge.classList.add('show');
    } else { badge.classList.remove('show'); }
  }

  function renderProgress(p){
    const bar = document.getElementById('simProgress');
    if(bar) bar.style.width = Math.round(p*100) + '%';
  }

  function renderAll(){
    renderHealth(); renderHost(); renderMembers();
    renderAlliances(); renderZones(); renderCities();
    renderChat(); renderChatBadge();
    renderMatrix();
    populateCityMatrixFilters();
    renderCityMatrix();
    renderSyncStatus();
    if(typeof window.SLG.renderOverview === 'function') window.SLG.renderOverview();
  }

  function startInlineEditAlliance(id){
    if(editingAllianceRowId === id) return;
    editingAllianceRowId = id;
    renderAlliances();
    setTimeout(() => {
      const tr = document.querySelector(`tr[data-alliance-id="${id}"]`);
      if(tr){
        const nameInput = tr.querySelector('[data-inline-field="name"]');
        if(nameInput){ nameInput.focus(); nameInput.select(); }
      }
    }, 0);
  }
  function cancelInlineEditAlliance(){ editingAllianceRowId = null; renderAlliances(); }

  function saveInlineEditAlliance(id){
    const tr = document.querySelector(`tr[data-alliance-id="${id}"]`);
    if(!tr) return false;
    const alliance = state.alliances.find(a => a.id === id);
    if(!alliance) return false;
    const getVal = (field) => {
      const el = tr.querySelector(`[data-inline-field="${field}"]`);
      return el ? el.value : '';
    };
    const icon = String(getVal('icon') || '').trim();
    const name = String(getVal('name') || '').trim();
    const side = String(getVal('side') || 'ally');
    const memberCount = parseFloat(getVal('memberCount')) || 0;
    const totalPowerYi = parseFloat(getVal('totalPowerYi')) || 0;
    const totalPower = Math.round(totalPowerYi * 1e8);

    if(!name){ alert('盟名稱不能為空'); return false; }
    if(name.length > 20){ alert('盟名稱最多 20 字'); return false; }
    if(memberCount <= 0){ alert('總人數必須大於 0'); return false; }
    if(icon && isAllianceIconUsed && isAllianceIconUsed(icon, id)){
      alert('❌ 此盟徽已被其他盟使用，請更換'); return false;
    }
    if(side === 'self'){
      state.alliances.forEach(a => {
        if(a.side === 'self' && a.id !== id){
          a.side = 'enemy';
          state.entityRev.alliance[a.id] = (state.entityRev.alliance[a.id] || 0) + 1;
          window.SLG.markDirty('alliance', a.id);
        }
      });
    }
    const avgPower = totalPower / memberCount;
    window.SLG.upsertEntity('alliance', {
      id, name, icon, side, memberCount, totalPower, avgPower, power: totalPower,
      order: typeof alliance.order === 'number' ? alliance.order : 9999,
      createdAt: alliance.createdAt || Date.now(),
    });
    editingAllianceRowId = null;
    renderAlliances();
    if(typeof renderMatrix === 'function') renderMatrix();
    if(window.SLG.CityManager) window.SLG.CityManager.render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(typeof renderOverview === 'function') renderOverview();
    window.SLG.saveState();
    logSystem(`✅ 已儲存同盟：${name}`);
    return true;
  }

  return {
    renderHealth, renderHost, renderDebug, renderMembers,
    renderAlliances, renderMatrix, renderCityMatrix, populateCityMatrixFilters,
    renderIconQuickRow, renderZones, renderCities,
    renderNarrative, renderChat, renderChatBadge, renderProgress,
    renderAll, renderSyncStatus,
    startInlineEditAlliance, cancelInlineEditAlliance, saveInlineEditAlliance,
    getEditingAllianceRowId: () => editingAllianceRowId,
    getEditingCityRowId: () => editingCityRowId,
  };
})();

/* ====== 第 1/4 段結束（DYN 模組將於第 2 段開始） ====== */
 /* ============================================================
   DYN — 動態戰報
   ============================================================ */
const DYN = (() => {
  let allRows = [];
  function setRows(rows){ allRows = rows || []; renderSummary(); renderTable(); }
  function renderSummary(){
    const el = document.getElementById('dynSummary');
    if(!el) return;
    if(allRows.length === 0){ el.textContent = '尚未推演'; return; }
    const routes = new Set();
    allRows.forEach(r => routes.add(`${r.srcId}→${r.tgtId}`));
    el.innerHTML = `共 <b>${allRows.length}</b> 筆 · <b>${routes.size}</b> 條路線`;
  }
  function getFilters(){
    return {
      granularity: parseFloat(document.getElementById('dynGranularity').value) || 5,
      action: document.getElementById('dynAction').value || 'all',
      srcCity: document.getElementById('dynSrcCity').value || 'all',
      tgtCity: document.getElementById('dynTgtCity').value || 'all',
    };
  }
  function formatFullTime(sec){
    const totalSec = ((state.simBaseMin || 0) * 60) + sec;
    const h = Math.floor(totalSec / 3600) % 24;
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  function renderTable(){
    const tbody = document.getElementById('dynTableBody');
    if(!tbody) return;
    if(allRows.length === 0){
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-dim);padding:20px;">尚未推演</td></tr>';
      return;
    }
    const f = getFilters();
    const granSec = Math.round(f.granularity * 60);
    const thConsume = document.querySelector('#dynTable thead tr th:nth-child(5)');
    if(thConsume) thConsume.textContent = (granSec === 30) ? '本30秒消耗' : '本分鐘消耗(速率)';
    const filtered = allRows.filter(r => {
      if(f.action === 'attack' && !r.isAttack) return false;
      if(f.action === 'defend' && r.isAttack) return false;
      if(f.srcCity !== 'all' && r.srcId !== f.srcCity) return false;
      if(f.tgtCity !== 'all' && r.tgtId !== f.tgtCity) return false;
      return true;
    });
    const grouped = new Map();
    for(const r of filtered){
      const roundedSec = Math.round(r.sec / granSec) * granSec;
      const key = `${roundedSec}|${r.srcId}|${r.tgtId}|${r.isAttack?1:0}`;
      if(!grouped.has(key)) grouped.set(key, r);
    }
    const rows = [...grouped.values()].sort((a,b) => a.sec - b.sec || a.srcCity.localeCompare(b.srcCity));
    if(rows.length === 0){
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-dim);padding:20px;">無資料</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const timeStr = (granSec === 30)
        ? formatFullTime(r.sec)
        : minutesToHHMM((state.simBaseMin || 0) + Math.floor(r.sec / 60));
      const actTxt = r.isAttack ? '⚔️ 進攻' : '🛡️ 協防';
      const wallDisplay = r.tgtFallen ? '🏳️ 城已破' : (r.wallSec / 60).toFixed(1) + ' 分';
      const consumeDisplay = ((r.consumeThisMin||0) * (granSec === 30 ? 0.5 : 1)).toFixed(1);
      return `<tr>
        <td class="time-cell">${esc(timeStr)}</td>
        <td class="atk-cell">${esc(r.srcCity)}城(${sideLabel(r.srcSide)})</td>
        <td class="${r.isAttack ? 'atk' : 'def'}">${actTxt}</td>
        <td class="def-cell">${esc(r.tgtCity)}城(${sideLabel(r.tgtSide)})</td>
        <td class="consumed">${consumeDisplay}</td>
        <td class="num-stay">${r.ownRemain}</td>
        <td class="num-cd">${r.ownCd} + ${r.ownMarch}</td>
        <td class="num-stay">${r.tgtRemain}</td>
        <td class="num-cd">${r.tgtCd} + ${r.tgtMarch}</td>
        <td>${wallDisplay}</td>
      </tr>`;
    }).join('');
  }
  function populateCityFilters(){
    const cities = state.cities;
    const srcSel = document.getElementById('dynSrcCity');
    const tgtSel = document.getElementById('dynTgtCity');
    if(srcSel){
      const cur = srcSel.value;
      srcSel.innerHTML = '<option value="all">全部</option>' +
        cities.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      srcSel.value = cur && cities.find(c => c.id === cur) ? cur : 'all';
    }
    if(tgtSel){
      const cur = tgtSel.value;
      tgtSel.innerHTML = '<option value="all">全部</option>' +
        cities.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      tgtSel.value = cur && cities.find(c => c.id === cur) ? cur : 'all';
    }
  }
  function copyAsTSV(){
    const tbody = document.getElementById('dynTableBody');
    if(!tbody) return;
    const headers = ['時間點','進攻方','行動','防守方','本時段消耗','進攻方剩餘','進攻方待復活','防守方剩餘','防守方待復活','城牆剩餘'];
    const lines = [headers.join('\t')];
    tbody.querySelectorAll('tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      if(cells.length === 10) lines.push(cells.join('\t'));
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => alert('已複製')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = lines.join('\n');
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      alert('已複製');
    });
  }
  function init(){
    ['dynGranularity','dynAction','dynSrcCity','dynTgtCity'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.addEventListener('change', renderTable);
    });
    const btn = document.getElementById('btnDynCopy');
    if(btn) btn.addEventListener('click', copyAsTSV);
    on(EVT.DYN_RESULT, () => { setRows(state.dynRows); populateCityFilters(); });
  }
  return { init, setRows, renderTable, populateCityFilters };
})();

/* ============================================================
   DEPLOY — 佈兵總覽
   ============================================================ */
const DEPLOY = (() => {
  let currentView = 'attack';
  function init(){
    document.querySelectorAll('.deploy-tab').forEach(tab => {
      tab.addEventListener('click', function(){
        document.querySelectorAll('.deploy-tab').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        currentView = this.dataset.view;
        const ctrl = document.getElementById('deployLayoutCtrl');
        if (ctrl) ctrl.style.display = (currentView === 'graph') ? '' : 'none';
        render();
      });
    });
    ['deployZone','deploySide','deployFilter','deploySort','deployLayout'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', render);
    });
    const exportBtn = document.getElementById('btnDeployExport');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);
  }
  function populateZoneFilter(){
    const sel = document.getElementById('deployZone');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="all">全部</option>' +
      state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
    if (cur && state.zones.find(z => z.id === cur)) sel.value = cur;
  }
  function getConflictInfo(){
    const map = new Map();
    for(const c of state.cities){
      let incoming = 0;
      for(const o of state.cities){
        (o.attackTargets||[]).forEach(t => {
          if (t.cityId === c.id && (t.preWarPercent||0) > 0)
            incoming += Math.floor((o.totalTeams||0) * t.preWarPercent / 100);
        });
        (o.defendTargets||[]).forEach(t => {
          if (t.cityId === c.id && (t.preWarPercent||0) > 0)
            incoming += Math.floor((o.totalTeams||0) * t.preWarPercent / 100);
        });
      }
      const own = c.totalTeams || 0;
      const conflict = own > 0 && incoming > own * 1.2;
      map.set(c.id, { incoming, own, conflict });
    }
    return map;
  }
  function getFilteredCities(conflictMap){
    const zoneId = document.getElementById('deployZone').value;
    const side = document.getElementById('deploySide').value;
    const filter = document.getElementById('deployFilter').value;
    let cities = state.cities.filter(c => {
      if (zoneId !== 'all' && c.zoneId !== zoneId) return false;
      if (side !== 'all' && c.side !== side) return false;
      if (filter === 'hasAction'){
        const hasAtk = (c.attackTargets || []).some(t => (t.preWarPercent||0) > 0);
        const hasDef = (c.defendTargets || []).some(t => (t.preWarPercent||0) > 0);
        const isAttacked = state.cities.some(o =>
          (o.attackTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0) > 0));
        const isDefended = state.cities.some(o =>
          (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0) > 0));
        if (!hasAtk && !hasDef && !isAttacked && !isDefended) return false;
      }
      if (filter === 'overdraft'){
        const alloc = computeAllocation(c);
        if (!alloc.over) return false;
      }
      if (filter === 'conflict'){
        const info = conflictMap.get(c.id);
        if (!info || !info.conflict) return false;
      }
      return true;
    });
    const sortBy = document.getElementById('deploySort').value;
    if (sortBy === 'totalTeams') cities.sort((a, b) => (b.totalTeams||0) - (a.totalTeams||0));
    else if (sortBy === 'deployed') cities.sort((a, b) => computeAllocation(b).allocated - computeAllocation(a).allocated);
    else if (sortBy === 'reserve') cities.sort((a, b) => computeAllocation(a).reserve - computeAllocation(b).reserve);
    else if (sortBy === 'incoming') cities.sort((a, b) => (conflictMap.get(b.id)?.incoming||0) - (conflictMap.get(a.id)?.incoming||0));
    return cities;
  }
  function allianceIconOf(city){
    const a = state.alliances.find(al => al.id === city.allianceId);
    return (a && a.icon) ? a.icon : '';
  }
  function cityNameWithCode(city){
    if(!city) return '';
    return city.code ? `${city.name} [${city.code}]` : city.name;
  }
  function renderAttackView(cities, conflictMap){
    let html = `<div class="deploy-table-wrap"><table class="deploy-table">
      <thead><tr>
        <th>出兵城</th><th>陣營</th><th>總隊數</th>
        <th>⚔️ 進攻指示</th><th>🛡️ 協防指示</th>
        <th>留守</th><th>受兵量</th><th>操作</th>
      </tr></thead><tbody>`;
    for(const c of cities){
      const alloc = computeAllocation(c);
      const sideCls = sideClass(c.side);
      const info = conflictMap.get(c.id) || { incoming: 0, conflict: false };
      const icon = allianceIconOf(c);
      const atkChips = (c.attackTargets || []).filter(t => (t.preWarPercent||0) > 0 && t.cityId).map(t => {
        const tgt = state.cities.find(cc => cc.id === t.cityId);
        if (!tgt) return '';
        const timeStr = t.attackStartTime ? ` @${t.attackStartTime}` : '';
        return `<span class="deploy-chip atk">→ ${esc(cityNameWithCode(tgt))} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}${timeStr}</span></span>`;
      }).join('');
      const defChips = (c.defendTargets || []).filter(t => (t.preWarPercent||0) > 0 && t.cityId).map(t => {
        const tgt = state.cities.find(cc => cc.id === t.cityId);
        if (!tgt) return '';
        return `<span class="deploy-chip def">→ ${esc(cityNameWithCode(tgt))} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const reserve = alloc.reserve;
      const reserveCls = alloc.over ? 'warn' : 'ok';
      const reservePct = c.totalTeams > 0 ? Math.round(reserve / c.totalTeams * 100) : 0;
      const conflictIcon = info.conflict ? '<span class="conflict-icon" title="受兵量超過自身兵力">⚠️</span>' : '';
      html += `<tr class="${info.conflict ? 'conflict-row' : ''}">
        <td class="city-name ${c.side==='enemy'?'city-fallen':''}">${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${c.isCapital ? '👑 ' : ''}${esc(cityNameWithCode(c))}${conflictIcon}</td>
        <td><span class="chip ${sideCls}">${sideLabel(c.side)}</span></td>
        <td>${c.totalTeams}</td>
        <td>${atkChips || '<span class="deploy-chip none">無</span>'}</td>
        <td>${defChips || '<span class="deploy-chip none">無</span>'}</td>
        <td><span class="deploy-reserve ${reserveCls}">${reserve} 隊 (${reservePct}%)</span></td>
        <td><b style="color:${info.conflict ? 'var(--neon-red)' : (info.incoming > 0 ? 'var(--neon-yellow)' : 'var(--text-dim)')};">${info.incoming} 隊</b></td>
        <td><button class="btn btn-primary btn-sm" data-deploy-edit="${c.id}">✏️</button></td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    document.getElementById('deployTableWrap').innerHTML = html;
  }
  function renderDefendView(cities, conflictMap){
    let html = `<div class="deploy-table-wrap"><table class="deploy-table">
      <thead><tr>
        <th>目標城</th><th>陣營</th><th>總隊數</th>
        <th>⚔️ 被誰進攻</th><th>🛡️ 被誰協防</th>
        <th>總受兵</th><th>操作</th>
      </tr></thead><tbody>`;
    for(const c of cities){
      const attackerChips = state.cities.filter(o =>
        (o.attackTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0) > 0)
      ).map(o => {
        const t = o.attackTargets.find(t => t.cityId === c.id);
        const timeStr = t.attackStartTime ? ` @${t.attackStartTime}` : '';
        return `<span class="deploy-chip atk">← ${esc(cityNameWithCode(o))} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}${timeStr}</span></span>`;
      }).join('');
      const defenderChips = state.cities.filter(o =>
        (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0) > 0)
      ).map(o => {
        const t = o.defendTargets.find(t => t.cityId === c.id);
        return `<span class="deploy-chip def">← ${esc(cityNameWithCode(o))} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const info = conflictMap.get(c.id) || { incoming: 0, conflict: false };
      const sideCls = sideClass(c.side);
      const icon = allianceIconOf(c);
      const conflictIcon = info.conflict ? '<span class="conflict-icon" title="受兵量超過自身兵力">⚠️</span>' : '';
      html += `<tr class="${info.conflict ? 'conflict-row' : ''}">
        <td class="city-name ${c.side==='enemy'?'city-fallen':''}">${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${c.isCapital ? '👑 ' : ''}${esc(cityNameWithCode(c))}${conflictIcon}</td>
        <td><span class="chip ${sideCls}">${sideLabel(c.side)}</span></td>
        <td>${c.totalTeams}</td>
        <td>${attackerChips || '<span class="deploy-chip none">無</span>'}</td>
        <td>${defenderChips || '<span class="deploy-chip none">無</span>'}</td>
        <td><b style="color:${info.conflict ? 'var(--neon-red)' : (info.incoming > 0 ? 'var(--neon-yellow)' : 'var(--text-dim)')};">${info.incoming} 隊</b></td>
        <td><button class="btn btn-primary btn-sm" data-deploy-edit="${c.id}">✏️</button></td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    document.getElementById('deployTableWrap').innerHTML = html;
  }
  function renderMatrixView(cities, conflictMap){
    const activeCities = cities.filter(c => {
      const hasOut = (c.attackTargets||[]).some(t => (t.preWarPercent||0)>0 && t.cityId) ||
                     (c.defendTargets||[]).some(t => (t.preWarPercent||0)>0 && t.cityId);
      const hasIn = state.cities.some(o =>
        (o.attackTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0) ||
        (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0)
      );
      return hasOut || hasIn;
    });
    if (activeCities.length === 0){
      document.getElementById('deployTableWrap').innerHTML = '<div class="empty-hint">無任何派兵或受擊關係。</div>';
      return;
    }
    let html = '<div class="deploy-table-wrap"><table class="deploy-matrix"><thead><tr>';
    html += '<th class="row-header">出兵城 \\ 目標城</th>';
    for(const c of activeCities){
      const info = conflictMap.get(c.id) || { conflict: false };
      const conflictIcon = info.conflict ? '<span class="conflict-icon">⚠️</span>' : '';
      const icon = allianceIconOf(c);
      html += `<th>${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${esc(cityNameWithCode(c))}${conflictIcon}</th>`;
    }
    html += '</tr></thead><tbody>';
    for(const src of activeCities){
      const srcIcon = allianceIconOf(src);
      html += `<tr><td class="row-header">${srcIcon ? `<span class="alliance-icon">${srcIcon}</span>` : ''}${src.isCapital ? '👑 ' : ''}${esc(cityNameWithCode(src))}</td>`;
      for(const tgt of activeCities){
        if (src.id === tgt.id){ html += '<td class="cell-self">—</td>'; continue; }
        const atk = (src.attackTargets||[]).find(t => t.cityId === tgt.id);
        const def = (src.defendTargets||[]).find(t => t.cityId === tgt.id);
        if (atk && (atk.preWarPercent||0) > 0){
          html += `<td class="cell-atk">⚔️ ${atk.preWarPercent}%<br><span style="font-size:9px;color:var(--text-dim);">#${atk.priority}</span></td>`;
        } else if (def && (def.preWarPercent||0) > 0){
          html += `<td class="cell-def">🛡️ ${def.preWarPercent}%<br><span style="font-size:9px;color:var(--text-dim);">#${def.priority}</span></td>`;
        } else {
          html += '<td class="cell-empty">·</td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    document.getElementById('deployTableWrap').innerHTML = html;
  }
  function renderGraphView(cities, conflictMap){
    const wrap = document.getElementById('deployTableWrap');
    const activeCities = cities.filter(c => {
      const hasOut = (c.attackTargets||[]).some(t => (t.preWarPercent||0)>0 && t.cityId) ||
                     (c.defendTargets||[]).some(t => (t.preWarPercent||0)>0 && t.cityId);
      const hasIn = state.cities.some(o =>
        (o.attackTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0) ||
        (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0)
      );
      return hasOut || hasIn;
    });
    if (activeCities.length === 0){
      wrap.innerHTML = '<div class="empty-hint">無任何派兵或受擊關係。</div>';
      return;
    }
    const W = 1000, H = 1000, CX = 500, CY = 500;
    const R = Math.min(W, H) * 0.36;
    const N = activeCities.length;
    const positions = new Map();
    activeCities.forEach((c, i) => {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      positions.set(c.id, { x: CX + Math.cos(ang) * R, y: CY + Math.sin(ang) * R });
    });
    const maxTeams = Math.max(...activeCities.map(c => c.totalTeams || 1), 1);
    const nodeRadius = (c) => {
      const t = c.totalTeams || 0;
      return 14 + Math.sqrt(t / maxTeams) * 16;
    };
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const defs = document.createElementNS(ns, 'defs');
    const mkArrow = (id, color) => {
      const marker = document.createElementNS(ns, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '5');
      marker.setAttribute('markerHeight', '5');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('fill', color);
      marker.appendChild(path);
      return marker;
    };
    defs.appendChild(mkArrow('arrow-atk', '#ff4466'));
    defs.appendChild(mkArrow('arrow-def', '#22ff88'));
    svg.appendChild(defs);

    const edgesG = document.createElementNS(ns, 'g');
    const radiusById = new Map();
    activeCities.forEach(c => radiusById.set(c.id, nodeRadius(c)));

    for (const src of activeCities){
      const fromPos = positions.get(src.id);
      if (!fromPos) continue;
      const fromR = radiusById.get(src.id) || 20;
      const addEdge = (targetId, pct, isAttack) => {
        if ((pct||0) <= 0 || !targetId) return;
        const toPos = positions.get(targetId);
        if (!toPos) return;
        const toR = radiusById.get(targetId) || 20;
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'graph-edge ' + (isAttack ? 'atk' : 'def'));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', isAttack ? 'rgba(255,68,102,.45)' : 'rgba(34,255,136,.45)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('marker-end', isAttack ? 'url(#arrow-atk)' : 'url(#arrow-def)');
        const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y;
        const dist = Math.hypot(dx, dy);
        const ux = dx/dist, uy = dy/dist;
        const sx = fromPos.x + ux * (fromR + 3);
        const sy = fromPos.y + uy * (fromR + 3);
        const ex = toPos.x - ux * (toR + 5);
        const ey = toPos.y - uy * (toR + 5);
        path.setAttribute('d', `M ${sx} ${sy} L ${ex} ${ey}`);
        edgesG.appendChild(path);
      };
      for (const t of (src.attackTargets || [])) addEdge(t.cityId, t.preWarPercent, true);
      for (const t of (src.defendTargets || [])) addEdge(t.cityId, t.preWarPercent, false);
    }
    svg.appendChild(edgesG);

    const nodesG = document.createElementNS(ns, 'g');
    for (const c of activeCities){
      const pos = positions.get(c.id);
      if (!pos) continue;
      const r = nodeRadius(c);
      const sideColors = { self:'#3b82f6', ally:'#10b981', enemy:'#ef4444', common_enemy:'#f59e0b', npc:'#a855f7' };
      const g = document.createElementNS(ns, 'g');
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', pos.x);
      circle.setAttribute('cy', pos.y);
      circle.setAttribute('r', r);
      circle.setAttribute('fill', sideColors[c.side] || '#64748b');
      circle.setAttribute('stroke', 'rgba(255,255,255,.3)');
      circle.setAttribute('stroke-width', '1.5');
      g.appendChild(circle);
      const a = state.alliances.find(al => al.id === c.allianceId);
      if (a && a.icon){
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', pos.x);
        text.setAttribute('y', pos.y + 4);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', r * 1.1);
        text.setAttribute('pointer-events', 'none');
        text.textContent = a.icon;
        g.appendChild(text);
      }
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', pos.x);
      label.setAttribute('y', pos.y + r + 14);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '11');
      label.setAttribute('font-weight', '700');
      label.setAttribute('fill', '#e2e8f0');
      label.setAttribute('pointer-events', 'none');
      label.textContent = c.code ? `${c.name} [${c.code}]` : c.name;
      g.appendChild(label);
      nodesG.appendChild(g);
    }
    svg.appendChild(nodesG);

    wrap.innerHTML = '';
    const gw = document.createElement('div');
    gw.className = 'deploy-graph-wrap';
    gw.appendChild(svg);
    wrap.appendChild(gw);
  }
  function renderSummary(cities, conflictMap){
    const totalCities = cities.length;
    const withAtk = cities.filter(c => (c.attackTargets||[]).some(t => (t.preWarPercent||0)>0)).length;
    const withDef = cities.filter(c => (c.defendTargets||[]).some(t => (t.preWarPercent||0)>0)).length;
    const overdraft = cities.filter(c => computeAllocation(c).over).length;
    const conflict = cities.filter(c => conflictMap.get(c.id)?.conflict).length;
    const totalDeployed = cities.reduce((sum, c) => sum + computeAllocation(c).allocated, 0);
    const totalTeams = cities.reduce((sum, c) => sum + (c.totalTeams || 0), 0);
    document.getElementById('deploySummary').innerHTML = `
      📊 共 <b>${totalCities}</b> 座城 · 
      ⚔️ 有進攻指示 <b>${withAtk}</b> 座 · 
      🛡️ 有協防指示 <b>${withDef}</b> 座 · 
      ⚠️ 超額派兵 <b>${overdraft}</b> 座 · 
      🚨 衝堂警示 <b style="color:var(--neon-red);">${conflict}</b> 座 · 
      總派兵 <b>${totalDeployed}</b> 隊 / 總兵力 <b>${totalTeams}</b> 隊
    `;
  }
  function render(){
    const conflictMap = getConflictInfo();
    const cities = getFilteredCities(conflictMap);
    if (currentView === 'attack') renderAttackView(cities, conflictMap);
    else if (currentView === 'defend') renderDefendView(cities, conflictMap);
    else if (currentView === 'matrix') renderMatrixView(cities, conflictMap);
    else if (currentView === 'graph') renderGraphView(cities, conflictMap);
    renderSummary(cities, conflictMap);
    document.querySelectorAll('[data-deploy-edit]').forEach(btn => {
      btn.addEventListener('click', function(){
        if(window.SLG.isInRoom()){
          if(!window.SLG.canEditRoomData()) return;
        } else if(Auth() && !Auth().canEditData()) return;
        if(typeof window.SLG.openCityModal === 'function') window.SLG.openCityModal(this.dataset.deployEdit);
      });
      if(hasTogglePerm() && Auth()){
        const canEdit = window.SLG.isInRoom() ? window.SLG.canEditRoomData() : Auth().canEditData();
        window.SLG.togglePerm(btn, canEdit, '需要編輯資料權限');
      }
    });
  }
  function exportCSV(){
    const conflictMap = getConflictInfo();
    const cities = getFilteredCities(conflictMap);
    let headers, rows;
    if (currentView === 'attack'){
      headers = ['出兵城', '陣營', '總隊數', '進攻指示', '協防指示', '留守隊數', '留守%', '受兵量', '衝堂警示'];
      rows = cities.map(c => {
        const alloc = computeAllocation(c);
        const info = conflictMap.get(c.id) || { incoming: 0, conflict: false };
        const atkStr = (c.attackTargets||[]).filter(t => (t.preWarPercent||0)>0 && t.cityId).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          if (!tgt) return '';
          const timeStr = t.attackStartTime ? ` @${t.attackStartTime}` : '';
          return `${tgt.name} ${t.preWarPercent}% #${t.priority}${timeStr}`;
        }).filter(Boolean).join(' | ');
        const defStr = (c.defendTargets||[]).filter(t => (t.preWarPercent||0)>0 && t.cityId).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}% #${t.priority}` : '';
        }).filter(Boolean).join(' | ');
        const reservePct = c.totalTeams > 0 ? Math.round(alloc.reserve / c.totalTeams * 100) : 0;
        return [c.name, sideLabel(c.side), c.totalTeams, atkStr || '-', defStr || '-', alloc.reserve, `${reservePct}%`, info.incoming, info.conflict ? '⚠️ 警示' : '正常'];
      });
    } else if (currentView === 'defend'){
      headers = ['目標城', '陣營', '總隊數', '被誰進攻', '被誰協防', '總受兵', '衝堂警示'];
      rows = cities.map(c => {
        const info = conflictMap.get(c.id) || { incoming: 0, conflict: false };
        const atkStr = state.cities.filter(o => (o.attackTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0))
          .map(o => {
            const t = o.attackTargets.find(t => t.cityId === c.id);
            const timeStr = t.attackStartTime ? ` @${t.attackStartTime}` : '';
            return `${o.name} ${t.preWarPercent}% #${t.priority}${timeStr}`;
          }).join(' | ');
        const defStr = state.cities.filter(o => (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0))
          .map(o => { const t = o.defendTargets.find(t => t.cityId === c.id); return `${o.name} ${t.preWarPercent}% #${t.priority}`; }).join(' | ');
        return [c.name, sideLabel(c.side), c.totalTeams, atkStr || '-', defStr || '-', info.incoming, info.conflict ? '⚠️ 警示' : '正常'];
      });
    } else {
      headers = ['出兵城', '目標城', '行動', '派兵%', '優先順序'];
      rows = [];
      for(const src of cities){
        for(const t of (src.attackTargets||[])){
          if ((t.preWarPercent||0) <= 0 || !t.cityId) continue;
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          if (!tgt) continue;
          rows.push([src.name, tgt.name, '進攻', t.preWarPercent + '%', t.priority]);
        }
        for(const t of (src.defendTargets||[])){
          if ((t.preWarPercent||0) <= 0 || !t.cityId) continue;
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          if (!tgt) continue;
          rows.push([src.name, tgt.name, '協防', t.preWarPercent + '%', t.priority]);
        }
      }
    }
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const viewName = currentView === 'attack' ? '出兵'
                    : currentView === 'defend' ? '受擊'
                    : currentView === 'graph' ? '連線圖' : '矩陣';
    a.href = url;
    a.download = `佈兵總覽_${viewName}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logSystem('📥 已匯出 CSV');
  }
  return { init, render, populateZoneFilter };
})();

/* ============================================================
   CityManager — 城池清單表格 + 批次操作 + 行內編輯 + 分級 Inline
   ============================================================ */
const CityManager = (() => {
  let currentView = 'table';

  function init(){
    const btn = document.getElementById('btnCityViewToggle');
    if(btn){
      btn.addEventListener('click', function(){
        currentView = currentView === 'table' ? 'card' : 'table';
        this.textContent = currentView === 'table' ? '🃏 卡片檢視' : '📋 表格檢視';
        const tv = document.getElementById('cityTableView');
        const cv = document.getElementById('cityCardView');
        if(tv) tv.style.display = currentView === 'table' ? '' : 'none';
        if(cv) cv.style.display = currentView === 'card' ? '' : 'none';
        render();
      });
    }

    ['cityFilterZone','cityFilterAlliance','cityFilterSide','citySearchInput'].forEach(id => {
      const el = document.getElementById(id);
      if(el){
        el.addEventListener('input', render);
        el.addEventListener('change', render);
      }
    });

    const selAll = document.getElementById('citySelectAll');
    if(selAll){
      selAll.addEventListener('change', function(){
        document.querySelectorAll('.city-table .city-cb').forEach(cb => { cb.checked = this.checked; });
        updateBatchBar();
      });
    }

    const btnApplyZone = document.getElementById('btnCityBatchApplyZone');
    if(btnApplyZone){
      btnApplyZone.addEventListener('click', () => {
        const raw = document.getElementById('cityBatchZone').value;
        if(!raw){ alert('請選擇戰區'); return; }
        const zoneId = (raw === '__CLEAR__') ? '' : raw;
        applyBatch('zoneId', zoneId);
      });
    }
    const btnApplyAlliance = document.getElementById('btnCityBatchApplyAlliance');
    if(btnApplyAlliance){
      btnApplyAlliance.addEventListener('click', () => {
        const aid = document.getElementById('cityBatchAlliance').value;
        if(!aid){ alert('請選擇所屬盟'); return; }
        applyBatch('allianceId', aid);
      });
    }
    const btnApplySide = document.getElementById('btnCityBatchApplySide');
    if(btnApplySide){
      btnApplySide.addEventListener('click', () => {
        const side = document.getElementById('cityBatchSide').value;
        if(!side){ alert('請選擇陣營'); return; }
        applyBatch('side', side);
      });
    }
    const btnBatchDel = document.getElementById('btnCityBatchDelete');
    if(btnBatchDel){
      btnBatchDel.addEventListener('click', () => {
        const ids = getCheckedIds();
        if(ids.length === 0){ alert('請先勾選城池'); return; }
        if(typeof window.SLG.showConfirm === 'function'){
          window.SLG.showConfirm('批次刪除', `確定刪除 ${ids.length} 座城池？`, () => {
            for(const id of ids) window.SLG.deleteEntity('city', id);
            if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
            render();
            if(window.SLG.saveState) window.SLG.saveState('important');
          });
        }
      });
    }

    const tbody = document.getElementById('cityTableBody');
    if(tbody && !tbody.dataset.bound){
      tbody.dataset.bound = '1';

      tbody.addEventListener('click', (e) => {
        const tierSaveBtn = e.target.closest('[data-action="save-tier"]');
        if(tierSaveBtn){ e.preventDefault(); e.stopPropagation(); saveTierEdit(tierSaveBtn.dataset.id); return; }
        const tierCancelBtn = e.target.closest('[data-action="cancel-tier"]');
        if(tierCancelBtn){ e.preventDefault(); e.stopPropagation(); cancelTierEdit(); return; }

        const memberCell = e.target.closest('.city-member-cell');
        if(memberCell){
          if(memberCell.classList.contains('disabled-cell')) return;
          if(memberCell.classList.contains('tier-editing')) return;
          e.preventDefault();
          e.stopPropagation();
          const cityId = memberCell.dataset.cityId;
          if(cityId) startTierEdit(cityId);
          return;
        }

        const saveBtn = e.target.closest('[data-action="save-city-inline"]');
        if(saveBtn){ e.preventDefault(); saveInlineEditCity(saveBtn.dataset.id); return; }
        const cancelBtn = e.target.closest('[data-action="cancel-city-inline"]');
        if(cancelBtn){ e.preventDefault(); cancelInlineEditCity(); return; }
        const editBtn = e.target.closest('[data-action="edit-city"]');
        if(editBtn){ e.preventDefault(); startInlineEditCity(editBtn.dataset.id); return; }
        const delBtn = e.target.closest('[data-action="del-city"]');
        if(delBtn){
          e.preventDefault();
          const id = delBtn.dataset.id;
          const c = state.cities.find(x => x.id === id);
          if(!c) return;
          if(typeof window.SLG.showConfirm === 'function'){
            window.SLG.showConfirm('刪除城池', `確定刪除「${c.name}」？`, () => {
              window.SLG.deleteEntity('city', id);
              if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
              render();
              if(window.SLG.saveState) window.SLG.saveState('important');
            });
          }
          return;
        }
      });

      tbody.addEventListener('change', e => {
        if(e.target.classList.contains('city-cb')) updateBatchBar();
      });

      tbody.addEventListener('input', (e) => {
        if(!e.target.matches('[data-tier-field]')) return;
        const tr = e.target.closest('tr.tier-edit-row');
        if(!tr) return;
        updateTierEditPreview(tr);
      });

      tbody.addEventListener('keydown', (e) => {
        const tierRow = e.target.closest('tr.tier-edit-row');
        if(tierRow){
          const parentId = tierRow.dataset.parentId;
          if(e.key === 'Enter'){
            e.preventDefault();
            saveTierEdit(parentId);
          } else if(e.key === 'Escape'){
            e.preventDefault();
            cancelTierEdit();
          }
          return;
        }

        if(!e.target.matches('input, select')) return;
        const tr = e.target.closest('tr.inline-editing');
        if(!tr) return;
        if(e.key === 'Enter'){
          e.preventDefault();
          const saveBtn = tr.querySelector('[data-action="save-city-inline"]');
          if(saveBtn) saveBtn.click();
        } else if(e.key === 'Escape'){
          e.preventDefault();
          const cancelBtn = tr.querySelector('[data-action="cancel-city-inline"]');
          if(cancelBtn) cancelBtn.click();
        }
      });
    }
  }

  function getCheckedIds(){
    return [...document.querySelectorAll('.city-table .city-cb:checked')].map(cb => cb.dataset.id);
  }
  function updateBatchBar(){
    const ids = getCheckedIds();
    const bar = document.getElementById('cityBatchBar');
    const cnt = document.getElementById('cityBatchCount');
    if(bar) bar.style.display = ids.length > 0 ? '' : 'none';
    if(cnt) cnt.textContent = ids.length;
  }
  function applyBatch(field, value){
    const ids = getCheckedIds();
    if(ids.length === 0){ alert('請先勾選城池'); return; }
    for(const id of ids){
      const city = state.cities.find(c => c.id === id);
      if(!city) continue;
      city[field] = value;
      state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
      if(window.SLG.markDirty) window.SLG.markDirty('city', id);
    }
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState('important');
    render();
    if(field === 'zoneId' && window.SLG.GameMap && window.SLG.GameMap.refreshZoneSelector){
      window.SLG.GameMap.refreshZoneSelector();
    }
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.R && window.SLG.R.renderCities) window.SLG.R.renderCities();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    logSystem(`✅ 已批次修改 ${ids.length} 座城池`);
  }
  function getFilteredCities(){
    const zoneId = document.getElementById('cityFilterZone')?.value || 'all';
    const allianceId = document.getElementById('cityFilterAlliance')?.value || 'all';
    const side = document.getElementById('cityFilterSide')?.value || 'all';
    const search = (document.getElementById('citySearchInput')?.value || '').trim().toLowerCase();
    return state.cities.filter(c => {
      if(zoneId !== 'all' && c.zoneId !== zoneId) return false;
      if(allianceId !== 'all' && c.allianceId !== allianceId) return false;
      if(side !== 'all' && c.side !== side) return false;
      if(search){
        const hay = (c.name + ' ' + (c.code || '')).toLowerCase();
        if(!hay.includes(search)) return false;
      }
      return true;
    });
  }

  function renderMemberCell(c, isEditingInline){
    if(isEditingInline){
      return `<td class="col-num">—</td>`;
    }
    const isTierEditing = (editingCityTierId === c.id);
    const cls = `col-num city-member-cell${isTierEditing ? ' tier-editing' : ''}`;
    const title = isTierEditing ? '編輯中' : '點擊編輯分級人數';

    const hasTiers = c.tierCounts &&
      (c.tierCounts.tier1 || c.tierCounts.tier2 || c.tierCounts.tier3 || c.tierCounts.tier4);

    if(!hasTiers){
      return `<td class="${cls}" data-city-id="${c.id}" title="${title}">${c.memberCount || 0}</td>`;
    }

    const tiers = state.troopTiers.tiers;
    const tc = c.tierCounts;
    const detailRows = [];
    if(tc.tier1 > 0) detailRows.push(`<div class="row"><span>≤${tiers[0].maxLevel}級</span><b>${tc.tier1} 人</b></div>`);
    if(tc.tier2 > 0) detailRows.push(`<div class="row"><span>≤${tiers[1].maxLevel}級</span><b>${tc.tier2} 人</b></div>`);
    if(tc.tier3 > 0) detailRows.push(`<div class="row"><span>≤${tiers[2].maxLevel}級</span><b>${tc.tier3} 人</b></div>`);
    if(tc.tier4 > 0) detailRows.push(`<div class="row"><span>≥25級</span><b>${tc.tier4} 人</b></div>`);

    return `<td class="${cls}" data-city-id="${c.id}" title="${title}">
      ${c.memberCount || 0}
      <div class="member-detail">${detailRows.join('')}</div>
    </td>`;
  }

  function renderTierEditRow(c){
    const tiers = state.troopTiers.tiers;
    const tc = c.tierCounts || { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
    const t1 = tc.tier1 || 0;
    const t2 = tc.tier2 || 0;
    const t3 = tc.tier3 || 0;
    const t4 = tc.tier4 || 0;
    const calc = calcTeamsFromTiers({ tier1: t1, tier2: t2, tier3: t3, tier4: t4 });

    const t1Teams = Math.floor(t1 * (tiers[0].teamsPerPlayer || 0));
    const t2Teams = Math.floor(t2 * (tiers[1].teamsPerPlayer || 0));
    const t3Teams = Math.floor(t3 * (tiers[2].teamsPerPlayer || 0));
    const t4Teams = Math.floor(t4 * (tiers[3].teamsPerPlayer || 0));

    return `<tr class="tier-edit-row" data-parent-id="${c.id}">
      <td colspan="11">
        <div class="tier-edit-panel">
          <div class="tier-edit-panel-header">
            👥 分級人數編輯：<span style="color:var(--text-primary);">${esc(c.name)}</span>${c.code ? ` <span style="color:var(--neon-blue);font-size:10px;">[${esc(c.code)}]</span>` : ''}
          </div>
          <div class="tier-edit-panel-rows">
            <div class="tier-edit-panel-row">
              <span class="tier-name">≤${tiers[0].maxLevel} 級</span>
              <input type="number" data-tier-field="tier1" value="${t1}" min="0" step="1" placeholder="0">
              <span class="tier-calc">× ${tiers[0].teamsPerPlayer} = <b data-tier-teams="1">${t1Teams}</b> 隊</span>
            </div>
            <div class="tier-edit-panel-row">
              <span class="tier-name">≤${tiers[1].maxLevel} 級</span>
              <input type="number" data-tier-field="tier2" value="${t2}" min="0" step="1" placeholder="0">
              <span class="tier-calc">× ${tiers[1].teamsPerPlayer} = <b data-tier-teams="2">${t2Teams}</b> 隊</span>
            </div>
            <div class="tier-edit-panel-row">
              <span class="tier-name">≤${tiers[2].maxLevel} 級</span>
              <input type="number" data-tier-field="tier3" value="${t3}" min="0" step="1" placeholder="0">
              <span class="tier-calc">× ${tiers[2].teamsPerPlayer} = <b data-tier-teams="3">${t3Teams}</b> 隊</span>
            </div>
            <div class="tier-edit-panel-row">
              <span class="tier-name">≥25 級</span>
              <input type="number" data-tier-field="tier4" value="${t4}" min="0" step="1" placeholder="0">
              <span class="tier-calc">× ${tiers[3].teamsPerPlayer} = <b data-tier-teams="4">${t4Teams}</b> 隊</span>
            </div>
          </div>
          <div class="tier-edit-panel-total">
            <span>總人數：<b data-tier-total="members">${calc.totalMembers}</b> 人</span>
            <span>總隊數：<b data-tier-total="teams">${calc.totalTeams}</b> 隊</span>
          </div>
          <div class="tier-edit-panel-actions">
            <button class="btn btn-ghost btn-sm" data-action="cancel-tier" data-id="${c.id}">✕ 取消</button>
            <button class="btn btn-success btn-sm" data-action="save-tier" data-id="${c.id}">💾 儲存</button>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function updateTierEditPreview(tr){
    if(!tr) return;
    const tiers = state.troopTiers.tiers;
    const v = (n) => parseFloat(tr.querySelector(`[data-tier-field="tier${n}"]`)?.value) || 0;
    const t1 = Math.max(0, v(1));
    const t2 = Math.max(0, v(2));
    const t3 = Math.max(0, v(3));
    const t4 = Math.max(0, v(4));

    const setText = (sel, val) => {
      const el = tr.querySelector(sel);
      if(el) el.textContent = val;
    };
    setText('[data-tier-teams="1"]', Math.floor(t1 * (tiers[0].teamsPerPlayer || 0)));
    setText('[data-tier-teams="2"]', Math.floor(t2 * (tiers[1].teamsPerPlayer || 0)));
    setText('[data-tier-teams="3"]', Math.floor(t3 * (tiers[2].teamsPerPlayer || 0)));
    setText('[data-tier-teams="4"]', Math.floor(t4 * (tiers[3].teamsPerPlayer || 0)));

    const calc = calcTeamsFromTiers({ tier1: t1, tier2: t2, tier3: t3, tier4: t4 });
    setText('[data-tier-total="members"]', calc.totalMembers);
    setText('[data-tier-total="teams"]', calc.totalTeams);
  }

  function startTierEdit(cityId){
    if(editingCityTierId === cityId) return;
    if(editingCityRowId){ editingCityRowId = null; }
    editingCityTierId = cityId;
    render();
    setTimeout(() => {
      const tr = document.querySelector(`tr.tier-edit-row[data-parent-id="${cityId}"]`);
      if(tr){
        const firstInput = tr.querySelector('input[data-tier-field="tier1"]');
        if(firstInput){ firstInput.focus(); firstInput.select(); }
      }
    }, 0);
  }

  function cancelTierEdit(){
    editingCityTierId = null;
    render();
  }

  function saveTierEdit(cityId){
    const tr = document.querySelector(`tr.tier-edit-row[data-parent-id="${cityId}"]`);
    if(!tr) return false;
    const city = state.cities.find(c => c.id === cityId);
    if(!city) return false;

    const v = (n) => parseFloat(tr.querySelector(`[data-tier-field="tier${n}"]`)?.value) || 0;
    const t1 = v(1);
    const t2 = v(2);
    const t3 = v(3);
    const t4 = v(4);

    if(t1 < 0 || t2 < 0 || t3 < 0 || t4 < 0){
      alert('⚠️ 人數不可為負數');
      return false;
    }

    const tierCounts = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };
    const calc = calcTeamsFromTiers(tierCounts);
    const hasAnyTier = (t1 + t2 + t3 + t4) > 0;

    const updated = { ...city };
    updated.memberCount = calc.totalMembers;
    updated.totalTeams = calc.totalTeams;
    updated.avgPower = calc.totalTeams > 0
      ? Math.floor((Number(city.totalPower) || 0) / calc.totalTeams)
      : 0;

    if(hasAnyTier){
      updated.tierCounts = tierCounts;
    } else {
      delete updated.tierCounts;
    }

    window.SLG.upsertEntity('city', updated);
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    editingCityTierId = null;
    render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.R && window.SLG.R.renderCities) window.SLG.R.renderCities();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    window.SLG.saveState('important');
    logSystem(`✅ 已更新「${city.name}」分級人數：${calc.totalMembers} 人 / ${calc.totalTeams} 隊`);
    return true;
  }

  function render(){
    populateFilters();
    populateBatchZoneOptions();
    populateBatchAllianceOptions();

    const list = getFilteredCities();
    const tbody = document.getElementById('cityTableBody');
    const editingId = editingCityRowId;

    if(tbody){
      if(list.length === 0){
        tbody.innerHTML = '<tr><td colspan="11" class="city-table-empty">無城池資料</td></tr>';
      } else {
        tbody.innerHTML = list.map(c => {
          const isEditingInline = (editingId === c.id);
          const isTierEditing = (editingCityTierId === c.id);
          const zone = state.zones.find(z => z.id === c.zoneId);
          const alliance = state.alliances.find(a => a.id === c.allianceId);
          const avg = c.totalTeams > 0 ? Math.floor((Number(c.totalPower)||0) / c.totalTeams) : null;
          const icon = (alliance && alliance.icon) ? alliance.icon + ' ' : '';
          const avgDisplay = avg === null || !isFinite(avg) ? '—' : formatAvgPower(avg);
          const yi = (Number(c.totalPower) || 0) / 1e8;

          let rowHtml = '';

          if(isEditingInline){
            const zoneOpts = '<option value="">（未分配）</option>' +
              state.zones.map(z => `<option value="${z.id}" ${z.id === c.zoneId ? 'selected' : ''}>${esc(z.name)}</option>`).join('');
            const allianceOpts = '<option value="">（不指定 / NPC）</option>' +
              state.alliances.map(a => `<option value="${a.id}" ${a.id === c.allianceId ? 'selected' : ''}>${a.icon ? a.icon + ' ' : ''}${esc(a.name)}</option>`).join('');
            const sideOpts = ['self','ally','enemy','common_enemy','npc'].map(s =>
              `<option value="${s}" ${s === c.side ? 'selected' : ''}>${sideLabel(s)}</option>`
            ).join('');

            rowHtml = `<tr data-city-id="${c.id}" class="inline-editing">
              <td><input type="checkbox" class="city-cb" data-id="${c.id}" disabled></td>
              <td class="city-name"><input type="text" class="inline-name-input" data-inline-field="name" value="${esc(c.name)}" maxlength="20"></td>
              <td><input type="number" class="inline-num-input" data-inline-field="level" value="${c.level||1}" min="1" max="10" step="1"></td>
              <td class="inline-select-td"><select data-inline-field="zoneId">${zoneOpts}</select></td>
              <td class="inline-select-td"><select data-inline-field="allianceId">${allianceOpts}</select></td>
              <td class="inline-select-td"><select data-inline-field="side">${sideOpts}</select></td>
              <td class="col-num"><input type="number" class="inline-num-input" data-inline-field="memberCount" value="${c.memberCount||0}" min="0" step="1"></td>
              <td class="col-num">
                <div class="inline-power-wrap">
                  <input type="number" class="inline-power-input" data-inline-field="totalPowerYi" value="${yi.toFixed(2)}" step="0.01" min="0">
                  <span class="inline-unit">億</span>
                </div>
              </td>
              <td class="col-num"><input type="number" class="inline-num-input" data-inline-field="totalTeams" value="${c.totalTeams||0}" min="0" step="1"></td>
              <td class="col-num inline-avg-preview" data-inline-preview="avgPower">—</td>
              <td class="col-actions">
                <button class="btn btn-success btn-sm" data-action="save-city-inline" data-id="${c.id}" title="儲存">💾</button>
                <button class="btn btn-ghost btn-sm" data-action="cancel-city-inline" data-id="${c.id}" title="取消">✕</button>
              </td>
            </tr>`;
          } else {
            const codeChip = c.code ? ` <span class="chip" style="font-size:9px;color:var(--neon-blue);border-color:rgba(68,170,255,.3);">${esc(c.code)}</span>` : '';
            rowHtml = `<tr class="${c.isCapital ? 'row-self' : ''}" data-city-id="${c.id}">
              <td><input type="checkbox" class="city-cb" data-id="${c.id}"></td>
              <td class="city-name">${c.isCapital ? '👑 ' : ''}${esc(c.name)}${codeChip}</td>
              <td><span class="chip" style="font-size:9px;">Lv.${c.level||1}</span></td>
              <td>${zone ? esc(zone.name) : '<span class="text-dim">—</span>'}</td>
              <td>${icon}${alliance ? esc(alliance.name) : '<span class="text-dim">NPC</span>'}</td>
              <td><span class="chip ${sideClass(c.side)}" style="font-size:9px;">${sideLabel(c.side)}</span></td>
              ${renderMemberCell(c, false)}
              <td class="col-num">${formatPower(c.totalPower)}</td>
              <td class="col-num">${c.totalTeams || '—'}</td>
              <td class="col-num">${avgDisplay}</td>
              <td>
                <button class="btn btn-primary btn-sm" data-action="edit-city" data-id="${c.id}">✏️</button>
                <button class="btn btn-danger btn-sm" data-action="del-city" data-id="${c.id}">🗑️</button>
              </td>
            </tr>`;
          }

          if(isTierEditing){
            rowHtml += renderTierEditRow(c);
          }

          return rowHtml;
        }).join('');
      }
    }

    if(tbody){
      tbody.querySelectorAll('tr.inline-editing').forEach(tr => {
        const teamsEl = tr.querySelector('[data-inline-field="totalTeams"]');
        const powerEl = tr.querySelector('[data-inline-field="totalPowerYi"]');
        const preview = tr.querySelector('[data-inline-preview="avgPower"]');
        const updatePreview = () => {
          const teams = parseFloat(teamsEl?.value) || 0;
          const yi = parseFloat(powerEl?.value) || 0;
          const total = Math.round(yi * 1e8);
          const avg = teams > 0 ? Math.floor(total / teams) : 0;
          if(preview) preview.textContent = avg > 0 ? formatAvgPower(avg) : '—';
        };
        if(teamsEl) teamsEl.addEventListener('input', updatePreview);
        if(powerEl) powerEl.addEventListener('input', updatePreview);
        updatePreview();
      });
    }

    updateBatchBar();
    renderDistSummary();

    if(typeof window.SLG.applyPermissions === 'function'){
      window.SLG.applyPermissions();
    }
  }

  function populateFilters(){
    const zSel = document.getElementById('cityFilterZone');
    if(zSel){
      const cur = zSel.value;
      zSel.innerHTML = '<option value="all">全部</option>' +
        state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
      zSel.value = cur && state.zones.find(z => z.id === cur) ? cur : 'all';
    }
    const aSel = document.getElementById('cityFilterAlliance');
    if(aSel){
      const cur = aSel.value;
      aSel.innerHTML = '<option value="all">全部</option>' +
        state.alliances.map(a => `<option value="${a.id}">${a.icon ? a.icon + ' ' : ''}${esc(a.name)}</option>`).join('');
      aSel.value = cur && state.alliances.find(a => a.id === cur) ? cur : 'all';
    }
  }
  function populateBatchZoneOptions(){
    const sel = document.getElementById('cityBatchZone');
    if(!sel) return;
    const cur = sel.value;
    let html = '<option value="">更改戰區...</option>';
    html += '<option value="__CLEAR__">（清除戰區 / 未分配）</option>';
    html += state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
    sel.innerHTML = html;
    if(cur){
      const valid = (cur === '__CLEAR__') || state.zones.find(z => z.id === cur);
      if(valid) sel.value = cur;
    }
  }
  function populateBatchAllianceOptions(){
    const sel = document.getElementById('cityBatchAlliance');
    if(!sel) return;
    sel.innerHTML = '<option value="">更改所屬盟...</option>' +
      state.alliances.map(a => `<option value="${a.id}">${a.icon ? a.icon + ' ' : ''}${esc(a.name)}</option>`).join('');
  }
  function renderDistSummary(){
    const el = document.getElementById('allianceDistSummary');
    if(!el) return;
    if(state.alliances.length === 0){
      el.innerHTML = '<div class="text-dim">尚未建立同盟</div>';
      return;
    }
    el.innerHTML = state.alliances.map(a => {
      const myCities = state.cities.filter(c => c.allianceId === a.id);
      const allocatedPower = myCities.reduce((s, c) => s + (Number(c.totalPower) || 0), 0);
      const totalPower = Number(a.totalPower) || 0;
      const remain = totalPower - allocatedPower;
      const pct = totalPower > 0 ? Math.round(allocatedPower / totalPower * 100) : 0;
      const cls = pct > 100 ? 'warn' : '';
      const icon = a.icon ? a.icon + ' ' : '';
      const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
      const remainStyle = remain < 0 ? 'style="color:var(--neon-red);"' : 'style="color:var(--neon-green);"';
      return `<div class="alliance-dist-row">
        <span class="name">${icon}${esc(a.name)}</span>
        <span class="chip ${chipCls}" style="font-size:9px;">${allianceSideLabel(a.side)}</span>
        <span class="num">${formatPower(allocatedPower)} / ${formatPower(totalPower)}</span>
        <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
        <span class="pct">${pct}%</span>
        <span class="num" ${remainStyle}>餘 ${formatPower(remain)}</span>
        <span class="num" style="color:var(--text-dim);">${myCities.length} 城</span>
      </div>`;
    }).join('');
  }

  function startInlineEditCity(id){
    if(editingCityRowId === id) return;
    if(editingCityTierId){ editingCityTierId = null; }
    editingCityRowId = id;
    render();
    setTimeout(() => {
      const tr = document.querySelector(`tr[data-city-id="${id}"]`);
      if(tr){
        const nameInput = tr.querySelector('[data-inline-field="name"]');
        if(nameInput){ nameInput.focus(); nameInput.select(); }
      }
    }, 0);
  }
  function cancelInlineEditCity(){ editingCityRowId = null; render(); }
  function saveInlineEditCity(id){
    const tr = document.querySelector(`tr[data-city-id="${id}"]`);
    if(!tr) return false;
    const city = state.cities.find(c => c.id === id);
    if(!city) return false;
    const getVal = (field) => {
      const el = tr.querySelector(`[data-inline-field="${field}"]`);
      return el ? el.value : '';
    };
    const name = String(getVal('name') || '').trim();
    const level = parseInt(getVal('level'), 10) || 1;
    const zoneId = String(getVal('zoneId') || '');
    const allianceId = String(getVal('allianceId') || '');
    const side = String(getVal('side') || 'self');
    const memberCount = parseFloat(getVal('memberCount')) || 0;
    const totalPowerYi = parseFloat(getVal('totalPowerYi')) || 0;
    const totalPower = Math.round(totalPowerYi * 1e8);
    const totalTeams = parseFloat(getVal('totalTeams')) || 0;

    if(!name){ alert('城池名稱不能為空'); return false; }
    if(name.length > 20){ alert('城池名稱最多 20 字'); return false; }
    if(level < 1 || level > 10){ alert('等級必須在 1~10 之間'); return false; }

    const avgPower = totalTeams > 0 ? Math.floor(totalPower / totalTeams) : 0;
    const updated = { ...city, name, zoneId, allianceId, side, level, memberCount, totalPower, totalTeams, avgPower };
    delete updated.tierCounts;

    window.SLG.upsertEntity('city', updated);
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    editingCityRowId = null;
    render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.R && window.SLG.R.renderCities) window.SLG.R.renderCities();
    if(window.SLG.renderOverview) window.SLG.renderOverview();
    window.SLG.saveState('important');
    logSystem(`✅ 已儲存城池：${name}`);
    return true;
  }

  return { init, render, startInlineEditCity, cancelInlineEditCity, saveInlineEditCity,
    startTierEdit, cancelTierEdit, saveTierEdit };
})();

/* ====== 第 2/4 段結束（WarManager 將於第 3 段開始） ====== */
 /* ============================================================
   WarManager — 宣戰清單
   ============================================================ */
const WarManager = (() => {
  const LS_SORT_KEY = 'slg_war_sort_v856';
  const LS_GROUP_KEY = 'slg_war_group_v856';
  const DEFAULT_SORT = 'time';
  const DEFAULT_GROUP = 'none';

  function init(){
    const btn = document.getElementById('btnAddWarLine');
    if(btn) btn.addEventListener('click', () => addLine());
    const btnManual = document.getElementById('btnWarAddManual');
    if(btnManual) btnManual.addEventListener('click', doAddManual);
    const srcSel = document.getElementById('warAddSrc');
    if(srcSel) srcSel.addEventListener('change', () => updateAddTargetOptions());
    const typeSel = document.getElementById('warAddType');
    if(typeSel) typeSel.addEventListener('change', () => updateAddTargetOptions());
    const tgtSel = document.getElementById('warAddTgt');
    [srcSel, typeSel, tgtSel].forEach(sel => {
      if(sel) sel.addEventListener('keydown', e => {
        if(e.key === 'Enter'){ e.preventDefault(); doAddManual(); }
      });
    });
    const sortSel = document.getElementById('warSortSelect');
    if(sortSel){
      sortSel.addEventListener('change', function(){
        state.listPrefs.warSort = this.value;
        try{ localStorage.setItem(LS_SORT_KEY, this.value); }catch(e){}
        if(window.SLG.saveState) window.SLG.saveState();
        render();
      });
    }
    const groupSel = document.getElementById('warGroupSelect');
    if(groupSel){
      groupSel.addEventListener('change', function(){
        state.listPrefs.warGroup = this.value;
        try{ localStorage.setItem(LS_GROUP_KEY, this.value); }catch(e){}
        if(window.SLG.saveState) window.SLG.saveState();
        render();
      });
    }
  }
  function getAllWarLines(){
    const lines = [];
    for(const src of state.cities){
      for(const t of (src.attackTargets || [])){
        lines.push({ srcId: src.id, tgtId: t.cityId, type: 'attack',
          preWarPercent: t.preWarPercent, postRevivePercent: t.postRevivePercent,
          priority: t.priority, attackStartTime: t.attackStartTime || '19:00' });
      }
      for(const t of (src.defendTargets || [])){
        lines.push({ srcId: src.id, tgtId: t.cityId, type: 'assist',
          preWarPercent: t.preWarPercent, postRevivePercent: t.postRevivePercent,
          priority: t.priority, attackStartTime: '' });
      }
    }
    return lines;
  }
  function isSameZoneAsSource(srcCity, tgtCity){
    if(state.settings.crossZoneWarAllowed) return true;
    return (srcCity.zoneId || '') === (tgtCity.zoneId || '');
  }
  function getTargetsForType(srcCityId, type){
    if(type === 'attack'){
      const src = state.cities.find(c => c.id === srcCityId);
      if(!src) return [];
      const allowedSides = ATTACK_RULES[src.side || 'npc'] || ['self','ally','enemy','common_enemy','npc'];
      let targets = state.cities.filter(c => {
        if(c.id === srcCityId) return false;
        if(!allowedSides.includes(c.side)) return false;
        if(!isSameZoneAsSource(src, c)) return false;
        return true;
      });
      if(state.settings.attackRequireRoute){
        targets = targets.filter(c => window.SLG.findRoute(srcCityId, c.id));
      }
      return targets;
    }
    if(type === 'assist'){
      const src = state.cities.find(c => c.id === srcCityId);
      if(!src) return [];
      const srcAllianceId = src.allianceId || '';
      if(!srcAllianceId) return [];
      return state.cities.filter(c => {
        if(c.id === srcCityId) return false;
        if((c.allianceId || '') !== srcAllianceId) return false;
        const alliance = state.alliances.find(a => a.id === srcAllianceId);
        if(alliance && alliance.name === 'NPC') return false;
        if(!isSameZoneAsSource(src, c)) return false;
        if(!window.SLG.findRoute(srcCityId, c.id)) return false;
        return true;
      });
    }
    return [];
  }
  function findWarLine(srcId, tgtId){
    if(!tgtId) return null;
    const src = state.cities.find(c => c.id === srcId);
    if(!src) return null;
    for(const t of (src.attackTargets || [])){
      if(t.cityId === tgtId) return { type:'attack', route:t };
    }
    for(const t of (src.defendTargets || [])){
      if(t.cityId === tgtId) return { type:'assist', route:t };
    }
    return null;
  }
  function addLine(){
    if(state.cities.length < 2){ alert('至少需要 2 座城池'); return; }
    for(const src of state.cities){
      const targets = getTargetsForType(src.id, 'attack');
      for(const tgt of targets){
        if(findWarLine(src.id, tgt.id)) continue;
        if(!src.attackTargets) src.attackTargets = [];
        src.attackTargets.push({
          cityId: tgt.id, preWarPercent: 50, postRevivePercent: 50,
          priority: 1, attackStartTime: '19:00',
        });
        if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
        markDirty(src.id);
        render();
        if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
        return;
      }
    }
    alert('已無新的宣戰組合可新增');
  }
  function renderAddForm(){
    const srcSel = document.getElementById('warAddSrc');
    if(!srcSel) return;
    const curSrc = srcSel.value;
    srcSel.innerHTML = '<option value="">選擇出兵城...</option>' +
      state.cities.map(c => {
        const a = state.alliances.find(al => al.id === c.allianceId);
        const icon = (a && a.icon) ? a.icon + ' ' : '';
        const codeStr = c.code ? ` [${c.code}]` : '';
        return `<option value="${c.id}" ${c.id === curSrc ? 'selected' : ''}>${icon}${esc(c.name)}${codeStr}</option>`;
      }).join('');
    updateAddTargetOptions();
  }
  function updateAddTargetOptions(){
    const srcSel = document.getElementById('warAddSrc');
    const typeSel = document.getElementById('warAddType');
    const tgtSel = document.getElementById('warAddTgt');
    const hintEl = document.getElementById('warAddHint');
    if(!srcSel || !typeSel || !tgtSel) return;
    const srcId = srcSel.value, type = typeSel.value;
    if(!srcId){
      tgtSel.innerHTML = '<option value="">請先選擇出兵城...</option>';
      if(hintEl) hintEl.textContent = '＊「自動新增」會依序找下一個未建立的組合（含所有方向）。';
      return;
    }
    const targets = getTargetsForType(srcId, type);
    if(targets.length === 0){
      tgtSel.innerHTML = '<option value="">（無可用目標城）</option>';
      if(hintEl){
        hintEl.textContent = type === 'attack'
          ? (state.settings.crossZoneWarAllowed ? '⚠️ 無可進攻目標城' : '⚠️ 無可進攻目標城（限同戰區）')
          : (state.settings.crossZoneWarAllowed ? '⚠️ 無可協防目標城' : '⚠️ 無可協防目標城（限同戰區）');
      }
      return;
    }
    const curTgt = tgtSel.value;
    const availableTargets = targets.filter(c => !findWarLine(srcId, c.id));
    if(availableTargets.length === 0){
      tgtSel.innerHTML = '<option value="">（所有目標都已建立宣戰）</option>';
      if(hintEl) hintEl.textContent = '⚠️ 此出兵城的所有可能方向都已建立宣戰';
      return;
    }
    tgtSel.innerHTML = '<option value="">選擇目標城...</option>' +
      availableTargets.map(c => {
        const a = state.alliances.find(al => al.id === c.allianceId);
        const icon = (a && a.icon) ? a.icon + ' ' : '';
        const codeStr = c.code ? ` [${c.code}]` : '';
        return `<option value="${c.id}" ${c.id === curTgt ? 'selected' : ''}>${icon}${esc(c.name)}${codeStr}</option>`;
      }).join('');
    if(hintEl){
      const zoneHint = state.settings.crossZoneWarAllowed ? '' : '（限同戰區）';
      hintEl.textContent = `＊可選 ${availableTargets.length} 個目標城${zoneHint}`;
    }
  }
  function doAddManual(){
    const srcSel = document.getElementById('warAddSrc');
    const typeSel = document.getElementById('warAddType');
    const tgtSel = document.getElementById('warAddTgt');
    if(!srcSel || !typeSel || !tgtSel) return;
    const srcId = srcSel.value, type = typeSel.value, tgtId = tgtSel.value;
    if(!srcId){ alert('請選擇出兵城'); return; }
    if(!tgtId){ alert('請選擇目標城'); return; }
    const src = state.cities.find(c => c.id === srcId);
    const tgt = state.cities.find(c => c.id === tgtId);
    if(!src || !tgt){ alert('找不到城池'); return; }
    const validTargets = getTargetsForType(srcId, type);
    if(!validTargets.find(c => c.id === tgtId)){
      alert(type === 'attack' ? '無法進攻該目標城' : '無法協防該目標城');
      return;
    }
    if(findWarLine(srcId, tgtId)){ alert(`「${src.name}」→「${tgt.name}」已有宣戰指示`); return; }
    const isAttack = (type === 'attack');
    const arr = isAttack ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) src[arr] = [];
    src[arr].push({
      cityId: tgtId, preWarPercent: 50, postRevivePercent: 50,
      priority: 1, attackStartTime: isAttack ? '19:00' : '',
    });
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    markDirty(src.id);
    render();
    renderAddForm();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
    logSystem(`✅ 已新增宣戰：${src.name} → ${tgt.name}`);
  }
  function computeEndTime(startTime, limitMin){
    if(!startTime) return '待設定';
    const m = hhmmToMinutes(startTime);
    if(!m && m !== 0) return '待設定';
    return minutesToHHMM(m + (parseInt(limitMin) || 120));
  }
  function getSortPref(){ return state.listPrefs.warSort || DEFAULT_SORT; }
  function getGroupPref(){ return state.listPrefs.warGroup || DEFAULT_GROUP; }
  function sortLines(lines, sortBy){
    const copy = lines.slice();
    if(sortBy === 'time'){
      copy.sort((a, b) => {
        const ta = a.attackStartTime || '', tb = b.attackStartTime || '';
        if(ta !== tb) return ta < tb ? -1 : 1;
        return (a.srcId || '').localeCompare(b.srcId || '');
      });
    } else if(sortBy === 'alliance'){
      copy.sort((a, b) => {
        const sa = state.cities.find(c => c.id === a.srcId);
        const sb = state.cities.find(c => c.id === b.srcId);
        const aa = sa ? (state.alliances.find(al => al.id === sa.allianceId)?.name || '') : '';
        const ab = sb ? (state.alliances.find(al => al.id === sb.allianceId)?.name || '') : '';
        if(aa !== ab) return aa.localeCompare(ab, 'zh-Hant');
        return (sa?.name || '').localeCompare(sb?.name || '', 'zh-Hant');
      });
    } else if(sortBy === 'type'){
      copy.sort((a, b) => {
        const oa = a.type === 'attack' ? 0 : 1, ob = b.type === 'attack' ? 0 : 1;
        if(oa !== ob) return oa - ob;
        const ta = a.attackStartTime || '', tb = b.attackStartTime || '';
        return ta < tb ? -1 : 1;
      });
    }
    return copy;
  }
  function groupLines(lines, groupBy){
    if(groupBy === 'none') return [{ key: '__all__', title: '', items: lines }];
    const groups = new Map();
    for(const l of lines){
      let key = '', title = '';
      const src = state.cities.find(c => c.id === l.srcId);
      if(groupBy === 'city'){ key = l.srcId || '__empty__'; title = '🏰 ' + (src ? src.name : '（無效）'); }
      else if(groupBy === 'type'){ key = l.type; title = l.type === 'attack' ? '⚔️ 進攻' : '🤝 協防'; }
      else if(groupBy === 'alliance'){
        const a = src ? state.alliances.find(al => al.id === src.allianceId) : null;
        key = a ? a.id : '__none__';
        title = '🤝 ' + (a ? ((a.icon ? a.icon + ' ' : '') + a.name) : '（無盟）');
      } else if(groupBy === 'time'){ const t = l.attackStartTime || '00:00'; key = t.slice(0, 2) + ':00'; title = '⏰ ' + key + ' 時段'; }
      if(!groups.has(key)) groups.set(key, { key, title, items: [] });
      groups.get(key).items.push(l);
    }
    const arr = [...groups.values()];
    if(groupBy === 'type') arr.sort((a, b) => (a.key === 'attack' ? 0 : 1) - (b.key === 'attack' ? 0 : 1));
    else arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hant'));
    return arr;
  }
  function render(){
    const container = document.getElementById('warListContainer');
    if(!container) return;
    const sortSel = document.getElementById('warSortSelect');
    if(sortSel) sortSel.value = getSortPref();
    const groupSel = document.getElementById('warGroupSelect');
    if(groupSel) groupSel.value = getGroupPref();
    const lines = getAllWarLines();
    if(lines.length === 0){
      container.innerHTML = '<div class="list-container-empty">尚無宣戰指示。點下方「➕ 新增」或「⚡ 自動新增」開始。</div>';
    } else {
      const sorted = sortLines(lines, getSortPref());
      const grouped = groupLines(sorted, getGroupPref());
      const limitMin = state.settings.timeLimitMin || 120;
      const theadHtml = `<thead><tr>
        <th style="width:80px;">開始時間</th>
        <th style="width:80px;">結束時間</th>
        <th>出兵城</th>
        <th style="width:100px;">類型</th>
        <th>目標城</th>
        <th style="width:50px;">操作</th>
      </tr></thead>`;
      const renderRow = (l, idx) => {
        const src = state.cities.find(c => c.id === l.srcId);
        const tgt = state.cities.find(c => c.id === l.tgtId);
        const isAttack = l.type === 'attack';
        const timeVal = isAttack ? (l.attackStartTime || '19:00') : '';
        const endTime = isAttack
          ? computeEndTime(timeVal, limitMin)
          : computeEndTime((() => {
              if(!tgt) return '';
              const incomingTimes = [];
              for(const o of state.cities){
                for(const t of (o.attackTargets || [])){
                  if(t.cityId === tgt.id && t.attackStartTime) incomingTimes.push(t.attackStartTime);
                }
              }
              if(incomingTimes.length === 0) return '';
              incomingTimes.sort();
              return incomingTimes[0];
            })(), limitMin);
        const rowPending = !l.tgtId;
        const srcOpts = state.cities.map(c =>
          `<option value="${c.id}" ${c.id === l.srcId ? 'selected' : ''}>${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`
        ).join('');
        const srcIcon = src ? (() => {
          const a = state.alliances.find(al => al.id === src.allianceId);
          return (a && a.icon) ? a.icon + ' ' : '';
        })() : '';
        const typeOpts = `
          <option value="attack" ${isAttack ? 'selected' : ''}>⚔️ 進攻</option>
          <option value="assist" ${!isAttack ? 'selected' : ''}>🤝 協防</option>
        `;
        const validTargets = getTargetsForType(l.srcId, l.type);
        let tgtOpts = '';
        if(!l.tgtId){ tgtOpts = `<option value="">（待設定）</option>`; }
        else if(validTargets.length === 0){ tgtOpts = `<option value="">（無可用目標）</option>`; }
        else {
          if(!validTargets.find(c => c.id === l.tgtId) && tgt){
            tgtOpts += `<option value="${tgt.id}" selected>${esc(tgt.name)}（不符）</option>`;
          }
          tgtOpts += validTargets.map(c =>
            `<option value="${c.id}" ${c.id === l.tgtId ? 'selected' : ''}>${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`
          ).join('');
        }
        const timeCell = isAttack
          ? `<input type="time" class="inline-time" value="${timeVal}" data-war-time="1" data-idx="${idx}">`
          : `<span class="col-time end">—</span>`;
        const endCell = `<span class="col-time end">${esc(endTime)}</span>`;
        const srcCell = `<div style="display:flex;align-items:center;gap:4px;">
          ${srcIcon ? `<span class="alliance-icon">${srcIcon}</span>` : ''}
          <select class="inline-select" data-war-src="1" data-idx="${idx}" style="flex:1;">${srcOpts}</select>
        </div>`;
        const tgtCell = `<select class="inline-select" data-war-tgt="1" data-idx="${idx}">${tgtOpts}</select>`;
        return `<tr class="${rowPending ? 'row-pending' : ''}" data-war-row="${idx}">
          <td>${timeCell}</td>
          <td>${endCell}</td>
          <td>${srcCell}</td>
          <td><select class="inline-select col-type ${isAttack ? 'attack' : 'assist'}" data-war-type="1" data-idx="${idx}">${typeOpts}</select></td>
          <td>${tgtCell}</td>
          <td class="col-del"><button class="btn btn-danger btn-sm" data-war-del="1" data-idx="${idx}">🗑️</button></td>
        </tr>`;
      };
      let html = '';
      if(getGroupPref() === 'none'){
        html = `<table class="list-table">${theadHtml}<tbody>${sorted.map((l, i) => renderRow(l, i)).join('')}</tbody></table>`;
      } else {
        let idxCounter = 0;
        html = grouped.map(g => {
          const rows = g.items.map(l => renderRow(l, idxCounter++)).join('');
          return `<div class="list-group open">
            <div class="list-group-header">
              <span class="toggle-icon">▶</span>
              <span class="group-title">${esc(g.title)}</span>
              <span class="group-count">${g.items.length} 條</span>
            </div>
            <div class="list-group-body">
              <table class="list-table">${theadHtml}<tbody>${rows}</tbody></table>
            </div>
          </div>`;
        }).join('');
      }
      container.innerHTML = html;
      container.querySelectorAll('.list-group-header').forEach(h => {
        h.addEventListener('click', () => {
          const group = h.closest('.list-group');
          if(group) group.classList.toggle('open');
        });
      });
      bindWarRowEvents(container, sorted);
    }
    renderAddForm();
  }
  function bindWarRowEvents(container, sortedLines){
    container.querySelectorAll('[data-war-time]').forEach(inp => {
      inp.addEventListener('change', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const line = sortedLines[idx];
        if(!line) return;
        updateWarLineTime(line, this.value || '19:00');
      });
    });
    container.querySelectorAll('[data-war-src]').forEach(sel => {
      sel.addEventListener('change', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const line = sortedLines[idx];
        if(!line) return;
        changeWarLine(line, this.value, line.tgtId, line.type, line.attackStartTime);
      });
    });
    container.querySelectorAll('[data-war-type]').forEach(sel => {
      sel.addEventListener('change', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const line = sortedLines[idx];
        if(!line) return;
        const newType = this.value;
        const validTargets = getTargetsForType(line.srcId, newType);
        let newTgtId = line.tgtId;
        if(!validTargets.find(c => c.id === newTgtId)){
          newTgtId = validTargets.length > 0 ? validTargets[0].id : '';
        }
        let newTime = line.attackStartTime;
        if(newType === 'assist'){ newTime = ''; }
        else if(!newTime){ newTime = '19:00'; }
        if(!newTgtId){ changeWarLineAllowEmpty(line, line.srcId, newType, newTime); return; }
        changeWarLine(line, line.srcId, newTgtId, newType, newTime);
      });
    });
    container.querySelectorAll('[data-war-tgt]').forEach(sel => {
      sel.addEventListener('change', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const line = sortedLines[idx];
        if(!line) return;
        const newTgtId = this.value;
        if(!newTgtId) return;
        changeWarLine(line, line.srcId, newTgtId, line.type, line.attackStartTime);
      });
    });
    container.querySelectorAll('[data-war-del]').forEach(btn => {
      btn.addEventListener('click', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const line = sortedLines[idx];
        if(!line) return;
        deleteWarLine(line);
      });
    });
  }
  function updateWarLineTime(line, newTime){
    const src = state.cities.find(c => c.id === line.srcId);
    if(!src) return;
    const arr = line.type === 'attack' ? 'attackTargets' : 'defendTargets';
    const route = (src[arr] || []).find(t => t.cityId === line.tgtId);
    if(!route) return;
    route.attackStartTime = newTime;
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    markDirty(src.id);
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }
  function changeWarLineAllowEmpty(oldLine, newSrcId, newType, newTime){
    deleteLineSilent(oldLine);
    const src = state.cities.find(c => c.id === newSrcId);
    if(!src) return;
    const isAttack = (newType === 'attack');
    const arr = isAttack ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) src[arr] = [];
    src[arr].push({
      cityId: '', preWarPercent: oldLine.preWarPercent || 50,
      postRevivePercent: oldLine.postRevivePercent || 50,
      priority: oldLine.priority || 1,
      attackStartTime: isAttack ? (newTime || '19:00') : '',
    });
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    markDirty(src.id);
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }
  function changeWarLine(oldLine, newSrcId, newTgtId, newType, newTime){
    const validTargets = getTargetsForType(newSrcId, newType);
    if(!validTargets.find(c => c.id === newTgtId)){
      alert(state.settings.crossZoneWarAllowed ? '此類型不能選擇該目標城' : '此類型不能選擇該目標城（或跨戰區被禁止）');
      render();
      return;
    }
    const isSelf = (oldLine.srcId === newSrcId && oldLine.tgtId === newTgtId);
    if(!isSelf){
      const existing = findWarLine(newSrcId, newTgtId);
      if(existing){ alert(`「${cityName(newSrcId)}」→「${cityName(newTgtId)}」已有宣戰指示`); render(); return; }
    }
    deleteLineSilent(oldLine);
    const src = state.cities.find(c => c.id === newSrcId);
    if(!src) return;
    const isAttack = (newType === 'attack');
    const arr = isAttack ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) src[arr] = [];
    src[arr].push({
      cityId: newTgtId, preWarPercent: oldLine.preWarPercent || 50,
      postRevivePercent: oldLine.postRevivePercent || 50,
      priority: oldLine.priority || 1,
      attackStartTime: isAttack ? (newTime || '19:00') : '',
    });
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    markDirty(src.id);
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }
  function deleteWarLine(line){
    deleteLineSilent(line);
    if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }
  function deleteLineSilent(line){
    const src = state.cities.find(c => c.id === line.srcId);
    if(!src) return;
    if(line.type === 'attack'){
      if(src.attackTargets) src.attackTargets = src.attackTargets.filter(t => t.cityId !== line.tgtId);
    } else {
      if(src.defendTargets) src.defendTargets = src.defendTargets.filter(t => t.cityId !== line.tgtId);
    }
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
  }
  function cityName(id){
    const c = state.cities.find(x => x.id === id);
    return c ? c.name : id;
  }
  function markDirty(cityId){
    state.entityRev.city[cityId] = (state.entityRev.city[cityId] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', cityId);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
  }
  return { init, render, findWarLine, renderAddForm, updateAddTargetOptions };
})();

/* ============================================================
   DeployInstr — 出兵清單
   ============================================================ */
const DeployInstr = (() => {
  const LS_SORT_KEY = 'slg_deploy_sort_v856';
  const LS_GROUP_KEY = 'slg_deploy_group_v856';
  const DEFAULT_SORT = 'alliance';
  const DEFAULT_GROUP = 'none';

  function init(){
    const el = document.getElementById('deployListContainer');
    if(!el) return;
    const sortSel = document.getElementById('deploySortSelect');
    if(sortSel){
      sortSel.addEventListener('change', function(){
        state.listPrefs.deploySort = this.value;
        try{ localStorage.setItem(LS_SORT_KEY, this.value); }catch(e){}
        if(window.SLG.saveState) window.SLG.saveState();
        render();
      });
    }
    const groupSel = document.getElementById('deployGroupSelect');
    if(groupSel){
      groupSel.addEventListener('change', function(){
        state.listPrefs.deployGroup = this.value;
        try{ localStorage.setItem(LS_GROUP_KEY, this.value); }catch(e){}
        if(window.SLG.saveState) window.SLG.saveState();
        render();
      });
    }
  }
  function getAllDeployLines(){
    const lines = [];
    for(const src of state.cities){
      for(const t of (src.attackTargets || [])){
        if(!t.cityId) continue;
        lines.push({ srcId: src.id, tgtId: t.cityId, type: 'attack',
          preWarPercent: t.preWarPercent, postRevivePercent: t.postRevivePercent,
          priority: t.priority, attackStartTime: t.attackStartTime || '19:00' });
      }
      for(const t of (src.defendTargets || [])){
        if(!t.cityId) continue;
        lines.push({ srcId: src.id, tgtId: t.cityId, type: 'assist',
          preWarPercent: t.preWarPercent, postRevivePercent: t.postRevivePercent,
          priority: t.priority, attackStartTime: '' });
      }
    }
    return lines;
  }
  function getSortPref(){ return state.listPrefs.deploySort || DEFAULT_SORT; }
  function getGroupPref(){ return state.listPrefs.deployGroup || DEFAULT_GROUP; }
  function computeEndTime(startTime, limitMin){
    if(!startTime) return '待設定';
    return minutesToHHMM(hhmmToMinutes(startTime) + (parseInt(limitMin) || 120));
  }
  function getCityDefStart(cityId){
    const city = state.cities.find(c => c.id === cityId);
    return city ? (city.defStartTime || '') : '';
  }
  function sortLines(lines, sortBy){
    const copy = lines.slice();
    if(sortBy === 'alliance'){
      copy.sort((a, b) => {
        const sa = state.cities.find(c => c.id === a.srcId);
        const sb = state.cities.find(c => c.id === b.srcId);
        const aa = sa ? (state.alliances.find(al => al.id === sa.allianceId)?.name || '') : '';
        const ab = sb ? (state.alliances.find(al => al.id === sb.allianceId)?.name || '') : '';
        if(aa !== ab) return aa.localeCompare(ab, 'zh-Hant');
        return (sa?.name || '').localeCompare(sb?.name || '', 'zh-Hant');
      });
    } else if(sortBy === 'type'){
      copy.sort((a, b) => {
        const oa = a.type === 'attack' ? 0 : 1, ob = b.type === 'attack' ? 0 : 1;
        if(oa !== ob) return oa - ob;
        return (a.srcId || '').localeCompare(b.srcId || '');
      });
    }
    return copy;
  }
  function groupLines(lines, groupBy){
    if(groupBy === 'none') return [{ key: '__all__', title: '', items: lines }];
    const groups = new Map();
    for(const l of lines){
      let key = '', title = '';
      const src = state.cities.find(c => c.id === l.srcId);
      if(groupBy === 'city'){ key = l.srcId; title = '🏰 ' + (src ? src.name : '（無效）'); }
      else if(groupBy === 'type'){ key = l.type; title = l.type === 'attack' ? '⚔️ 進攻' : '🤝 協防'; }
      else if(groupBy === 'alliance'){
        const a = src ? state.alliances.find(al => al.id === src.allianceId) : null;
        key = a ? a.id : '__none__';
        title = '🤝 ' + (a ? ((a.icon ? a.icon + ' ' : '') + a.name) : '（無盟）');
      }
      if(!groups.has(key)) groups.set(key, { key, title, items: [] });
      groups.get(key).items.push(l);
    }
    const arr = [...groups.values()];
    if(groupBy === 'type') arr.sort((a, b) => (a.key === 'attack' ? 0 : 1) - (b.key === 'attack' ? 0 : 1));
    else arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hant'));
    return arr;
  }
  function render(){
    const container = document.getElementById('deployListContainer');
    if(!container) return;
    const sortSel = document.getElementById('deploySortSelect');
    if(sortSel) sortSel.value = getSortPref();
    const groupSel = document.getElementById('deployGroupSelect');
    if(groupSel) groupSel.value = getGroupPref();
    const lines = getAllDeployLines();
    if(lines.length === 0){
      container.innerHTML = '<div class="list-container-empty">尚無出兵指示。請先在「⚔️ 宣戰」建立宣戰路線。</div>';
      return;
    }
    const sorted = sortLines(lines, getSortPref());
    const grouped = groupLines(sorted, getGroupPref());
    const limitMin = state.settings.timeLimitMin || 120;
    const theadHtml = `<thead><tr>
      <th style="width:80px;">開始時間</th>
      <th style="width:80px;">結束時間</th>
      <th>出兵城</th>
      <th style="width:90px;">行動</th>
      <th>目標城</th>
      <th style="width:70px;">戰前%</th>
      <th style="width:70px;">復活%</th>
      <th style="width:60px;">順序</th>
    </tr></thead>`;
    const renderRow = (l, idx) => {
      const src = state.cities.find(c => c.id === l.srcId);
      const tgt = state.cities.find(c => c.id === l.tgtId);
      const isAttack = l.type === 'attack';
      let startTime = '', endTime = '';
      if(isAttack){
        startTime = l.attackStartTime || '19:00';
        endTime = computeEndTime(startTime, limitMin);
      } else {
        const defStart = getCityDefStart(l.tgtId);
        startTime = defStart || '待設定';
        endTime = defStart ? computeEndTime(defStart, limitMin) : '待設定';
      }
      const srcIcon = src ? (() => {
        const a = state.alliances.find(al => al.id === src.allianceId);
        return (a && a.icon) ? a.icon + ' ' : '';
      })() : '';
      const tgtIcon = tgt ? (() => {
        const a = state.alliances.find(al => al.id === tgt.allianceId);
        return (a && a.icon) ? a.icon + ' ' : '';
      })() : '';
      const preOpts = PERCENT_OPTIONS.map(p =>
        `<option value="${p}" ${p === l.preWarPercent ? 'selected' : ''}>${p}%</option>`
      ).join('');
      const postOpts = PERCENT_OPTIONS.map(p =>
        `<option value="${p}" ${p === l.postRevivePercent ? 'selected' : ''}>${p}%</option>`
      ).join('');
      const srcCodeStr = src && src.code ? ` [${src.code}]` : '';
      const tgtCodeStr = tgt && tgt.code ? ` [${tgt.code}]` : '';
      return `<tr data-deploy-row="${idx}">
        <td><span class="col-time start">${esc(startTime)}</span></td>
        <td><span class="col-time end">${esc(endTime)}</span></td>
        <td class="col-city">${srcIcon}${src ? esc(src.name) + srcCodeStr : '—'}</td>
        <td><span class="col-type ${isAttack ? 'attack' : 'assist'}">${isAttack ? '⚔️ 進攻' : '🤝 協防'}</span></td>
        <td class="col-city">${tgtIcon}${tgt ? esc(tgt.name) + tgtCodeStr : '—'}</td>
        <td><select class="inline-select col-num" data-deploy-field="preWarPercent" data-idx="${idx}">${preOpts}</select></td>
        <td><select class="inline-select col-num" data-deploy-field="postRevivePercent" data-idx="${idx}">${postOpts}</select></td>
        <td><input type="number" class="inline-number" data-deploy-field="priority" data-idx="${idx}" value="${l.priority || 1}" min="1" max="99" step="1"></td>
      </tr>`;
    };
    let html = '';
    if(getGroupPref() === 'none'){
      html = `<table class="list-table">${theadHtml}<tbody>${sorted.map((l, i) => renderRow(l, i)).join('')}</tbody></table>`;
    } else {
      let idxCounter = 0;
      html = grouped.map(g => {
        const rows = g.items.map(l => renderRow(l, idxCounter++)).join('');
        return `<div class="list-group open">
          <div class="list-group-header">
            <span class="toggle-icon">▶</span>
            <span class="group-title">${esc(g.title)}</span>
            <span class="group-count">${g.items.length} 條</span>
          </div>
          <div class="list-group-body">
            <table class="list-table">${theadHtml}<tbody>${rows}</tbody></table>
          </div>
        </div>`;
      }).join('');
    }
    container.innerHTML = html;
    container.querySelectorAll('.list-group-header').forEach(h => {
      h.addEventListener('click', () => {
        const group = h.closest('.list-group');
        if(group) group.classList.toggle('open');
      });
    });
    bindDeployRowEvents(container, sorted);
  }
  function bindDeployRowEvents(container, sortedLines){
    container.querySelectorAll('[data-deploy-field]').forEach(inp => {
      inp.addEventListener('change', function(){
        const idx = parseInt(this.dataset.idx, 10);
        const field = this.dataset.deployField;
        const line = sortedLines[idx];
        if(!line) return;
        updateDeployField(line, field, this.value);
      });
    });
  }
  function updateDeployField(line, field, value){
    const src = state.cities.find(c => c.id === line.srcId);
    if(!src) return;
    const arr = line.type === 'attack' ? 'attackTargets' : 'defendTargets';
    const route = (src[arr] || []).find(t => t.cityId === line.tgtId);
    if(!route) return;
    route[field] = parseFloat(value) || 0;
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
    render();
  }
  return { init, render };
})();

/* ============================================================
   RouteManager — 地圖路線管理
   ============================================================ */
const RouteManager = (() => {
  let editingRouteId = null;
  function init(){
    const btnQuick = document.getElementById('btnQuickAddRoute');
    if(btnQuick) btnQuick.addEventListener('click', doQuickAdd);
    const selA = document.getElementById('quickRouteCityA');
    const selB = document.getElementById('quickRouteCityB');
    [selA, selB].forEach(sel => {
      if(sel) sel.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); doQuickAdd(); } });
    });
    const btnAdd = document.getElementById('btnAddRouteLine');
    if(btnAdd) btnAdd.addEventListener('click', addEmptyLine);
    const btnExpand = document.getElementById('btnExpandAllRouteGroups');
    if(btnExpand) btnExpand.addEventListener('click', () => {
      document.querySelectorAll('.route-group').forEach(g => g.classList.add('open'));
    });
    const btnCollapse = document.getElementById('btnCollapseAllRouteGroups');
    if(btnCollapse) btnCollapse.addEventListener('click', () => {
      document.querySelectorAll('.route-group').forEach(g => g.classList.remove('open'));
    });
    const groups = document.getElementById('routeGroups');
    if(groups){
      groups.addEventListener('click', e => {
        const header = e.target.closest('.route-group-header');
        if(header){
          const group = header.closest('.route-group');
          if(group) group.classList.toggle('open');
          return;
        }
        const delBtn = e.target.closest('[data-route-del]');
        if(delBtn){
          e.stopPropagation();
          const id = delBtn.dataset.routeId;
          if(window.SLG.removeRoute(id)){
            if(window.SLG.saveState) window.SLG.saveState('important');
            render();
            if(window.SLG.GameMap) window.SLG.GameMap.render();
            if(window.SLG.WarManager) window.SLG.WarManager.render();
          }
          return;
        }
        const modalBtn = e.target.closest('[data-route-modal]');
        if(modalBtn){ e.stopPropagation(); openRouteEditModal(modalBtn.dataset.routeId); return; }
      });
      groups.addEventListener('change', e => {
        const sel = e.target.closest('[data-route-src],[data-route-tgt]');
        if(!sel) return;
        const line = sel.closest('.route-line');
        if(!line) return;
        const oldId = line.dataset.routeId;
        const srcId = line.querySelector('[data-route-src]').value;
        const tgtId = line.querySelector('[data-route-tgt]').value;
        if(!srcId || !tgtId || srcId === tgtId){
          if(oldId){ window.SLG.removeRoute(oldId); }
          if(window.SLG.saveState) window.SLG.saveState('important');
          render();
          if(window.SLG.GameMap) window.SLG.GameMap.render();
          if(window.SLG.WarManager) window.SLG.WarManager.render();
          return;
        }
        if(oldId){ window.SLG.removeRoute(oldId); }
        window.SLG.addRoute(srcId, tgtId);
        if(window.SLG.saveState) window.SLG.saveState('important');
        render();
        if(window.SLG.GameMap) window.SLG.GameMap.render();
        if(window.SLG.WarManager) window.SLG.WarManager.render();
      });
    }
    const mCancel = document.getElementById('routeEditCancel');
    if(mCancel) mCancel.addEventListener('click', closeRouteEditModal);
    const mSave = document.getElementById('routeEditSave');
    if(mSave) mSave.addEventListener('click', saveRouteEditModal);
    const mDelete = document.getElementById('routeEditDelete');
    if(mDelete) mDelete.addEventListener('click', deleteRouteFromModal);
  }
  function doQuickAdd(){
    const selA = document.getElementById('quickRouteCityA');
    const selB = document.getElementById('quickRouteCityB');
    if(!selA || !selB) return;
    const aId = selA.value, bId = selB.value;
    if(!aId || !bId){ alert('請選擇城池 A 與城池 B'); return; }
    if(aId === bId){ alert('兩城池不可相同'); return; }
    if(window.SLG.findRoute(aId, bId)){ alert('此路線已存在'); return; }
    const r = window.SLG.addRoute(aId, bId);
    if(r){
      if(window.SLG.saveState) window.SLG.saveState('important');
      render();
      if(window.SLG.GameMap) window.SLG.GameMap.render();
      if(window.SLG.WarManager) window.SLG.WarManager.render();
      logSystem('🛣️ 已新增路線');
    }
  }
  function addEmptyLine(){
    if(state.cities.length < 2){ alert('至少需要 2 座城池'); return; }
    const cities = state.cities;
    for(let i = 0; i < cities.length; i++){
      for(let j = i + 1; j < cities.length; j++){
        const a = cities[i], b = cities[j];
        if(!window.SLG.findRoute(a.id, b.id)){
          const r = window.SLG.addRoute(a.id, b.id);
          if(r){
            if(window.SLG.saveState) window.SLG.saveState('important');
            render();
            if(window.SLG.GameMap) window.SLG.GameMap.render();
            if(window.SLG.WarManager) window.SLG.WarManager.render();
            return;
          }
        }
      }
    }
    alert('所有城池組合都已有路線');
  }
  function getCityZoneName(cityId){
    const city = state.cities.find(c => c.id === cityId);
    if(!city) return '（無效城池）';
    if(!city.zoneId) return '未分配戰區';
    const zone = state.zones.find(z => z.id === city.zoneId);
    return zone ? zone.name : '未分配戰區';
  }
  function groupRoutes(){
    const groups = new Map();
    for(const r of (state.routes || [])){
      const zoneName = getCityZoneName(r.cityAId);
      if(!groups.has(zoneName)) groups.set(zoneName, []);
      groups.get(zoneName).push(r);
    }
    const arr = [...groups.entries()];
    arr.sort((a, b) => {
      if(a[0] === '未分配戰區') return 1;
      if(b[0] === '未分配戰區') return -1;
      return a[0].localeCompare(b[0], 'zh-Hant');
    });
    return arr;
  }
  function render(){
    populateQuickSelects();
    const el = document.getElementById('routeGroups');
    if(!el) return;
    const routes = state.routes || [];
    if(routes.length === 0){
      el.innerHTML = '<div class="route-groups-empty">尚無地圖路線。使用上方快速新增建立第一條路線。</div>';
      return;
    }
    const cityOpts = (selectedId) => state.cities.map(c =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`
    ).join('');
    const groups = groupRoutes();
    el.innerHTML = groups.map(([zoneName, list], gi) => {
      const groupId = 'route-group-' + gi;
      const bodyHtml = list.map(r => {
        return `<div class="route-line" data-route-id="${r.id}">
          <select data-route-src>${cityOpts(r.cityAId)}</select>
          <span class="route-arrow">—</span>
          <select data-route-tgt>${cityOpts(r.cityBId)}</select>
          <button class="btn btn-sm route-modal-btn" data-route-modal="1" data-route-id="${r.id}" title="開啟 Modal 編輯">✏️</button>
          <button class="btn btn-danger btn-sm" data-route-del="1" data-route-id="${r.id}" title="刪除">🗑️</button>
        </div>`;
      }).join('');
      const openCls = gi === 0 ? 'open' : '';
      return `<div class="route-group ${openCls}" id="${groupId}">
        <div class="route-group-header">
          <span class="toggle-icon">▶</span>
          <span class="group-name">🗺️ ${esc(zoneName)}</span>
          <span class="group-count">${list.length} 條</span>
        </div>
        <div class="route-group-body">${bodyHtml}</div>
      </div>`;
    }).join('');
  }
  function populateQuickSelects(){
    const selA = document.getElementById('quickRouteCityA');
    const selB = document.getElementById('quickRouteCityB');
    if(!selA || !selB) return;
    const curA = selA.value, curB = selB.value;
    const opts = '<option value="">選擇城池...</option>' +
      state.cities.map(c => `<option value="${c.id}">${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`).join('');
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    if(curA && state.cities.find(c => c.id === curA)) selA.value = curA;
    if(curB && state.cities.find(c => c.id === curB)) selB.value = curB;
  }
  function openRouteEditModal(routeId){
    const r = (state.routes || []).find(x => x.id === routeId);
    if(!r){ alert('找不到此路線'); return; }
    editingRouteId = routeId;
    const selA = document.getElementById('re_cityA');
    const selB = document.getElementById('re_cityB');
    const hint = document.getElementById('routeEditHint');
    if(selA){ selA.innerHTML = state.cities.map(c => `<option value="${c.id}" ${c.id === r.cityAId ? 'selected' : ''}>${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`).join(''); }
    if(selB){ selB.innerHTML = state.cities.map(c => `<option value="${c.id}" ${c.id === r.cityBId ? 'selected' : ''}>${esc(c.name)}${c.code ? ' [' + esc(c.code) + ']' : ''}</option>`).join(''); }
    if(hint) hint.textContent = '＊兩城池不可相同，且路線不可重複（A-B 等同 B-A）。';
    const modal = document.getElementById('routeEditModal');
    if(modal) modal.classList.add('show');
  }
  function closeRouteEditModal(){
    editingRouteId = null;
    const modal = document.getElementById('routeEditModal');
    if(modal) modal.classList.remove('show');
  }
  function saveRouteEditModal(){
    if(!editingRouteId) return;
    const selA = document.getElementById('re_cityA');
    const selB = document.getElementById('re_cityB');
    if(!selA || !selB) return;
    const aId = selA.value, bId = selB.value;
    if(!aId || !bId){ alert('請選擇兩座城池'); return; }
    if(aId === bId){ alert('兩城池不可相同'); return; }
    const existing = window.SLG.findRoute(aId, bId);
    if(existing && existing.id !== editingRouteId){ alert('此路線已存在'); return; }
    const r = (state.routes || []).find(x => x.id === editingRouteId);
    if(!r){ closeRouteEditModal(); return; }
    r.cityAId = aId;
    r.cityBId = bId;
    if(window.SLG.saveState) window.SLG.saveState('important');
    closeRouteEditModal();
    render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.WarManager) window.SLG.WarManager.render();
    logSystem('🛣️ 已更新路線');
  }
  function deleteRouteFromModal(){
    if(!editingRouteId) return;
    const r = (state.routes || []).find(x => x.id === editingRouteId);
    if(!r){ closeRouteEditModal(); return; }
    if(!confirm('確定要刪除此路線嗎？')) return;
    window.SLG.removeRoute(editingRouteId);
    if(window.SLG.saveState) window.SLG.saveState('important');
    closeRouteEditModal();
    render();
    if(window.SLG.GameMap) window.SLG.GameMap.render();
    if(window.SLG.WarManager) window.SLG.WarManager.render();
    logSystem('🛣️ 已刪除路線');
  }
  return { init, render, openRouteEditModal, closeRouteEditModal };
})();

/* ============================================================
   GameMap — 地圖（v8.9.3）
   ============================================================ */
const GameMap = (() => {
  let canvas, ctx, containerEl, outerEl;
  let view = { x: 0, y: 0, scale: 1 };
  let nodePositions = new Map();
  let layoutDirty = true;
  let dragging = false;
  let dragStart = null;
  let nodeDragging = null;
  let editRouteMode = false;
  let routeDragFrom = null;
  let routeDragEnd = null;
  let hoveredCityId = null;
  let highlight = null;
  let currentZoneFilter = 'all';
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartCenter = null;
  let touchPanStart = null;

  /* v8.9.2：宣戰模式狀態 */
  let warMode = false;
  let warFromCityId = '';
  let warHoverTgtId = '';
  let pendingWarCount = 0;

  /* v8.9.3：宣戰模式點擊判定 */
  let warPointerStart = null;
  let warTouchStart = null;

  /* v8.9.3：底圖開關 */
  let baseMapVisible = true;

  const CANVAS_W = 2000, CANVAS_H = 2000;
  const LS_MAP_ZONE_KEY = 'slg_map_zone_v862';
  const LS_BASE_MAP_KEY = 'slg_base_map_visible_v893';

  let activeMapId = '';
  let activeMapNodes = null;
  let activeMapImageEl = null;

  function init(){
    containerEl = document.getElementById('gameMapContainer');
    outerEl = document.getElementById('gameMapOuter');
    if(!containerEl) return;
    canvas = document.getElementById('gameMapCanvas');
    if(!canvas) return;
    ctx = canvas.getContext('2d');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = CANVAS_W + 'px';
    canvas.style.height = CANVAS_H + 'px';
    loadZoneFilter();
    loadBaseMapPref();
    applyBaseMapUI();
    containerEl.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', () => { hoveredCityId = null; });
    containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', onTouchEnd, { passive: false });

    const btnEdit = document.getElementById('btnMapEditRoute');
    if(btnEdit && !btnEdit.dataset.bound){
      btnEdit.dataset.bound = '1';
      btnEdit.addEventListener('click', () => {
        editRouteMode = !editRouteMode;
        if(editRouteMode && warMode) setWarMode(false);
        btnEdit.textContent = editRouteMode ? '✏️ 編輯路線：開' : '✏️ 編輯路線：關';
        btnEdit.classList.toggle('active', editRouteMode);
        applyCursor();
      });
    }

    const btnWar = document.getElementById('btnMapWarMode');
    if(btnWar && !btnWar.dataset.bound){
      btnWar.dataset.bound = '1';
      btnWar.addEventListener('click', () => {
        setWarMode(!warMode);
        btnWar.textContent = warMode ? '⚔️ 宣戰模式：開' : '⚔️ 宣戰模式：關';
        btnWar.classList.toggle('active', warMode);
      });
    }

    /* v8.9.3：底圖開關按鈕 */
    const btnBaseMap = document.getElementById('btnMapBaseMap');
    if(btnBaseMap && !btnBaseMap.dataset.bound){
      btnBaseMap.dataset.bound = '1';
      btnBaseMap.addEventListener('click', toggleBaseMap);
    }

    const btnRelayout = document.getElementById('btnMapRelayout');
    if(btnRelayout) btnRelayout.addEventListener('click', () => {
      layoutDirty = true;
      view = { x: 0, y: 0, scale: 1 };
      applyView();
      render();
    });

    const btnFit = document.getElementById('btnMapFit');
    if(btnFit) btnFit.addEventListener('click', () => { fitView(); applyView(); render(); });

    const btnClearHighlight = document.getElementById('btnMapClearHighlight');
    if(btnClearHighlight) btnClearHighlight.addEventListener('click', () => {
      if(window.SLG.clearDistanceHighlight) window.SLG.clearDistanceHighlight();
    });

    const btnExportPDF = document.getElementById('btnMapExportPDF');
    if(btnExportPDF && !btnExportPDF.dataset.bound){
      btnExportPDF.dataset.bound = '1';
      btnExportPDF.addEventListener('click', exportAsPDF);
    }

    bindFloatButtons();

    const mapZoneSel = document.getElementById('mapZoneSelect');
    if(mapZoneSel && !mapZoneSel.dataset.bound){
      mapZoneSel.dataset.bound = '1';
      mapZoneSel.addEventListener('change', function(){ setZoneFilter(this.value); });
    }

    if(window.SLG.EVT && window.SLG.on){
      window.SLG.on(window.SLG.EVT.DISTANCE_HIGHLIGHT, (h) => { highlight = h; render(); });
      window.SLG.on(window.SLG.EVT.DISTANCE_CLEAR, () => { highlight = null; render(); });
      window.SLG.on(window.SLG.EVT.MAP_LIBRARY_UPDATED, () => { onMapLibraryChanged(); });
    }
    window.addEventListener('resize', () => { if(containerEl) render(); });
    refreshZoneSelector();
    onMapLibraryChanged();
  }

  function bindFloatButtons(){
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if(el && !el.dataset.bound){
        el.dataset.bound = '1';
        el.addEventListener('click', fn);
      }
    };
    bind('btnMapZoomIn', () => zoomAtCenter(1.25));
    bind('btnMapZoomOut', () => zoomAtCenter(1 / 1.25));
    bind('btnMapZoomFitBtn', () => { fitView(); applyView(); render(); });
    bind('btnMapZoomReset', () => {
      view = { x: 0, y: 0, scale: 1 };
      if(containerEl){ containerEl.scrollLeft = 0; containerEl.scrollTop = 0; }
      applyView();
      render();
    });
    bind('btnMapPanLeft',  () => panBy(-1, 0));
    bind('btnMapPanRight', () => panBy( 1, 0));
    bind('btnMapPanUp',    () => panBy( 0, -1));
    bind('btnMapPanDown',  () => panBy( 0,  1));
    bind('mapWarSaveBtn', saveWarChanges);
  }

  function zoomAtCenter(factor){
    if(!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const mx = (cx - rect.left + containerEl.scrollLeft) / view.scale;
    const my = (cy - rect.top + containerEl.scrollTop) / view.scale;
    const newScale = Math.max(0.2, Math.min(3, view.scale * factor));
    view.x = mx - (cx - rect.left + containerEl.scrollLeft) / newScale;
    view.y = my - (cy - rect.top + containerEl.scrollTop) / newScale;
    view.scale = newScale;
    applyView();
    render();
  }

  function panBy(dirX, dirY){
    if(!containerEl) return;
    const stepX = containerEl.clientWidth / 3;
    const stepY = containerEl.clientHeight / 3;
    containerEl.scrollLeft += dirX * stepX;
    containerEl.scrollTop += dirY * stepY;
  }

  function setWarMode(on){
    warMode = !!on;
    warFromCityId = '';
    warHoverTgtId = '';
    warPointerStart = null;
    warTouchStart = null;
    updateWarHint();
    if(outerEl) outerEl.classList.toggle('war-mode', warMode);
    applyCursor();
    render();
  }

  function updateWarHint(){
    const hint = document.getElementById('mapWarHint');
    const hintText = document.getElementById('mapWarHintText');
    if(!hint || !hintText) return;
    if(!warMode){
      hint.classList.add('hidden');
      return;
    }
    hint.classList.remove('hidden');
    if(!warFromCityId){
      hintText.textContent = '⚔️ 請點選出兵城';
    } else {
      const city = state.cities.find(c => c.id === warFromCityId);
      hintText.textContent = `⚔️ 出兵城：${city ? city.name : '?'} — 請點目標城`;
    }
  }

  function onMapLibraryChanged(){
    const newId = state.mapLibrary.activeMapId || '';
    const map = newId ? getLoadedMap(newId) : null;
    activeMapId = newId;
    activeMapNodes = (map && map.nodes) ? map.nodes : null;
    activeMapImageEl = (map && map.imageEl) ? map.imageEl : null;
    layoutDirty = true;
    nodePositions.clear();
    if(activeMapImageEl){
      const w = activeMapImageEl.naturalWidth || map.imageWidth || CANVAS_W;
      const h = activeMapImageEl.naturalHeight || map.imageHeight || CANVAS_H;
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    } else {
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      canvas.style.width = CANVAS_W + 'px';
      canvas.style.height = CANVAS_H + 'px';
    }
    view = { x: 0, y: 0, scale: 1 };
    applyView();
    render();
    if(containerEl && activeMapImageEl){ fitView(); applyView(); render(); }
  }

  function loadZoneFilter(){
    try{
      const saved = localStorage.getItem(LS_MAP_ZONE_KEY);
      if(saved) currentZoneFilter = saved;
    }catch(e){}
  }
  function saveZoneFilter(){
    try{ localStorage.setItem(LS_MAP_ZONE_KEY, currentZoneFilter); }catch(e){}
  }
  function loadBaseMapPref(){
    try{
      const saved = localStorage.getItem(LS_BASE_MAP_KEY);
      if(saved === '0') baseMapVisible = false;
      else if(saved === '1') baseMapVisible = true;
    }catch(e){}
  }
  function saveBaseMapPref(){
    try{ localStorage.setItem(LS_BASE_MAP_KEY, baseMapVisible ? '1' : '0'); }catch(e){}
  }
  function applyBaseMapUI(){
    const btnBaseMap = document.getElementById('btnMapBaseMap');
    if(btnBaseMap){
      btnBaseMap.textContent = baseMapVisible ? '🖼️ 底圖：開' : '🖼️ 底圖：關';
      btnBaseMap.classList.toggle('active', !baseMapVisible);
    }
    if(outerEl) outerEl.classList.toggle('base-map-off', !baseMapVisible);
  }
  function toggleBaseMap(){
    baseMapVisible = !baseMapVisible;
    saveBaseMapPref();
    applyBaseMapUI();
    render();
    logSystem(baseMapVisible ? '🖼️ 底圖：開' : '🖼️ 底圖：關');
  }

  function getZoneFilter(){ return currentZoneFilter; }
  function setZoneFilter(zoneId){
    currentZoneFilter = zoneId || 'all';
    saveZoneFilter();
    const sel = document.getElementById('mapZoneSelect');
    if(sel && sel.value !== currentZoneFilter) sel.value = currentZoneFilter;
    fitView(); applyView(); render();
  }
  function refreshZoneSelector(){
    const sel = document.getElementById('mapZoneSelect');
    if(!sel) return;
    const zoneCounts = new Map();
    for(const c of state.cities){
      const zid = c.zoneId || '__none__';
      zoneCounts.set(zid, (zoneCounts.get(zid) || 0) + 1);
    }
    let html = `<option value="all">🌐 全部（${state.cities.length}）</option>`;
    for(const z of state.zones){
      const n = zoneCounts.get(z.id) || 0;
      html += `<option value="${z.id}">${esc(z.name)}（${n}）</option>`;
    }
    const noneCount = zoneCounts.get('__none__') || 0;
    if(noneCount > 0){ html += `<option value="__none__">未分配（${noneCount}）</option>`; }
    sel.innerHTML = html;
    const validValues = ['all', '__none__'].concat(state.zones.map(z => z.id));
    if(!validValues.includes(currentZoneFilter)){ currentZoneFilter = 'all'; saveZoneFilter(); }
    sel.value = currentZoneFilter;
  }
  function getVisibleRect(){
    if(!containerEl) return null;
    const sc = view.scale || 1;
    const left = containerEl.scrollLeft / sc;
    const top = containerEl.scrollTop / sc;
    const width = (containerEl.clientWidth || 600) / sc;
    const height = (containerEl.clientHeight || 400) / sc;
    return { left, top, right: left + width, bottom: top + height };
  }
  function rayToRectEdge(sx, sy, ux, uy, rect){
    let minT = Infinity;
    if(ux > 0.0001) minT = Math.min(minT, (rect.right - sx) / ux);
    else if(ux < -0.0001) minT = Math.min(minT, (rect.left - sx) / ux);
    if(uy > 0.0001) minT = Math.min(minT, (rect.bottom - sy) / uy);
    else if(uy < -0.0001) minT = Math.min(minT, (rect.top - sy) / uy);
    if(!isFinite(minT) || minT <= 0) return null;
    return { x: sx + ux * minT, y: sy + uy * minT };
  }
  function applyCursor(){
    if(!canvas) return;
    if(warMode) canvas.style.cursor = 'crosshair';
    else if(editRouteMode) canvas.style.cursor = 'crosshair';
    else canvas.style.cursor = 'grab';
  }
  function onWheel(e){
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const mx = (e.clientX - rect.left + containerEl.scrollLeft) / view.scale;
    const my = (e.clientY - rect.top + containerEl.scrollTop) / view.scale;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.2, Math.min(3, view.scale * factor));
    view.x = mx - (e.clientX - rect.left + containerEl.scrollLeft) / newScale;
    view.y = my - (e.clientY - rect.top + containerEl.scrollTop) / newScale;
    view.scale = newScale;
    applyView();
    render();
  }
  function touchDist(t1, t2){ return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY); }
  function touchCenter(t1, t2){ return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }; }

  function onTouchStart(e){
    if(e.touches.length === 2){
      e.preventDefault();
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = view.scale;
      pinchStartCenter = touchCenter(e.touches[0], e.touches[1]);
      dragging = false; nodeDragging = null; routeDragFrom = null;
    } else if(e.touches.length === 1){
      const t = e.touches[0];

      /* v8.9.3：宣戰模式優先處理 */
      if(warMode){
        warTouchStart = { x: t.clientX, y: t.clientY, moved: false };
        e.preventDefault();
        return;
      }

      const worldPos = getWorldPosFromClient(t.clientX, t.clientY);
      const city = pickCity(worldPos);
      if(!warMode && city){
        nodeDragging = { cityId: city.id, offsetX: worldPos.x - nodePositions.get(city.id).x, offsetY: worldPos.y - nodePositions.get(city.id).y };
        e.preventDefault();
      } else if(editRouteMode){
        const city2 = pickCity(worldPos);
        if(city2){ routeDragFrom = city2; routeDragEnd = worldPos; e.preventDefault(); }
        else { touchPanStart = { x: t.clientX, y: t.clientY, sx: containerEl.scrollLeft, sy: containerEl.scrollTop }; }
      } else {
        touchPanStart = { x: t.clientX, y: t.clientY, sx: containerEl.scrollLeft, sy: containerEl.scrollTop };
      }
    }
  }

  function onTouchMove(e){
    if(e.touches.length === 2 && pinchStartDist > 0){
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      const center = touchCenter(e.touches[0], e.touches[1]);
      const factor = dist / pinchStartDist;
      const newScale = Math.max(0.2, Math.min(3, pinchStartScale * factor));
      const rect = containerEl.getBoundingClientRect();
      const cx = (center.x - rect.left + containerEl.scrollLeft) / view.scale;
      const cy = (center.y - rect.top + containerEl.scrollTop) / view.scale;
      view.x = cx - (center.x - rect.left + containerEl.scrollLeft) / newScale;
      view.y = cy - (center.y - rect.top + containerEl.scrollTop) / newScale;
      view.scale = newScale;
      applyView();
      render();
      return;
    }
    if(e.touches.length === 1){
      const t = e.touches[0];

      /* v8.9.3：宣戰模式：僅記錄移動，不拖曳畫布 */
      if(warMode && warTouchStart){
        const dx = Math.abs(t.clientX - warTouchStart.x);
        const dy = Math.abs(t.clientY - warTouchStart.y);
        if(dx > 5 || dy > 5) warTouchStart.moved = true;
        e.preventDefault();
        return;
      }

      const worldPos = getWorldPosFromClient(t.clientX, t.clientY);
      if(nodeDragging){
        e.preventDefault();
        const p = nodePositions.get(nodeDragging.cityId);
        if(p){ p.x = worldPos.x - nodeDragging.offsetX; p.y = worldPos.y - nodeDragging.offsetY; render(); }
        return;
      }
      if(routeDragFrom){ e.preventDefault(); routeDragEnd = worldPos; render(); return; }
      if(touchPanStart){
        e.preventDefault();
        const dx = t.clientX - touchPanStart.x;
        const dy = t.clientY - touchPanStart.y;
        containerEl.scrollLeft = touchPanStart.sx - dx;
        containerEl.scrollTop = touchPanStart.sy - dy;
      }
    }
  }

  function onTouchEnd(e){
    if(e.touches.length < 2){ pinchStartDist = 0; pinchStartCenter = null; }
    if(e.touches.length === 0){
      /* v8.9.3：宣戰模式：判定點擊 */
      if(warMode && warTouchStart){
        if(!warTouchStart.moved){
          const t = e.changedTouches[0];
          if(t) handleWarTap(t.clientX, t.clientY);
        }
        warTouchStart = null;
        e.preventDefault();
        return;
      }

      if(routeDragFrom){
        const t = e.changedTouches[0];
        const worldPos = getWorldPosFromClient(t.clientX, t.clientY);
        const targetCity = pickCity(worldPos);
        if(targetCity && targetCity.id !== routeDragFrom.id){
          const existing = window.SLG.findRoute(routeDragFrom.id, targetCity.id);
          if(existing){ window.SLG.removeRoute(existing.id); }
          else { window.SLG.addRoute(routeDragFrom.id, targetCity.id); }
          if(window.SLG.saveState) window.SLG.saveState('important');
          if(window.SLG.RouteManager) window.SLG.RouteManager.render();
          if(window.SLG.WarManager) window.SLG.WarManager.render();
        }
        routeDragFrom = null; routeDragEnd = null;
        render();
      }
      nodeDragging = null;
      touchPanStart = null;
      applyCursor();
    }
  }

  function getWorldPos(e){ return getWorldPosFromClient(e.clientX, e.clientY); }
  function getWorldPosFromClient(clientX, clientY){
    const rect = containerEl.getBoundingClientRect();
    const sx = clientX - rect.left + containerEl.scrollLeft;
    const sy = clientY - rect.top + containerEl.scrollTop;
    return { x: sx / view.scale, y: sy / view.scale };
  }
  function pickCity(worldPos){
    let closest = null, minDist = 40;
    for(const c of state.cities){
      if(!isCityVisibleInCurrentZone(c)) continue;
      const p = nodePositions.get(c.id);
      if(!p) continue;
      const d = Math.hypot(p.x - worldPos.x, p.y - worldPos.y);
      if(d < minDist){ minDist = d; closest = c; }
    }
    return closest;
  }
  function isCityVisibleInCurrentZone(city){
    if(currentZoneFilter === 'all') return true;
    return (city.zoneId || '__none__') === currentZoneFilter;
  }

  function onPointerDown(e){
    if(e.pointerType === 'touch') return;

    /* v8.9.3：宣戰模式：記錄起始位置，等待 pointerup 判定點擊 */
    if(warMode){
      warPointerStart = { x: e.clientX, y: e.clientY, moved: false };
      return;
    }

    const worldPos = getWorldPos(e);
    if(editRouteMode){
      const city = pickCity(worldPos);
      if(city){ routeDragFrom = city; routeDragEnd = worldPos; return; }
    }
    const city = pickCity(worldPos);
    if(city){
      nodeDragging = { cityId: city.id, offsetX: worldPos.x - nodePositions.get(city.id).x, offsetY: worldPos.y - nodePositions.get(city.id).y };
      canvas.style.cursor = 'grabbing';
      return;
    }
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, sx: containerEl.scrollLeft, sy: containerEl.scrollTop };
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e){
    if(e.pointerType === 'touch') return;

    /* v8.9.3：宣戰模式：記錄移動 */
    if(warMode && warPointerStart){
      const dx = Math.abs(e.clientX - warPointerStart.x);
      const dy = Math.abs(e.clientY - warPointerStart.y);
      if(dx > 5 || dy > 5) warPointerStart.moved = true;

      /* 更新 hover 預覽 */
      const worldPos = getWorldPos(e);
      const city = pickCity(worldPos);
      if(warFromCityId){
        warHoverTgtId = (city && city.id !== warFromCityId) ? city.id : '';
        render();
      }
      return;
    }

    const worldPos = getWorldPos(e);
    const city = pickCity(worldPos);
    hoveredCityId = city ? city.id : null;

    if(warMode && warFromCityId){
      warHoverTgtId = (city && city.id !== warFromCityId) ? city.id : '';
      render();
      return;
    }

    if(nodeDragging){
      const p = nodePositions.get(nodeDragging.cityId);
      if(p){ p.x = worldPos.x - nodeDragging.offsetX; p.y = worldPos.y - nodeDragging.offsetY; render(); }
      return;
    }
    if(routeDragFrom){ routeDragEnd = worldPos; render(); return; }
    if(dragging){
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      containerEl.scrollLeft = dragStart.sx - dx;
      containerEl.scrollTop = dragStart.sy - dy;
      return;
    }
    if(state.cities.length > 0) render();
  }

  function onPointerUp(e){
    if(e.pointerType === 'touch') return;

    /* v8.9.3：宣戰模式：判定點擊 */
    if(warMode && warPointerStart){
      if(!warPointerStart.moved){
        handleWarTap(e.clientX, e.clientY);
      }
      warPointerStart = null;
      return;
    }

    if(nodeDragging){ nodeDragging = null; applyCursor(); return; }
    if(routeDragFrom){
      const worldPos = getWorldPos(e);
      const targetCity = pickCity(worldPos);
      if(targetCity && targetCity.id !== routeDragFrom.id){
        const existing = window.SLG.findRoute(routeDragFrom.id, targetCity.id);
        if(existing){ window.SLG.removeRoute(existing.id); }
        else { window.SLG.addRoute(routeDragFrom.id, targetCity.id); }
        if(window.SLG.saveState) window.SLG.saveState('important');
        if(window.SLG.RouteManager) window.SLG.RouteManager.render();
        if(window.SLG.WarManager) window.SLG.WarManager.render();
      }
      routeDragFrom = null; routeDragEnd = null;
      render();
      return;
    }
    if(dragging){ dragging = false; applyCursor(); }
  }

  function handleWarTap(clientX, clientY){
    const worldPos = getWorldPosFromClient(clientX, clientY);
    const city = pickCity(worldPos);
    if(!city) return;

    if(!warFromCityId){
      warFromCityId = city.id;
      warHoverTgtId = '';
      updateWarHint();
      render();
      return;
    }

    if(city.id === warFromCityId){
      warFromCityId = '';
      warHoverTgtId = '';
      updateWarHint();
      render();
      return;
    }

    const fromCity = state.cities.find(c => c.id === warFromCityId);
    const toCity = city;
    if(fromCity && toCity && window.SLG.WarQuickPanel){
      window.SLG.WarQuickPanel.open(fromCity, toCity, () => {
        warFromCityId = '';
        warHoverTgtId = '';
        updateWarHint();
        render();
      });
    }
  }

  function accumulateWarChange(){
    pendingWarCount++;
    const btn = document.getElementById('mapWarSaveBtn');
    const cnt = document.getElementById('mapWarSaveCount');
    if(btn) btn.classList.remove('hidden');
    if(cnt) cnt.textContent = pendingWarCount;
  }

  async function saveWarChanges(){
    if(pendingWarCount === 0) return;
    const btn = document.getElementById('mapWarSaveBtn');
    if(btn) btn.disabled = true;
    try{
      if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
      if(window.SLG.saveState) window.SLG.saveState('important');
      if(window.SLG.WarManager) window.SLG.WarManager.render();
      if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
      if(window.SLG.Render) window.SLG.Render.renderCities && window.SLG.Render.renderCities();
      logSystem(`💾 已儲存 ${pendingWarCount} 筆宣戰變更`);
      pendingWarCount = 0;
      if(btn) btn.classList.add('hidden');
      if(document.getElementById('mapWarSaveCount')) document.getElementById('mapWarSaveCount').textContent = '0';
    }catch(e){
      alert('❌ 儲存失敗：' + e.message);
    }finally{
      if(btn) btn.disabled = false;
    }
  }

  function resolveCityMapNode(city, mapNodes){
    if(!city || !mapNodes) return null;
    if(city.mapNode && city.mapNode.nodeId && mapNodes[city.mapNode.nodeId]){
      return mapNodes[city.mapNode.nodeId];
    }
    if(city.code){
      for(const nid in mapNodes){
        if(mapNodes[nid].code === city.code) return mapNodes[nid];
      }
    }
    if(city.name){
      for(const nid in mapNodes){
        if(mapNodes[nid].name === city.name) return mapNodes[nid];
      }
    }
    return null;
  }

  function computeLayout(){
    const cities = state.cities;
    if(cities.length === 0){ nodePositions.clear(); return; }

    if(activeMapNodes && Object.keys(activeMapNodes).length > 0){
      nodePositions.clear();
      for(const c of cities){
        const n = resolveCityMapNode(c, activeMapNodes);
        if(n){
          nodePositions.set(c.id, { x: Number(n.x) || 0, y: Number(n.y) || 0 });
        }
      }
      layoutDirty = false;
      return;
    }

    if(!layoutDirty && nodePositions.size === cities.length) return;
    nodePositions.clear();
    const W = CANVAS_W, H = CANVAS_H, PAD = 200;
    const N = cities.length;
    const area = (W - PAD * 2) * (H - PAD * 2);
    const k = Math.sqrt(area / Math.max(N, 1)) * 0.55;
    cities.forEach((c, i) => {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      const r = 200 + (i % 4) * 80;
      nodePositions.set(c.id, { x: W/2 + Math.cos(ang) * r, y: H/2 + Math.sin(ang) * r });
    });
    const edges = [];
    for(const r of (state.routes || [])){
      if(nodePositions.has(r.cityAId) && nodePositions.has(r.cityBId)) edges.push([r.cityAId, r.cityBId]);
    }
    const iterations = N > 60 ? 150 : 300;
    let temp = W / 10;
    const cool = temp / (iterations + 1);
    for(let iter = 0; iter < iterations; iter++){
      const disp = new Map();
      cities.forEach(c => disp.set(c.id, { x: 0, y: 0 }));
      for(let i = 0; i < N; i++){
        for(let j = i + 1; j < N; j++){
          const a = nodePositions.get(cities[i].id);
          const b = nodePositions.get(cities[j].id);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if(d < 0.01){ dx = (Math.random()-0.5)*10; dy = (Math.random()-0.5)*10; d = Math.hypot(dx, dy) || 0.01; }
          const force = (k * k) / d;
          const fx = (dx / d) * force, fy = (dy / d) * force;
          const da = disp.get(cities[i].id), db = disp.get(cities[j].id);
          da.x += fx; da.y += fy;
          db.x -= fx; db.y -= fy;
        }
      }
      for(const [aId, bId] of edges){
        const pa = nodePositions.get(aId), pb = nodePositions.get(bId);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if(d < 0.01) d = 0.01;
        const force = (d * d) / k * 1.2;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        const da = disp.get(aId), db = disp.get(bId);
        da.x -= fx; da.y -= fy;
        db.x += fx; db.y += fy;
      }
      cities.forEach(c => {
        const d = disp.get(c.id);
        const p = nodePositions.get(c.id);
        const len = Math.hypot(d.x, d.y);
        if(len > 0){
          const limit = Math.min(len, temp);
          p.x += (d.x / len) * limit;
          p.y += (d.y / len) * limit;
        }
        p.x = Math.max(PAD, Math.min(W - PAD, p.x));
        p.y = Math.max(PAD, Math.min(H - PAD, p.y));
      });
      temp = Math.max(temp - cool, 0.5);
    }
    layoutDirty = false;
  }

  function fitView(){
    if(nodePositions.size === 0){ view = { x: 0, y: 0, scale: 1 }; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for(const c of state.cities){
      if(!isCityVisibleInCurrentZone(c)) continue;
      const p = nodePositions.get(c.id);
      if(!p) continue;
      any = true;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    if(!any){
      if(activeMapImageEl){
        const availW = containerEl.clientWidth || 600;
        const availH = containerEl.clientHeight || 400;
        const sc = Math.min(availW / canvas.width, availH / canvas.height);
        view.scale = sc;
        view.x = 0; view.y = 0;
      }
      return;
    }
    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const availW = containerEl.clientWidth || 600;
    const availH = containerEl.clientHeight || 400;
    const scale = Math.min(availW / (contentW + 200), availH / (contentH + 200), 1.5);
    view.scale = scale;
    view.x = Math.max(0, minX - 100);
    view.y = Math.max(0, minY - 100);
  }

  function applyView(){
    if(!canvas) return;
    canvas.style.transform = `scale(${view.scale})`;
    canvas.style.transformOrigin = '0 0';
    if(containerEl){
      containerEl.scrollLeft = view.x * view.scale;
      containerEl.scrollTop = view.y * view.scale;
    }
  }

  function drawCrossZoneEdge(fromPos, toPos, visRect, color, dashed){
    if(!visRect) return;
    const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y;
    const len = Math.hypot(dx, dy);
    if(len < 0.01) return;
    const ux = dx / len, uy = dy / len;
    const hit = rayToRectEdge(fromPos.x, fromPos.y, ux, uy, visRect);
    if(!hit) return;
    const startX = fromPos.x + ux * 36;
    const startY = fromPos.y + uy * 36;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    if(dashed) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    if(dashed) ctx.setLineDash([]);
  }

  function drawCrossZoneArrow(fromPos, toPos, visRect, isAttack, targetName){
    if(!visRect) return;
    const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y;
    const len = Math.hypot(dx, dy);
    if(len < 0.01) return;
    const ux = dx / len, uy = dy / len;
    const hit = rayToRectEdge(fromPos.x, fromPos.y, ux, uy, visRect);
    if(!hit) return;
    const color = isAttack ? 'rgba(255,68,102,0.9)' : 'rgba(34,255,136,0.9)';
    const startX = fromPos.x + ux * 36;
    const startY = fromPos.y + uy * 36;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const angle = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(hit.x, hit.y);
    ctx.lineTo(hit.x - Math.cos(angle - 0.4) * 11, hit.y - Math.sin(angle - 0.4) * 11);
    ctx.lineTo(hit.x - Math.cos(angle + 0.4) * 11, hit.y - Math.sin(angle + 0.4) * 11);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    const labelText = `→ ${targetName}`;
    ctx.font = 'bold 12px sans-serif';
    const textW = ctx.measureText(labelText).width;
    const bw = textW + 12, bh = 20;
    const offset = 28;
    const lx = hit.x - ux * offset, ly = hit.y - uy * offset;
    const clampedLx = Math.max(visRect.left + bw/2 + 4, Math.min(visRect.right - bw/2 - 4, lx));
    const clampedLy = Math.max(visRect.top + bh/2 + 4, Math.min(visRect.bottom - bh/2 - 4, ly));
    ctx.fillStyle = 'rgba(10,14,23,0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if(ctx.roundRect){
      ctx.beginPath();
      ctx.roundRect(clampedLx - bw/2, clampedLy - bh/2, bw, bh, 4);
      ctx.fill(); ctx.stroke();
    } else {
      ctx.fillRect(clampedLx - bw/2, clampedLy - bh/2, bw, bh);
      ctx.strokeRect(clampedLx - bw/2, clampedLy - bh/2, bw, bh);
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, clampedLx, clampedLy);
  }

  /* v8.9.3：路線改粗黑線 + 白色外框 */
  function drawNormalRoute(a, b, isHi){
    /* 白色外框 */
    ctx.strokeStyle = isHi ? 'rgba(34,255,136,0.9)' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 13;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    /* 黑色主線 */
    ctx.strokeStyle = isHi ? '#22ff88' : '#000000';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function drawWarArrows(){
    if(!warMode) return;
    const NODE_RADIUS = 30;
    const cityById = new Map(state.cities.map(c => [c.id, c]));

    for(const src of state.cities){
      if(!isCityVisibleInCurrentZone(src)) continue;
      const fromP = nodePositions.get(src.id);
      if(!fromP) continue;

      const drawOne = (tgtId, isAttack, pct) => {
        const tgt = cityById.get(tgtId);
        if(!tgt) return;
        if(!isCityVisibleInCurrentZone(tgt)) return;
        const toP = nodePositions.get(tgtId);
        if(!toP) return;

        const dx = toP.x - fromP.x;
        const dy = toP.y - fromP.y;
        const dist = Math.hypot(dx, dy);
        if(dist < 1) return;
        const ux = dx / dist, uy = dy / dist;
        const sx = fromP.x + ux * NODE_RADIUS;
        const sy = fromP.y + uy * NODE_RADIUS;
        const ex = toP.x - ux * (NODE_RADIUS + 6);
        const ey = toP.y - uy * (NODE_RADIUS + 6);

        const color = isAttack ? 'rgba(255,68,102,1)' : 'rgba(34,255,136,1)';
        const width = Math.max(2, Math.min(8, (pct / 100) * 8));

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash([8, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        const angle = Math.atan2(uy, ux);
        const ah = 12;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(angle - 0.4) * ah, ey - Math.sin(angle - 0.4) * ah);
        ctx.lineTo(ex - Math.cos(angle + 0.4) * ah, ey - Math.sin(angle + 0.4) * ah);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      for(const t of (src.attackTargets || [])){
        if(!t.cityId || (t.preWarPercent || 0) <= 0) continue;
        drawOne(t.cityId, true, t.preWarPercent);
      }
      for(const t of (src.defendTargets || [])){
        if(!t.cityId || (t.preWarPercent || 0) <= 0) continue;
        drawOne(t.cityId, false, t.preWarPercent);
      }
    }

    if(warFromCityId && warHoverTgtId){
      const fromP = nodePositions.get(warFromCityId);
      const toP = nodePositions.get(warHoverTgtId);
      if(fromP && toP){
        ctx.beginPath();
        ctx.moveTo(fromP.x, fromP.y);
        ctx.lineTo(toP.x, toP.y);
        ctx.strokeStyle = 'rgba(255,204,0,0.9)';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function render(){
    if(!canvas || !ctx) return;
    computeLayout();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /* v8.9.3：底圖開關 */
    if(activeMapImageEl && baseMapVisible){
      try{
        ctx.drawImage(activeMapImageEl, 0, 0, canvas.width, canvas.height);
        if(warMode){
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }catch(e){
        console.warn('繪製底圖失敗', e);
        ctx.fillStyle = '#0a0e17';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      ctx.fillStyle = '#0a0e17';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const isAllView0 = (currentZoneFilter === 'all');
      if(isAllView0){
        const zoneCities = new Map();
        for(const c of state.cities){
          const zid = c.zoneId || '__none__';
          if(!zoneCities.has(zid)) zoneCities.set(zid, []);
          zoneCities.get(zid).push(c);
        }
        const zoneColors = ['#3b82f6','#10b981','#f59e0b','#a855f7','#ef4444','#06b6d4','#84cc16','#f97316'];
        let colorIdx = 0;
        for(const [zid, cities] of zoneCities){
          if(zid === '__none__') continue;
          const pts = cities.map(c => nodePositions.get(c.id)).filter(Boolean);
          if(pts.length === 0) continue;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for(const p of pts){
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
          }
          const pad = 60;
          const color = zoneColors[colorIdx % zoneColors.length];
          colorIdx++;
          ctx.fillStyle = color + '15';
          ctx.beginPath();
          const x = minX - pad, y = minY - pad, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
          if(ctx.roundRect) ctx.roundRect(x, y, w, h, 20);
          else ctx.rect(x, y, w, h);
          ctx.fill();
          ctx.strokeStyle = color + '60';
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
          const zone = state.zones.find(z => z.id === zid);
          if(zone){
            ctx.font = 'bold 20px sans-serif';
            ctx.fillStyle = color;
            ctx.textAlign = 'left';
            ctx.fillText(zone.name, x + 12, y + 28);
          }
        }
      } else {
        const zoneCities = state.cities.filter(c => (c.zoneId || '__none__') === currentZoneFilter);
        if(zoneCities.length === 0 && !activeMapImageEl){
          ctx.font = 'bold 26px sans-serif';
          ctx.fillStyle = 'rgba(148,163,184,0.55)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('此戰區尚無城池', canvas.width / 2, canvas.height / 2);
          return;
        }
      }
    }

    const isAllView = (currentZoneFilter === 'all');
    const visRect = getVisibleRect();
    const highlightedRoutes = new Set(highlight ? highlight.routeKeys : []);

    /* 路線（非宣戰模式才顯示） */
    if(!warMode){
      for(const r of (state.routes || [])){
        const a = nodePositions.get(r.cityAId);
        const b = nodePositions.get(r.cityBId);
        if(!a || !b) continue;
        const cityA = state.cities.find(c => c.id === r.cityAId);
        const cityB = state.cities.find(c => c.id === r.cityBId);
        if(!cityA || !cityB) continue;
        const aZone = cityA.zoneId || '__none__';
        const bZone = cityB.zoneId || '__none__';
        if(isAllView){
          const key = [r.cityAId, r.cityBId].sort().join('|');
          drawNormalRoute(a, b, highlightedRoutes.has(key));
          continue;
        }
        const aInZone = (aZone === currentZoneFilter);
        const bInZone = (bZone === currentZoneFilter);
        if(!aInZone && !bInZone) continue;
        if(aInZone && bInZone){
          const key = [r.cityAId, r.cityBId].sort().join('|');
          drawNormalRoute(a, b, highlightedRoutes.has(key));
        } else {
          const fromPos = aInZone ? a : b;
          const toPos = aInZone ? b : a;
          drawCrossZoneEdge(fromPos, toPos, visRect, 'rgba(160,160,160,0.5)', true);
        }
      }
    }

    drawWarArrows();

    if(routeDragFrom && routeDragEnd){
      const a = nodePositions.get(routeDragFrom.id);
      if(a){
        ctx.strokeStyle = 'rgba(68,170,255,0.9)';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(routeDragEnd.x, routeDragEnd.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if(!isAllView && !warMode){
      for(const src of state.cities){
        const srcZone = src.zoneId || '__none__';
        if(srcZone !== currentZoneFilter) continue;
        const p = nodePositions.get(src.id);
        if(!p) continue;
        const allTargets = [
          ...(src.attackTargets || []).map(t => ({ cityId: t.cityId, isAttack: true })),
          ...(src.defendTargets || []).map(t => ({ cityId: t.cityId, isAttack: false })),
        ];
        for(const t of allTargets){
          if(!t.cityId) continue;
          const tgt = state.cities.find(c => c.id === t.cityId);
          if(!tgt) continue;
          const tgtZone = tgt.zoneId || '__none__';
          if(tgtZone === currentZoneFilter) continue;
          const tp = nodePositions.get(tgt.id);
          if(!tp) continue;
          drawCrossZoneArrow(p, tp, visRect, t.isAttack, tgt.name);
        }
      }
    }
    const highlightedCities = new Set(highlight ? highlight.cityIds : []);
    for(const c of state.cities){
      if(!isAllView){
        const cZone = c.zoneId || '__none__';
        if(cZone !== currentZoneFilter) continue;
      }
      const p = nodePositions.get(c.id);
      if(!p) continue;
      const isHovered = (hoveredCityId === c.id);
      const isDragFrom = routeDragFrom && routeDragFrom.id === c.id;
      const isHi = highlightedCities.has(c.id);
      const isWarFrom = (warMode && c.id === warFromCityId);
      const isWarHover = (warMode && c.id === warHoverTgtId);

      if(isHovered || isDragFrom || isHi || isWarFrom || isWarHover){
        ctx.beginPath();
        const r = isHi ? 46 : (isWarFrom ? 50 : 42);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = isWarFrom ? 'rgba(255,204,0,1)'
                        : isWarHover ? 'rgba(255,68,102,1)'
                        : isHi ? 'rgba(34,255,136,1)'
                        : (isDragFrom ? 'rgba(68,170,255,1)' : 'rgba(255,255,255,0.4)');
        ctx.lineWidth = isWarFrom ? 5 : (isHi ? 4 : (isDragFrom ? 4 : 3));
        if(isWarFrom) ctx.setLineDash([8, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const sideColor = c.side === 'self' ? 'rgba(59,130,246,0.25)'
                     : c.side === 'ally' ? 'rgba(16,185,129,0.25)'
                     : (c.side === 'enemy' || c.side === 'common_enemy') ? 'rgba(239,68,68,0.25)'
                     : 'rgba(168,85,247,0.25)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 30, 0, Math.PI * 2);
      ctx.fillStyle = sideColor;
      ctx.fill();
      ctx.strokeStyle = sideColor.replace('0.25', '0.8');
      ctx.lineWidth = 2;
      ctx.stroke();
      const alliance = state.alliances.find(a => a.id === c.allianceId);
      const icon = (alliance && alliance.icon) ? alliance.icon : '🏰';
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, p.x, p.y);
      const level = c.level || 1;
      ctx.beginPath();
      ctx.arc(p.x + 22, p.y - 22, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc00';
      ctx.fill();
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = '#000';
      ctx.fillText(level, p.x + 22, p.y - 22);
      const label = c.code ? `${c.name} (${c.code})` : c.name;
      ctx.font = 'bold 18px "Noto Sans TC","Microsoft JhengHei",-apple-system,BlinkMacSystemFont,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0a0e17';
      ctx.lineWidth = 5;
      ctx.strokeText(label, p.x, p.y + 40);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, p.x, p.y + 40);
      if(c.isCapital){
        ctx.font = '16px sans-serif';
        ctx.fillText('👑', p.x - 28, p.y - 32);
      }
    }
  }

  function activate(){
    if(!containerEl) return;
    refreshZoneSelector();
    onMapLibraryChanged();
  }

  function reset(){
    nodePositions.clear();
    layoutDirty = true;
    view = { x: 0, y: 0, scale: 1 };
    if(containerEl){ containerEl.scrollLeft = 0; containerEl.scrollTop = 0; }
    applyView();
    refreshZoneSelector();
    onMapLibraryChanged();
  }

  function setHighlight(h){ highlight = h; render(); }

  async function exportAsPDF(){
    if(typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF){
      alert('❌ PDF 函式庫尚未載入，請檢查網路連線後重新整理頁面');
      return;
    }
    if(state.cities.length === 0){
      alert('⚠️ 沒有城池可以匯出');
      return;
    }
    if(!canvas){
      alert('⚠️ 畫布尚未初始化');
      return;
    }
    try{
      logSystem('📄 開始匯出 PDF...');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let any = false;
      for(const c of state.cities){
        if(!isCityVisibleInCurrentZone(c)) continue;
        const p = nodePositions.get(c.id);
        if(!p) continue;
        any = true;
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      if(!any){
        if(activeMapImageEl){
          minX = 0; minY = 0; maxX = canvas.width; maxY = canvas.height;
        } else {
          alert('⚠️ 沒有可匯出的城池');
          return;
        }
      }
      const padding = 200;
      minX = Math.max(0, minX - padding);
      minY = Math.max(0, minY - padding);
      maxX = Math.min(canvas.width, maxX + padding);
      maxY = Math.min(canvas.height, maxY + padding);
      const w = Math.ceil(maxX - minX);
      const h = Math.ceil(maxY - minY);
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = w;
      tempCanvas.height = h;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.fillStyle = '#0a0e17';
      tempCtx.fillRect(0, 0, w, h);
      tempCtx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
      const imgData = tempCanvas.toDataURL('image/png');
      const { jsPDF } = window.jspdf;
      const orientation = w >= h ? 'landscape' : 'portrait';
      const pdf = new jsPDF({
        orientation: orientation,
        unit: 'px',
        format: [w, h],
        hotfixes: ['px_scaling'],
      });
      pdf.addImage(imgData, 'PNG', 0, 0, w, h);
      let zoneName = '全部';
      if(currentZoneFilter === '__none__'){ zoneName = '未分配'; }
      else if(currentZoneFilter !== 'all'){
        const z = state.zones.find(x => x.id === currentZoneFilter);
        if(z) zoneName = z.name;
      }
      const safeZoneName = String(zoneName).replace(/[\\/:*?"<>|]/g, '_');
      const date = new Date().toISOString().slice(0,10);
      pdf.save(`路線圖_${safeZoneName}_${date}.pdf`);
      logSystem(`📄 已匯出 PDF（${w}×${h}）`);
    }catch(e){
      console.error('PDF 匯出失敗', e);
      alert('❌ PDF 匯出失敗：' + (e.message || e));
    }
  }

  return {
    init, render, activate, reset, fitView, setHighlight,
    getZoneFilter, setZoneFilter, refreshZoneSelector,
    exportAsPDF, onMapLibraryChanged,
    setWarMode: (on) => {
      setWarMode(on);
      const btn = document.getElementById('btnMapWarMode');
      if(btn){
        btn.textContent = warMode ? '⚔️ 宣戰模式：開' : '⚔️ 宣戰模式：關';
        btn.classList.toggle('active', warMode);
      }
    },
    isWarMode: () => warMode,
    accumulateWarChange,
    saveWarChanges,
    getPendingWarCount: () => pendingWarCount,
    isBaseMapVisible: () => baseMapVisible,
    toggleBaseMap,
  };
})();

/* ====== 第 3/4 段結束（WarQuickPanel / MapLibrary / NodeCalibration 將於第 4 段交付） ====== */
 /* ============================================================
   WarQuickPanel — 快速建立宣戰
   ============================================================ */
const WarQuickPanel = (() => {
  let fromCity = null;
  let toCity = null;
  let selectedType = 'attack';
  let selectedPre = 50;
  let selectedPost = 50;
  let onCreated = null;

  function open(from, to, onCreatedCb){
    if(!from || !to || from.id === to.id) return;

    const type = 'attack';
    const validation = validateWar(from, to, type);
    if(!validation.ok){
      alert('⚠️ ' + validation.msg);
      return;
    }

    fromCity = from;
    toCity = to;
    selectedType = type;
    selectedPre = 50;
    selectedPost = 50;
    onCreated = onCreatedCb || null;

    const modal = document.getElementById('warQuickModal');
    if(!modal) return;

    document.getElementById('warQuickFromName').textContent =
      `${from.name}${from.code ? ' [' + from.code + ']' : ''}`;
    document.getElementById('warQuickToName').textContent =
      `${to.name}${to.code ? ' [' + to.code + ']' : ''}`;

    document.querySelectorAll('.war-quick-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.warType === 'attack');
    });

    document.querySelectorAll('.war-quick-pct-btn').forEach(btn => {
      btn.classList.toggle('active',
        parseInt(btn.dataset.pre, 10) === 50 && parseInt(btn.dataset.post, 10) === 50
      );
    });

    const timeField = document.getElementById('warQuickTimeField');
    const timeInput = document.getElementById('warQuickStartTime');
    if(timeField) timeField.classList.remove('hidden');
    if(timeInput) timeInput.value = '19:00';

    bindEvents();
    modal.classList.add('show');
  }

  function close(){
    const modal = document.getElementById('warQuickModal');
    if(modal) modal.classList.remove('show');
    fromCity = null;
    toCity = null;
  }

  let eventsBound = false;
  function bindEvents(){
    if(eventsBound) return;
    eventsBound = true;

    const closeBtn = document.getElementById('warQuickClose');
    if(closeBtn) closeBtn.addEventListener('click', close);
    const cancelBtn = document.getElementById('warQuickCancel');
    if(cancelBtn) cancelBtn.addEventListener('click', close);

    document.querySelectorAll('.war-quick-type-btn').forEach(btn => {
      btn.addEventListener('click', function(){
        selectedType = this.dataset.warType;
        document.querySelectorAll('.war-quick-type-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const timeField = document.getElementById('warQuickTimeField');
        if(timeField){
          if(selectedType === 'assist') timeField.classList.add('hidden');
          else timeField.classList.remove('hidden');
        }
      });
    });

    document.querySelectorAll('.war-quick-pct-btn').forEach(btn => {
      btn.addEventListener('click', function(){
        selectedPre = parseInt(this.dataset.pre, 10);
        selectedPost = parseInt(this.dataset.post, 10);
        document.querySelectorAll('.war-quick-pct-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
      });
    });

    const detailBtn = document.getElementById('warQuickDetail');
    if(detailBtn){
      detailBtn.addEventListener('click', () => {
        if(!fromCity || !toCity) return;
        const fromId = fromCity.id;
        const fromName = fromCity.name;
        close();
        if(typeof window.SLG.openCityModal === 'function'){
          window.SLG.openCityModal(fromId);
        }
        setTimeout(() => {
          alert('已為您開啟「' + fromName + '」的編輯視窗。\n\n請於「城池數據 → 宣戰」中設定此宣戰指示。');
        }, 200);
      });
    }

    const confirmBtn = document.getElementById('warQuickConfirm');
    if(confirmBtn){
      confirmBtn.addEventListener('click', () => {
        if(!fromCity || !toCity) return;
        doCreate();
      });
    }
  }

  function doCreate(){
    const validation = validateWar(fromCity, toCity, selectedType);
    if(!validation.ok){ alert('⚠️ ' + validation.msg); return; }

    const arr = selectedType === 'attack' ? 'attackTargets' : 'defendTargets';
    if(!fromCity[arr]) fromCity[arr] = [];

    const timeInput = document.getElementById('warQuickStartTime');
    const startTime = (selectedType === 'attack')
      ? (timeInput ? timeInput.value : '19:00') || '19:00'
      : '';

    const existingIdx = fromCity[arr].findIndex(t => t.cityId === toCity.id);
    if(existingIdx >= 0){
      const route = fromCity[arr][existingIdx];
      route.preWarPercent = selectedPre;
      route.postRevivePercent = selectedPost;
      route.attackStartTime = startTime;
    } else {
      fromCity[arr].push({
        cityId: toCity.id,
        preWarPercent: selectedPre,
        postRevivePercent: selectedPost,
        priority: 1,
        attackStartTime: startTime,
      });
    }

    state.entityRev.city[fromCity.id] = (state.entityRev.city[fromCity.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', fromCity.id);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();

    if(window.SLG.GameMap && window.SLG.GameMap.accumulateWarChange){
      window.SLG.GameMap.accumulateWarChange();
    }

    if(window.SLG.WarManager) window.SLG.WarManager.render();

    logSystem(`⚔️ 已建立：${fromCity.name} → ${toCity.name}（${selectedType === 'attack' ? '進攻' : '協防'}）`);

    const cb = onCreated;
    close();
    if(cb) cb();
  }

  function validateWar(from, to, type){
    if(!from || !to) return { ok: false, msg: '缺少城池' };
    if(from.id === to.id) return { ok: false, msg: '出兵城與目標城不能相同' };

    const arr = type === 'attack' ? 'attackTargets' : 'defendTargets';
    if((from[arr] || []).some(t => t.cityId === to.id)){
      return { ok: false, msg: `「${from.name}」→「${to.name}」已有${type === 'attack' ? '進攻' : '協防'}指示` };
    }

    if(type === 'attack'){
      const allowed = ATTACK_RULES[from.side || 'npc'] || [];
      if(!allowed.includes(to.side)){
        return { ok: false, msg: `規則不允許「${from.name}」進攻「${to.name}」` };
      }
    } else if(type === 'assist'){
      if(!from.allianceId || from.allianceId !== to.allianceId){
        return { ok: false, msg: '協防需要出兵城與目標城同屬一個盟' };
      }
      const alliance = state.alliances.find(a => a.id === from.allianceId);
      if(alliance && alliance.name === 'NPC'){
        return { ok: false, msg: 'NPC 盟不能協防' };
      }
    }

    if(!state.settings.crossZoneWarAllowed){
      const zFrom = from.zoneId || '__none__';
      const zTo = to.zoneId || '__none__';
      if(zFrom !== zTo){
        return { ok: false, msg: '跨戰區宣戰已被禁止（可於參數設定開啟）' };
      }
    }

    if(type === 'attack' && state.settings.attackRequireRoute){
      if(!window.SLG.findRoute(from.id, to.id)){
        return { ok: false, msg: '此規則要求進攻需有路線接觸' };
      }
    }
    if(type === 'assist'){
      if(!window.SLG.findRoute(from.id, to.id)){
        return { ok: false, msg: '協防需要路線上必須有接觸' };
      }
    }

    return { ok: true };
  }

  return { open, close };
})();

/* ============================================================
   MapLibrary — 地圖庫
   ============================================================ */
const MapLibrary = (() => {
  let uploading = false;

  function init(){
    const viewModeSel = document.getElementById('mapLibraryViewMode');
    if(viewModeSel && !viewModeSel.dataset.bound){
      viewModeSel.dataset.bound = '1';
      viewModeSel.value = state.mapLibrary.viewMode || 'single';
      viewModeSel.addEventListener('change', function(){
        setMapViewMode(this.value);
      });
    }
    const mapSel = document.getElementById('mapLibrarySelect');
    if(mapSel && !mapSel.dataset.bound){
      mapSel.dataset.bound = '1';
      mapSel.addEventListener('change', async function(){
        const id = this.value;
        if(!id){ setActiveMap(''); return; }
        setActiveMap(id);
        try{
          await window.SLG.ensureMapLoaded(id);
          window.SLG.startMapLibraryMapWatcher(id);
        }catch(e){
          console.warn('載入地圖失敗', e);
          alert('❌ 載入地圖失敗：' + e.message);
        }
      });
    }
    const btnUpload = document.getElementById('btnMapUpload');
    if(btnUpload && !btnUpload.dataset.bound){
      btnUpload.dataset.bound = '1';
      btnUpload.addEventListener('click', openUploadModal);
    }
    const btnCalibrate = document.getElementById('btnMapCalibrate');
    if(btnCalibrate && !btnCalibrate.dataset.bound){
      btnCalibrate.dataset.bound = '1';
      btnCalibrate.addEventListener('click', () => {
        if(!window.SLG.canEditMapLibrary()){ alert('🔒 您沒有地圖庫編輯權限'); return; }
        if(!state.mapLibrary.activeMapId){ alert('請先選擇一張地圖'); return; }
        NodeCalibration.open(state.mapLibrary.activeMapId);
      });
    }
    const btnExportCoords = document.getElementById('btnMapExportCoords');
    if(btnExportCoords && !btnExportCoords.dataset.bound){
      btnExportCoords.dataset.bound = '1';
      btnExportCoords.addEventListener('click', exportActiveMapCoords);
    }

    const muFile = document.getElementById('mu_file');
    if(muFile && !muFile.dataset.bound){
      muFile.dataset.bound = '1';
      muFile.addEventListener('change', function(){
        const f = this.files && this.files[0];
        if(!f) return;
        const img = new Image();
        const url = URL.createObjectURL(f);
        img.onload = () => {
          const wEl = document.getElementById('mu_width');
          const hEl = document.getElementById('mu_height');
          if(wEl) wEl.value = img.naturalWidth;
          if(hEl) hEl.value = img.naturalHeight;
          URL.revokeObjectURL(url);
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
      });
    }
    const muCancel = document.getElementById('mu_cancel');
    if(muCancel && !muCancel.dataset.bound){
      muCancel.dataset.bound = '1';
      muCancel.addEventListener('click', closeUploadModal);
    }
    const muSubmit = document.getElementById('mu_submit');
    if(muSubmit && !muSubmit.dataset.bound){
      muSubmit.dataset.bound = '1';
      muSubmit.addEventListener('click', doUpload);
    }

    on(EVT.MAP_LIBRARY_UPDATED, (e) => {
      renderSelect();
      renderGallery();
      const vm = state.mapLibrary.viewMode || 'single';
      const viewModeSel2 = document.getElementById('mapLibraryViewMode');
      if(viewModeSel2 && viewModeSel2.value !== vm) viewModeSel2.value = vm;
      applyViewMode();
    });
  }

  function applyViewMode(){
    const mode = state.mapLibrary.viewMode || 'single';
    const single = document.getElementById('mapSingleView');
    const gallery = document.getElementById('mapGalleryView');
    const dynamic = document.getElementById('mapDynamicWrap');
    if(!single || !gallery) return;
    if(mode === 'gallery'){
      single.style.display = 'none';
      if(gallery) gallery.style.display = '';
      if(dynamic) dynamic.style.display = 'none';
      renderGallery();
    } else {
      single.style.display = '';
      if(gallery) gallery.style.display = 'none';
    }
  }

  function renderSelect(){
    const sel = document.getElementById('mapLibrarySelect');
    if(!sel) return;
    const idx = state.mapLibrary.index || {};
    const ids = Object.keys(idx).sort((a, b) => (idx[b].updatedAt || 0) - (idx[a].updatedAt || 0));
    let html = '<option value="">（尚未選擇地圖）</option>';
    for(const id of ids){
      const m = idx[id];
      const selected = state.mapLibrary.activeMapId === id ? 'selected' : '';
      html += `<option value="${esc(id)}" ${selected}>${esc(m.name || '未命名')}（${m.nodeCount || 0} 節點）</option>`;
    }
    sel.innerHTML = html;
    if(state.mapLibrary.activeMapId && !idx[state.mapLibrary.activeMapId]){
      state.mapLibrary.activeMapId = '';
      if(window.SLG.saveMapLibraryPrefs) window.SLG.saveMapLibraryPrefs();
    }
    sel.value = state.mapLibrary.activeMapId || '';
  }

  function renderGallery(){
    const grid = document.getElementById('mapGalleryGrid');
    if(!grid) return;
    const idx = state.mapLibrary.index || {};
    const ids = Object.keys(idx).sort((a, b) => (idx[b].updatedAt || 0) - (idx[a].updatedAt || 0));
    if(ids.length === 0){
      grid.innerHTML = `<div class="map-gallery-empty">
        <div class="icon">🗺️</div>
        <div class="text">尚無地圖<br>點上方「📤 上傳新地圖」建立第一張</div>
      </div>`;
      return;
    }
    const canEdit = window.SLG.canEditMapLibrary();
    const isSuper = window.SLG.Auth && window.SLG.Auth.isSuperAdmin();
    const activeId = state.mapLibrary.activeMapId || '';
    grid.innerHTML = ids.map(id => {
      const m = idx[id];
      const isActive = (id === activeId);
      const name = m.name || '未命名';
      const nodeCount = m.nodeCount || 0;
      const timeStr = m.updatedAt ? timeAgo(m.updatedAt) : '—';
      const thumbHtml = m.imageUrl
        ? `<img src="${esc(m.imageUrl)}" alt="${esc(name)}" loading="lazy">`
        : `<div class="map-gallery-thumb-placeholder">🗺️</div>`;
      const activeMark = isActive ? '<span class="active-mark">● 使用中</span>' : '';
      return `<div class="map-gallery-card ${isActive ? 'active' : ''}" data-map-id="${esc(id)}">
        <div class="map-gallery-thumb">
          ${thumbHtml}
          <span class="map-gallery-thumb-badge${nodeCount === 0 ? ' warn' : ''}">${nodeCount} 節點</span>
        </div>
        <div class="map-gallery-body">
          <div class="map-gallery-name" title="${esc(name)}">${esc(name)} ${activeMark}</div>
          <div class="map-gallery-meta">
            <span class="item">📐 <b>${m.imageWidth || 0}×${m.imageHeight || 0}</b></span>
            <span class="item">🕒 <b>${esc(timeStr)}</b></span>
            ${m.updatedByName ? `<span class="item">👤 <b>${esc(m.updatedByName)}</b></span>` : ''}
          </div>
          <div class="map-gallery-actions">
            <button class="btn btn-primary btn-sm" data-action="use">▶️ 使用</button>
            <button class="btn btn-warning btn-sm" data-action="calibrate" ${canEdit?'':'disabled'}>🎯 校準</button>
            <button class="btn btn-ghost btn-sm" data-action="edit" ${canEdit?'':'disabled'}>✏️ 改名</button>
            ${isSuper ? `<button class="btn btn-danger btn-sm" data-action="del">🗑️</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.map-gallery-card').forEach(card => {
      const id = card.dataset.mapId;
      card.addEventListener('click', async (e) => {
        if(e.target.closest('button')) return;
        await useMap(id);
      });
      const btnUse = card.querySelector('[data-action="use"]');
      if(btnUse) btnUse.addEventListener('click', (e) => { e.stopPropagation(); useMap(id); });
      const btnCal = card.querySelector('[data-action="calibrate"]');
      if(btnCal && canEdit) btnCal.addEventListener('click', (e) => { e.stopPropagation(); NodeCalibration.open(id); });
      const btnEdit = card.querySelector('[data-action="edit"]');
      if(btnEdit && canEdit) btnEdit.addEventListener('click', (e) => { e.stopPropagation(); editMapName(id); });
      const btnDel = card.querySelector('[data-action="del"]');
      if(btnDel) btnDel.addEventListener('click', async (e) => {
        e.stopPropagation();
        const m = idx[id];
        if(!confirm(`確定刪除地圖「${m.name}」嗎？\n\n⚠️ 此操作無法復原。`)) return;
        try{
          await window.SLG.deleteMapLibraryMap(id);
          alert('✅ 已刪除');
        }catch(err){ alert('❌ 刪除失敗：' + err.message); }
      });
    });
  }

  async function useMap(id){
    if(state.mapLibrary.activeMapId === id) return;
    setActiveMap(id);
    try{
      await window.SLG.ensureMapLoaded(id);
      window.SLG.startMapLibraryMapWatcher(id);
    }catch(e){
      console.warn('載入地圖失敗', e);
      alert('❌ 載入地圖失敗：' + e.message);
    }
  }

  async function editMapName(id){
    const m = getMapMeta(id);
    if(!m) return;
    const newName = prompt('輸入新的地圖名稱：', m.name || '');
    if(newName === null) return;
    const trimmed = String(newName).trim();
    if(!trimmed){ alert('名稱不能為空'); return; }
    if(trimmed === m.name) return;
    try{
      const data = await window.SLG.fetchMapLibraryMap(id);
      await window.SLG.saveMapLibraryMap(id, Object.assign({}, data, { name: trimmed }));
      alert('✅ 已更新名稱');
    }catch(e){ alert('❌ 更新失敗：' + e.message); }
  }

  function openUploadModal(){
    if(!window.SLG.canEditMapLibrary()){ alert('🔒 您沒有地圖庫編輯權限'); return; }
    if(!state.auth.signedIn){ alert('請先登入'); return; }
    uploading = false;
    const modal = document.getElementById('mapUploadModal');
    if(!modal) return;
    document.getElementById('mu_name').value = '';
    document.getElementById('mu_file').value = '';
    document.getElementById('mu_width').value = '';
    document.getElementById('mu_height').value = '';
    const prog = document.getElementById('mu_progress');
    if(prog) prog.style.display = 'none';
    const bar = document.getElementById('mu_progressBar');
    if(bar) bar.style.width = '0';
    document.getElementById('mu_status').textContent = '';
    const btn = document.getElementById('mu_submit');
    btn.disabled = false;
    btn.textContent = '📤 上傳';
    modal.classList.add('show');
  }
  function closeUploadModal(){
    if(uploading) return;
    const modal = document.getElementById('mapUploadModal');
    if(modal) modal.classList.remove('show');
  }

  async function doUpload(){
    if(uploading){
      console.warn('[MapUpload] 已有上傳進行中，忽略此次點擊');
      return;
    }
    const name = (document.getElementById('mu_name').value || '').trim();
    const fileEl = document.getElementById('mu_file');
    const file = fileEl && fileEl.files ? fileEl.files[0] : null;
    const statusEl = document.getElementById('mu_status');
    const btn = document.getElementById('mu_submit');
    if(!name){ alert('請輸入地圖名稱'); return; }
    if(!file){ alert('請選擇圖片檔案'); return; }
    if(!isOnline()){ alert('離線中，無法上傳'); return; }

    uploading = true;
    btn.disabled = true;
    btn.textContent = '⏳ 上傳中...';
    const prog = document.getElementById('mu_progress');
    if(prog) prog.style.display = '';
    const bar = document.getElementById('mu_progressBar');
    if(statusEl) statusEl.textContent = '上傳至 Cloudinary...';

    try{
      const result = await window.SLG.uploadMapImageToCloudinary(file, (percent) => {
        if(bar) bar.style.width = percent + '%';
        if(statusEl) statusEl.textContent = `上傳至 Cloudinary ${percent}%`;
      });
      if(statusEl) statusEl.textContent = '寫入資料庫...';
      const newId = await window.SLG.saveMapLibraryMap('', {
        name,
        imageUrl: result.secureUrl,
        imageWidth: result.width,
        imageHeight: result.height,
        nodes: {},
      });
      if(statusEl) statusEl.textContent = '✅ 完成！';
      setActiveMap(newId);
      await window.SLG.ensureMapLoaded(newId);
      window.SLG.startMapLibraryMapWatcher(newId);
      setTimeout(() => {
        uploading = false;
        closeUploadModal();
        logSystem(`📤 已上傳新地圖：${name}`);
        if(state.cities.length > 0){
          const goCal = confirm(`地圖「${name}」已上傳！\n\n目前有 ${state.cities.length} 座城池，要現在去校準節點嗎？`);
          if(goCal){ NodeCalibration.open(newId); }
        }
      }, 400);
    }catch(e){
      uploading = false;
      btn.disabled = false;
      btn.textContent = '📤 上傳';
      if(statusEl) statusEl.textContent = '❌ ' + (e.message || e);
      console.error(e);
    }
  }

  function exportActiveMapCoords(){
    const id = state.mapLibrary.activeMapId;
    if(!id){ alert('請先選擇一張地圖'); return; }
    const map = getLoadedMap(id);
    if(!map){ alert('地圖尚未載入'); return; }
    const nodes = map.nodes || {};
    const count = Object.keys(nodes).length;
    if(count === 0){ alert('此圖尚無節點座標'); return; }
    const payload = {
      mapId: id,
      mapName: map.name || '',
      imageWidth: map.imageWidth || 0,
      imageHeight: map.imageHeight || 0,
      nodeCount: count,
      exportedAt: new Date().toISOString(),
      nodes,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(map.name || 'map').replace(/[\\/:*?"<>|]/g, '_')}_coords.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logSystem(`💾 已匯出 ${count} 個節點座標`);
  }

  return { init, renderSelect, renderGallery, applyViewMode };
})();

/* ============================================================
   NodeCalibration — v8.9.3 大改
   新增：定點模式 + 拖曳節點 + 刪除標記
   ============================================================ */
const NodeCalibration = (() => {
  let mapId = '';
  let mapData = null;
  let imageEl = null;
  let nodes = {};
  let routes = [];
  let activeCityId = '';
  let activeRouteIdx = -1;
  let canvas, ctx, wrapEl;
  let natW = 0, natH = 0;
  let zoom = 1;
  let offsetX = 0, offsetY = 0;
  let isDragging = false;
  let dragStart = null;
  let isManualMode = false;
  let isFixedPointMode = false;
  let fixedPointCityId = '';
  let isAiScanning = false;
  let aiAborted = false;
  let displayW = 0, displayH = 0;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchStartCenter = null;
  let clickPopupTarget = null;

  /* v8.9.3：拖曳節點 */
  let draggingNodeId = null;
  let nodeDragOffset = { x: 0, y: 0 };
  let nodeDragMoved = false;

  async function open(id){
    if(!window.SLG.canEditMapLibrary()){ alert('🔒 您沒有地圖庫編輯權限'); return; }
    if(!id){ alert('缺少 mapId'); return; }
    mapId = id;

    const modal = document.getElementById('nodeCalibrationModal');
    if(!modal) return;
    modal.classList.add('show');

    const nameEl = document.getElementById('nc_mapName');
    if(nameEl) nameEl.textContent = '載入中...';

    resetState();

    try{
      const m = await window.SLG.ensureMapLoaded(id);
      mapData = m;
      imageEl = m.imageEl;
      if(!imageEl){ throw new Error('底圖載入失敗'); }
      nodes = JSON.parse(JSON.stringify(m.nodes || {}));
      natW = imageEl.naturalWidth || mapData.imageWidth || 0;
      natH = imageEl.naturalHeight || mapData.imageHeight || 0;
      if(natW === 0 || natH === 0) throw new Error('圖片尺寸為 0');
      if(nameEl) nameEl.textContent = m.name || '未命名';

      setupCanvas();
      bindEvents();
      fitToWindow();
      renderAll();
      updateProgress();
      updateModeUI();
    }catch(e){
      console.error('校準開啟失敗', e);
      alert('❌ 開啟校準失敗：' + e.message);
      close();
    }
  }

  function resetState(){
    nodes = {};
    routes = [];
    activeCityId = '';
    activeRouteIdx = -1;
    zoom = 1;
    offsetX = 0;
    offsetY = 0;
    isDragging = false;
    dragStart = null;
    isManualMode = false;
    isFixedPointMode = false;
    fixedPointCityId = '';
    isAiScanning = false;
    aiAborted = false;
    clickPopupTarget = null;
    draggingNodeId = null;
    nodeDragOffset = { x: 0, y: 0 };
    nodeDragMoved = false;
  }

  function close(){
    const modal = document.getElementById('nodeCalibrationModal');
    if(modal) modal.classList.remove('show');
    closeClickPopup();
    mapId = '';
    mapData = null;
    imageEl = null;
    resetState();
  }

  function setupCanvas(){
    wrapEl = document.getElementById('nc_canvasWrap');
    canvas = document.getElementById('nc_canvas');
    if(!canvas || !wrapEl) return;
    ctx = canvas.getContext('2d');
    resizeCanvasToZoom();
  }

  function resizeCanvasToZoom(){
    displayW = Math.round(natW * zoom);
    displayH = Math.round(natH * zoom);
    canvas.width = displayW;
    canvas.height = displayH;
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';
  }

  function fitToWindow(){
    if(!wrapEl || natW === 0) return;
    const availW = wrapEl.clientWidth - 4 || 800;
    const availH = wrapEl.clientHeight - 4 || 600;
    const scaleW = availW / natW;
    const scaleH = availH / natH;
    zoom = Math.min(scaleW, scaleH, 2);
    offsetX = 0;
    offsetY = 0;
    resizeCanvasToZoom();
    updateZoomDisplay();
    if(wrapEl){ wrapEl.scrollLeft = 0; wrapEl.scrollTop = 0; }
  }

  function setZoom(newZoom, centerClientX, centerClientY){
    newZoom = Math.max(0.2, Math.min(6, newZoom));
    if(Math.abs(newZoom - zoom) < 0.001) return;

    if(centerClientX !== undefined && wrapEl){
      const rect = wrapEl.getBoundingClientRect();
      const mouseX = centerClientX - rect.left + wrapEl.scrollLeft;
      const mouseY = centerClientY - rect.top + wrapEl.scrollTop;
      const imgX = mouseX / zoom;
      const imgY = mouseY / zoom;

      zoom = newZoom;
      resizeCanvasToZoom();

      const newMouseX = imgX * zoom;
      const newMouseY = imgY * zoom;
      wrapEl.scrollLeft = newMouseX - (centerClientX - rect.left);
      wrapEl.scrollTop = newMouseY - (centerClientY - rect.top);
    } else {
      zoom = newZoom;
      resizeCanvasToZoom();
    }
    updateZoomDisplay();
    renderAll();
  }

  function updateZoomDisplay(){
    const el = document.getElementById('nc_zoomLevel');
    if(el) el.textContent = Math.round(zoom * 100) + '%';
  }

  function clientToImage(clientX, clientY){
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / zoom;
    const y = (clientY - rect.top) / zoom;
    return { x, y };
  }

  function bindEvents(){
    const btnZoomIn = document.getElementById('nc_btnZoomIn');
    if(btnZoomIn && !btnZoomIn.dataset.bound){
      btnZoomIn.dataset.bound = '1';
      btnZoomIn.addEventListener('click', () => setZoom(zoom * 1.25));
    }
    const btnZoomOut = document.getElementById('nc_btnZoomOut');
    if(btnZoomOut && !btnZoomOut.dataset.bound){
      btnZoomOut.dataset.bound = '1';
      btnZoomOut.addEventListener('click', () => setZoom(zoom / 1.25));
    }
    const btnZoomReset = document.getElementById('nc_btnZoomReset');
    if(btnZoomReset && !btnZoomReset.dataset.bound){
      btnZoomReset.dataset.bound = '1';
      btnZoomReset.addEventListener('click', () => { setZoom(1); if(wrapEl){ wrapEl.scrollLeft = 0; wrapEl.scrollTop = 0; } });
    }
    const btnZoomFit = document.getElementById('nc_btnZoomFit');
    if(btnZoomFit && !btnZoomFit.dataset.bound){
      btnZoomFit.dataset.bound = '1';
      btnZoomFit.addEventListener('click', () => { fitToWindow(); renderAll(); });
    }
    const btnAiScan = document.getElementById('nc_btnAiScan');
    if(btnAiScan && !btnAiScan.dataset.bound){
      btnAiScan.dataset.bound = '1';
      btnAiScan.addEventListener('click', startAiScan);
    }
    const btnManual = document.getElementById('nc_btnManualAdd');
    if(btnManual && !btnManual.dataset.bound){
      btnManual.dataset.bound = '1';
      btnManual.addEventListener('click', toggleManualMode);
    }
    /* v8.9.3：定點模式按鈕 */
    const btnFixed = document.getElementById('nc_btnFixedPoint');
    if(btnFixed && !btnFixed.dataset.bound){
      btnFixed.dataset.bound = '1';
      btnFixed.addEventListener('click', toggleFixedPointMode);
    }
    const btnClearAll = document.getElementById('nc_btnClearAll');
    if(btnClearAll && !btnClearAll.dataset.bound){
      btnClearAll.dataset.bound = '1';
      btnClearAll.addEventListener('click', () => {
        if(!confirm('確定要清空所有標記嗎？')) return;
        nodes = {};
        routes = [];
        activeCityId = '';
        activeRouteIdx = -1;
        fixedPointCityId = '';
        renderAll();
        updateProgress();
      });
    }
    document.querySelectorAll('[data-nc-tab]').forEach(btn => {
      if(btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-nc-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.ncTab;
        const cityList = document.getElementById('nc_cityList');
        const routeList = document.getElementById('nc_routeList');
        if(cityList) cityList.style.display = (tab === 'cities') ? '' : 'none';
        if(routeList) routeList.style.display = (tab === 'routes') ? '' : 'none';
      });
    });
    const btnCancel = document.getElementById('nc_cancel');
    if(btnCancel && !btnCancel.dataset.bound){
      btnCancel.dataset.bound = '1';
      btnCancel.addEventListener('click', () => {
        if(Object.keys(nodes).length > 0){
          if(!confirm('有尚未儲存的標記，確定要放棄嗎？')) return;
        }
        close();
      });
    }
    const btnSave = document.getElementById('nc_save');
    if(btnSave && !btnSave.dataset.bound){
      btnSave.dataset.bound = '1';
      btnSave.addEventListener('click', doSave);
    }
    const clickClose = document.getElementById('nc_clickPopupClose');
    if(clickClose && !clickClose.dataset.bound){
      clickClose.dataset.bound = '1';
      clickClose.addEventListener('click', closeClickPopup);
    }
    if(canvas && !canvas.dataset.bound){
      canvas.dataset.bound = '1';
      canvas.addEventListener('click', onClickCanvas);
      /* v8.9.3：拖曳節點 */
      canvas.addEventListener('pointerdown', onCanvasPointerDown);
      canvas.addEventListener('pointermove', onCanvasPointerMove);
      canvas.addEventListener('pointerup', onCanvasPointerUp);
      canvas.addEventListener('pointercancel', onCanvasPointerUp);
    }
    if(wrapEl && !wrapEl.dataset.wheelBound){
      wrapEl.dataset.wheelBound = '1';
      wrapEl.addEventListener('wheel', (e) => {
        if(e.ctrlKey || e.metaKey || e.deltaMode === 0){
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
          setZoom(zoom * factor, e.clientX, e.clientY);
        }
      }, { passive: false });
      wrapEl.addEventListener('mousedown', (e) => {
        if(e.target !== canvas && e.target !== wrapEl) return;
        if(draggingNodeId) return;
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY, sx: wrapEl.scrollLeft, sy: wrapEl.scrollTop };
        wrapEl.classList.add('dragging');
      });
      wrapEl.addEventListener('mousemove', (e) => {
        if(!isDragging) return;
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        wrapEl.scrollLeft = dragStart.sx - dx;
        wrapEl.scrollTop = dragStart.sy - dy;
      });
      wrapEl.addEventListener('mouseup', () => {
        isDragging = false;
        wrapEl.classList.remove('dragging');
      });
      wrapEl.addEventListener('mouseleave', () => {
        isDragging = false;
        wrapEl.classList.remove('dragging');
      });
      wrapEl.addEventListener('touchstart', (e) => {
        if(e.touches.length === 2){
          e.preventDefault();
          pinchStartDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          pinchStartZoom = zoom;
          pinchStartCenter = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
          };
        } else if(e.touches.length === 1 && e.target === canvas){
          isDragging = true;
          dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, sx: wrapEl.scrollLeft, sy: wrapEl.scrollTop };
        }
      }, { passive: false });
      wrapEl.addEventListener('touchmove', (e) => {
        if(e.touches.length === 2 && pinchStartDist > 0){
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const factor = dist / pinchStartDist;
          setZoom(pinchStartZoom * factor, pinchStartCenter.x, pinchStartCenter.y);
        } else if(isDragging && e.touches.length === 1){
          e.preventDefault();
          const dx = e.touches[0].clientX - dragStart.x;
          const dy = e.touches[0].clientY - dragStart.y;
          wrapEl.scrollLeft = dragStart.sx - dx;
          wrapEl.scrollTop = dragStart.sy - dy;
        }
      }, { passive: false });
      wrapEl.addEventListener('touchend', (e) => {
        if(e.touches.length < 2){ pinchStartDist = 0; }
        if(e.touches.length === 0){ isDragging = false; }
      });
    }

    if(!window.__ncResizeBound){
      window.__ncResizeBound = true;
      window.addEventListener('resize', () => {
        const modal = document.getElementById('nodeCalibrationModal');
        if(modal && modal.classList.contains('show') && imageEl){
          renderAll();
        }
      });
    }
  }

  /* v8.9.3：切換 AI 補點模式 */
  function toggleManualMode(){
    isManualMode = !isManualMode;
    if(isManualMode){ isFixedPointMode = false; fixedPointCityId = ''; }
    updateModeUI();
  }

  /* v8.9.3：切換定點模式 */
  function toggleFixedPointMode(){
    isFixedPointMode = !isFixedPointMode;
    if(isFixedPointMode){
      isManualMode = false;
      const next = findNextUnmarkedCity();
      fixedPointCityId = next ? next.id : '';
      activeCityId = fixedPointCityId;
    } else {
      fixedPointCityId = '';
    }
    updateModeUI();
    renderCityList();
    renderAll();
  }

  function updateModeUI(){
    if(wrapEl){
      wrapEl.classList.toggle('manual-mode', isManualMode);
      wrapEl.classList.toggle('fixed-point-mode', isFixedPointMode);
    }
    const btnManual = document.getElementById('nc_btnManualAdd');
    if(btnManual){
      btnManual.textContent = isManualMode ? '✖️ 取消 AI 補點' : '🤖 AI 補點';
      btnManual.classList.toggle('btn-warning', !isManualMode);
    }
    const btnFixed = document.getElementById('nc_btnFixedPoint');
    if(btnFixed){
      btnFixed.textContent = isFixedPointMode ? '✖️ 取消定點' : '🎯 定點模式';
      btnFixed.classList.toggle('active', isFixedPointMode);
    }
    const hint = document.getElementById('nc_canvasHint');
    if(hint){
      if(isFixedPointMode){
        const city = state.cities.find(c => c.id === fixedPointCityId);
        hint.textContent = city
          ? `🎯 請點圖上「${city.name}」的正確位置`
          : '🎯 請從左側選擇城池，再點圖上位置';
      } else if(isManualMode){
        hint.textContent = '🎯 點圖上位置，AI 將辨識該區域';
      } else {
        hint.textContent = '🖱️ 滾輪縮放、拖曳平移、點擊位置辨識';
      }
    }
  }

  function findNextUnmarkedCity(){
    for(const city of state.cities){
      const nid = cityNodeId(city);
      if(!nodes[nid]) return city;
    }
    return null;
  }

  /* v8.9.3：畫布上的節點拖曳 */
  function onCanvasPointerDown(e){
    if(e.pointerType === 'touch') return;
    if(isFixedPointMode || isManualMode) return;
    const imgPos = clientToImage(e.clientX, e.clientY);
    const hit = findNodeAt(imgPos.x, imgPos.y);
    if(hit){
      draggingNodeId = hit.nodeId;
      nodeDragOffset = { x: imgPos.x - hit.node.x, y: imgPos.y - hit.node.y };
      nodeDragMoved = false;
      try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function onCanvasPointerMove(e){
    if(!draggingNodeId) return;
    const imgPos = clientToImage(e.clientX, e.clientY);
    const node = nodes[draggingNodeId];
    if(node){
      node.x = Math.round(imgPos.x - nodeDragOffset.x);
      node.y = Math.round(imgPos.y - nodeDragOffset.y);
      nodeDragMoved = true;
      redrawCanvas();
    }
  }

  function onCanvasPointerUp(e){
    if(!draggingNodeId) return;
    const node = nodes[draggingNodeId];
    if(node && nodeDragMoved){
      node.source = 'manual';
    }
    draggingNodeId = null;
    nodeDragMoved = false;
    renderAll();
    updateProgress();
    try{ canvas.releasePointerCapture(e.pointerId); }catch(_){}
    e.stopPropagation();
  }

  async function startAiScan(){
    if(isAiScanning) return;
    if(!window.SLG.detectFullMap){
      alert('❌ AI 辨識模組未載入，請重新整理頁面');
      return;
    }
    if(!confirm('確定要執行 AI 全圖辨識嗎？\n\n這會花 30~90 秒，並消耗智譜 API 額度。')){
      return;
    }

    isAiScanning = true;
    aiAborted = false;

    const progressEl = document.getElementById('nc_aiProgress');
    const progressFill = document.getElementById('nc_aiProgressFill');
    const progressText = document.getElementById('nc_aiProgressText');
    if(progressEl) progressEl.style.display = '';

    const onProgress = (p, text) => {
      if(progressFill) progressFill.style.width = Math.round(p * 100) + '%';
      if(progressText) progressText.textContent = text || '';
    };

    try{
      const result = await window.SLG.detectFullMap(imageEl, onProgress, () => aiAborted);

      let addedCount = 0;
      let mergedCount = 0;

      for(const c of result.cities || []){
        if(!c || !c.name) continue;
        const city = findCityByNameOrCode(c.name, c.code);
        if(!city) continue;
        const nid = cityNodeId(city);
        const existing = nodes[nid];
        if(existing && existing.source === 'manual'){
          mergedCount++;
          continue;
        }
        nodes[nid] = {
          name: city.name,
          code: city.code || '',
          x: c.x,
          y: c.y,
          namedCityId: city.id,
          source: 'ai',
          confidence: c.confidence || 0.8,
        };
        addedCount++;
      }

      routes = (result.routes || []).map(r => ({
        fromName: r.fromName,
        toName: r.toName,
        type: r.type || 'land',
        color: r.color || 'blue',
        source: 'ai',
      }));

      renderAll();
      updateProgress();
      updateRouteCount();

      if(progressText) progressText.textContent = `完成！新增 ${addedCount} 城 / ${routes.length} 路線`;

      setTimeout(() => {
        if(progressEl) progressEl.style.display = 'none';
        isAiScanning = false;
        alert(
          `✅ AI 辨識完成！\n\n` +
          `新增：${addedCount} 座城池\n` +
          `保留手動：${mergedCount} 座\n` +
          `路線：${routes.length} 條\n\n` +
          `請檢查並補正後儲存。`
        );
      }, 500);

    }catch(e){
      console.error('AI 辨識失敗', e);
      if(progressEl) progressEl.style.display = 'none';
      isAiScanning = false;
      alert('❌ AI 辨識失敗：' + e.message);
    }
  }

  async function onClickCanvas(e){
    if(draggingNodeId) return;

    const imgPos = clientToImage(e.clientX, e.clientY);
    const hit = findNodeAt(imgPos.x, imgPos.y);
    if(hit){
      activeCityId = hit.cityId;
      activeRouteIdx = -1;
      renderCityList();
      renderRouteList();
      renderAll();
      return;
    }

    /* v8.9.3：定點模式 */
    if(isFixedPointMode){
      if(!fixedPointCityId){
        alert('請先從左側選擇一座城池');
        return;
      }
      const city = state.cities.find(c => c.id === fixedPointCityId);
      if(!city) return;
      applyNodeForCity(fixedPointCityId, imgPos.x, imgPos.y, 'manual');
      /* 自動跳下一個未標記城池 */
      const next = findNextUnmarkedCity();
      if(next){
        fixedPointCityId = next.id;
        activeCityId = next.id;
        renderCityList();
        updateModeUI();
        setTimeout(() => {
          const items = document.querySelectorAll('#nc_cityList .nc-item-v3');
          for(const item of items){
            if(item.dataset.cityId === next.id){
              item.scrollIntoView({ behavior: 'smooth', block: 'center' });
              break;
            }
          }
        }, 50);
      } else {
        fixedPointCityId = '';
        activeCityId = '';
        updateModeUI();
        alert('🎉 所有城池都已標記完成！');
      }
      renderAll();
      return;
    }

    /* AI 補點模式 */
    if(isManualMode){
      await handleClickDetect(imgPos.x, imgPos.y, e.clientX, e.clientY);
      return;
    }
  }

  async function handleClickDetect(imgX, imgY, clientX, clientY){
    if(!window.SLG.detectAtPoint){
      alert('❌ AI 辨識模組未載入');
      return;
    }
    clickPopupTarget = { x: imgX, y: imgY };
    openClickPopup(clientX, clientY);
    setClickPopupContent('<div class="text-dim">🤖 AI 辨識中...</div>');

    try{
      const radius = Math.round(Math.min(natW, natH) * 0.06);
      const result = await window.SLG.detectAtPoint(imageEl, imgX, imgY, radius);

      if(!result || !result.name){
        renderClickPopupFallback(imgX, imgY);
        return;
      }
      renderClickPopupResult(result, imgX, imgY);

    }catch(e){
      console.error('點擊辨識失敗', e);
      renderClickPopupFallback(imgX, imgY, e.message);
    }
  }

  function openClickPopup(clientX, clientY){
    const popup = document.getElementById('nc_clickPopup');
    if(!popup || !wrapEl) return;

    const wrapRect = wrapEl.getBoundingClientRect();
    let left = clientX - wrapRect.left + wrapEl.scrollLeft + 20;
    let top = clientY - wrapRect.top + wrapEl.scrollTop - 20;
    const popupW = 280;
    const popupH = 400;

    if(left + popupW > displayW - 10) left = clientX - wrapRect.left + wrapEl.scrollLeft - popupW - 20;
    if(left < 10) left = 10;
    if(top + popupH > displayH - 10) top = displayH - popupH - 10;
    if(top < 10) top = 10;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.classList.remove('hidden');
  }

  function closeClickPopup(){
    const popup = document.getElementById('nc_clickPopup');
    if(popup) popup.classList.add('hidden');
    clickPopupTarget = null;
  }

  function setClickPopupContent(html){
    const body = document.getElementById('nc_clickPopupBody');
    if(body) body.innerHTML = html;
  }

  function renderClickPopupResult(result, imgX, imgY){
    const city = findCityByNameOrCode(result.name, result.code);
    const confPct = Math.round((result.confidence || 0) * 100);

    let html = `<div class="nc-ai-result">
      <div class="nc-ai-result-title">
        <span>${city ? '✅ 匹配成功' : '⚠️ 系統無此城'}</span>
      </div>
      <div class="nc-ai-result-name">
        ${esc(result.name)}
        ${result.code ? `<span class="nc-ai-result-code">${esc(result.code)}</span>` : ''}
      </div>
      <div class="nc-ai-result-conf">信心度：${confPct}%</div>`;

    if(city){
      html += `<div class="nc-ai-result-actions">
        <button class="btn btn-primary btn-sm" data-nc-action="confirm-city" data-city-id="${esc(city.id)}" data-x="${Math.round(imgX)}" data-y="${Math.round(imgY)}">✅ 確認標記</button>
      </div>`;
    } else {
      html += `<div class="text-dim" style="font-size:10px;margin-top:4px;">找不到對應城池，請從下方選擇：</div>
      <div class="nc-fallback-list" id="nc_fallbackList"></div>`;
    }

    html += `</div>`;
    setClickPopupContent(html);

    if(city){
      const btn = document.querySelector('[data-nc-action="confirm-city"]');
      if(btn){
        btn.addEventListener('click', () => {
          const cityId = btn.dataset.cityId;
          const x = parseFloat(btn.dataset.x);
          const y = parseFloat(btn.dataset.y);
          applyNodeForCity(cityId, x, y, 'ai-click');
          closeClickPopup();
        });
      }
    } else {
      renderFallbackList(imgX, imgY, document.getElementById('nc_fallbackList'));
    }
  }

  function renderClickPopupFallback(imgX, imgY, errorMsg){
    let html = `<div class="nc-ai-result" style="border-color:rgba(255,204,0,.4);">
      <div class="nc-ai-result-title" style="color:var(--neon-yellow);">
        <span>⚠️ ${errorMsg ? '辨識失敗' : '無明確結果'}</span>
      </div>
      <div class="text-dim" style="font-size:10px;">請從下方選擇最近的城池：</div>
      <div class="nc-fallback-list" id="nc_fallbackList"></div>
    </div>`;
    setClickPopupContent(html);
    renderFallbackList(imgX, imgY, document.getElementById('nc_fallbackList'));
  }

  function renderFallbackList(imgX, imgY, container){
    if(!container) return;

    const sorted = state.cities.map(c => {
      const nid = cityNodeId(c);
      const existing = nodes[nid];
      const dist = existing
        ? Math.hypot(existing.x - imgX, existing.y - imgY)
        : Infinity;
      return { city: c, dist, existing };
    }).sort((a, b) => {
      if(a.existing && !b.existing) return 1;
      if(!a.existing && b.existing) return -1;
      return a.dist - b.dist;
    });

    const top = sorted.slice(0, 15);

    if(top.length === 0){
      container.innerHTML = '<div class="text-dim" style="padding:8px;text-align:center;">無城池資料</div>';
      return;
    }

    container.innerHTML = top.map(item => {
      const isUsed = !!item.existing;
      const distText = isFinite(item.dist) ? `${Math.round(item.dist)}px` : '';
      const codeStr = item.city.code ? ` <span class="nc-item-code">[${esc(item.city.code)}]</span>` : '';
      return `<div class="nc-fallback-item" data-city-id="${esc(item.city.id)}" data-used="${isUsed ? '1' : '0'}">
        <span class="nc-fallback-name">${esc(item.city.name)}${codeStr}${isUsed ? ' <span style="color:var(--neon-green);font-size:9px;">✓</span>' : ''}</span>
        <span class="nc-fallback-dist">${distText}</span>
      </div>`;
    }).join('');

    container.querySelectorAll('.nc-fallback-item').forEach(el => {
      el.addEventListener('click', () => {
        const cityId = el.dataset.cityId;
        applyNodeForCity(cityId, imgX, imgY, 'manual');
        closeClickPopup();
      });
    });
  }

  function applyNodeForCity(cityId, x, y, source){
    const city = state.cities.find(c => c.id === cityId);
    if(!city) return;
    const nid = cityNodeId(city);
    nodes[nid] = {
      name: city.name,
      code: city.code || '',
      x: Math.round(x),
      y: Math.round(y),
      namedCityId: city.id,
      source: source || 'manual',
    };
    renderAll();
    updateProgress();
    logSystem(`✅ 已標記：${city.name}${city.code ? ' (' + city.code + ')' : ''}`);
  }

  function findNodeAt(imgX, imgY){
    const threshold = 20 / zoom;
    for(const nid in nodes){
      const n = nodes[nid];
      if(!n || typeof n.x !== 'number') continue;
      const dist = Math.hypot(n.x - imgX, n.y - imgY);
      if(dist < threshold){
        return { nodeId: nid, node: n, cityId: n.namedCityId || '' };
      }
    }
    return null;
  }

  function renderAll(){
    redrawCanvas();
    renderCityList();
    renderRouteList();
    updateRouteCount();
  }

  function redrawCanvas(){
    if(!ctx || !imageEl) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageEl, 0, 0, displayW, displayH);

    for(let i = 0; i < routes.length; i++){
      const r = routes[i];
      const fromCity = findCityByNameOrCode(r.fromName, '');
      const toCity = findCityByNameOrCode(r.toName, '');
      if(!fromCity || !toCity) continue;
      const fromNode = nodes[cityNodeId(fromCity)];
      const toNode = nodes[cityNodeId(toCity)];
      if(!fromNode || !toNode) continue;

      const isActive = (activeRouteIdx === i);
      const dx1 = fromNode.x * zoom, dy1 = fromNode.y * zoom;
      const dx2 = toNode.x * zoom, dy2 = toNode.y * zoom;

      ctx.beginPath();
      ctx.moveTo(dx1, dy1);
      ctx.lineTo(dx2, dy2);
      const color = r.color === 'yellow' ? 'rgba(255,204,0,.7)'
                  : r.color === 'white' ? 'rgba(255,255,255,.7)'
                  : r.color === 'red' ? 'rgba(255,68,102,.7)'
                  : 'rgba(68,170,255,.7)';
      ctx.strokeStyle = isActive ? 'rgba(170,102,255,1)' : color;
      ctx.lineWidth = isActive ? 4 : 2;
      if(r.color === 'yellow' || r.type === 'dashed'){
        ctx.setLineDash([6, 4]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for(const nid in nodes){
      const n = nodes[nid];
      if(!n || typeof n.x !== 'number') continue;
      const dx = n.x * zoom;
      const dy = n.y * zoom;
      const isSelected = (n.namedCityId === activeCityId) || (n.namedCityId === fixedPointCityId);
      const isManual = (n.source === 'manual');
      const isDraggingThis = (draggingNodeId === nid);

      /* v8.9.3：AI = 黃色，手動 = 藍色，選中 = 白色外框 */
      let color = '#ffcc00';
      if(isManual) color = '#3b82f6';

      const radius = Math.max(8, Math.min(14, 14 * Math.min(1, zoom)));
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, Math.PI * 2);
      ctx.fillStyle = color + 'cc';
      ctx.fill();
      ctx.strokeStyle = isDraggingThis ? '#22ff88' : (isSelected ? '#ffffff' : 'rgba(0,0,0,.7)');
      ctx.lineWidth = isDraggingThis ? 4 : (isSelected ? 3 : 1.5);
      ctx.stroke();

      if(isDraggingThis){
        ctx.beginPath();
        ctx.arc(dx, dy, radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(68,170,255,0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(dx, dy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();

      if(isSelected && zoom > 0.5 && !draggingNodeId){
        const label = n.code ? `${n.name} (${n.code})` : n.name;
        ctx.font = `bold ${Math.max(11, Math.min(16, 14 * zoom))}px "Noto Sans TC",sans-serif`;
        const tw = ctx.measureText(label).width;
        const bw = tw + 12;
        const bh = 20;
        const lx = dx - bw / 2;
        const ly = dy - radius - bh - 4;

        ctx.fillStyle = 'rgba(255,204,0,.95)';
        if(ctx.roundRect){
          ctx.beginPath();
          ctx.roundRect(lx, ly, bw, bh, 4);
          ctx.fill();
        } else {
          ctx.fillRect(lx, ly, bw, bh);
        }
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, dx, ly + bh / 2);
      }
    }
  }

  function renderCityList(){
    const el = document.getElementById('nc_cityList');
    if(!el) return;

    const list = state.cities.map(c => {
      const nid = cityNodeId(c);
      const n = nodes[nid];
      return { city: c, node: n || null };
    });

    if(list.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;">無城池資料</div>';
      return;
    }

    el.innerHTML = list.map(({ city, node }) => {
      const isNamed = !!node;
      const isSelected = (activeCityId === city.id) || (fixedPointCityId === city.id);
      const isManual = node && node.source === 'manual';
      const isAiClick = node && node.source === 'ai-click';
      const isFixedSel = (fixedPointCityId === city.id);
      const cls = 'nc-item-v3'
        + (isNamed ? ' named' : ' unnamed')
        + (isManual || isAiClick ? ' manual' : '')
        + (isFixedSel ? ' fixed-selected' : '')
        + (isSelected ? ' selected' : '');
      const icon = isNamed ? '✅' : '⭕';
      const codeStr = city.code ? `<span class="nc-item-code">${esc(city.code)}</span>` : '';
      const coordStr = node ? `(${node.x}, ${node.y})` : '';
      const sourceStr = node
        ? (node.source === 'ai' ? 'AI' : node.source === 'ai-click' ? 'AI點擊' : '手動')
        : '';
      /* v8.9.3：刪除按鈕 */
      const deleteBtn = node
        ? `<button class="nc-item-delete" data-delete-city="${esc(city.id)}" title="刪除標記">🗑️</button>`
        : '';
      return `<div class="${cls}" data-city-id="${esc(city.id)}">
        <span class="nc-item-icon">${icon}</span>
        <div class="nc-item-body">
          <div class="nc-item-name${isNamed ? '' : ' unnamed'}">${esc(city.name)}${codeStr}</div>
          <div class="nc-item-meta">
            ${coordStr ? `<span class="nc-item-dist">${coordStr}</span>` : ''}
            ${sourceStr ? `<span>${sourceStr}</span>` : ''}
          </div>
        </div>
        ${deleteBtn}
      </div>`;
    }).join('');

    el.querySelectorAll('.nc-item-v3').forEach(item => {
      item.addEventListener('click', (e) => {
        if(e.target.closest('.nc-item-delete')) return;
        const cityId = item.dataset.cityId;
        activeCityId = cityId;
        if(isFixedPointMode){
          fixedPointCityId = cityId;
          updateModeUI();
        }
        activeRouteIdx = -1;
        renderCityList();
        renderRouteList();
        renderAll();
        const city = state.cities.find(c => c.id === cityId);
        if(city){
          const n = nodes[cityNodeId(city)];
          if(n && wrapEl){
            const px = n.x * zoom;
            const py = n.y * zoom;
            wrapEl.scrollTo({
              left: Math.max(0, px - wrapEl.clientWidth / 2),
              top: Math.max(0, py - wrapEl.clientHeight / 2),
              behavior: 'smooth',
            });
          }
        }
      });
    });

    /* v8.9.3：刪除標記按鈕 */
    el.querySelectorAll('[data-delete-city]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cityId = btn.dataset.deleteCity;
        const city = state.cities.find(c => c.id === cityId);
        if(!city) return;
        const nid = cityNodeId(city);
        if(!nodes[nid]) return;
        if(!confirm(`確定刪除「${city.name}」的標記嗎？`)) return;
        delete nodes[nid];
        if(fixedPointCityId === cityId){
          fixedPointCityId = cityId;
        }
        renderAll();
        updateProgress();
        logSystem(`🗑️ 已刪除標記：${city.name}`);
      });
    });
  }

  function renderRouteList(){
    const el = document.getElementById('nc_routeList');
    if(!el) return;
    if(routes.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;">尚無路線<br><span style="font-size:10px;">執行「AI 辨識全圖」後顯示</span></div>';
      return;
    }
    el.innerHTML = routes.map((r, idx) => {
      const isActive = (activeRouteIdx === idx);
      const colorStr = r.color === 'yellow' ? '🟡' : r.color === 'white' ? '⚪' : r.color === 'red' ? '🔴' : '🔵';
      return `<div class="nc-item-v3${isActive ? ' selected' : ''}" data-route-idx="${idx}">
        <span class="nc-item-icon">${colorStr}</span>
        <div class="nc-item-body">
          <div class="nc-item-name">${esc(r.fromName)} → ${esc(r.toName)}</div>
          <div class="nc-item-meta">
            <span>${r.type === 'land' ? '陸路' : r.type}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('[data-route-idx]').forEach(item => {
      item.addEventListener('click', () => {
        activeRouteIdx = parseInt(item.dataset.routeIdx, 10);
        activeCityId = '';
        renderCityList();
        renderRouteList();
        renderAll();
      });
    });
  }

  function updateRouteCount(){
    const el = document.getElementById('nc_routeCount');
    if(el) el.textContent = routes.length;
  }

  function updateProgress(){
    const total = state.cities.length;
    const done = Object.keys(nodes).length;
    const doneEl = document.getElementById('nc_doneCount');
    if(doneEl) doneEl.textContent = done;
    const totalEl = document.getElementById('nc_totalCount');
    if(totalEl) totalEl.textContent = total;
    const cityCount = document.getElementById('nc_cityCount');
    if(cityCount) cityCount.textContent = done;
  }

  function findCityByNameOrCode(name, code){
    if(!name && !code) return null;
    if(code){
      const byCode = state.cities.find(c => c.code && c.code === code);
      if(byCode) return byCode;
    }
    if(name){
      const byName = state.cities.find(c => c.name === name);
      if(byName) return byName;
      const norm = window.SLG.normalizeCityName ? window.SLG.normalizeCityName(name) : name.toLowerCase();
      const byNorm = state.cities.find(c => {
        const n = window.SLG.normalizeCityName ? window.SLG.normalizeCityName(c.name) : c.name.toLowerCase();
        return n === norm;
      });
      if(byNorm) return byNorm;
    }
    return null;
  }

  function cityNodeId(city){
    if(!city) return '';
    if(city.code) return city.code;
    return 'n_' + city.id;
  }

  async function doSave(){
    if(!mapId) return;
    if(!window.SLG.canEditMapLibrary()){ alert('🔒 沒有編輯權限'); return; }

    const nodeCount = Object.keys(nodes).length;
    const routeCount = routes.length;

    if(nodeCount === 0 && routeCount === 0){
      if(!confirm('目前沒有任何標記，確定要儲存（清空）嗎？')) return;
    }

    const msg = `確定要儲存嗎？\n\n` +
      `城池節點：${nodeCount} 個\n` +
      `路線：${routeCount} 條\n\n` +
      `（會覆蓋此圖原有的節點與路線資料）`;

    if(!confirm(msg)) return;

    try{
      await window.SLG.updateMapNodes(mapId, nodes);
      if(routeCount > 0 && window.SLG.saveMapRoutes){
        try{
          await window.SLG.saveMapRoutes(mapId, routes);
        }catch(e){
          console.warn('路線儲存失敗（不影響節點）', e);
        }
      }
      logSystem(`💾 已儲存 ${nodeCount} 節點 / ${routeCount} 路線`);
      alert(`✅ 已儲存 ${nodeCount} 個節點${routeCount > 0 ? ` / ${routeCount} 條路線` : ''}`);
      close();
    }catch(e){
      console.error('儲存失敗', e);
      alert('❌ 儲存失敗：' + e.message);
    }
  }

  return {
    open,
    close,
    rescan: startAiScan,
    getNodes: () => ({ ...nodes }),
    getRoutes: () => routes.slice(),
  };
})();

/* ============================================================
   FuzzyMatch — 模糊匹配候選 Modal
   ============================================================ */
const FuzzyMatch = (() => {
  let queue = [];
  let currentIndex = 0;
  let decisions = {};

  function open(items){
    if(!Array.isArray(items) || items.length === 0) return;
    queue = items.slice();
    currentIndex = 0;
    decisions = {};
    const modal = document.getElementById('fuzzyMatchModal');
    if(!modal) return;
    modal.classList.add('show');
    bindEvents();
    renderCurrent();
  }

  function close(){
    const modal = document.getElementById('fuzzyMatchModal');
    if(modal) modal.classList.remove('show');
    queue = []; currentIndex = 0; decisions = {};
  }

  function bindEvents(){
    const btnConfirm = document.getElementById('fm_confirm');
    if(btnConfirm && !btnConfirm.dataset.bound){
      btnConfirm.dataset.bound = '1';
      btnConfirm.addEventListener('click', () => {
        const selected = document.querySelector('input[name="fm_choice"]:checked');
        if(!selected){ alert('請選擇一個選項'); return; }
        const val = selected.value;
        const item = queue[currentIndex];
        if(!item) return;
        decisions[item.cityId] = (val === '__skip__') ? null : val;
        currentIndex++;
        if(currentIndex >= queue.length){ applyAndClose(); }
        else { renderCurrent(); }
      });
    }
    const btnSkipAll = document.getElementById('fm_skipAll');
    if(btnSkipAll && !btnSkipAll.dataset.bound){
      btnSkipAll.dataset.bound = '1';
      btnSkipAll.addEventListener('click', () => {
        for(let i = currentIndex; i < queue.length; i++) decisions[queue[i].cityId] = null;
        applyAndClose();
      });
    }
  }

  function renderCurrent(){
    const item = queue[currentIndex];
    if(!item){ applyAndClose(); return; }
    const nameEl = document.getElementById('fm_originName');
    if(nameEl){
      const codeStr = item.cityCode ? ` [${item.cityCode}]` : '';
      nameEl.textContent = item.cityName + codeStr;
    }
    const listEl = document.getElementById('fm_candidates');
    if(!listEl) return;
    const candidates = item.candidates || [];
    let html = '';
    let firstChecked = true;
    for(const c of candidates){
      const score = Math.round((c.score || 0) * 100);
      const scoreCls = score >= 80 ? 'high' : (score >= 60 ? '' : 'low');
      const codeStr = c.node.code ? `<span class="fm-candidate-code">[${esc(c.node.code)}]</span>` : '';
      const coordsStr = (typeof c.node.x === 'number') ? `座標 (${c.node.x}, ${c.node.y})` : '';
      html += `<label class="fm-candidate">
        <input type="radio" name="fm_choice" value="${esc(c.nodeId)}" ${firstChecked ? 'checked' : ''}>
        <div class="fm-candidate-body">
          <div class="fm-candidate-name">${esc(c.node.name || '')}${codeStr}</div>
          <div class="fm-candidate-meta">${coordsStr}</div>
        </div>
        <span class="fm-score ${scoreCls}">${score}%</span>
      </label>`;
      firstChecked = false;
    }
    html += `<label class="fm-candidate skip">
      <input type="radio" name="fm_choice" value="__skip__">
      <div class="fm-candidate-body">
        <div class="fm-candidate-name">跳過此城池</div>
        <div class="fm-candidate-meta">稍後可手動指定座標</div>
      </div>
      <span class="fm-score low">—</span>
    </label>`;
    listEl.innerHTML = html;
  }

  function applyAndClose(){
    let applied = 0;
    for(const cityId in decisions){
      const nodeId = decisions[cityId];
      if(!nodeId) continue;
      const city = state.cities.find(c => c.id === cityId);
      if(!city) continue;
      const map = getLoadedMap(state.mapLibrary.activeMapId);
      if(!map || !map.nodes || !map.nodes[nodeId]) continue;
      const node = map.nodes[nodeId];
      city.mapNode = {
        nodeId,
        x: node.x,
        y: node.y,
        method: 'fuzzy-manual',
      };
      state.entityRev.city[cityId] = (state.entityRev.city[cityId] || 0) + 1;
      window.SLG.markDirty('city', cityId);
      applied++;
    }
    if(applied > 0){
      window.SLG.tickLamport();
      window.SLG.flushPatches();
      window.SLG.saveState('important');
      if(window.SLG.GameMap) window.SLG.GameMap.render();
    }
    close();
    if(applied > 0) logSystem(`🔀 已套用 ${applied} 個模糊匹配結果`);
  }

  return { open, close };
})();

/* ============================================================
   匯入城池後的匹配處理
   ============================================================ */
function onCityImportMatched({ touchedCities, matchResult, mode }){
  if(!matchResult) return;
  if(!matchResult.needChoice || matchResult.needChoice.length === 0) return;
  const items = matchResult.needChoice.map(item => ({
    cityId: item.cityId,
    cityName: item.cityName,
    cityCode: item.cityCode,
    candidates: item.candidates,
  }));
  FuzzyMatch.open(items);
}

/* ============================================================
   概覽面板渲染
   ============================================================ */
function renderOverview(){
  const cityCount = state.cities.length;
  const allianceCount = state.alliances.length;
  const zoneCount = state.zones.length;
  const routeCount = (state.routes || []).length;
  let warCount = 0;
  for(const c of state.cities){
    warCount += (c.attackTargets || []).filter(t => t.cityId).length;
    warCount += (c.defendTargets || []).filter(t => t.cityId).length;
  }
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if(el) el.textContent = val;
  };
  setText('ovCityCount', cityCount);
  setText('ovAllianceCount', allianceCount);
  setText('ovZoneCount', zoneCount);
  setText('ovRouteCount', routeCount);
  setText('ovWarCount', warCount);

  const distEl = document.getElementById('overviewAllianceDist');
  if(distEl){
    if(state.alliances.length === 0){
      distEl.innerHTML = '<div class="text-dim">尚未建立同盟</div>';
    } else {
      distEl.innerHTML = state.alliances.map(a => {
        const myCities = state.cities.filter(c => c.allianceId === a.id);
        const allocatedPower = myCities.reduce((s, c) => s + (Number(c.totalPower) || 0), 0);
        const totalPower = Number(a.totalPower) || 0;
        const remain = totalPower - allocatedPower;
        const pct = totalPower > 0 ? Math.round(allocatedPower / totalPower * 100) : 0;
        const cls = pct > 100 ? 'warn' : '';
        const icon = a.icon ? a.icon + ' ' : '';
        const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
        const remainStyle = remain < 0 ? 'style="color:var(--neon-red);"' : 'style="color:var(--neon-green);"';
        return `<div class="alliance-dist-row">
          <span class="name">${icon}${esc(a.name)}</span>
          <span class="chip ${chipCls}" style="font-size:9px;">${allianceSideLabel(a.side)}</span>
          <span class="num">${formatPower(allocatedPower)} / ${formatPower(totalPower)}</span>
          <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="pct">${pct}%</span>
          <span class="num" ${remainStyle}>餘 ${formatPower(remain)}</span>
          <span class="num" style="color:var(--text-dim);">${myCities.length} 城</span>
        </div>`;
      }).join('');
    }
  }

  const sideEl = document.getElementById('overviewSideDist');
  if(sideEl){
    const sides = [
      { key:'self', label:'本方' }, { key:'ally', label:'同盟' }, { key:'enemy', label:'敵方' },
      { key:'common_enemy', label:'共同敵方' }, { key:'npc', label:'NPC' },
    ];
    const counts = {};
    for(const s of sides) counts[s.key] = 0;
    for(const c of state.cities) counts[c.side] = (counts[c.side] || 0) + 1;
    const total = state.cities.length || 1;
    sideEl.innerHTML = sides.map(s => {
      const n = counts[s.key] || 0;
      const pct = Math.round(n / total * 100);
      return `<div class="overview-side-row">
        <span class="name">${s.label}</span>
        <div class="bar"><div class="bar-fill ${s.key}" style="width:${pct}%"></div></div>
        <span class="num">${n} 城</span>
      </div>`;
    }).join('');
  }
}

/* ============================================================
   距離計算工具
   ============================================================ */
const DistanceTool = (() => {
  let currentResult = null;
  function init(){
    const btn = document.getElementById('btnCalcDistance');
    if(btn) btn.addEventListener('click', doCalculate);
    const srcSel = document.getElementById('distSrcCity');
    const tgtSel = document.getElementById('distTgtCity');
    [srcSel, tgtSel].forEach(sel => {
      if(sel) sel.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); doCalculate(); } });
    });
    document.querySelectorAll('.distance-view-tab').forEach(tab => {
      tab.addEventListener('click', function(){
        const view = this.dataset.distView || 'number';
        state.distanceView = view;
        document.querySelectorAll('.distance-view-tab').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        renderResult();
        if(view === 'map'){
          if(currentResult) setDistanceHighlight(currentResult);
          const mapBtn = document.querySelector('.top-nav button[data-tab="tab-map"]');
          if(mapBtn) mapBtn.click();
          const routeTab = document.querySelector('.map-view-tab[data-map-view="route"]');
          if(routeTab) routeTab.click();
        }
      });
    });
  }
  function populateSelects(){
    const srcSel = document.getElementById('distSrcCity');
    const tgtSel = document.getElementById('distTgtCity');
    if(!srcSel || !tgtSel) return;
    const curSrc = srcSel.value, curTgt = tgtSel.value;
    const opts = '<option value="">選擇城池...</option>' +
      state.cities.map(c => {
        const a = state.alliances.find(al => al.id === c.allianceId);
        const icon = (a && a.icon) ? a.icon + ' ' : '';
        const codeStr = c.code ? ' [' + c.code + ']' : '';
        return `<option value="${c.id}">${icon}${esc(c.name)}${codeStr}</option>`;
      }).join('');
    srcSel.innerHTML = opts;
    tgtSel.innerHTML = opts;
    if(curSrc && state.cities.find(c => c.id === curSrc)) srcSel.value = curSrc;
    if(curTgt && state.cities.find(c => c.id === curTgt)) tgtSel.value = curTgt;
  }
  function doCalculate(){
    const srcSel = document.getElementById('distSrcCity');
    const tgtSel = document.getElementById('distTgtCity');
    if(!srcSel || !tgtSel) return;
    const srcId = srcSel.value, tgtId = tgtSel.value;
    if(!srcId || !tgtId){ alert('請選擇起點與終點'); return; }
    if(srcId === tgtId){ alert('起點與終點不可相同'); return; }
    const result = computeCityDistance(srcId, tgtId);
    currentResult = result;
    if(!result){ alert('計算失敗'); return; }
    if(state.distanceView === 'map'){ setDistanceHighlight(result); }
    renderResult();
  }
  function renderResult(){
    const el = document.getElementById('distanceResult');
    if(!el) return;
    if(!currentResult){ el.innerHTML = '<div class="text-dim">請選擇起點與終點後點「計算」</div>'; return; }
    const r = currentResult;
    const view = state.distanceView || 'number';
    if(view === 'map'){
      el.innerHTML = '<div class="text-dim">已切換至地圖 Tab，並高亮顯示路徑。<br>點擊地圖工具列的「✖️ 清除高亮」可移除。</div>';
      return;
    }
    if(view === 'number') el.innerHTML = renderNumberView(r);
    else if(view === 'path') el.innerHTML = renderPathView(r);
  }
  function getCrossZoneWarning(path){
    if(!path || path.length < 2) return '';
    const zoneIds = new Set();
    for(const id of path){
      const c = state.cities.find(x => x.id === id);
      if(c) zoneIds.add(c.zoneId || '');
    }
    if(zoneIds.size <= 1) return '';
    return '<div class="dist-crosszone-warn">⚠️ 此路徑跨越其他戰區，請切到「🌐 全部」檢視（地圖工具列）</div>';
  }
  function renderNumberView(r){
    const srcInfo = `${esc(r.src.name)}（${esc(r.src.allianceName || r.src.side)}）`;
    const tgtInfo = `${esc(r.tgt.name)}（${esc(r.tgt.allianceName || r.tgt.side)}）`;
    let html = `<div style="margin-bottom:8px;font-size:11px;color:var(--text-secondary);">🏁 ${srcInfo} → 🎯 ${tgtInfo}</div>`;
    if(r.passable.found) html += getCrossZoneWarning(r.passable.path);
    if(r.passable.found){
      html += `<div class="dist-block passable">
        <div class="dist-title">✅ 可通行路徑</div>
        <div class="dist-steps">${r.passable.steps} 步</div>
        ${r.passable.conquerNodes.length > 0 ? `<div class="dist-note">⚠️ 需先佔領 ${r.passable.conquerNodes.length} 座 NPC 城</div>` : ''}
      </div>`;
    } else {
      html += `<div class="dist-block no-route">
        <div class="dist-title">❌ 無可通行路徑</div>
        <div class="dist-note">中間城必須是同盟城或 NPC 城</div>
      </div>`;
    }
    if(r.conquer.found){
      const passableSteps = r.passable.found ? r.passable.steps : Infinity;
      const isShorter = r.conquer.steps < passableSteps;
      html += `<div class="dist-block conquer">
        <div class="dist-title">⚡ 最短征服路徑${isShorter ? '（更短）' : ''}</div>
        <div class="dist-steps">${r.conquer.steps} 步</div>
        ${r.conquer.conquerNodes.length > 0 ? `<div class="dist-note warn">⚠️ 需打下 ${r.conquer.conquerNodes.length} 座敵方城</div>` : ''}
      </div>`;
    } else {
      html += `<div class="dist-block no-route">
        <div class="dist-title">❌ 無征服路徑</div>
        <div class="dist-note">兩城之間無任何連通路線</div>
      </div>`;
    }
    return html;
  }
  function renderPathView(r){
    let html = '';
    if(r.passable.found){
      html += `<div class="dist-block passable">
        <div class="dist-title">✅ 可通行路徑 <span class="dist-steps">${r.passable.steps} 步</span></div>
        ${renderPathNodes(r.passable)}
        ${r.passable.conquerNodes.length > 0 ? `<div class="dist-note">⚠️ 需先佔領：${r.passable.conquerNodes.map(id => {
          const c = state.cities.find(x => x.id === id);
          return c ? c.name + '(NPC)' : '?';
        }).join('、')}</div>` : ''}
        ${getCrossZoneWarning(r.passable.path)}
      </div>`;
    } else {
      html += `<div class="dist-block no-route">
        <div class="dist-title">❌ 無可通行路徑</div>
        <div class="dist-note">中間城必須是同盟城或 NPC 城</div>
      </div>`;
    }
    if(r.conquer.found){
      const passableSteps = r.passable.found ? r.passable.steps : Infinity;
      const isShorter = r.conquer.steps < passableSteps;
      html += `<div class="dist-block conquer">
        <div class="dist-title">⚡ 最短征服路徑${isShorter ? '（更短）' : ''} <span class="dist-steps">${r.conquer.steps} 步</span></div>
        ${renderPathNodes(r.conquer)}
        ${r.conquer.conquerNodes.length > 0 ? `<div class="dist-note warn">⚠️ 需打下：${r.conquer.conquerNodes.map(id => {
          const c = state.cities.find(x => x.id === id);
          return c ? c.name : '?';
        }).join('、')}</div>` : ''}
      </div>`;
    }
    return html;
  }
  function renderPathNodes(result){
    const nodes = result.nodes;
    const conquerSet = new Set(result.conquerNodes);
    let html = '<div class="dist-path">';
    nodes.forEach((n, i) => {
      if(i > 0) html += '<span class="dist-arrow">→</span>';
      let cls = 'dist-node';
      if(n.isSrc) cls += ' src';
      else if(n.isTgt) cls += ' tgt';
      else if(conquerSet.has(n.id)) cls += ' conquer';
      else if(n.isNpc) cls += ' npc';
      const allianceIcon = (() => {
        const a = state.alliances.find(al => al.id === n.allianceId);
        return (a && a.icon) ? a.icon + ' ' : '';
      })();
      const suffix = n.isNpc ? '(NPC)' : (n.allianceName ? `(${n.allianceName})` : '');
      html += `<span class="${cls}">${allianceIcon}${esc(n.name)}${suffix ? ' ' + esc(suffix) : ''}</span>`;
    });
    html += '</div>';
    return html;
  }
  function clear(){
    currentResult = null;
    clearDistanceHighlight();
    renderResult();
  }
  function render(){ populateSelects(); renderResult(); }
  return { init, render, doCalculate, renderResult, clear };
})();

/* ============================================================
   城池數據子 Tab
   ============================================================ */
let currentCityView = 'overview';

function switchCityView(view){
  currentCityView = view;
  document.querySelectorAll('.city-subtab').forEach(t => {
    t.classList.toggle('active', t.dataset.cityView === view);
  });
  document.querySelectorAll('.city-subpanel').forEach(p => {
    p.classList.toggle('active', p.id === 'cityPanel-' + view);
  });
  if(view === 'overview') renderOverview();
  else if(view === 'zones') R.renderZones();
  else if(view === 'cities') CityManager.render();
  else if(view === 'war') WarManager.render();
  else if(view === 'deploy') DeployInstr.render();
  else if(view === 'routes'){ RouteManager.render(); DistanceTool.render(); }
  try{ localStorage.setItem('slg_city_view_v855', view); }catch(e){}
}

function initCitySubtabs(){
  document.querySelectorAll('.city-subtab').forEach(tab => {
    tab.addEventListener('click', function(){ switchCityView(this.dataset.cityView); });
  });
  document.querySelectorAll('[data-goto-city-view]').forEach(btn => {
    btn.addEventListener('click', function(){
      const view = this.dataset.gotoCityView;
      if(view) switchCityView(view);
    });
  });
  let saved = 'overview';
  try{
    const s = localStorage.getItem('slg_city_view_v855');
    if(s && ['overview','zones','cities','war','deploy','routes'].includes(s)) saved = s;
  }catch(e){}
  switchCityView(saved);
}

/* ============================================================
   房間 UI 更新
   ============================================================ */
function updateRoomEditButton(){
  const btn = document.getElementById('btnRequestRoomEdit');
  if(!btn) return;
  if(!window.SLG.isInRoom() || !state.auth.signedIn){ btn.style.display = 'none'; return; }
  if(window.SLG.canEditRoomData()){ btn.style.display = 'none'; return; }
  btn.style.display = '';
  if(state.myEditRequestStatus === 'pending'){
    btn.textContent = '⏳ 已申請，等待審核';
    btn.className = 'btn btn-sm pending';
    btn.disabled = true;
  } else {
    btn.textContent = '📝 申請編輯此房間資料';
    btn.className = 'btn btn-warning btn-sm';
    btn.disabled = false;
  }
}
function updateRoomSandboxActions(){
  const row = document.getElementById('roomSandboxActions');
  const btnUpload = document.getElementById('btnUploadSandboxToRoom');
  const btnDownload = document.getElementById('btnDownloadRoomSandbox');
  if(!row) return;
  if(!window.SLG.isInRoom()){ row.style.display = 'none'; return; }
  row.style.display = '';
  if(btnUpload){
    const canUpload = window.SLG.canUploadSandboxToRoom();
    btnUpload.style.display = canUpload ? '' : 'none';
    btnUpload.disabled = !canUpload;
  }
  if(btnDownload){
    const hasRoom = !!state.roomHasSnapshot;
    btnDownload.style.display = hasRoom ? '' : 'none';
    btnDownload.disabled = !hasRoom;
  }
}

/* ============================================================
   沙盤數據頁渲染
   ============================================================ */
function renderSandboxData(){
  const meName = document.getElementById('sandboxMeName');
  const meTime = document.getElementById('sandboxMeTime');
  const meStats = document.getElementById('sandboxMeStats');
  if(meName){
    meName.textContent = state.auth.signedIn ? (state.auth.displayName || state.auth.username || '—') : '未登入';
  }
  if(meTime){
    const ts = state.mySandbox.updatedAt;
    meTime.textContent = ts ? `最後更新：${timeAgo(ts)}` : '尚未同步';
  }
  if(meStats){
    meStats.innerHTML = `🏰 城池 <b>${state.cities.length}</b> · 🤝 同盟 <b>${state.alliances.length}</b> · 🗺️ 戰區 <b>${state.zones.length}</b> · 🛣️ 路線 <b>${state.routes.length}</b>`;
  }
  const tbody = document.getElementById('sandboxTableBody');
  if(tbody){
    const list = Object.entries(state.sandboxesList || {})
      .map(([uid, sb]) => ({ uid, ...sb }))
      .filter(sb => {
        const isSelf = sb.uid === state.auth.accountUid;
        if(isSelf) return true;
        return window.SLG.canViewSandboxOf(sb.uid, sb.role || 'member');
      })
      .sort((a, b) => {
        if(a.uid === state.auth.accountUid) return -1;
        if(b.uid === state.auth.accountUid) return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    if(list.length === 0){
      tbody.innerHTML = '<tr><td colspan="7" class="sandbox-empty">尚無沙盤資料</td></tr>';
    } else {
      tbody.innerHTML = list.map(sb => {
        const isSelf = sb.uid === state.auth.accountUid;
        const fileName = buildSandboxFileName(sb.displayName, sb.updatedAt);
        const cityCount = sb.data?.cities?.length || 0;
        const allianceCount = sb.data?.alliances?.length || 0;
        const zoneCount = sb.data?.zones?.length || 0;
        return `<tr class="${isSelf ? 'row-self' : ''}">
          <td class="sandbox-name">${esc(fileName)}${isSelf ? ' <span class="chip" style="font-size:9px;color:var(--neon-yellow);">你</span>' : ''}</td>
          <td class="sandbox-owner">${esc(sb.displayName || sb.username || '—')}</td>
          <td class="col-num">${cityCount}</td>
          <td class="col-num">${allianceCount}</td>
          <td class="col-num">${zoneCount}</td>
          <td class="sandbox-time">${esc(timeAgo(sb.updatedAt))}</td>
          <td class="col-actions">
            <button class="btn btn-primary btn-sm" data-action="load-sandbox" data-uid="${sb.uid}" ${isSelf?'disabled':''}>📥 載入</button>
          </td>
        </tr>`;
      }).join('');
    }
  }
  const roomCard = document.getElementById('roomSandboxCard');
  if(roomCard){
    if(window.SLG.canViewRoomSandboxes()){ roomCard.style.display = ''; }
    else { roomCard.style.display = 'none'; }
  }
  const rescueCard = document.getElementById('rescueCard');
  if(rescueCard){ rescueCard.style.display = window.SLG.canUseRescueTool() ? '' : 'none'; }
  if(tbody){
    tbody.querySelectorAll('[data-action="load-sandbox"]').forEach(btn => {
      btn.addEventListener('click', function(){
        const uid = this.dataset.uid;
        if(typeof window.SLG.loadSandboxFromList === 'function') window.SLG.loadSandboxFromList(uid);
      });
    });
  }
  renderSyncStatus();
}

/* ============================================================
   雲端歷史版本
   ============================================================ */
async function renderHistoryList(){
  const listEl = document.getElementById('historyList');
  if(!listEl) return;
  listEl.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;">載入中...</div>';
  if(!state.auth.signedIn){ listEl.innerHTML = '<div class="history-empty">請先登入</div>'; return; }
  if(!window.SLG.isOnline || !window.SLG.isOnline()){
    listEl.innerHTML = '<div class="history-empty">離線中，無法讀取歷史</div>';
    return;
  }
  try{
    const history = await window.SLG.listSandboxHistory();
    if(!history || history.length === 0){
      listEl.innerHTML = '<div class="history-empty">尚無歷史版本<br><span style="font-size:10px;">每次上傳時會自動備份前一版</span></div>';
      return;
    }
    listEl.innerHTML = history.map(h => {
      const time = new Date(h.ts).toLocaleString('zh-TW', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      return `<div class="history-item">
        <div class="history-time">${esc(time)}</div>
        <div class="history-info">🏰 <b>${h.citiesCount}</b> 城 / 🤝 <b>${h.alliancesCount}</b> 盟</div>
        <div class="history-actions">
          <button class="btn btn-primary btn-sm" data-history-restore="${h.ts}">↩️ 還原</button>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-history-restore]').forEach(btn => {
      btn.addEventListener('click', async function(){
        const ts = parseInt(this.dataset.historyRestore, 10);
        if(!ts) return;
        try{
          const ok = await window.SLG.restoreFromHistory(ts);
          if(ok){
            alert('✅ 已還原');
            if(typeof window.SLG.renderAll === 'function') window.SLG.renderAll();
            if(window.SLG.CityManager) window.SLG.CityManager.render();
            if(window.SLG.renderSandboxData) window.SLG.renderSandboxData();
          }
        }catch(e){ alert('❌ 還原失敗：' + e.message); }
      });
    });
  }catch(e){
    console.warn(e);
    listEl.innerHTML = '<div class="history-empty">讀取失敗</div>';
  }
}

/* ============================================================
   盟表單輔助
   ============================================================ */
function updateAllianceAvgPowerPreview(){
  const mc = parseFloat(document.getElementById('allyMemberCount').value) || 0;
  const inputVal = document.getElementById('allyTotalPower').value;
  const totalPower = (() => {
    const n = parseFloat(inputVal);
    if(isNaN(n) || n < 0) return 0;
    return Math.round(n * 1e8);
  })();
  const avg = mc > 0 ? (totalPower / mc) : 0;
  const el = document.getElementById('allyAvgPower');
  if(el) el.value = formatAvgPower(avg);
}
function resetAllianceForm(){
  state.editingAllianceId = null;
  document.getElementById('allyFormTitle').textContent = '➕ 新增參戰盟';
  document.getElementById('allyName').value = '';
  document.getElementById('allyIcon').value = '';
  document.getElementById('allySide').value = 'ally';
  document.getElementById('allyMemberCount').value = 100;
  document.getElementById('allyTotalPower').value = '2';
  document.getElementById('btnCancelAllianceEdit').style.display = 'none';
  document.getElementById('btnSaveAlliance').textContent = '💾 儲存';
  updateAllianceAvgPowerPreview();
  if(R.renderIconQuickRow) R.renderIconQuickRow();
  R.renderAlliances();
}
function startEditAlliance(id){
  const a = state.alliances.find(x => x.id === id);
  if(!a) return;
  state.editingAllianceId = id;
  document.getElementById('allyFormTitle').textContent = `✏️ 編輯同盟：${esc(a.name)}`;
  document.getElementById('allyName').value = a.name || '';
  document.getElementById('allyIcon').value = a.icon || '';
  document.getElementById('allySide').value = a.side || 'ally';
  document.getElementById('allyMemberCount').value = a.memberCount || 100;
  const yi = (Number(a.totalPower) || 0) / 1e8;
  document.getElementById('allyTotalPower').value = yi.toFixed(2);
  document.getElementById('btnCancelAllianceEdit').style.display = 'inline-flex';
  document.getElementById('btnSaveAlliance').textContent = '💾 更新';
  updateAllianceAvgPowerPreview();
  if(R.renderIconQuickRow) R.renderIconQuickRow();
  R.renderAlliances();
}

/* ============================================================
   城池 Modal 分級輸入
   ============================================================ */
let editingCityId = null;
let cityModalTierInited = false;

function updateAutoCalcFields(){
  const t = updateCityModalTierPreview();
  const pInput = document.getElementById('cm_totalPower').value;
  const p = (() => {
    const n = parseFloat(pInput);
    if(isNaN(n) || n < 0) return 0;
    return Math.round(n * 1e8);
  })();
  const el = document.getElementById('cm_avgPower');
  if(!el) return;
  if(t > 0 && p > 0){ el.value = formatAvgPower(Math.floor(p/t)); }
  else { el.value = '—'; }
}

function updateCityModalTierPreview(){
  const t1 = parseFloat(document.getElementById('cm_tier1')?.value) || 0;
  const t2 = parseFloat(document.getElementById('cm_tier2')?.value) || 0;
  const t3 = parseFloat(document.getElementById('cm_tier3')?.value) || 0;
  const t4 = parseFloat(document.getElementById('cm_tier4')?.value) || 0;
  const tierCounts = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };
  const tiers = state.troopTiers.tiers;
  const calc = calcTeamsFromTiers(tierCounts);

  const setText = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  setText('cm_tier1Teams', Math.floor(t1 * (tiers[0].teamsPerPlayer || 0)));
  setText('cm_tier2Teams', Math.floor(t2 * (tiers[1].teamsPerPlayer || 0)));
  setText('cm_tier3Teams', Math.floor(t3 * (tiers[2].teamsPerPlayer || 0)));
  setText('cm_tier4Teams', Math.floor(t4 * (tiers[3].teamsPerPlayer || 0)));
  setText('cm_tierTotalMembers', calc.totalMembers);
  setText('cm_tierTotalTeams', calc.totalTeams);

  return calc.totalTeams;
}

function bindCityModalTierInputs(){
  if(cityModalTierInited) return;
  cityModalTierInited = true;
  ['cm_tier1','cm_tier2','cm_tier3','cm_tier4'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', () => {
      updateCityModalTierPreview();
      updateAutoCalcFields();
    });
  });
}

function openCityModal(cityId){
  editingCityId = cityId || null;
  const isNew = !editingCityId;
  const city = isNew ? null : state.cities.find(c => c.id === editingCityId);

  if(!isNew && window.SLG.isConnected && window.SLG.isConnected()){
    window.SLG.acquireEditLock(editingCityId);
  }
  document.getElementById('cityModalTitle').textContent =
    isNew ? '🏰 新增城池' : `✏️ 編輯城池：${city ? city.name : ''}`;

  const zoneSel = document.getElementById('cm_zone');
  zoneSel.innerHTML = '<option value="">（不指定戰區）</option>' +
    state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');

  const allianceSel = document.getElementById('cm_alliance');
  allianceSel.innerHTML = '<option value="">（不指定 / NPC）</option>' +
    state.alliances.map(a =>
      `<option value="${a.id}">${a.icon ? a.icon + ' ' : ''}${esc(a.name)}（${allianceSideLabel(a.side)}）</option>`
    ).join('');

  if(isNew){
    document.getElementById('cm_name').value = '';
    document.getElementById('cm_side').value = 'self';
    document.getElementById('cm_level').value = 1;
    document.getElementById('cm_totalPower').value = '';
    document.getElementById('cm_cooldownMin').value = 5;
    document.getElementById('cm_wallMin').value = 30;
    document.getElementById('cm_isCapital').checked = false;
    if(state.zones.length > 0) zoneSel.value = state.zones[0].id;
    document.getElementById('cm_tier1').value = 0;
    document.getElementById('cm_tier2').value = 0;
    document.getElementById('cm_tier3').value = 0;
    document.getElementById('cm_tier4').value = 0;
  } else {
    document.getElementById('cm_name').value = city.name;
    document.getElementById('cm_zone').value = city.zoneId || '';
    document.getElementById('cm_alliance').value = city.allianceId || '';
    document.getElementById('cm_side').value = city.side;
    document.getElementById('cm_level').value = city.level || 1;
    const yi = (Number(city.totalPower) || 0) / 1e8;
    document.getElementById('cm_totalPower').value = yi > 0 ? yi.toFixed(2) : '';
    document.getElementById('cm_cooldownMin').value = city.cooldownMin;
    document.getElementById('cm_wallMin').value = city.wallMin;
    document.getElementById('cm_isCapital').checked = !!city.isCapital;
    const tc = city.tierCounts || { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
    document.getElementById('cm_tier1').value = tc.tier1 || 0;
    document.getElementById('cm_tier2').value = tc.tier2 || 0;
    document.getElementById('cm_tier3').value = tc.tier3 || 0;
    document.getElementById('cm_tier4').value = tc.tier4 || 0;
  }

  bindCityModalTierInputs();
  updateCityModalTierPreview();
  updateAutoCalcFields();
  document.getElementById('cityModal').classList.add('show');
}

function closeCityModal(){
  if(editingCityId && window.SLG.isConnected && window.SLG.isConnected()){
    window.SLG.releaseEditLock(editingCityId);
  }
  delete state.editLocks[editingCityId];
  document.getElementById('cityModal').classList.remove('show');
  editingCityId = null;
  R.renderCities();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY.render();
}

function saveCityFromModal(){
  const name = document.getElementById('cm_name').value.trim();
  if(!name){ alert('請輸入城池名稱'); return; }
  const zoneId = document.getElementById('cm_zone').value;
  const allianceId = document.getElementById('cm_alliance').value;
  const side = document.getElementById('cm_side').value;
  const level = parseInt(document.getElementById('cm_level').value) || 1;
  const pInput = parseFloat(document.getElementById('cm_totalPower').value) || 0;
  const totalPower = Math.round(pInput * 1e8);
  const cooldownMin = parseFloat(document.getElementById('cm_cooldownMin').value) || 0;
  const wallMin = parseFloat(document.getElementById('cm_wallMin').value) || 0;
  const isCapital = document.getElementById('cm_isCapital').checked;

  const t1 = parseFloat(document.getElementById('cm_tier1').value) || 0;
  const t2 = parseFloat(document.getElementById('cm_tier2').value) || 0;
  const t3 = parseFloat(document.getElementById('cm_tier3').value) || 0;
  const t4 = parseFloat(document.getElementById('cm_tier4').value) || 0;
  const tierCounts = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };
  const hasAnyTier = (t1 + t2 + t3 + t4) > 0;
  const calc = calcTeamsFromTiers(tierCounts);
  const memberCount = calc.totalMembers;
  const totalTeams = calc.totalTeams;

  const existingCity = editingCityId ? state.cities.find(c => c.id === editingCityId) : null;
  const attackTargets = existingCity ? (existingCity.attackTargets || []) : [];
  const defendTargets = existingCity ? (existingCity.defendTargets || []) : [];
  const defStartTime = existingCity ? (existingCity.defStartTime || '19:00') : '19:00';
  const avgPower = totalTeams > 0 ? Math.floor(totalPower / totalTeams) : 0;
  const id = editingCityId || uid();

  if(isCapital && allianceId){
    state.cities.forEach(c => {
      if(c.allianceId === allianceId && c.isCapital && c.id !== id){
        c.isCapital = false;
        state.entityRev.city[c.id] = (state.entityRev.city[c.id] || 0) + 1;
        window.SLG.markDirty('city', c.id);
      }
    });
  }

  const entity = {
    id, name, zoneId, allianceId, side,
    level, memberCount, totalPower, totalTeams, avgPower,
    cooldownMin, wallMin, defStartTime, isCapital,
    attackTargets, defendTargets
  };
  if(hasAnyTier) entity.tierCounts = tierCounts;
  if(existingCity && existingCity.code) entity.code = existingCity.code;
  if(existingCity && existingCity.mapNode) entity.mapNode = existingCity.mapNode;

  window.SLG.upsertEntity('city', entity);
  if(window.SLG.computeDefStartTimes) window.SLG.computeDefStartTimes(state.cities);
  closeCityModal();
  R.renderCities();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();
  if(R.renderCityMatrix) R.renderCityMatrix();
  window.SLG.saveState('important');
}

function deployRender(){ DEPLOY.render(); }

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  viz, R,
  renderAll: R.renderAll,
  renderChat: R.renderChat,
  renderChatBadge: R.renderChatBadge,
  renderCities: R.renderCities,
  renderZones: R.renderZones,
  renderAlliances: R.renderAlliances,
  renderMatrix: R.renderMatrix,
  renderCityMatrix: R.renderCityMatrix,
  populateCityMatrixFilters: R.populateCityMatrixFilters,
  renderIconQuickRow: R.renderIconQuickRow,
  renderNarrative: R.renderNarrative,
  renderDebug: R.renderDebug,
  renderSyncStatus,
  updateRoomEditButton,
  updateRoomSandboxActions,
  renderSandboxData,
  renderHistoryList,

  renderOverview,
  switchCityView,
  initCitySubtabs,

  DistanceTool, DYN, DEPLOY, deployRender,
  updateAllianceAvgPowerPreview,
  resetAllianceForm,
  startEditAlliance,
  updateAutoCalcFields,
  updateCityModalTierPreview,
  openCityModal,
  closeCityModal,
  saveCityFromModal,

  CityManager, WarManager, DeployInstr, RouteManager, GameMap,

  MapLibrary, NodeCalibration, FuzzyMatch,
  WarQuickPanel,
  onCityImportMatched,

  startInlineEditAlliance: R.startInlineEditAlliance,
  cancelInlineEditAlliance: R.cancelInlineEditAlliance,
  saveInlineEditAlliance: R.saveInlineEditAlliance,
});

})();
/* ============================================================================
 * ui.js 結束（v8.9.3）
 * ========================================================================== */
