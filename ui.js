/* ============================================================================
 * ui.js — 所有渲染（viz / R / DYN / DEPLOY）+ 城池/同盟表單 + 房間編輯按鈕
 * v8.1 P6
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
      tbody.innerHTML = '<tr><td colspan="6" class="ally-table-empty">尚無同盟資料</td></tr>';
      renderMatrix();
      return;
    }
    tbody.innerHTML = state.alliances.map(a => {
      const cap = state.cities.find(c => c.allianceId === a.id && c.isCapital);
      const tagCls = a.side === 'self' ? 'tag-self' : (a.side === 'ally' ? 'tag-ally' : 'tag-enemy');
      const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
      const avg = getAllianceAvgPowerLocal(a);
      const isEditing = state.editingAllianceId === a.id;
      const icon = a.icon || '';
      return `<tr${isEditing ? ' style="background:rgba(255,204,0,.08);"' : ''}>
        <td class="col-name"><span class="alliance-tag ${tagCls}"></span>${icon ? `<span class="alliance-icon">${icon}</span>` : ''}${esc(a.name)}${isEditing ? '<span class="editing-badge">編輯中</span>' : ''}${cap ? ` <span style="color:var(--neon-yellow);font-size:10px;">👑 ${esc(cap.name)}</span>` : ''}</td>
        <td><span class="chip ${chipCls}">${allianceSideLabel(a.side)}</span></td>
        <td class="col-num">${(a.memberCount||0).toLocaleString()}</td>
        <td class="col-num">${(a.totalPower||0).toLocaleString()}</td>
        <td class="col-num" style="color:var(--neon-green);font-weight:700;">${avg.toLocaleString(undefined,{maximumFractionDigits:2})}</td>
        <td class="col-actions">
          <button class="btn btn-primary btn-sm" data-action="edit-alliance" data-id="${a.id}">✏️ 編輯</button>
          <button class="btn btn-danger btn-sm" data-action="del-alliance" data-id="${a.id}">🗑️ 刪除</button>
        </td>
      </tr>`;
    }).join('');
    renderMatrix();
    if(hasTogglePerm() && Auth()){
      document.querySelectorAll('[data-action="edit-alliance"],[data-action="del-alliance"]').forEach(b => {
        window.SLG.togglePerm(b, Auth().canEditData(), '需要編輯資料權限');
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
      document.querySelectorAll('[data-action="del-zone"]').forEach(b => {
        window.SLG.togglePerm(b, Auth().canEditData(), '需要編輯資料權限');
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
        html += `<div class="flex-row" style="justify-content:space-between;margin-bottom:6px;"><strong style="font-size:13px;">${c.isCapital ? '👑 ' : ''}${esc(c.name)}</strong><span class="chip ${sideClass(c.side)}">${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${sideLabel(c.side)}</span></div>`;
        if(alliance){
          html += `<div class="text-dim" style="margin-bottom:4px;">同盟：${allianceIcon ? `<span class="alliance-icon">${allianceIcon}</span>` : ''}${esc(alliance.name)}</div>`;
        }
        html += `<div class="flex-row" style="margin-bottom:4px;"><span class="chip time">🕐 ${esc(defStart)} – ${esc(defEnd)}</span></div>`;
        html += `<div class="flex-row" style="font-size:11px;color:var(--text-secondary);gap:12px;"><span>總戰力 ${(c.totalPower||0).toLocaleString()}</span><span>總隊數 ${c.totalTeams}</span><span>均戰 ${c.avgPower}</span></div>`;
        if(alloc.over){
          html += `<div class="flex-row" style="font-size:11px;margin-top:4px;"><span class="text-warn">⚠️ 戰前派兵合計 ${alloc.allocated} 隊 ＞ 總隊數 ${alloc.totalTeams} 隊（推演時將按比例縮減）</span></div>`;
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
      document.querySelectorAll('[data-action="edit-city"],[data-action="del-city"]').forEach(b => {
        window.SLG.togglePerm(b, Auth().canEditData(), '需要編輯資料權限');
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
   ★ P6：房間編輯按鈕狀態渲染
   ============================================================ */
