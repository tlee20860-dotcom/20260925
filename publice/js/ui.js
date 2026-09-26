/* ============================================================================
 * ui.js — 所有渲染（viz / R / DYN / DEPLOY / CityManager / WarManager / DeployInstr / RouteManager / GameMap）
 * v8.5
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
  AI,
  ROLE, ROLE_ORDER,
  timeAgo, buildSandboxFileName,
  getAllianceByName,
  findRoute,
  addRoute,
  removeRoute,
  getReachableCityIds,
} = window.SLG;

const Auth = () => window.SLG.Auth;
const hasTogglePerm = () => typeof window.SLG.togglePerm === 'function';

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
    on(EVT.DATA, () => {
      computeLayout(); resizeCanvases(); renderStatic(); renderLive(currentSec);
    });
    on(EVT.VIZ_SNAPSHOTS, ({snapshots:s, secs}) => {
      snapshots = s; snapshotSecs = secs;
      if(secs.length > 0){
        slider.min = secs[0];
        slider.max = secs[secs.length-1];
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

  function activate(){
    if(!containerEl) return;
    computeLayout(); resizeCanvases();
    renderStatic(); renderLive(currentSec); renderClearPanel(currentSec);
  }
  function formatAbsTime(sec){
    return minutesToHHMM((state.simBaseMin || 0) + Math.floor(sec/60));
  }
  function getSchedule(maxSec){
    const set = new Set();
    for(let s=0;s<=maxSec;s+=VIZ_SNAPSHOT_INTERVAL) set.add(s);
    set.add(maxSec);
    return [...set];
  }
  function ingestSnapshot(sec, snap){
    snapshots.set(sec, snap);
    if(!snapshotSecs.includes(sec)){
      snapshotSecs.push(sec);
      snapshotSecs.sort((a,b) => a-b);
    }
  }
  function finalize(){ emit(EVT.VIZ_SNAPSHOTS, {snapshots, secs:snapshotSecs}); }
  function reset(){
    emit(EVT.VIZ_RESET);
    snapshots = new Map(); snapshotSecs = []; currentSec = 0;
  }
  function getAllSnapshots(){
    return {
      snapEntries:[...snapshots.entries()],
      secs:snapshotSecs,
      baseMin: state.simBaseMin
    };
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
      return;
    }
    const scale = Math.min(1, w / Math.max(layout.bounds.w, 320));
    const wS = Math.max(320, layout.bounds.w * scale);
    const hS = Math.max(240, layout.bounds.h * scale);
    [cvStatic, cvLive].forEach(cv => {
      cv.width = wS; cv.height = hS;
      cv.style.width = wS + 'px'; cv.style.height = hS + 'px';
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
        if((t.preWarPercent||0)<=0) continue;
        const to = layout.nodes.get(t.cityId); if(!to) continue;
        drawArrow(ctxStatic, from, to, 'rgba(255,68,102,0.35)', t.preWarPercent);
      }
      for(const t of (c.defendTargets || [])){
        if((t.preWarPercent||0)<=0) continue;
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

  function getAllianceAvgPowerLocal(a){
    if(typeof a.avgPower === 'number' && a.avgPower > 0) return a.avgPower;
    const mc = Number(a.memberCount) || 0;
    const tp = Number(a.totalPower) || 0;
    return mc > 0 ? tp / mc : 0;
  }

  function renderAlliances(){
    const tbody = document.getElementById('allianceTableBody');
    if(!tbody) return;
    if(state.alliances.length === 0){
      tbody.innerHTML = '<tr><td colspan="8" class="ally-table-empty">尚無同盟資料</td></tr>';
      return;
    }
    tbody.innerHTML = state.alliances.map(a => {
      const cap = state.cities.find(c => c.allianceId === a.id && c.isCapital);
      const tagCls = a.side === 'self' ? 'tag-self' : (a.side === 'ally' ? 'tag-ally' : 'tag-enemy');
      const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
      const icon = a.icon || '';
      const isEditing = state.editingAllianceId === a.id;

      const myCities = state.cities.filter(c => c.allianceId === a.id);
      const allocatedPower = myCities.reduce((s, c) => s + (Number(c.totalPower) || 0), 0);
      const totalPower = Number(a.totalPower) || 0;
      const remain = totalPower - allocatedPower;
      const pct = totalPower > 0 ? Math.round(allocatedPower / totalPower * 100) : 0;
      const remainColor = remain < 0 ? 'var(--neon-red)' : 'var(--neon-green)';

      return `<tr${isEditing ? ' style="background:rgba(255,204,0,.08);"' : ''}>
        <td class="col-name"><span class="alliance-tag ${tagCls}"></span>${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${esc(a.name)}${isEditing ? '<span class="editing-badge">編輯中</span>' : ''}${cap ? ` <span style="color:var(--neon-yellow);font-size:10px;">👑 ${esc(cap.name)}</span>` : ''}</td>
        <td><span class="chip ${chipCls}">${allianceSideLabel(a.side)}</span></td>
        <td class="col-num">${(a.memberCount||0).toLocaleString()}</td>
        <td class="col-num">${totalPower.toLocaleString()}</td>
        <td class="col-num">${allocatedPower.toLocaleString()}</td>
        <td class="col-num" style="color:${remainColor};">${remain.toLocaleString()}</td>
        <td class="col-num">${pct}%</td>
        <td class="col-actions">
          <button class="btn btn-primary btn-sm" data-action="edit-alliance" data-id="${a.id}">✏️</button>
          <button class="btn btn-danger btn-sm" data-action="del-alliance" data-id="${a.id}">🗑️</button>
        </td>
      </tr>`;
    }).join('');

    if(hasTogglePerm() && Auth()){
      const canEdit = window.SLG.isInRoom() ? window.SLG.canEditRoomData() : Auth().canEditData();
      document.querySelectorAll('[data-action="edit-alliance"],[data-action="del-alliance"]').forEach(b => {
        window.SLG.togglePerm(b, canEdit, '需要編輯資料權限');
      });
    }
  }

  function renderMatrix(){
    const wrap = document.getElementById('matrixWrap');
    if(!wrap) return;
    if(state.alliances.length < 2){
      wrap.innerHTML = '<div class="text-dim">至少需要 2 個同盟才能生成矩陣</div>';
      return;
    }
    const consume = (state.settings.consumeMinPerMin + state.settings.consumeMaxPerMin) / 2;
    let html = '<table class="matrix-table"><thead><tr><th>發起方 ↓ / 對手 →</th>';
    state.alliances.forEach(a => {
      const avg = getAllianceAvgPowerLocal(a);
      const icon = a.icon ? a.icon + ' ' : '';
      html += `<th>${icon}${esc(a.name)}<br><span style="font-size:9px;color:var(--text-dim);">均戰 ${avg.toLocaleString(undefined,{maximumFractionDigits:2})}</span></th>`;
    });
    html += '</tr></thead><tbody>';
    state.alliances.forEach(y => {
      const yAvg = getAllianceAvgPowerLocal(y);
      const yIcon = y.icon ? y.icon + ' ' : '';
      html += `<tr><td class="row-label">${yIcon}${esc(y.name)}</td>`;
      state.alliances.forEach(x => {
        if(y.id === x.id){
          html += '<td style="color:#334155;">—</td>';
        } else {
          const xAvg = getAllianceAvgPowerLocal(x);
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

  function renderZones(){
    const el = document.getElementById('zoneList');
    if(!el) return;
    el.innerHTML = state.zones.map(z =>
      `<span class="chip">${esc(z.name)} <button class="btn btn-danger btn-sm" style="padding:0 4px;margin-left:4px;" data-action="del-zone" data-id="${z.id}">✕</button></span>`
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
      document.querySelectorAll('[data-action="del-zone"]').forEach(b => {
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
        html += `<div class="flex-row" style="justify-content:space-between;margin-bottom:6px;"><strong style="font-size:13px;">${c.isCapital ? '👑 ' : ''}${esc(c.name)} <span style="font-size:10px;color:var(--text-dim);">Lv.${c.level||1}</span></strong><span class="chip ${sideClass(c.side)}">${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${sideLabel(c.side)}</span></div>`;
        if(alliance){
          html += `<div class="text-dim" style="margin-bottom:4px;">同盟：${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${esc(alliance.name)}</div>`;
        }
        html += `<div class="flex-row" style="margin-bottom:4px;"><span class="chip time">🕐 ${esc(defStart)} – ${esc(defEnd)}</span></div>`;
        html += `<div class="flex-row" style="font-size:11px;color:var(--text-secondary);gap:12px;"><span>戰力 ${(c.totalPower||0).toLocaleString()}</span><span>隊數 ${c.totalTeams}</span><span>均戰 ${c.avgPower}</span></div>`;
        if(alloc.over){
          html += `<div class="flex-row" style="font-size:11px;margin-top:4px;"><span class="text-warn">⚠️ 戰前派兵合計 ${alloc.allocated} 隊 ＞ 總隊數 ${alloc.totalTeams} 隊</span></div>`;
        } else {
          html += `<div class="flex-row" style="font-size:11px;gap:12px;margin-top:4px;"><span style="color:#ff8fa3;">⚔️ 戰前 ${alloc.atkSum} 隊</span><span style="color:#8fffb0;">🛡️ 協防 ${alloc.defSum} 隊</span><span style="color:#8ecbff;">🏰 留守 ${alloc.reserve} 隊</span></div>`;
        }
        html += `<div class="flex-row" style="font-size:11px;color:var(--text-dim);gap:12px;margin-top:4px;"><span>冷卻 ${c.cooldownMin}分</span><span>城牆 ${c.wallMin}分</span></div>`;
        if(c.attackTargets?.length){
          const list = c.attackTargets.filter(t => (t.preWarPercent||0)>0).map(t => {
            const tgt = state.cities.find(cc => cc.id === t.cityId);
            return tgt ? `<span class="chip enemy">${esc(tgt.name)} 戰${t.preWarPercent}% 復${t.postRevivePercent}% #${t.priority}</span>` : null;
          }).filter(Boolean);
          if(list.length) html += `<div style="margin-top:4px;">⚔️ ${list.join(' ')}</div>`;
        }
        if(c.defendTargets?.length){
          const list = c.defendTargets.filter(t => (t.preWarPercent||0)>0).map(t => {
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
                : l.type === 'revive' ? 'event-revive'
                : 'event-info';
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
      if(m.isSystem){
        div.textContent = m.text;
      } else {
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
    } else {
      badge.classList.remove('show');
    }
  }

  function renderProgress(p){
    const bar = document.getElementById('simProgress');
    if(bar) bar.style.width = Math.round(p*100) + '%';
  }

  function renderAll(){
    renderHealth(); renderHost(); renderMembers();
    renderAlliances(); renderZones(); renderCities();
    renderChat(); renderChatBadge();
  }

  return {
    renderHealth, renderHost, renderDebug, renderMembers,
    renderAlliances, renderMatrix, renderZones, renderCities,
    renderNarrative, renderChat, renderChatBadge, renderProgress,
    renderAll,
  };
})();

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
    if (thConsume) thConsume.textContent = (granSec === 30) ? '本30秒消耗' : '本分鐘消耗(速率)';

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
    const rows = [...grouped.values()].sort((a,b) =>
      a.sec - b.sec || a.srcCity.localeCompare(b.srcCity)
    );
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
      const atkChips = (c.attackTargets || []).filter(t => (t.preWarPercent||0) > 0).map(t => {
        const tgt = state.cities.find(cc => cc.id === t.cityId);
        if (!tgt) return '';
        return `<span class="deploy-chip atk">→ ${esc(tgt.name)} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const defChips = (c.defendTargets || []).filter(t => (t.preWarPercent||0) > 0).map(t => {
        const tgt = state.cities.find(cc => cc.id === t.cityId);
        if (!tgt) return '';
        return `<span class="deploy-chip def">→ ${esc(tgt.name)} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const reserve = alloc.reserve;
      const reserveCls = alloc.over ? 'warn' : 'ok';
      const reservePct = c.totalTeams > 0 ? Math.round(reserve / c.totalTeams * 100) : 0;
      const conflictIcon = info.conflict ? '<span class="conflict-icon" title="受兵量超過自身兵力">⚠️</span>' : '';
      html += `<tr class="${info.conflict ? 'conflict-row' : ''}">
        <td class="city-name ${c.side==='enemy'?'city-fallen':''}">${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${c.isCapital ? '👑 ' : ''}${esc(c.name)}${conflictIcon}</td>
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
        return `<span class="deploy-chip atk">← ${esc(o.name)} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const defenderChips = state.cities.filter(o =>
        (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0) > 0)
      ).map(o => {
        const t = o.defendTargets.find(t => t.cityId === c.id);
        return `<span class="deploy-chip def">← ${esc(o.name)} <span class="pct">${t.preWarPercent}%</span><span class="pr">#${t.priority}</span></span>`;
      }).join('');
      const info = conflictMap.get(c.id) || { incoming: 0, conflict: false };
      const sideCls = sideClass(c.side);
      const icon = allianceIconOf(c);
      const conflictIcon = info.conflict ? '<span class="conflict-icon" title="受兵量超過自身兵力">⚠️</span>' : '';
      html += `<tr class="${info.conflict ? 'conflict-row' : ''}">
        <td class="city-name ${c.side==='enemy'?'city-fallen':''}">${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${c.isCapital ? '👑 ' : ''}${esc(c.name)}${conflictIcon}</td>
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
      const hasOut = (c.attackTargets||[]).some(t => (t.preWarPercent||0)>0) ||
                     (c.defendTargets||[]).some(t => (t.preWarPercent||0)>0);
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
      html += `<th>${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${esc(c.name)}${conflictIcon}</th>`;
    }
    html += '</tr></thead><tbody>';
    for(const src of activeCities){
      const srcIcon = allianceIconOf(src);
      html += `<tr><td class="row-header">${srcIcon ? `<span class="alliance-icon">${srcIcon}</span>` : ''}${src.isCapital ? '👑 ' : ''}${esc(src.name)}</td>`;
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

  function computeCircleLayout(activeCities){
    const W = 1000, H = 1000, CX = 500, CY = 500;
    const R = Math.min(W, H) * 0.36;
    const N = activeCities.length;
    const pos = new Map();
    activeCities.forEach((c, i) => {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      pos.set(c.id, { x: CX + Math.cos(ang) * R, y: CY + Math.sin(ang) * R });
    });
    return { pos, zones: [] };
  }

  function fitToCanvas(pos, W, H, padding){
    if (pos.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pos.values()){
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const availW = W - padding * 2;
    const availH = H - padding * 2;
    const scale = Math.min(availW / contentW, availH / contentH, 1.6);
    const offsetX = (W - contentW * scale) / 2 - minX * scale;
    const offsetY = (H - contentH * scale) / 2 - minY * scale;
    for (const [id, p] of pos){
      pos.set(id, { x: p.x * scale + offsetX, y: p.y * scale + offsetY });
    }
  }

  function computeForceLayout(activeCities, allCities){
    const W = 1000, H = 1000, PAD = 120;
    const N = activeCities.length;
    if (N === 0) return { pos: new Map(), zones: [] };
    const area = (W - PAD * 2) * (H - PAD * 2);
    const k = Math.sqrt(area / N) * 0.55;

    const pos = new Map();
    activeCities.forEach((c, i) => {
      const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
      const r = 150 + (i % 3) * 50;
      pos.set(c.id, { x: W/2 + Math.cos(ang) * r, y: H/2 + Math.sin(ang) * r });
    });

    const edges = [];
    for (const src of activeCities){
      for (const t of (src.attackTargets || [])){
        if ((t.preWarPercent||0) <= 0) continue;
        if (!pos.has(t.cityId)) continue;
        edges.push([src.id, t.cityId]);
      }
      for (const t of (src.defendTargets || [])){
        if ((t.preWarPercent||0) <= 0) continue;
        if (!pos.has(t.cityId)) continue;
        edges.push([src.id, t.cityId]);
      }
    }

    const iterations = N > 50 ? 150 : 300;
    let temp = W / 8;
    const cool = temp / (iterations + 1);

    for (let iter = 0; iter < iterations; iter++){
      const disp = new Map();
      activeCities.forEach(c => disp.set(c.id, { x: 0, y: 0 }));

      for (let i = 0; i < activeCities.length; i++){
        for (let j = i + 1; j < activeCities.length; j++){
          const a = pos.get(activeCities[i].id);
          const b = pos.get(activeCities[j].id);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01){ dx = (Math.random()-0.5)*10; dy = (Math.random()-0.5)*10; d = Math.hypot(dx, dy) || 0.01; }
          const force = (k * k) / d;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          const da = disp.get(activeCities[i].id);
          const db = disp.get(activeCities[j].id);
          da.x += fx; da.y += fy;
          db.x -= fx; db.y -= fy;
        }
      }

      for (const [aId, bId] of edges){
        const pa = pos.get(aId), pb = pos.get(bId);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) d = 0.01;
        const force = (d * d) / k * 1.4;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        const da = disp.get(aId), db = disp.get(bId);
        da.x -= fx; da.y -= fy;
        db.x += fx; db.y += fy;
      }

      activeCities.forEach(c => {
        const d = disp.get(c.id);
        const p = pos.get(c.id);
        const len = Math.hypot(d.x, d.y);
        if (len > 0){
          const limit = Math.min(len, temp);
          p.x += (d.x / len) * limit;
          p.y += (d.y / len) * limit;
        }
        p.x = Math.max(PAD, Math.min(W - PAD, p.x));
        p.y = Math.max(PAD, Math.min(H - PAD, p.y));
      });

      temp = Math.max(temp - cool, 0.5);
    }

    fitToCanvas(pos, W, H, 150);
    return { pos, zones: [] };
  }

  function computeZoneLayout(activeCities, allCities){
    const W = 1000, H = 1000, PAD = 40;
    const pos = new Map();
    const zones = [];

    const groups = new Map();
    for (const c of activeCities){
      const key = c.zoneId || '__none__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const groupArr = [...groups.entries()];
    const numGroups = groupArr.length;
    const cols = numGroups <= 1 ? 1 : numGroups <= 4 ? 2 : numGroups <= 9 ? 3 : 4;
    const rows = Math.ceil(numGroups / cols);
    const gap = 22;
    const cellW = (W - PAD * 2 - gap * (cols - 1)) / cols;
    const cellH = (H - PAD * 2 - gap * (rows - 1)) / rows;

    groupArr.forEach(([zoneId, groupCities], gi) => {
      const col = gi % cols;
      const row = Math.floor(gi / cols);
      const cellX = PAD + col * (cellW + gap);
      const cellY = PAD + row * (cellH + gap);
      const cx = cellX + cellW / 2;
      const cy = cellY + cellH / 2;
      const n = groupCities.length;
      const R = n === 1 ? 0 : Math.min(cellW, cellH) * 0.32;

      const zoneName = zoneId === '__none__' ? '未分配'
        : (state.zones.find(z => z.id === zoneId)?.name || '未分配');

      zones.push({ zoneId, name: zoneName, x: cellX, y: cellY, w: cellW, h: cellH, cx, cy, count: n });

      groupCities.forEach((c, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        pos.set(c.id, { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R });
      });
    });

    return { pos, zones };
  }

  function makeNodeShape(ns, side, x, y, r){
    const cls = 'graph-node ' + side;
    let el;
    if (side === 'ally'){
      el = document.createElementNS(ns, 'rect');
      el.setAttribute('x', x - r);
      el.setAttribute('y', y - r);
      el.setAttribute('width', r * 2);
      el.setAttribute('height', r * 2);
      el.setAttribute('rx', r * 0.35);
      el.setAttribute('ry', r * 0.35);
    } else if (side === 'enemy'){
      const h = r * 1.15;
      el = document.createElementNS(ns, 'polygon');
      el.setAttribute('points', `${x},${y - h} ${x + r * 0.95},${y + h * 0.65} ${x - r * 0.95},${y + h * 0.65}`);
    } else if (side === 'common_enemy'){
      el = document.createElementNS(ns, 'polygon');
      el.setAttribute('points', `${x},${y - r * 1.15} ${x + r * 1.15},${y} ${x},${y + r * 1.15} ${x - r * 1.15},${y}`);
    } else if (side === 'npc'){
      const pts = [];
      for (let i = 0; i < 6; i++){
        const ang = (i / 6) * Math.PI * 2 - Math.PI / 2;
        pts.push(`${x + Math.cos(ang) * r},${y + Math.sin(ang) * r}`);
      }
      el = document.createElementNS(ns, 'polygon');
      el.setAttribute('points', pts.join(' '));
    } else {
      el = document.createElementNS(ns, 'circle');
      el.setAttribute('cx', x);
      el.setAttribute('cy', y);
      el.setAttribute('r', r);
    }
    el.setAttribute('class', cls);
    return el;
  }

  function renderGraphView(cities, conflictMap){
    const wrap = document.getElementById('deployTableWrap');
    const activeCities = cities.filter(c => {
      const hasOut = (c.attackTargets||[]).some(t => (t.preWarPercent||0)>0) ||
                     (c.defendTargets||[]).some(t => (t.preWarPercent||0)>0);
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

    const layoutSel = document.getElementById('deployLayout');
    const layoutMode = layoutSel ? layoutSel.value : 'circle';

    let layoutResult;
    if (layoutMode === 'force') layoutResult = computeForceLayout(activeCities, state.cities);
    else if (layoutMode === 'zone') layoutResult = computeZoneLayout(activeCities, state.cities);
    else layoutResult = computeCircleLayout(activeCities);
    const positions = layoutResult.pos;
    const zones = layoutResult.zones || [];

    const W = 1000, H = 1000;

    const maxTeams = Math.max(...activeCities.map(c => c.totalTeams || 1), 1);
    const nodeRadius = (c) => {
      const t = c.totalTeams || 0;
      return 14 + Math.sqrt(t / maxTeams) * 16;
    };

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    svg.appendChild(makeDefs(ns));

    if (layoutMode === 'zone' && zones.length > 0){
      const zoneG = document.createElementNS(ns, 'g');
      zoneG.setAttribute('class', 'graph-zones');
      zones.forEach(z => {
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('class', 'graph-zone-box');
        rect.setAttribute('x', z.x);
        rect.setAttribute('y', z.y);
        rect.setAttribute('width', z.w);
        rect.setAttribute('height', z.h);
        rect.setAttribute('rx', 14);
        rect.setAttribute('ry', 14);
        zoneG.appendChild(rect);

        const label = document.createElementNS(ns, 'text');
        label.setAttribute('class', 'graph-zone-label');
        label.setAttribute('x', z.cx);
        label.setAttribute('y', z.y + 20);
        label.textContent = z.name;
        zoneG.appendChild(label);

        const sub = document.createElementNS(ns, 'text');
        sub.setAttribute('class', 'graph-zone-sublabel');
        sub.setAttribute('x', z.cx);
        sub.setAttribute('y', z.y + 36);
        sub.textContent = `${z.count} 座城`;
        zoneG.appendChild(sub);
      });
      svg.appendChild(zoneG);
    }

    const edgesG = document.createElementNS(ns, 'g');
    edgesG.setAttribute('class', 'graph-edges');

    const radiusById = new Map();
    activeCities.forEach(c => radiusById.set(c.id, nodeRadius(c)));

    for (const src of activeCities){
      const fromPos = positions.get(src.id);
      if (!fromPos) continue;
      const fromR = radiusById.get(src.id) || 20;

      const addEdge = (targetId, pct, isAttack) => {
        if ((pct||0) <= 0) return;
        const toPos = positions.get(targetId);
        if (!toPos) return;
        const toR = radiusById.get(targetId) || 20;
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('class', 'graph-edge ' + (isAttack ? 'atk' : 'def'));
        path.setAttribute('d', makeCurve(fromPos, toPos, fromR, toR));
        path.setAttribute('marker-end', isAttack ? 'url(#arrow-atk)' : 'url(#arrow-def)');
        path.dataset.src = src.id;
        path.dataset.tgt = targetId;
        edgesG.appendChild(path);
      };

      for (const t of (src.attackTargets || [])) addEdge(t.cityId, t.preWarPercent, true);
      for (const t of (src.defendTargets || [])) addEdge(t.cityId, t.preWarPercent, false);
    }
    svg.appendChild(edgesG);

    const nodesG = document.createElementNS(ns, 'g');
    nodesG.setAttribute('class', 'graph-nodes');

    for (const c of activeCities){
      const pos = positions.get(c.id);
      if (!pos) continue;
      const r = nodeRadius(c);
      const info = conflictMap.get(c.id) || { conflict: false, incoming: 0 };
      const cIcon = allianceIconOf(c);
      const hasIcon = !!cIcon;

      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'graph-node-group');
      g.dataset.cityId = c.id;

      if (info.conflict){
        const halo = document.createElementNS(ns, 'circle');
        halo.setAttribute('cx', pos.x);
        halo.setAttribute('cy', pos.y);
        halo.setAttribute('r', r + 6);
        halo.setAttribute('fill', 'none');
        halo.setAttribute('stroke', '#ff4466');
        halo.setAttribute('stroke-width', '2');
        halo.setAttribute('stroke-dasharray', '4 3');
        halo.setAttribute('opacity', '0.8');
        const animate = document.createElementNS(ns, 'animate');
        animate.setAttribute('attributeName', 'opacity');
        animate.setAttribute('values', '0.8;0.3;0.8');
        animate.setAttribute('dur', '1.5s');
        animate.setAttribute('repeatCount', 'indefinite');
        halo.appendChild(animate);
        g.appendChild(halo);
      }

      g.appendChild(makeNodeShape(ns, c.side, pos.x, pos.y, r));

      if (hasIcon){
        const bg = document.createElementNS(ns, 'circle');
        bg.setAttribute('cx', pos.x);
        bg.setAttribute('cy', pos.y);
        bg.setAttribute('r', r * 0.82);
        bg.setAttribute('fill', 'rgba(0,0,0,0.55)');
        bg.setAttribute('pointer-events', 'none');
        g.appendChild(bg);
      }

      if (c.isCapital){
        const crown = document.createElementNS(ns, 'text');
        crown.setAttribute('x', pos.x);
        crown.setAttribute('y', pos.y - r - 8);
        crown.setAttribute('text-anchor', 'middle');
        crown.setAttribute('font-size', '14');
        crown.textContent = '👑';
        g.appendChild(crown);
      }

      if (hasIcon){
        const iconText = document.createElementNS(ns, 'text');
        iconText.setAttribute('x', pos.x);
        iconText.setAttribute('y', pos.y);
        iconText.setAttribute('text-anchor', 'middle');
        iconText.setAttribute('dominant-baseline', 'central');
        iconText.setAttribute('font-size', r * 1.15);
        iconText.setAttribute('font-family', '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif');
        iconText.setAttribute('pointer-events', 'none');
        iconText.textContent = cIcon;
        g.appendChild(iconText);
      } else {
        const numLabel = document.createElementNS(ns, 'text');
        numLabel.setAttribute('x', pos.x);
        numLabel.setAttribute('y', pos.y + 4);
        numLabel.setAttribute('text-anchor', 'middle');
        numLabel.setAttribute('font-size', Math.min(11, r * 0.7));
        numLabel.setAttribute('font-weight', '700');
        numLabel.setAttribute('fill', '#fff');
        numLabel.setAttribute('pointer-events', 'none');
        numLabel.textContent = c.totalTeams;
        g.appendChild(numLabel);
      }

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('class', 'graph-node-label' + (c.name.length > 4 ? ' small' : ''));
      label.setAttribute('x', pos.x);
      label.setAttribute('y', pos.y + r + 16);
      label.textContent = (c.name.length > 8 ? c.name.slice(0,8)+'…' : c.name) + (hasIcon ? ` (${c.totalTeams})` : '');
      g.appendChild(label);

      nodesG.appendChild(g);
    }
    svg.appendChild(nodesG);

    const infoPanel = document.createElement('div');
    infoPanel.className = 'graph-info-panel';
    infoPanel.style.display = 'none';
    infoPanel.innerHTML = '<div class="title"></div><div class="body"></div>';

    const legend = document.createElement('div');
    legend.className = 'graph-legend';
    legend.innerHTML = `
      <span><span class="dot" style="background:#3b82f6;border-radius:50%;"></span>本方</span>
      <span><span class="dot" style="background:#10b981;border-radius:3px;"></span>同盟</span>
      <span><span class="dot" style="background:#ef4444;clip-path:polygon(50% 0, 100% 100%, 0 100%);"></span>敵方</span>
      <span><span class="dot" style="background:#f59e0b;transform:rotate(45deg);"></span>共同敵</span>
      <span><span class="dot" style="background:#a855f7;clip-path:polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);"></span>NPC</span>
      <span><span class="line atk"></span>進攻</span>
      <span><span class="line def"></span>協防</span>
      <span style="color:var(--text-dim);">★ 節點中央 = 盟徽</span>
    `;

    const zoomCtrl = document.createElement('div');
    zoomCtrl.className = 'graph-zoom';
    zoomCtrl.innerHTML = `
      <button data-zoom="in">＋</button>
      <button data-zoom="out">－</button>
      <button data-zoom="reset">⟲</button>
    `;

    wrap.innerHTML = '';
    const graphWrap = document.createElement('div');
    graphWrap.className = 'deploy-graph-wrap';
    graphWrap.appendChild(svg);
    graphWrap.appendChild(infoPanel);
    graphWrap.appendChild(legend);
    graphWrap.appendChild(zoomCtrl);
    wrap.appendChild(graphWrap);

    let vb = { x: 0, y: 0, w: W, h: H };
    function applyVB(){ svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }

    zoomCtrl.querySelector('[data-zoom="in"]').addEventListener('click', () => {
      const cx = vb.x + vb.w/2, cy = vb.y + vb.h/2;
      vb.w *= 0.75; vb.h *= 0.75;
      vb.x = cx - vb.w/2; vb.y = cy - vb.h/2; applyVB();
    });
    zoomCtrl.querySelector('[data-zoom="out"]').addEventListener('click', () => {
      const cx = vb.x + vb.w/2, cy = vb.y + vb.h/2;
      vb.w *= 1.33; vb.h *= 1.33;
      vb.x = cx - vb.w/2; vb.y = cy - vb.h/2; applyVB();
    });
    zoomCtrl.querySelector('[data-zoom="reset"]').addEventListener('click', () => {
      vb = { x: 0, y: 0, w: W, h: H }; applyVB();
    });

    let dragging = false, dragStart = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.graph-node-group')) return;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, vbX: vb.x, vbY: vb.y };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const dx = (e.clientX - dragStart.x) * (vb.w / rect.width);
      const dy = (e.clientY - dragStart.y) * (vb.h / rect.height);
      vb.x = dragStart.vbX - dx;
      vb.y = dragStart.vbY - dy;
      applyVB();
    });
    svg.addEventListener('pointerup', (e) => {
      dragging = false;
      try { svg.releasePointerCapture(e.pointerId); } catch(err){}
    });
    svg.addEventListener('pointercancel', () => { dragging = false; });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      const px = vb.x + vb.w * mx;
      const py = vb.y + vb.h * my;
      const factor = e.deltaY < 0 ? 0.85 : 1.18;
      vb.w *= factor; vb.h *= factor;
      vb.x = px - vb.w * mx;
      vb.y = py - vb.h * my;
      applyVB();
    }, { passive: false });

    const allNodeGroups = nodesG.querySelectorAll('.graph-node-group');
    const allEdges = edgesG.querySelectorAll('.graph-edge');

    function highlightCity(cityId){
      allNodeGroups.forEach(g => {
        if (g.dataset.cityId === cityId){ g.classList.add('highlight'); g.classList.remove('dim'); }
        else g.classList.add('dim');
      });
      allEdges.forEach(edge => {
        if (edge.dataset.src === cityId || edge.dataset.tgt === cityId){
          edge.classList.add('highlight'); edge.classList.remove('dim');
        } else {
          edge.classList.add('dim'); edge.classList.remove('highlight');
        }
      });
    }
    function clearHighlight(){
      allNodeGroups.forEach(g => g.classList.remove('highlight', 'dim'));
      allEdges.forEach(e => e.classList.remove('highlight', 'dim'));
    }

    allNodeGroups.forEach(g => {
      const cityId = g.dataset.cityId;
      const city = state.cities.find(c => c.id === cityId);
      if (!city) return;

      g.addEventListener('mouseenter', () => {
        highlightCity(cityId);
        const info = conflictMap.get(cityId) || { incoming: 0, conflict: false };
        const alloc = computeAllocation(city);
        const title = infoPanel.querySelector('.title');
        const body = infoPanel.querySelector('.body');
        const cIcon = allianceIconOf(city);
        title.textContent = `${cIcon ? cIcon + ' ' : ''}${city.isCapital ? '👑 ' : ''}${city.name}（Lv.${city.level||1}）`;
        const atkList = (city.attackTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}%` : '';
        }).filter(Boolean).join('、') || '無';
        const defList = (city.defendTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}%` : '';
        }).filter(Boolean).join('、') || '無';
        body.innerHTML = `
          <div class="row"><span>等級</span><b>Lv.${city.level||1}</b></div>
          <div class="row"><span>總隊數</span><b>${city.totalTeams}</b></div>
          <div class="row"><span>均戰</span><b>${city.avgPower}</b></div>
          <div class="row"><span>留守</span><b>${alloc.reserve} 隊</b></div>
          <div class="row"><span>受兵量</span><b style="color:${info.conflict?'var(--neon-red)':'var(--text-primary)'};">${info.incoming} 隊</b></div>
          <div class="row" style="flex-direction:column;align-items:flex-start;gap:2px;margin-top:4px;"><span>⚔️ 進攻</span><b style="font-size:10px;">${esc(atkList)}</b></div>
          <div class="row" style="flex-direction:column;align-items:flex-start;gap:2px;"><span>🛡️ 協防</span><b style="font-size:10px;">${esc(defList)}</b></div>
        `;
        infoPanel.style.display = 'block';
      });
      g.addEventListener('mouseleave', () => {
        clearHighlight();
        infoPanel.style.display = 'none';
      });
      g.addEventListener('click', () => {
        if(typeof window.SLG.canEditRoomData === 'function' && window.SLG.isInRoom()){
          if(!window.SLG.canEditRoomData()) return;
        } else if(Auth() && !Auth().canEditData()) return;
        if(typeof window.SLG.openCityModal === 'function') window.SLG.openCityModal(cityId);
      });
    });

    svg.addEventListener('click', (e) => {
      if (e.target === svg){ clearHighlight(); infoPanel.style.display = 'none'; }
    });
  }

  function makeCurve(fromPos, toPos, fromR, toR){
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return '';
    const ux = dx/dist, uy = dy/dist;
    const sx = fromPos.x + ux * (fromR + 3);
    const sy = fromPos.y + uy * (fromR + 3);
    const ex = toPos.x - ux * (toR + 5);
    const ey = toPos.y - uy * (toR + 5);
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const curvature = Math.min(dist * 0.08, 55);
    const cx = mx - uy * curvature;
    const cy = my + ux * curvature;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  }

  function makeDefs(ns){
    const defs = document.createElementNS(ns, 'defs');
    const mk = (id, color) => {
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
    defs.appendChild(mk('arrow-atk', '#ff4466'));
    defs.appendChild(mk('arrow-def', '#22ff88'));
    return defs;
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
        const atkStr = (c.attackTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}% #${t.priority}` : '';
        }).filter(Boolean).join(' | ');
        const defStr = (c.defendTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
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
          .map(o => { const t = o.attackTargets.find(t => t.cityId === c.id); return `${o.name} ${t.preWarPercent}% #${t.priority}`; }).join(' | ');
        const defStr = state.cities.filter(o => (o.defendTargets||[]).some(t => t.cityId === c.id && (t.preWarPercent||0)>0))
          .map(o => { const t = o.defendTargets.find(t => t.cityId === c.id); return `${o.name} ${t.preWarPercent}% #${t.priority}`; }).join(' | ');
        return [c.name, sideLabel(c.side), c.totalTeams, atkStr || '-', defStr || '-', info.incoming, info.conflict ? '⚠️ 警示' : '正常'];
      });
    } else {
      headers = ['出兵城', '目標城', '行動', '派兵%', '優先順序'];
      rows = [];
      for(const src of cities){
        for(const t of (src.attackTargets||[])){
          if ((t.preWarPercent||0) <= 0) continue;
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          if (!tgt) continue;
          rows.push([src.name, tgt.name, '進攻', t.preWarPercent + '%', t.priority]);
        }
        for(const t of (src.defendTargets||[])){
          if ((t.preWarPercent||0) <= 0) continue;
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
                    : currentView === 'graph' ? '連線圖'
                    : '矩陣';
    a.href = url;
    a.download = `佈兵總覽_${viewName}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logSystem('📥 已匯出 CSV');
  }

  return { init, render, populateZoneFilter };
})();

/* ============================================================
   CityManager — 城池清單表格 + 批次操作
   ============================================================ */
