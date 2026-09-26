/* ============================================================================
 * ui.js — 所有渲染（viz / R / DYN / DEPLOY / CityManager / WarManager / DeployInstr / RouteManager / GameMap）
 * v8.5.1
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
   viz — 態勢圖（v8.5.1：加 touch 縮放）
   ============================================================ */
const viz = (() => {
  const NODE_RADIUS = 14;
  let cvStatic, ctxStatic, cvLive, ctxLive, containerEl;
  let layout = { nodes:new Map(), zones:[], bounds:{w:0, h:0} };
  let snapshots = new Map();
  let snapshotSecs = [];
  let currentSec = 0;

  /* v8.5.1：touch 縮放 */
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

    /* v8.5.1：touch 縮放（pinch） */
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
        if(Math.abs(newScale - vizScale) > 0.02){
          vizScale = newScale;
          applyVizScale();
        }
      }
    }, { passive: false });

    containerEl.addEventListener('touchend', (e) => {
      if(e.touches.length < 2){
        vizPinchStartDist = 0;
      }
    }, { passive: true });

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

  function touchDist(t1, t2){
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

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
      baseCanvasW = 320; baseCanvasH = 240;
      return;
    }
    const scale = Math.min(1, w / Math.max(layout.bounds.w, 320));
    const wS = Math.max(320, layout.bounds.w * scale);
    const hS = Math.max(240, layout.bounds.h * scale);
    baseCanvasW = wS;
    baseCanvasH = hS;
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

  function renderGraphView(cities, conflictMap){
    /* 保留 v8.4 的 SVG 連線圖邏輯 */
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
        if ((pct||0) <= 0) return;
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
      label.textContent = c.name;
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
   /* ============================================================
   WarManager — 宣戰指示（v8.5.2：加標題、防守/協防區分、去重）
   ============================================================ */
const WarManager = (() => {
  function init(){
    const btn = document.getElementById('btnAddWarLine');
    if(btn) btn.addEventListener('click', () => addLine());
  }

  /* ============================================================
     取得所有宣戰指示
     類型依目標城陣營自動判定：
       - 敵方 → attack（進攻）
       - 本方 → defend（防守）
       - 同盟 → assist（協防）
     ============================================================ */
  function getAllWarLines(){
    const lines = [];
    for(const src of state.cities){
      /* 進攻 */
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
      /* 防守 or 協防 */
      for(const t of (src.defendTargets || [])){
        const tgt = state.cities.find(c => c.id === t.cityId);
        let type = 'defend';
        if(tgt){
          if(tgt.side === 'ally') type = 'assist';
          else if(tgt.side === 'self') type = 'defend';
        }
        lines.push({
          srcId: src.id,
          tgtId: t.cityId,
          type,
          preWarPercent: t.preWarPercent,
          postRevivePercent: t.postRevivePercent,
          priority: t.priority,
        });
      }
    }
    return lines;
  }

  /* ============================================================
     依類型取得可選目標城
     ============================================================ */
  function getTargetsForType(srcCityId, type){
    if(type === 'attack'){
      /* 進攻：敵方 / 共同敵方 / NPC */
      return state.cities.filter(c =>
        c.id !== srcCityId &&
        (c.side === 'enemy' || c.side === 'common_enemy' || c.side === 'npc')
      );
    }
    if(type === 'defend'){
      /* 防守：本方 */
      return state.cities.filter(c =>
        c.id !== srcCityId && c.side === 'self'
      );
    }
    if(type === 'assist'){
      /* 協防：同盟 */
      return state.cities.filter(c =>
        c.id !== srcCityId && c.side === 'ally'
      );
    }
    return [];
  }

  /* 檢查某方向是否已有宣戰 */
  function findWarLine(srcId, tgtId){
    const src = state.cities.find(c => c.id === srcId);
    if(!src) return null;
    for(const t of (src.attackTargets || [])){
      if(t.cityId === tgtId) return { type:'attack', route:t };
    }
    for(const t of (src.defendTargets || [])){
      if(t.cityId === tgtId) return { type:'defend', route:t };
    }
    return null;
  }

  /* 移除指定方向的所有宣戰 */
  function removeWarLine(srcId, tgtId){
    const src = state.cities.find(c => c.id === srcId);
    if(!src) return;
    if(src.attackTargets){
      src.attackTargets = src.attackTargets.filter(t => t.cityId !== tgtId);
    }
    if(src.defendTargets){
      src.defendTargets = src.defendTargets.filter(t => t.cityId !== tgtId);
    }
  }

  /* ============================================================
     新增一行宣戰指示（預設進攻）
     ============================================================ */
  function addLine(){
    if(state.cities.length < 2){ alert('至少需要 2 座城池'); return; }
    const src = state.cities[0];

    /* 找第一個可進攻的目標 */
    const targets = getTargetsForType(src.id, 'attack');
    if(targets.length === 0){
      alert('目前沒有可進攻的敵方城池');
      return;
    }
    const tgt = targets[0];

    if(findWarLine(src.id, tgt.id)){
      alert('此方向已有宣戰指示');
      return;
    }

    if(!src.attackTargets) src.attackTargets = [];
    src.attackTargets.push({
      cityId: tgt.id,
      preWarPercent: 50,
      postRevivePercent: 50,
      priority: 1,
    });

    markDirty(src.id);
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }

  /* ============================================================
     渲染
     ============================================================ */
  function render(){
    const el = document.getElementById('warList');
    if(!el) return;
    const lines = getAllWarLines();

    if(lines.length === 0){
      el.innerHTML = '<div class="text-dim" style="padding:10px;">尚無宣戰指示</div>';
      return;
    }

    /* 標題列 */
    const headerHtml = `<div class="war-header">
      <span>出兵城</span>
      <span>類型</span>
      <span>目標城</span>
      <span></span>
    </div>`;

    const linesHtml = lines.map((l, i) => {
      const src = state.cities.find(c => c.id === l.srcId);
      const tgt = state.cities.find(c => c.id === l.tgtId);
      const valid = src && tgt;
      const invalidCls = valid ? '' : 'invalid';
      const typeCls = l.type;   /* attack / defend / assist */

      /* 出兵城下拉（所有城池） */
      const srcOpts = state.cities.map(c =>
        `<option value="${c.id}" ${c.id === l.srcId ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');

      /* 類型下拉 */
      const typeOpts = `
        <option value="attack" ${l.type === 'attack' ? 'selected' : ''}>⚔️ 進攻</option>
        <option value="defend" ${l.type === 'defend' ? 'selected' : ''}>🛡️ 防守</option>
        <option value="assist" ${l.type === 'assist' ? 'selected' : ''}>🤝 協防</option>
      `;

      /* 目標城下拉（依類型過濾） */
      const validTargets = getTargetsForType(l.srcId, l.type);
      let tgtOpts = validTargets.map(c =>
        `<option value="${c.id}" ${c.id === l.tgtId ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');
      /* 若當前目標城不在可選清單中（異常狀態），仍顯示 */
      if(!validTargets.find(c => c.id === l.tgtId) && tgt){
        tgtOpts = `<option value="${tgt.id}" selected>${esc(tgt.name)}（不符）</option>` + tgtOpts;
      }

      return `<div class="war-line ${invalidCls}" data-line-idx="${i}">
        <select class="war-src">${srcOpts}</select>
        <select class="war-type ${typeCls}">${typeOpts}</select>
        <select class="war-tgt">${tgtOpts}</select>
        <button class="btn btn-danger btn-sm war-del">🗑️</button>
      </div>`;
    }).join('');

    el.innerHTML = headerHtml + linesHtml;

    /* 綁定事件 */
    el.querySelectorAll('.war-line').forEach((lineEl, i) => {
      const line = lines[i];

      lineEl.querySelector('.war-src')?.addEventListener('change', function(){
        changeLine(line, this.value, line.tgtId, line.type);
      });

      lineEl.querySelector('.war-type')?.addEventListener('change', function(){
        /* 切換類型時，目標城要依類型重新選擇 */
        const newType = this.value;
        const validTargets = getTargetsForType(line.srcId, newType);
        if(validTargets.length === 0){
          alert('此類型沒有可選的目標城');
          render();
          return;
        }
        /* 若原目標城符合新類型，保留；否則選第一個 */
        let newTgtId = line.tgtId;
        if(!validTargets.find(c => c.id === newTgtId)){
          newTgtId = validTargets[0].id;
        }
        changeLine(line, line.srcId, newTgtId, newType);
      });

      lineEl.querySelector('.war-tgt')?.addEventListener('change', function(){
        changeLine(line, line.srcId, this.value, line.type);
      });

      lineEl.querySelector('.war-del')?.addEventListener('click', () => {
        deleteLine(line);
      });
    });
  }

  /* ============================================================
     修改宣戰（出兵城 / 目標城 / 類型 任一變動）
     ============================================================ */
  function changeLine(oldLine, newSrcId, newTgtId, newType){
    /* 1. 驗證目標城是否符合類型 */
    const validTargets = getTargetsForType(newSrcId, newType);
    if(!validTargets.find(c => c.id === newTgtId)){
      alert('此類型不能選擇該目標城');
      render();
      return;
    }

    /* 2. 去重：檢查新方向是否已有宣戰（且不是自己） */
    const isSelf = (oldLine.srcId === newSrcId && oldLine.tgtId === newTgtId);
    if(!isSelf){
      const existing = findWarLine(newSrcId, newTgtId);
      if(existing){
        alert(`「${cityName(newSrcId)}」→「${cityName(newTgtId)}」已有宣戰指示`);
        render();
        return;
      }
    }

    /* 3. 刪除舊的 */
    deleteLineSilent(oldLine);

    /* 4. 新增新的 */
    const src = state.cities.find(c => c.id === newSrcId);
    if(!src) return;

    const isAttack = (newType === 'attack');
    const arr = isAttack ? 'attackTargets' : 'defendTargets';
    if(!src[arr]) src[arr] = [];

    src[arr].push({
      cityId: newTgtId,
      preWarPercent: oldLine.preWarPercent || 50,
      postRevivePercent: oldLine.postRevivePercent || 50,
      priority: oldLine.priority || 1,
    });

    markDirty(src.id);
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
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

  /* ============================================================
     刪除
     ============================================================ */
  function deleteLine(line){
    deleteLineSilent(line);
    if(window.SLG.saveState) window.SLG.saveState();
    render();
    if(window.SLG.DeployInstr) window.SLG.DeployInstr.render();
  }

  function deleteLineSilent(line){
    const src = state.cities.find(c => c.id === line.srcId);
    if(!src) return;
    /* 依原類型刪除 */
    if(line.type === 'attack'){
      if(src.attackTargets){
        src.attackTargets = src.attackTargets.filter(t => t.cityId !== line.tgtId);
      }
    } else {
      if(src.defendTargets){
        src.defendTargets = src.defendTargets.filter(t => t.cityId !== line.tgtId);
      }
    }
    state.entityRev.city[src.id] = (state.entityRev.city[src.id] || 0) + 1;
    if(window.SLG.markDirty) window.SLG.markDirty('city', src.id);
  }

  return { init, render, findWarLine };
})();
/* ============================================================
   DeployInstr — 出兵指示（v8.5.1：加標題、去重）
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

  /* v8.5.1：標題列 */
  function headerRow(){
    return `<div class="deploy-instr-header-row">
      <span>類型</span>
      <span>目標城</span>
      <span>戰前%</span>
      <span>復活%</span>
      <span>順序</span>
      <span>操作</span>
    </div>`;
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

    const hasAtk = atkLines.length > 0;
    const hasDef = defLines.length > 0;

    return `<div class="deploy-instr-card" data-src-id="${src.id}">
      <div class="deploy-instr-header">
        <div class="deploy-instr-title">${src.isCapital ? '👑 ' : ''}${esc(src.name)}</div>
        <div class="deploy-instr-total">總隊數 ${totalTeams}</div>
      </div>
      ${hasAtk ? `<div class="section-label" style="font-size:10px;">⚔️ 進攻指示（${atkSum}%）</div>${headerRow()}${atkLines}` : ''}
      ${hasDef ? `<div class="section-label" style="font-size:10px;">🛡️ 防守指示（${defSum}%）</div>${headerRow()}${defLines}` : ''}
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
   RouteManager — 地圖路線管理
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
   GameMap — 地圖（力導向 + 盟徽 + 路線 + 拖曳 + touch 縮放）
   v8.5.1：加入 touch pinch 縮放
   ============================================================ */
const GameMap = (() => {
  let canvas, ctx, containerEl;
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

  /* v8.5.1：touch */
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartCenter = null;
  let touchPanStart = null;

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

    /* v8.5.1：touch 事件 */
    containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', onTouchEnd, { passive: false });

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
        view = { x: 0, y: 0, scale: 1 };
        applyView();
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
    view.x = mx - (e.clientX - rect.left + containerEl.scrollLeft) / newScale;
    view.y = my - (e.clientY - rect.top + containerEl.scrollTop) / newScale;
    view.scale = newScale;
    applyView();
  }

  /* ============================================================
     v8.5.1：touch 事件處理
     ============================================================ */
  function touchDist(t1, t2){
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  function touchCenter(t1, t2){
    return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
  }

  function onTouchStart(e){
    if(e.touches.length === 2){
      /* 雙指：縮放 */
      e.preventDefault();
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartScale = view.scale;
      pinchStartCenter = touchCenter(e.touches[0], e.touches[1]);
      /* 停止拖曳 */
      dragging = false;
      nodeDragging = null;
      routeDragFrom = null;
    } else if(e.touches.length === 1){
      /* 單指：判斷是否拖曳節點 */
      const t = e.touches[0];
      const worldPos = getWorldPosFromClient(t.clientX, t.clientY);
      const city = pickCity(worldPos);
      if(city){
        nodeDragging = {
          cityId: city.id,
          offsetX: worldPos.x - nodePositions.get(city.id).x,
          offsetY: worldPos.y - nodePositions.get(city.id).y,
        };
        e.preventDefault();
      } else if(editRouteMode){
        const city2 = pickCity(worldPos);
        if(city2){
          routeDragFrom = city2;
          routeDragEnd = worldPos;
          e.preventDefault();
        } else {
          /* 空白處：記錄拖曳起點 */
          touchPanStart = {
            x: t.clientX, y: t.clientY,
            sx: containerEl.scrollLeft, sy: containerEl.scrollTop,
          };
        }
      } else {
        /* 空白處：記錄拖曳起點（原生 scroll） */
        touchPanStart = {
          x: t.clientX, y: t.clientY,
          sx: containerEl.scrollLeft, sy: containerEl.scrollTop,
        };
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

      /* 以 pinch 中心為縮放中心 */
      const rect = containerEl.getBoundingClientRect();
      const cx = (center.x - rect.left + containerEl.scrollLeft) / view.scale;
      const cy = (center.y - rect.top + containerEl.scrollTop) / view.scale;
      view.x = cx - (center.x - rect.left + containerEl.scrollLeft) / newScale;
      view.y = cy - (center.y - rect.top + containerEl.scrollTop) / newScale;
      view.scale = newScale;
      applyView();
      return;
    }

    if(e.touches.length === 1){
      const t = e.touches[0];
      const worldPos = getWorldPosFromClient(t.clientX, t.clientY);

      if(nodeDragging){
        e.preventDefault();
        const p = nodePositions.get(nodeDragging.cityId);
        if(p){
          p.x = worldPos.x - nodeDragging.offsetX;
          p.y = worldPos.y - nodeDragging.offsetY;
          render();
        }
        return;
      }

      if(routeDragFrom){
        e.preventDefault();
        routeDragEnd = worldPos;
        render();
        return;
      }

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
    if(e.touches.length < 2){
      pinchStartDist = 0;
      pinchStartCenter = null;
    }

    if(e.touches.length === 0){
      /* 所有手指離開：結束操作 */
      if(routeDragFrom){
        /* 找最終觸點位置 */
        const t = e.changedTouches[0];
        const worldPos = getWorldPosFromClient(t.clientX, t.clientY);
        const targetCity = pickCity(worldPos);
        if(targetCity && targetCity.id !== routeDragFrom.id){
          const existing = window.SLG.findRoute(routeDragFrom.id, targetCity.id);
          if(existing){
            window.SLG.removeRoute(existing.id);
          } else {
            window.SLG.addRoute(routeDragFrom.id, targetCity.id);
          }
          if(window.SLG.saveState) window.SLG.saveState();
          if(window.SLG.RouteManager) window.SLG.RouteManager.render();
        }
        routeDragFrom = null;
        routeDragEnd = null;
        render();
      }
      nodeDragging = null;
      touchPanStart = null;
      applyCursor();
    }
  }

  /* ============================================================
     滑鼠事件
     ============================================================ */
  function getWorldPos(e){
    return getWorldPosFromClient(e.clientX, e.clientY);
  }

  function getWorldPosFromClient(clientX, clientY){
    const rect = containerEl.getBoundingClientRect();
    const sx = clientX - rect.left + containerEl.scrollLeft;
    const sy = clientY - rect.top + containerEl.scrollTop;
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
    if(e.pointerType === 'touch') return;   /* 由 touch 事件處理 */
    const worldPos = getWorldPos(e);

    if(editRouteMode){
      const city = pickCity(worldPos);
      if(city){
        routeDragFrom = city;
        routeDragEnd = worldPos;
        return;
      }
    }

    const city = pickCity(worldPos);
    if(city){
      nodeDragging = {
        cityId: city.id,
        offsetX: worldPos.x - nodePositions.get(city.id).x,
        offsetY: worldPos.y - nodePositions.get(city.id).y,
      };
      canvas.style.cursor = 'grabbing';
      return;
    }

    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, sx: containerEl.scrollLeft, sy: containerEl.scrollTop };
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e){
    if(e.pointerType === 'touch') return;
    const worldPos = getWorldPos(e);

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

    if(state.cities.length > 0) render();
  }

  function onPointerUp(e){
    if(e.pointerType === 'touch') return;

    if(nodeDragging){
      nodeDragging = null;
      applyCursor();
      return;
    }

    if(routeDragFrom){
      const worldPos = getWorldPos(e);
      const targetCity = pickCity(worldPos);
      if(targetCity && targetCity.id !== routeDragFrom.id){
        const existing = window.SLG.findRoute(routeDragFrom.id, targetCity.id);
        if(existing){
          window.SLG.removeRoute(existing.id);
        } else {
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
    /* 更新容器 scroll 位置，模擬以 view.x/view.y 為左上角 */
    if(containerEl){
      containerEl.scrollLeft = view.x * view.scale;
      containerEl.scrollTop = view.y * view.scale;
    }
  }

  function render(){
    if(!canvas || !ctx) return;
    computeLayout();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

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
      if(ctx.roundRect) ctx.roundRect(x, y, w, h, r);
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

    for(const c of state.cities){
      const p = nodePositions.get(c.id);
      if(!p) continue;
      const isHovered = (hoveredCityId === c.id);
      const isDragFrom = routeDragFrom && routeDragFrom.id === c.id;

      if(isHovered || isDragFrom){
        ctx.beginPath();
        ctx.arc(p.x, p.y, 42, 0, Math.PI * 2);
        ctx.strokeStyle = isDragFrom ? 'rgba(68,170,255,1)' : 'rgba(255,255,255,0.4)';
        ctx.lineWidth = isDragFrom ? 4 : 3;
        ctx.stroke();
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

      ctx.font = 'bold 13px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.textBaseline = 'top';
      ctx.fillText(c.name, p.x, p.y + 38);

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
      }
      applyView();
    }
    applyCursor();
    render();
  }

  function reset(){
    nodePositions.clear();
    layoutDirty = true;
    view = { x: 0, y: 0, scale: 1 };
    if(containerEl){
      containerEl.scrollLeft = 0;
      containerEl.scrollTop = 0;
    }
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