function updateRoomEditButton(){
  const btn = document.getElementById('btnRequestRoomEdit');
  if(!btn) return;

  /* 只在房間模式且已登入非訪客時顯示 */
  if(!window.SLG.isInRoom() || !state.auth.signedIn || state.auth.isGuest){
    btn.style.display = 'none';
    return;
  }

  /* 房主 / 管理員 / 超管 → 不顯示按鈕（不需申請） */
  if(window.SLG.canEditRoomData()){
    btn.style.display = 'none';
    return;
  }

  /* 顯示按鈕 */
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

/* ============================================================
   ★ 3-1 段結束：暴露 viz + R + updateRoomEditButton
   ★ 注意：這裡「不」關閉 IIFE，3-2 段會接續
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
});

/* ⚠️ 不要在此行下方加 })(); —— 3-2 段會接續 */
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
        title.textContent = `${cIcon ? cIcon + ' ' : ''}${city.isCapital ? '👑 ' : ''}${city.name}（${sideLabel(city.side)}）`;
        const atkList = (city.attackTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}%` : '';
        }).filter(Boolean).join('、') || '無';
        const defList = (city.defendTargets||[]).filter(t => (t.preWarPercent||0)>0).map(t => {
          const tgt = state.cities.find(cc => cc.id === t.cityId);
          return tgt ? `${tgt.name} ${t.preWarPercent}%` : '';
        }).filter(Boolean).join('、') || '無';
        body.innerHTML = `
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
        if(Auth() && !Auth().canEditData()) return;
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
        if(Auth() && !Auth().canEditData()) return;
        if(typeof window.SLG.openCityModal === 'function') window.SLG.openCityModal(this.dataset.deployEdit);
      });
      if(hasTogglePerm() && Auth()){
        window.SLG.togglePerm(btn, Auth().canEditData(), '需要編輯資料權限');
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
   同盟表單輔助
   ============================================================ */
function updateAllianceAvgPowerPreview(){
  const mc = parseFloat(document.getElementById('allyMemberCount').value) || 0;
  const tp = parseFloat(document.getElementById('allyTotalPower').value) || 0;
  document.getElementById('allyAvgPower').value =
    mc > 0 ? (tp / mc).toLocaleString(undefined,{maximumFractionDigits:2}) : '0';
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

function updateSectionLabels(){
  const mySide = document.getElementById('cm_side').value;
  const atkSides = (ATTACK_RULES[mySide] || []).map(sideLabel).join(' / ');
  const defSides = (DEFEND_RULES[mySide] || []).map(sideLabel).join(' / ');
  document.getElementById('attackSectionLabel').textContent = `⚔️ 選擇進攻的城池（限 ${atkSides || '無'}）`;
  document.getElementById('defendSectionLabel').textContent = `🛡️ 選擇協防的城池${defSides ? `（限 ${defSides}）` : '（不可協防）'}`;
}
function updateAutoCalcFields(){
  const t = parseFloat(document.getElementById('cm_totalTeams').value)||0;
  const p = parseFloat(document.getElementById('cm_totalPower').value)||0;
  document.getElementById('cm_avgPower').value = t > 0 ? Math.floor(p/t) : 0;
}
function updateAllocPanel(){
  const total = parseFloat(document.getElementById('cm_totalTeams').value) || 0;
  let atkSum = 0, defSum = 0;
  document.querySelectorAll('.atk-cb:checked').forEach(cb => {
    const sel = document.querySelector(`.atk-pre[data-city="${cb.dataset.city}"]`);
    atkSum += Math.floor(total * (parseFloat(sel.value)||0) / 100);
  });
  document.querySelectorAll('.def-cb:checked').forEach(cb => {
    const sel = document.querySelector(`.def-pre[data-city="${cb.dataset.city}"]`);
    defSum += Math.floor(total * (parseFloat(sel.value)||0) / 100);
  });
  const allocated = atkSum + defSum, reserve = total - allocated;
  document.getElementById('cm_allocTotal').textContent = total;
  document.getElementById('cm_allocAtk').textContent = atkSum;
  document.getElementById('cm_allocDef').textContent = defSum;
  const reserveEl = document.getElementById('cm_allocReserve');
  reserveEl.textContent = reserve;
  reserveEl.style.color = reserve < 0 ? 'var(--neon-red)' : 'var(--neon-green)';
  document.getElementById('cm_allocWarning').style.display = reserve < 0 ? 'block' : 'none';
}
function renderTargetSelectors(attackTargets, defendTargets){
  const zoneId = document.getElementById('cm_zone').value;
  const mySide = document.getElementById('cm_side').value;
  const attackEl = document.getElementById('cm_attackList');
  const defendEl = document.getElementById('cm_defendList');
  const pool = state.cities.filter(c => c.id !== editingCityId);
  const sameZone = zoneId ? pool.filter(c => c.zoneId === zoneId) : pool;
  const attackableSides = ATTACK_RULES[mySide] || [];
  const attackable = sameZone.filter(c => attackableSides.includes(c.side));
  const defendableSides = DEFEND_RULES[mySide] || [];
  const defendable = sameZone.filter(c => defendableSides.includes(c.side));
  const aMap = {}; (attackTargets || []).forEach(t => aMap[t.cityId] = t);
  const dMap = {}; (defendTargets || []).forEach(t => dMap[t.cityId] = t);

  const buildOptions = (selected) =>
    PERCENT_OPTIONS.map(p => `<option value="${p}" ${p===selected?'selected':''}>${p}%</option>`).join('');

  const myCityForAI = {
    avgPower: parseFloat(document.getElementById('cm_avgPower').value) || 1,
    totalTeams: parseFloat(document.getElementById('cm_totalTeams').value) || 0,
    side: document.getElementById('cm_side').value,
  };

  if(attackable.length === 0){
    attackEl.innerHTML = `<div class="empty-hint">無可進攻目標</div>`;
  } else {
    attackEl.innerHTML = attackable.map(c => {
      const cfg = aMap[c.id] || {};
      const checked = cfg.cityId !== undefined;
      const pre = cfg.preWarPercent !== undefined ? cfg.preWarPercent : 50;
      const post = cfg.postRevivePercent !== undefined ? cfg.postRevivePercent : 50;
      const pr = cfg.priority !== undefined ? cfg.priority : 1;
      const defStart = c.defStartTime || '19:00';
      const aiSuggest = AI.suggestForTarget(myCityForAI, c, true);
      const aiCls = (aiSuggest === 100 && myCityForAI.avgPower < c.avgPower) ? 'ai-hint warn' : 'ai-hint';
      const a = state.alliances.find(al => al.id === c.allianceId);
      const icon = (a && a.icon) ? a.icon + ' ' : '';
      return `<div class="target-item ${checked ? 'checked' : ''}" data-city="${c.id}">
        <input type="checkbox" class="atk-cb" data-city="${c.id}" ${checked ? 'checked' : ''}>
        <span class="tname">${icon}${c.isCapital ? '👑 ' : ''}${esc(c.name)}</span>
        <span class="tside ${sideClass(c.side)}">${sideLabel(c.side)}</span>
        <span class="tside time">${esc(defStart)}</span>
        <span class="${aiCls}">🤖 ${aiSuggest}%</span>
        <div class="target-config-row">
          <span class="cfg-label">戰前</span>
          <select class="atk-pre" data-city="${c.id}" ${checked ? '' : 'disabled'}>${buildOptions(pre)}</select>
          <span class="cfg-label">復活</span>
          <select class="atk-post" data-city="${c.id}" ${checked ? '' : 'disabled'}>${buildOptions(post)}</select>
          <span class="cfg-label">順序</span>
          <input type="number" class="atk-priority" data-city="${c.id}" value="${pr}" min="1" max="99" step="1" ${checked ? '' : 'disabled'}>
        </div>
      </div>`;
    }).join('');
  }

  if(defendable.length === 0){
    defendEl.innerHTML = defendableSides.length === 0
      ? '<div class="empty-hint">此陣營不可協防任何城池</div>'
      : `<div class="empty-hint">無可協防目標</div>`;
  } else {
    defendEl.innerHTML = defendable.map(c => {
      const cfg = dMap[c.id] || {};
      const checked = cfg.cityId !== undefined;
      const pre = cfg.preWarPercent !== undefined ? cfg.preWarPercent : 50;
      const post = cfg.postRevivePercent !== undefined ? cfg.postRevivePercent : 50;
      const pr = cfg.priority !== undefined ? cfg.priority : 1;
      const defStart = c.defStartTime || '19:00';
      const aiSuggest = AI.suggestForTarget(myCityForAI, c, false);
      const a = state.alliances.find(al => al.id === c.allianceId);
      const icon = (a && a.icon) ? a.icon + ' ' : '';
      return `<div class="target-item ${checked ? 'checked' : ''}" data-city="${c.id}">
        <input type="checkbox" class="def-cb" data-city="${c.id}" ${checked ? 'checked' : ''}>
        <span class="tname">${icon}${c.isCapital ? '👑 ' : ''}${esc(c.name)}</span>
        <span class="tside ${sideClass(c.side)}">${sideLabel(c.side)}</span>
        <span class="tside time">${esc(defStart)}</span>
        <span class="ai-hint">🤖 ${aiSuggest}%</span>
        <div class="target-config-row">
          <span class="cfg-label">戰前</span>
          <select class="def-pre" data-city="${c.id}" ${checked ? '' : 'disabled'}>${buildOptions(pre)}</select>
          <span class="cfg-label">復活</span>
          <select class="def-post" data-city="${c.id}" ${checked ? '' : 'disabled'}>${buildOptions(post)}</select>
          <span class="cfg-label">順序</span>
          <input type="number" class="def-priority" data-city="${c.id}" value="${pr}" min="1" max="99" step="1" ${checked ? '' : 'disabled'}>
        </div>
      </div>`;
    }).join('');
  }

  const bindToggle = (cbSelector, itemSelector, selects, priorityEl) => {
    document.querySelectorAll(cbSelector).forEach(cb => cb.addEventListener('change', function(){
      const item = this.closest(itemSelector);
      item.classList.toggle('checked', this.checked);
      item.querySelectorAll(selects).forEach(s => s.disabled = !this.checked);
      item.querySelector(priorityEl).disabled = !this.checked;
      updateAllocPanel();
    }));
  };
  bindToggle('.atk-cb', '.target-item', '.atk-pre,.atk-post', '.atk-priority');
  bindToggle('.def-cb', '.target-item', '.def-pre,.def-post', '.def-priority');
  document.querySelectorAll('.atk-pre,.def-pre').forEach(el => el.addEventListener('change', updateAllocPanel));
  updateAllocPanel();
}
function collectCurrentTargets(){
  const atk = [], def = [];
  document.querySelectorAll('.atk-cb:checked').forEach(cb => {
    const cityId = cb.dataset.city;
    const pre = parseFloat(document.querySelector(`.atk-pre[data-city="${cityId}"]`).value) || 0;
    const post = parseFloat(document.querySelector(`.atk-post[data-city="${cityId}"]`).value) || 0;
    const pr = parseInt(document.querySelector(`.atk-priority[data-city="${cityId}"]`).value) || 1;
    if(pre > 0) atk.push({ cityId, preWarPercent: pre, postRevivePercent: post, priority: pr });
  });
  document.querySelectorAll('.def-cb:checked').forEach(cb => {
    const cityId = cb.dataset.city;
    const pre = parseFloat(document.querySelector(`.def-pre[data-city="${cityId}"]`).value) || 0;
    const post = parseFloat(document.querySelector(`.def-post[data-city="${cityId}"]`).value) || 0;
    const pr = parseInt(document.querySelector(`.def-priority[data-city="${cityId}"]`).value) || 1;
    if(pre > 0) def.push({ cityId, preWarPercent: pre, postRevivePercent: post, priority: pr });
  });
  return { attackTargets: atk, defendTargets: def };
}
function applyAISuggestion(){
  const currentCity = {
    avgPower: parseFloat(document.getElementById('cm_avgPower').value) || 1,
    totalTeams: parseFloat(document.getElementById('cm_totalTeams').value) || 0,
    attackTargets: [],
    defendTargets: [],
  };
  if (!currentCity.totalTeams){ alert('請先輸入總隊數'); return; }
  const currentAtk = [], currentDef = [];
  document.querySelectorAll('.atk-cb:checked').forEach(cb => {
    const cityId = cb.dataset.city;
    const pre = parseFloat(document.querySelector(`.atk-pre[data-city="${cityId}"]`).value) || 0;
    const pr = parseInt(document.querySelector(`.atk-priority[data-city="${cityId}"]`).value) || 1;
    if (pre > 0) currentAtk.push({ cityId, priority: pr });
  });
  document.querySelectorAll('.def-cb:checked').forEach(cb => {
    const cityId = cb.dataset.city;
    const pre = parseFloat(document.querySelector(`.def-pre[data-city="${cityId}"]`).value) || 0;
    const pr = parseInt(document.querySelector(`.def-priority[data-city="${cityId}"]`).value) || 1;
    if (pre > 0) currentDef.push({ cityId, priority: pr });
  });
  if (currentAtk.length === 0 && currentDef.length === 0){
    alert('請先勾選至少一個進攻或協防目標'); return;
  }
  currentCity.attackTargets = currentAtk;
  currentCity.defendTargets = currentDef;
  const suggestion = AI.suggestForCity(currentCity, state.cities);
  for (const s of suggestion.atk){
    const preEl = document.querySelector(`.atk-pre[data-city="${s.cityId}"]`);
    const postEl = document.querySelector(`.atk-post[data-city="${s.cityId}"]`);
    if (preEl) preEl.value = s.preWarPercent;
    if (postEl) postEl.value = s.postRevivePercent;
  }
  for (const s of suggestion.def){
    const preEl = document.querySelector(`.def-pre[data-city="${s.cityId}"]`);
    const postEl = document.querySelector(`.def-post[data-city="${s.cityId}"]`);
    if (preEl) preEl.value = s.preWarPercent;
    if (postEl) postEl.value = s.postRevivePercent;
  }
  updateAllocPanel();
  logSystem('🤖 AI 佈兵建議已套用');
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
  zoneSel.innerHTML = state.zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('')
    || '<option value="">（尚未建立戰區）</option>';

  const allianceSel = document.getElementById('cm_alliance');
  allianceSel.innerHTML = '<option value="">（不指定）</option>' +
    state.alliances.map(a =>
      `<option value="${a.id}">${a.icon ? a.icon + ' ' : ''}${esc(a.name)}（${allianceSideLabel(a.side)}）</option>`
    ).join('');

  if(isNew){
    document.getElementById('cm_name').value = '';
    document.getElementById('cm_side').value = 'self';
    document.getElementById('cm_totalPower').value = 100000;
    document.getElementById('cm_totalTeams').value = 100;
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
    document.getElementById('cm_totalPower').value = city.totalPower;
    document.getElementById('cm_totalTeams').value = city.totalTeams;
    document.getElementById('cm_cooldownMin').value = city.cooldownMin;
    document.getElementById('cm_wallMin').value = city.wallMin;
    document.getElementById('cm_defStartTime').value = city.defStartTime || '19:00';
    document.getElementById('cm_isCapital').checked = !!city.isCapital;
  }
  updateAutoCalcFields(); updateSectionLabels();
  renderTargetSelectors(city ? (city.attackTargets || []) : [], city ? (city.defendTargets || []) : []);
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
  if (document.getElementById('tab-deploy').classList.contains('active')) DEPLOY.render();
}
function saveCityFromModal(){
  const name = document.getElementById('cm_name').value.trim();
  if(!name){ alert('請輸入城池名稱'); return; }
  const zoneId = document.getElementById('cm_zone').value;
  if(!zoneId){ alert('請先建立並選擇戰區'); return; }
  const allianceId = document.getElementById('cm_alliance').value;
  const side = document.getElementById('cm_side').value;
  const totalPower = parseFloat(document.getElementById('cm_totalPower').value) || 0;
  const totalTeams = parseFloat(document.getElementById('cm_totalTeams').value) || 0;
  const cooldownMin = parseFloat(document.getElementById('cm_cooldownMin').value) || 0;
  const wallMin = parseFloat(document.getElementById('cm_wallMin').value) || 0;
  const defStartTime = document.getElementById('cm_defStartTime').value || '19:00';
  const isCapital = document.getElementById('cm_isCapital').checked;
  const { attackTargets, defendTargets } = collectCurrentTargets();
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
    id, name, zoneId, allianceId, side, totalPower, totalTeams, avgPower,
    cooldownMin, wallMin, defStartTime, isCapital, attackTargets, defendTargets
  };
  window.SLG.upsertEntity('city', entity);
  closeCityModal();
  R.renderCities();
  window.SLG.saveState();
}

/* ============================================================
   DEPLOY 便捷函式（給 data.js 呼叫）
   ============================================================ */
function deployRender(){ DEPLOY.render(); }

/* ============================================================
   ★ 3-2 段結尾：暴露 DYN + DEPLOY + 表單函式
   ★ 並關閉 IIFE
   ============================================================ */
Object.assign(window.SLG, {
  DYN,
  DEPLOY,
  deployRender,
  updateAllianceAvgPowerPreview,
  resetAllianceForm,
  startEditAlliance,
  updateSectionLabels,
  updateAutoCalcFields,
  updateAllocPanel,
  renderTargetSelectors,
  collectCurrentTargets,
  applyAISuggestion,
  openCityModal,
  closeCityModal,
  saveCityFromModal,
});

})();