const CityManager = (() => {
  let currentView = 'table';

  function init(){
    const btn = document.getElementById('btnCityViewToggle');
    if(btn){
      btn.addEventListener('click', function(){
        currentView = currentView === 'table' ? 'card' : 'table';
        this.textContent = currentView === 'table' ? '🃏 卡片檢視' : '📋 表格檢視';
        document.getElementById('cityTableView').style.display = currentView === 'table' ? '' : 'none';
        document.getElementById('cityCardView').style.display = currentView === 'card' ? '' : 'none';
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
        document.querySelectorAll('.city-table .city-cb').forEach(cb => {
          cb.checked = this.checked;
        });
        updateBatchBar();
      });
    }

    const btnApplyAlliance = document.getElementById('btnCityBatchApplyAlliance');
    if(btnApplyAlliance){
      btnApplyAlliance.addEventListener('click', () => {
        const aid = document.getElementById('cityBatchAlliance').value;
        if(!aid) { alert('請選擇所屬盟'); return; }
        applyBatch('allianceId', aid);
      });
    }

    const btnApplySide = document.getElementById('btnCityBatchApplySide');
    if(btnApplySide){
      btnApplySide.addEventListener('click', () => {
        const side = document.getElementById('cityBatchSide').value;
        if(!side) { alert('請選擇陣營'); return; }
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
            for(const id of ids){
              window.SLG.deleteEntity('city', id);
            }
            render();
            if(window.SLG.saveState) window.SLG.saveState();
          });
        }
      });
    }

    const tbody = document.getElementById('cityTableBody');
    if(tbody){
      tbody.addEventListener('change', e => {
        if(e.target.classList.contains('city-cb')) updateBatchBar();
      });
    }
  }

  function getCheckedIds(){
    return [...document.querySelectorAll('.city-table .city-cb:checked')]
      .map(cb => cb.dataset.id);
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
    if(window.SLG.saveState) window.SLG.saveState();
    render();
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
      if(search && !c.name.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  function render(){
    populateFilters();
    populateBatchAllianceOptions();

    const list = getFilteredCities();
    const tbody = document.getElementById('cityTableBody');
    if(tbody){
      if(list.length === 0){
        tbody.innerHTML = '<tr><td colspan="11" class="city-table-empty">無城池資料</td></tr>';
      } else {
        tbody.innerHTML = list.map(c => {
          const zone = state.zones.find(z => z.id === c.zoneId);
          const alliance = state.alliances.find(a => a.id === c.allianceId);
          const avg = c.totalTeams > 0 ? Math.floor((Number(c.totalPower)||0) / c.totalTeams) : null;
          const icon = (alliance && alliance.icon) ? alliance.icon + ' ' : '';
          const avgDisplay = avg === null || !isFinite(avg) ? '—' : avg;

          return `<tr class="${c.isCapital ? 'row-self' : ''}">
            <td><input type="checkbox" class="city-cb" data-id="${c.id}"></td>
            <td class="city-name">${c.isCapital ? '👑 ' : ''}${esc(c.name)}</td>
            <td><span class="chip" style="font-size:9px;">Lv.${c.level||1}</span></td>
            <td>${zone ? esc(zone.name) : '<span class="text-dim">—</span>'}</td>
            <td>${icon}${alliance ? esc(alliance.name) : '<span class="text-dim">NPC</span>'}</td>
            <td><span class="chip ${sideClass(c.side)}" style="font-size:9px;">${sideLabel(c.side)}</span></td>
            <td class="col-num">${c.memberCount || '—'}</td>
            <td class="col-num">${(Number(c.totalPower)||0).toLocaleString()}</td>
            <td class="col-num">${c.totalTeams || '—'}</td>
            <td class="col-num">${avgDisplay}</td>
            <td>
              <button class="btn btn-primary btn-sm" data-action="edit-city" data-id="${c.id}">✏️</button>
              <button class="btn btn-danger btn-sm" data-action="del-city" data-id="${c.id}">🗑️</button>
            </td>
          </tr>`;
        }).join('');
      }
    }

    if(tbody){
      tbody.querySelectorAll('[data-action="edit-city"]').forEach(b => {
        b.addEventListener('click', function(){
          if(window.SLG.openCityModal) window.SLG.openCityModal(this.dataset.id);
        });
      });
      tbody.querySelectorAll('[data-action="del-city"]').forEach(b => {
        b.addEventListener('click', function(){
          const id = this.dataset.id;
          const c = state.cities.find(x => x.id === id);
          if(!c) return;
          if(typeof window.SLG.showConfirm === 'function'){
            window.SLG.showConfirm('刪除城池', `確定刪除「${c.name}」？`, () => {
              window.SLG.deleteEntity('city', id);
              render();
              if(window.SLG.saveState) window.SLG.saveState();
            });
          }
        });
      });
    }

    updateBatchBar();
    renderDistSummary();
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
        <span class="num">${allocatedPower.toLocaleString()} / ${totalPower.toLocaleString()}</span>
        <div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
        <span class="pct">${pct}%</span>
        <span class="num" ${remainStyle}>餘 ${remain.toLocaleString()}</span>
        <span class="num" style="color:var(--text-dim);">${myCities.length} 城</span>
      </div>`;
    }).join('');
  }

  return { init, render };
})();

/* ⚠️ 不要在此行下方加 })(); —— 第 2/2 部分會接續 */
/* ============================================================
   WarManager — 宣戰指示
   ============================================================ */
const WarManager = (() => {
  function init(){
    const btn = document.getElementById('btnAddWarLine');
    if(btn) btn.addEventListener('click', () => addLine());
  }

  function getAllWarLines(){
    const lines = [];
    for(const src of state.cities){
      for(const t of (src.attackTargets || [])){
        lines.push({
          srcId: src.id,
          tgtId: t.cityId,
          type: 'attack',
          preWarPercent: t.preWarPercent,
          postRevivePercent: t.postRevivePercent,
          priority: t.priority,
        });
      }
      for(const t of (src.defendTargets || [])){
        lines.push({
          srcId: src.id,
          tgtId: t.cityId,
          type: 'defend',
          preWarPercent: t.preWarPercent,
          postRevivePercent: t.postRevivePercent,
          priority: t.priority,
        });
      }
    }
    return lines;
  }

  function addLine(){
    if(state.cities.length < 2){ alert('至少需要 2 座城池'); return; }
    const src = state.cities[0];
    const tgt = state.cities.find(c => c.id !== src.id);
    if(!src || !tgt) return;

    if(!src.attackTargets) src.attackTargets = [];
    src.attackTargets.push({
      cityId: tgt.id,
      preWarPercent: 50,
      postRevivePercent: 50,
      priority: 1,
    });
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }

  function render(){
    const el = document.getElementById('warList');
    if(!el) return;
    const lines = getAllWarLines();

    if(lines.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:10px;">尚無宣戰指示</div>';
      return;
    }

    const cityOpts = (selectedId) => state.cities.map(c =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');

    el.innerHTML = lines.map((l, i) => {
      const src = state.cities.find(c => c.id === l.srcId);
      const tgt = state.cities.find(c => c.id === l.tgtId);
      const valid = src && tgt;
      const invalidCls = valid ? '' : 'invalid';
      return `<div class="war-line ${invalidCls}" data-line-idx="${i}">
        <select class="war-src">${cityOpts(l.srcId)}</select>
        <select class="war-type">
          <option value="attack" ${l.type === 'attack' ? 'selected' : ''}>⚔️ 進攻</option>
          <option value="defend" ${l.type === 'defend' ? 'selected' : ''}>🛡️ 防守</option>
        </select>
        <select class="war-tgt">${cityOpts(l.tgtId)}</select>
        <button class="btn btn-danger btn-sm war-del">🗑️</button>
      </div>`;
    }).join('');

    el.querySelectorAll('.war-line').forEach((lineEl, i) => {
      const line = lines[i];
      lineEl.querySelector('.war-src')?.addEventListener('change', function(){
        moveLine(line, this.value, line.tgtId, line.type);
      });
      lineEl.querySelector('.war-type')?.addEventListener('change', function(){
        moveLine(line, line.srcId, line.tgtId, this.value);
      });
      lineEl.querySelector('.war-tgt')?.addEventListener('change', function(){
        moveLine(line, line.srcId, this.value, line.type);
      });
      lineEl.querySelector('.war-del')?.addEventListener('click', () => {
        deleteLine(line);
      });
    });
  }

  function moveLine(oldLine, newSrcId, newTgtId, newType){
    deleteLineSilent(oldLine);
    const src = state.cities.find(c => c.id === newSrcId);
    if(!src) return;
    const arr = newType === 'attack' ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) src[arr] = [];

    const existing = src[arr].find(t => t.cityId === newTgtId);
    if(existing){
      existing.preWarPercent = oldLine.preWarPercent || 50;
      existing.postRevivePercent = oldLine.postRevivePercent || 50;
      existing.priority = oldLine.priority || 1;
    } else {
      src[arr].push({
        cityId: newTgtId,
        preWarPercent: oldLine.preWarPercent || 50,
        postRevivePercent: oldLine.postRevivePercent || 50,
        priority: oldLine.priority || 1,
      });
    }
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }

  function deleteLine(line){
    deleteLineSilent(line);
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }

  function deleteLineSilent(line){
    const src = state.cities.find(c => c.id === line.srcId);
    if(!src) return;
    const arr = line.type === 'attack' ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) return;
    src[arr] = src[arr].filter(t => t.cityId !== line.tgtId);
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
  }

  return { init, render };
})();

/* ============================================================
   DeployInstr — 出兵指示
   ============================================================ */
const DeployInstr = (() => {
  function init(){
    const el = document.getElementById('deployInstructionList');
    if(el){
      el.addEventListener('change', e => {
        const input = e.target.closest('[data-deploy-field]');
        if(!input) return;
        const card = input.closest('.deploy-instr-card');
        if(!card) return;
        const srcId = card.dataset.srcId;
        const tgtId = input.dataset.tgtId;
        const type = input.dataset.type;
        const field = input.dataset.deployField;
        updateRoute(srcId, tgtId, type, field, input.value);
      });
      el.addEventListener('click', e => {
        const delBtn = e.target.closest('[data-deploy-del]');
        if(!delBtn) return;
        const srcId = delBtn.dataset.srcId;
        const tgtId = delBtn.dataset.tgtId;
        const type = delBtn.dataset.type;
        deleteRoute(srcId, tgtId, type);
      });
    }
  }

  function updateRoute(srcId, tgtId, type, field, value){
    const src = state.cities.find(c => c.id === srcId);
    if(!src) return;
    const arr = type === 'attack' ? 'attackTargets' : 'defendTargets';
    const route = (src[arr] || []).find(t => t.cityId === tgtId);
    if(!route) return;
    route[field] = parseFloat(value) || 0;
    state.entityRev.city[srcId] = (state.entityRev.city[srcId] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', srcId);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
    render();
  }

  function deleteRoute(srcId, tgtId, type){
    const src = state.cities.find(c => c.id === srcId);
    if(!src) return;
    const arr = type === 'attack' ? 'attackTargets' : 'defendTargets';
    src[arr] = (src[arr] || []).filter(t => t.cityId !== tgtId);
    state.entityRev.city[srcId] = (state.entityRev.city[srcId] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', srcId);
    if(window.SLG.tickLamport) window.SLG.tickLamport();
    if(window.SLG.flushPatches) window.SLG.flushPatches();
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.WarManager) window.SLG.WarManager.render();
  }

  function render(){
    const el = document.getElementById('deployInstructionList');
    if(!el) return;

    const sources = state.cities.filter(c =>
      (c.attackTargets && c.attackTargets.length > 0) ||
      (c.defendTargets && c.defendTargets.length > 0)
    );

    if(sources.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:10px;">尚無出兵指示（請先在「宣戰指示」新增路線）</div>';
      return;
    }

    el.innerHTML = sources.map(src => renderCard(src)).join('');
  }

  function renderCard(src){
    const totalTeams = Number(src.totalTeams) || 0;
    const atkLines = (src.attackTargets || []).map(t => renderLine(src, t, 'attack')).join('');
    const defLines = (src.defendTargets || []).map(t => renderLine(src, t, 'defend')).join('');

    let atkSum = 0, defSum = 0;
    for(const t of (src.attackTargets || [])) atkSum += (Number(t.preWarPercent) || 0);
    for(const t of (src.defendTargets || [])) defSum += (Number(t.preWarPercent) || 0);
    const total = atkSum + defSum;
    const isOver = total > 100;
    const reserve = Math.max(0, 100 - total);

    return `<div class="deploy-instr-card" data-src-id="${src.id}">
      <div class="deploy-instr-header">
        <div class="deploy-instr-title">${src.isCapital ? '👑 ' : ''}${esc(src.name)}</div>
        <div class="deploy-instr-total">總隊數 ${totalTeams}</div>
      </div>
      ${atkLines ? `<div class="section-label" style="font-size:10px;">⚔️ 進攻指示（${atkSum}%）</div>${atkLines}` : ''}
      ${defLines ? `<div class="section-label" style="font-size:10px;">🛡️ 防守指示（${defSum}%）</div>${defLines}` : ''}
      <div class="deploy-instr-footer ${isOver ? 'warn' : ''}">
        合計 ${total}%　留守 ${reserve}%　${isOver ? '⚠️ 超過 100%' : '✅'}
      </div>
    </div>`;
  }

  function renderLine(src, route, type){
    const tgt = state.cities.find(c => c.id === route.cityId);
    if(!tgt) return '';
    const arrow = type === 'attack' ? '⚔️' : '🛡️';

    return `<div class="deploy-instr-line">
      <span class="label">${arrow}</span>
      <span class="target">${esc(tgt.name)}</span>
      <select data-deploy-field="preWarPercent" data-tgt-id="${route.cityId}" data-type="${type}">
        ${PERCENT_OPTIONS.map(p => `<option value="${p}" ${p === route.preWarPercent ? 'selected' : ''}>${p}%</option>`).join('')}
      </select>
      <select data-deploy-field="postRevivePercent" data-tgt-id="${route.cityId}" data-type="${type}">
        ${PERCENT_OPTIONS.map(p => `<option value="${p}" ${p === route.postRevivePercent ? 'selected' : ''}>${p}%</option>`).join('')}
      </select>
      <input type="number" data-deploy-field="priority" data-tgt-id="${route.cityId}" data-type="${type}" value="${route.priority || 1}" min="1" max="99" step="1">
      <button class="btn btn-danger btn-sm" data-deploy-del="1" data-tgt-id="${route.cityId}" data-type="${type}" data-src-id="${src.id}">🗑️</button>
    </div>`;
  }

  return { init, render };
})();

/* ============================================================
   v8.5：RouteManager — 地圖路線管理
   ============================================================ */
const RouteManager = (() => {
  function init(){
    const btn = document.getElementById('btnAddRouteLine');
    if(btn){
      btn.addEventListener('click', () => addEmptyLine());
    }

    const list = document.getElementById('routeManagerList');
    if(list){
      list.addEventListener('click', e => {
        const delBtn = e.target.closest('[data-route-del]');
        if(delBtn){
          const id = delBtn.dataset.routeId;
          if(window.SLG.removeRoute(id)){
            if(window.SLG.saveState) window.SLG.saveState();
            render();
            if(window.SLG.GameMap) window.SLG.GameMap.render();
          }
        }
      });

      list.addEventListener('change', e => {
        const sel = e.target.closest('[data-route-src],[data-route-tgt]');
        if(!sel) return;
        const line = sel.closest('.route-line');
        if(!line) return;
        const oldId = line.dataset.routeId;
        const srcId = line.querySelector('[data-route-src]').value;
        const tgtId = line.querySelector('[data-route-tgt]').value;

        if(!srcId || !tgtId || srcId === tgtId){
          if(oldId){
            window.SLG.removeRoute(oldId);
          }
          if(window.SLG.saveState) window.SLG.saveState();
          render();
          if(window.SLG.GameMap) window.SLG.GameMap.render();
          return;
        }

        if(oldId){
          window.SLG.removeRoute(oldId);
        }
        const r = window.SLG.addRoute(srcId, tgtId);
        if(window.SLG.saveState) window.SLG.saveState();
        render();
        if(window.SLG.GameMap) window.SLG.GameMap.render();
      });
    }
  }

  function addEmptyLine(){
    if(state.cities.length < 2){ alert('至少需要 2 座城池'); return; }
    const a = state.cities[0];
    const b = state.cities.find(c => c.id !== a.id);
    if(!a || !b) return;
    if(window.SLG.findRoute(a.id, b.id)){
      alert('這兩城之間已有路線');
      return;
    }
    const r = window.SLG.addRoute(a.id, b.id);
    if(r){
      if(window.SLG.saveState) window.SLG.saveState();
      render();
      if(window.SLG.GameMap) window.SLG.GameMap.render();
    }
  }

  function render(){
    const el = document.getElementById('routeManagerList');
    if(!el) return;

    const routes = state.routes || [];

    if(routes.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:10px;">尚無地圖路線。點下方按鈕新增。</div>';
      return;
    }

    const cityOpts = (selectedId) => state.cities.map(c =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');

    el.innerHTML = routes.map(r => {
      return `<div class="route-line" data-route-id="${r.id}">
        <select data-route-src>${cityOpts(r.cityAId)}</select>
        <span class="route-arrow">—</span>
        <select data-route-tgt>${cityOpts(r.cityBId)}</select>
        <button class="btn btn-danger btn-sm" data-route-del data-route-id="${r.id}">🗑️</button>
      </div>`;
    }).join('');
  }

  return { init, render };
})();

/* ============================================================
   v8.5：GameMap — 地圖（力導向 + 盟徽 + 路線）
   ============================================================ */
const GameMap = (() => {
  let canvas, ctx, containerEl;
  let view = { x: 0, y: 0, scale: 1 };
  let nodePositions = new Map();     // cityId -> {x, y}
  let layoutDirty = true;
  let dragging = false;
  let dragStart = null;
  let nodeDragging = null;
  let editRouteMode = false;
  let routeDragFrom = null;
  let routeDragEnd = null;
  let hoveredCityId = null;

  const CANVAS_W = 2000;
  const CANVAS_H = 2000;

  function init(){
    containerEl = document.getElementById('gameMapContainer');
    if(!containerEl) return;
    canvas = document.getElementById('gameMapCanvas');
    if(!canvas) return;
    ctx = canvas.getContext('2d');

    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    canvas.style.width = CANVAS_W + 'px';
    canvas.style.height = CANVAS_H + 'px';

    containerEl.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', () => { hoveredCityId = null; });

    const btnEdit = document.getElementById('btnMapEditRoute');
    if(btnEdit){
      btnEdit.addEventListener('click', () => {
        editRouteMode = !editRouteMode;
        btnEdit.textContent = editRouteMode ? '✏️ 編輯路線：開' : '✏️ 編輯路線：關';
        btnEdit.classList.toggle('active', editRouteMode);
        applyCursor();
      });
    }

    const btnRelayout = document.getElementById('btnMapRelayout');
    if(btnRelayout){
      btnRelayout.addEventListener('click', () => {
        layoutDirty = true;
        render();
      });
    }

    const btnFit = document.getElementById('btnMapFit');
    if(btnFit){
      btnFit.addEventListener('click', () => {
        fitView();
        applyView();
        render();
      });
    }

    window.addEventListener('resize', () => {
      if(containerEl) { render(); }
    });
  }

  function applyCursor(){
    if(!canvas) return;
    canvas.style.cursor = editRouteMode ? 'crosshair' : 'grab';
  }

  function onWheel(e){
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const mx = (e.clientX - rect.left + containerEl.scrollLeft) / view.scale;
    const my = (e.clientY - rect.top + containerEl.scrollTop) / view.scale;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.2, Math.min(3, view.scale * factor));
    // 以滑鼠為中心縮放
    view.x = mx - (e.clientX - rect.left + containerEl.scrollLeft) / newScale;
    view.y = my - (e.clientY - rect.top + containerEl.scrollTop) / newScale;
    view.scale = newScale;
    canvas.style.transform = `scale(${view.scale})`;
    canvas.style.transformOrigin = '0 0';
  }

  function getWorldPos(e){
    const rect = containerEl.getBoundingClientRect();
    const sx = e.clientX - rect.left + containerEl.scrollLeft;
    const sy = e.clientY - rect.top + containerEl.scrollTop;
    return { x: sx / view.scale, y: sy / view.scale };
  }

  function pickCity(worldPos){
    let closest = null, minDist = 40;
    for(const c of state.cities){
      const p = nodePositions.get(c.id);
      if(!p) continue;
      const d = Math.hypot(p.x - worldPos.x, p.y - worldPos.y);
      if(d < minDist){ minDist = d; closest = c; }
    }
    return closest;
  }

  function onPointerDown(e){
    const worldPos = getWorldPos(e);

    if(editRouteMode){
      // 路線編輯模式：拖曳建線
      const city = pickCity(worldPos);
      if(city){
        routeDragFrom = city;
        routeDragEnd = worldPos;
        return;
      }
    }

    // 檢查是否點到節點（拖曳節點）
    const city = pickCity(worldPos);
    if(city){
      nodeDragging = { cityId: city.id, offsetX: worldPos.x - nodePositions.get(city.id).x, offsetY: worldPos.y - nodePositions.get(city.id).y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    // 拖曳畫布
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, sx: containerEl.scrollLeft, sy: containerEl.scrollTop };
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e){
    const worldPos = getWorldPos(e);

    // 更新 hover 狀態
    const city = pickCity(worldPos);
    hoveredCityId = city ? city.id : null;

    if(nodeDragging){
      const p = nodePositions.get(nodeDragging.cityId);
      if(p){
        p.x = worldPos.x - nodeDragging.offsetX;
        p.y = worldPos.y - nodeDragging.offsetY;
        render();
      }
      return;
    }

    if(routeDragFrom){
      routeDragEnd = worldPos;
      render();
      return;
    }

    if(dragging){
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      containerEl.scrollLeft = dragStart.sx - dx;
      containerEl.scrollTop = dragStart.sy - dy;
      return;
    }

    // 一般 hover 也重繪（顯示 hover 效果）
    if(state.cities.length > 0) render();
  }

  function onPointerUp(e){
    if(nodeDragging){
      nodeDragging = null;
      applyCursor();
      // 拖曳節點後重新佈局旗標可不清除（位置已手動調整）
      return;
    }

    if(routeDragFrom){
      const worldPos = getWorldPos(e);
      const targetCity = pickCity(worldPos);
      if(targetCity && targetCity.id !== routeDragFrom.id){
        const existing = window.SLG.findRoute(routeDragFrom.id, targetCity.id);
        if(existing){
          // 已存在 → 刪除
          window.SLG.removeRoute(existing.id);
        } else {
          // 建立新路線
          window.SLG.addRoute(routeDragFrom.id, targetCity.id);
        }
        if(window.SLG.saveState) window.SLG.saveState();
        if(window.SLG.RouteManager) window.SLG.RouteManager.render();
      }
      routeDragFrom = null;
      routeDragEnd = null;
      render();
      return;
    }

    if(dragging){
      dragging = false;
      applyCursor();
    }
  }

  function computeLayout(){
    const cities = state.cities;
    if(cities.length === 0){
      nodePositions.clear();
      return;
    }

    // 若已有位置且非強制重算，跳過
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

    // 路線（無向）
    const edges = [];
    for(const r of (state.routes || [])){
      if(nodePositions.has(r.cityAId) && nodePositions.has(r.cityBId)){
        edges.push([r.cityAId, r.cityBId]);
      }
    }

    const iterations = N > 60 ? 150 : 300;
    let temp = W / 10;
    const cool = temp / (iterations + 1);

    for(let iter = 0; iter < iterations; iter++){
      const disp = new Map();
      cities.forEach(c => disp.set(c.id, { x: 0, y: 0 }));

      // 斥力
      for(let i = 0; i < N; i++){
        for(let j = i + 1; j < N; j++){
          const a = nodePositions.get(cities[i].id);
          const b = nodePositions.get(cities[j].id);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if(d < 0.01){ dx = (Math.random()-0.5)*10; dy = (Math.random()-0.5)*10; d = Math.hypot(dx, dy) || 0.01; }
          const force = (k * k) / d;
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          const da = disp.get(cities[i].id);
          const db = disp.get(cities[j].id);
          da.x += fx; da.y += fy;
          db.x -= fx; db.y -= fy;
        }
      }

      // 引力（有路線）
      for(const [aId, bId] of edges){
        const pa = nodePositions.get(aId), pb = nodePositions.get(bId);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if(d < 0.01) d = 0.01;
        const force = (d * d) / k * 1.2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        const da = disp.get(aId), db = disp.get(bId);
        da.x -= fx; da.y -= fy;
        db.x += fx; db.y += fy;
      }

      // 更新位置
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
    for(const p of nodePositions.values()){
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const availW = containerEl.clientWidth || 600;
    const availH = containerEl.clientHeight || 400;
    const scale = Math.min(availW / (contentW + 200), availH / (contentH + 200), 1.5);
    view.scale = scale;
    view.x = minX - 100;
    view.y = minY - 100;
  }

  function applyView(){
    if(!canvas) return;
    canvas.style.transform = `scale(${view.scale})`;
    canvas.style.transformOrigin = '0 0';
    canvas.style.width = CANVAS_W + 'px';
    canvas.style.height = CANVAS_H + 'px';
  }

  function render(){
    if(!canvas || !ctx) return;
    computeLayout();

    if(layoutDirty === false && nodePositions.size > 0 && view.scale === 1 && view.x === 0 && view.y === 0){
      fitView();
      applyView();
    }

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // 深色底
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 畫戰區背景（淡色）
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
      const r = 20;
      const x = minX - pad, y = minY - pad, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
      ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
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

    // 畫路線（灰色）
    for(const r of (state.routes || [])){
      const a = nodePositions.get(r.cityAId);
      const b = nodePositions.get(r.cityBId);
      if(!a || !b) continue;
      ctx.strokeStyle = 'rgba(160,160,160,0.45)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // 畫路線拖曳預覽
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

    // 畫城池節點
    for(const c of state.cities){
      const p = nodePositions.get(c.id);
      if(!p) continue;
      const isHovered = (hoveredCityId === c.id);
      const isDragFrom = routeDragFrom && routeDragFrom.id === c.id;

      // 光環
      if(isHovered || isDragFrom){
        ctx.beginPath();
        ctx.arc(p.x, p.y, 42, 0, Math.PI * 2);
        ctx.strokeStyle = isDragFrom ? 'rgba(68,170,255,1)' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = isDragFrom ? 4 : 3;
        ctx.stroke();
      }

      // 圓底
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

      // 盟徽
      const alliance = state.alliances.find(a => a.id === c.allianceId);
      const icon = (alliance && alliance.icon) ? alliance.icon : '🏰';
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, p.x, p.y);

      // 等級（右上角）
      const level = c.level || 1;
      ctx.beginPath();
      ctx.arc(p.x + 22, p.y - 22, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc00';
      ctx.fill();
      ctx.font = 'bold 11px sans-serif';
      ctx.fillStyle = '#000';
      ctx.fillText(level, p.x + 22, p.y - 22);

      // 城池名稱（下方）
      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.textBaseline = 'top';
      ctx.fillText(c.name, p.x, p.y + 38);

      // 首都皇冠
      if(c.isCapital){
        ctx.font = '16px sans-serif';
        ctx.fillText('👑', p.x - 28, p.y - 32);
      }
    }
  }

  function activate(){
    if(!containerEl) return;
    if(state.cities.length > 0){
      computeLayout();
      if(nodePositions.size > 0 && view.scale === 1 && view.x === 0 && view.y === 0){
        fitView();
        applyView();
      }
    }
    applyCursor();
    render();
  }

  function reset(){
    nodePositions.clear();
    layoutDirty = true;
    view = { x: 0, y: 0, scale: 1 };
    applyView();
  }

  return { init, render, activate, reset, fitView };
})();

/* ============================================================
   更新房間編輯按鈕 / 房間沙盤操作
   ============================================================ */
function updateRoomEditButton(){
  const btn = document.getElementById('btnRequestRoomEdit');
  if(!btn) return;

  if(!window.SLG.isInRoom() || !state.auth.signedIn){
    btn.style.display = 'none';
    return;
  }
  if(window.SLG.canEditRoomData()){
    btn.style.display = 'none';
    return;
  }
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
  if(!window.SLG.isInRoom()){
    row.style.display = 'none';
    return;
  }
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
    if(state.auth.signedIn){
      meName.textContent = state.auth.displayName || state.auth.username || '—';
    } else {
      meName.textContent = '未登入';
    }
  }
  if(meTime){
    const ts = state.mySandbox.updatedAt;
    meTime.textContent = ts ? `最後更新：${timeAgo(ts)}` : '尚未同步';
  }
  if(meStats){
    const c = state.cities.length;
    const a = state.alliances.length;
    const z = state.zones.length;
    const r = state.routes.length;
    meStats.innerHTML = `🏰 城池 <b>${c}</b> · 🤝 同盟 <b>${a}</b> · 🗺️ 戰區 <b>${z}</b> · 🛣️ 路線 <b>${r}</b>`;
  }

  const tbody = document.getElementById('sandboxTableBody');
  if(tbody){
    const list = Object.entries(state.sandboxesList || {})
      .map(([uid, sb]) => ({ uid, ...sb }))
      .filter(sb => {
        const isSelf = sb.uid === state.auth.accountUid;
        if(isSelf) return true;
        const role = sb.role || 'member';
        if(!window.SLG.canViewSandboxOf(sb.uid, role)) return false;
        return true;
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
  const roomTbody = document.getElementById('roomSandboxTableBody');
  if(roomCard){
    if(window.SLG.canViewRoomSandboxes()){
      roomCard.style.display = '';
      if(roomTbody && (!state.roomSnapshotsList || state.roomSnapshotsList.length === 0)){
        roomTbody.innerHTML = '<tr><td colspan="6" class="sandbox-empty">尚無房間沙盤資料</td></tr>';
      }
    } else {
      roomCard.style.display = 'none';
    }
  }

  const rescueCard = document.getElementById('rescueCard');
  if(rescueCard){
    rescueCard.style.display = window.SLG.canUseRescueTool() ? '' : 'none';
  }

  if(tbody){
    tbody.querySelectorAll('[data-action="load-sandbox"]').forEach(btn => {
      btn.addEventListener('click', function(){
        const uid = this.dataset.uid;
        if(typeof window.SLG.loadSandboxFromList === 'function'){
          window.SLG.loadSandboxFromList(uid);
        }
      });
    });
  }
}

/* ============================================================
   同盟表單輔助
   ============================================================ */
function updateAllianceAvgPowerPreview(){
  const mc = parseFloat(document.getElementById('allyMemberCount').value) || 0;
  const tp = parseFloat(document.getElementById('allyTotalPower').value) || 0;
  const el = document.getElementById('allyAvgPower');
  if(el){
    el.value = mc > 0 ? (tp / mc).toLocaleString(undefined,{maximumFractionDigits:2}) : '0';
  }
}

function resetAllianceForm(){
  state.editingAllianceId = null;
  document.getElementById('allyFormTitle').textContent = '➕ 新增同盟';
  document.getElementById('allyName').value = '';
  document.getElementById('allyIcon').value = '';
  document.getElementById('allySide').value = 'ally';
  document.getElementById('allyMemberCount').value = 100;
  document.getElementById('allyTotalPower').value = 20000;
  document.getElementById('btnCancelAllianceEdit').style.display = 'none';
  document.getElementById('btnSaveAlliance').textContent = '💾 儲存';
  updateAllianceAvgPowerPreview();
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
  document.getElementById('allyTotalPower').value = a.totalPower || 20000;
  document.getElementById('btnCancelAllianceEdit').style.display = 'inline-flex';
  document.getElementById('btnSaveAlliance').textContent = '💾 更新';
  updateAllianceAvgPowerPreview();
  R.renderAlliances();
}

/* ============================================================
   城池表單
   ============================================================ */
let editingCityId = null;

function updateAutoCalcFields(){
  const t = parseFloat(document.getElementById('cm_totalTeams').value)||0;
  const p = parseFloat(document.getElementById('cm_totalPower').value)||0;
  const el = document.getElementById('cm_avgPower');
  if(!el) return;
  if(t > 0 && p > 0){
    el.value = Math.floor(p/t);
  } else {
    el.value = '—';
  }
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
    document.getElementById('cm_memberCount').value = '';
    document.getElementById('cm_totalPower').value = '';
    document.getElementById('cm_totalTeams').value = '';
    document.getElementById('cm_cooldownMin').value = 5;
    document.getElementById('cm_wallMin').value = 30;
    document.getElementById('cm_defStartTime').value = '19:00';
    document.getElementById('cm_isCapital').checked = false;
    if(state.zones.length > 0) zoneSel.value = state.zones[0].id;
  } else {
    document.getElementById('cm_name').value = city.name;
    document.getElementById('cm_zone').value = city.zoneId || '';
    document.getElementById('cm_alliance').value = city.allianceId || '';
    document.getElementById('cm_side').value = city.side;
    document.getElementById('cm_level').value = city.level || 1;
    document.getElementById('cm_memberCount').value = city.memberCount || '';
    document.getElementById('cm_totalPower').value = city.totalPower || '';
    document.getElementById('cm_totalTeams').value = city.totalTeams || '';
    document.getElementById('cm_cooldownMin').value = city.cooldownMin;
    document.getElementById('cm_wallMin').value = city.wallMin;
    document.getElementById('cm_defStartTime').value = city.defStartTime || '19:00';
    document.getElementById('cm_isCapital').checked = !!city.isCapital;
  }
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
  const memberCount = parseFloat(document.getElementById('cm_memberCount').value) || 0;
  const totalPower = parseFloat(document.getElementById('cm_totalPower').value) || 0;
  const totalTeams = parseFloat(document.getElementById('cm_totalTeams').value) || 0;
  const cooldownMin = parseFloat(document.getElementById('cm_cooldownMin').value) || 0;
  const wallMin = parseFloat(document.getElementById('cm_wallMin').value) || 0;
  const defStartTime = document.getElementById('cm_defStartTime').value || '19:00';
  const isCapital = document.getElementById('cm_isCapital').checked;

  const existingCity = editingCityId ? state.cities.find(c => c.id === editingCityId) : null;
  const attackTargets = existingCity ? (existingCity.attackTargets || []) : [];
  const defendTargets = existingCity ? (existingCity.defendTargets || []) : [];

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
  window.SLG.upsertEntity('city', entity);
  closeCityModal();
  R.renderCities();
  if(window.SLG.CityManager) window.SLG.CityManager.render();
  if(window.SLG.WarManager) window.SLG.WarManager.render();
  if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  if(window.SLG.RouteManager) window.SLG.RouteManager.render();
  if(window.SLG.GameMap) window.SLG.GameMap.render();
  window.SLG.saveState();
}

/* ============================================================
   DEPLOY 便捷
   ============================================================ */
function deployRender(){ DEPLOY.render(); }

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  viz,
  R,
  renderAll: R.renderAll,
  renderChat: R.renderChat,
  renderChatBadge: R.renderChatBadge,
  renderCities: R.renderCities,
  renderZones: R.renderZones,
  renderAlliances: R.renderAlliances,
  renderMatrix: R.renderMatrix,
  renderNarrative: R.renderNarrative,
  renderDebug: R.renderDebug,
  updateRoomEditButton,
  updateRoomSandboxActions,
  renderSandboxData,

  DYN,
  DEPLOY,
  deployRender,
  updateAllianceAvgPowerPreview,
  resetAllianceForm,
  startEditAlliance,
  updateAutoCalcFields,
  openCityModal,
  closeCityModal,
  saveCityFromModal,

  CityManager,
  WarManager,
  DeployInstr,
  RouteManager,
  GameMap,
});

})();