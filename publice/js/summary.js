/* ============================================================================
 * summary.js — 推演總結（v8.4）
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, emit, EVT, on,
  esc, logSystem,
  sideLabel, sideClass,
  minutesToHHMM,
  ROLE,
} = window.SLG;

const Summary = (() => {
  let lastSummary = null;

  /* ============================================================
     資料建構
     ============================================================ */
  function build(result, cities, alliances, dynRows) {
    if(!result || !result.finalStates) return null;

    return {
      timestamp: Date.now(),
      overview: buildOverview(result, cities),
      allianceDist: buildAllianceDist(alliances, cities),
      cityStates: buildCityStates(result.finalStates, cities, alliances),
      highlights: buildHighlights(result.finalStates, cities),
      timeline: buildTimeline(result.narrativeLines, result.minDefStartMin),
    };
  }

  /* ── 概況 ── */
  function buildOverview(result, cities) {
    const totalSec = result.totalSimSec || 0;
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);

    let totalRoutes = 0;
    for(const c of cities){
      totalRoutes += (c.attackTargets || []).length;
      totalRoutes += (c.defendTargets || []).length;
    }

    const allianceCount = new Set(cities.map(c => c.allianceId).filter(Boolean)).size;

    return {
      duration: `${hours} 時 ${mins} 分`,
      cityCount: cities.length,
      allianceCount,
      routeCount: totalRoutes,
    };
  }

  /* ── 盟兵力分佈 ── */
  function buildAllianceDist(alliances, cities) {
    return alliances.map(a => {
      const myCities = cities.filter(c => c.allianceId === a.id);
      const allocatedPower = myCities.reduce((sum, c) => sum + (Number(c.totalPower) || 0), 0);
      const allocatedTeams = myCities.reduce((sum, c) => sum + (Number(c.totalTeams) || 0), 0);
      const totalPower = Number(a.totalPower) || 0;
      const remainPower = totalPower - allocatedPower;
      const usedPct = totalPower > 0 ? (allocatedPower / totalPower * 100) : 0;

      return {
        id: a.id,
        name: a.name,
        icon: a.icon || '',
        side: a.side,
        totalPower,
        allocatedPower,
        remainPower,
        allocatedTeams,
        cityCount: myCities.length,
        usedPct: Math.round(usedPct),
        overAllocated: remainPower < 0,
      };
    }).sort((a, b) => {
      const order = { self: 0, ally: 1, enemy: 2 };
      return (order[a.side] ?? 9) - (order[b.side] ?? 9);
    });
  }

  /* ── 城池最終狀態 ── */
  function buildCityStates(finalStates, cities, alliances) {
    return finalStates.map(s => {
      const city = cities.find(c => c.id === s.id);
      if(!city) return null;
      const alliance = alliances.find(a => a.id === city.allianceId);

      return {
        id: s.id,
        name: city.name,
        side: city.side,
        sideLabel: sideLabel(city.side),
        allianceId: city.allianceId,
        allianceName: alliance ? alliance.name : '（無）',
        allianceIcon: alliance ? (alliance.icon || '') : '',
        isCapital: !!city.isCapital,
        atHome: Math.round(s.r),
        outbound: Math.round(s.o),
        cooldown: Math.round(s.c),
        total: Math.round(s.r + s.o + s.c),
        initialTeams: city.totalTeams || 0,
        wallSec: s.wallSec,
        wallMin: city.wallMin || 0,
        wallPct: city.wallMin > 0 ? Math.max(0, s.wallSec / (city.wallMin * 60)) : 1,
        fallen: !!s.fallen,
      };
    }).filter(Boolean);
  }

  /* ── 推演重點 ── */
  function buildHighlights(finalStates, cities) {
    const result = {
      selfDefended: 0,
      selfCritical: 0,
      selfFallen: 0,
      enemyCaptured: 0,
      enemyCritical: 0,
      enemyDefended: 0,
      npcFallen: 0,
    };

    for(const s of finalStates) {
      const city = cities.find(c => c.id === s.id);
      if(!city) continue;

      const isSelf = (city.side === 'self' || city.side === 'ally');
      const isEnemy = (city.side === 'enemy' || city.side === 'common_enemy');
      const isNpc = city.side === 'npc';

      const wallInit = (city.wallMin || 0) * 60;
      const wallPct = wallInit > 0 ? s.wallSec / wallInit : 1;

      if(s.fallen) {
        if(isSelf) result.selfFallen++;
        else if(isEnemy) result.enemyCaptured++;
        else if(isNpc) result.npcFallen++;
      } else {
        if(isSelf) {
          if(wallPct < 0.3) result.selfCritical++;
          else result.selfDefended++;
        } else if(isEnemy) {
          if(wallPct < 0.3) result.enemyCritical++;
          else result.enemyDefended++;
        }
      }
    }

    return result;
  }

  /* ── 時間軸 ── */
  function buildTimeline(narrativeLines, baseMin) {
    if(!narrativeLines) return [];
    /* 只留關鍵事件 */
    return narrativeLines
      .filter(l => l.type === 'warn' || l.type === 'capture')
      .map(l => {
        /* 擷取時間戳「【HH:MM:SS】」 */
        const m = l.text.match(/【(\d{2}:\d{2}:\d{2})】/);
        const time = m ? m[1] : '';
        const text = l.text.replace(/【.*?】/, '').trim();
        return { type: l.type, time, text };
      });
  }

  /* ============================================================
     渲染
     ============================================================ */
  function render(summary) {
    lastSummary = summary;

    const emptyEl = document.getElementById('summaryEmpty');
    const contentEl = document.getElementById('summaryContent');

    if(!summary) {
      if(emptyEl) emptyEl.style.display = '';
      if(contentEl) contentEl.style.display = 'none';
      return;
    }

    if(emptyEl) emptyEl.style.display = 'none';
    if(contentEl) contentEl.style.display = '';

    renderOverview(summary.overview);
    renderAllianceDist(summary.allianceDist);
    renderCities(summary.cityStates);
    renderHighlights(summary.highlights);
    renderTimeline(summary.timeline);
  }

  function renderOverview(o) {
    const el = document.getElementById('summaryOverview');
    if(!el) return;
    el.innerHTML = `
      <div class="summary-stat"><div class="label">總時長</div><div class="value">${esc(o.duration)}</div></div>
      <div class="summary-stat"><div class="label">城池數</div><div class="value">${o.cityCount}</div></div>
      <div class="summary-stat"><div class="label">參戰盟</div><div class="value">${o.allianceCount}</div></div>
      <div class="summary-stat"><div class="label">路線數</div><div class="value">${o.routeCount}</div></div>
    `;
  }

  function renderAllianceDist(list) {
    const el = document.getElementById('summaryAllianceDist');
    if(!el) return;
    if(list.length === 0) {
      el.innerHTML = '<div class="text-dim">無盟資料</div>';
      return;
    }
    el.innerHTML = list.map(a => {
      const chipCls = a.side === 'self' ? 'self' : (a.side === 'ally' ? 'ally' : 'enemy');
      const barCls = a.overAllocated ? 'warn' : '';
      const remainCls = a.remainPower < 0 ? 'style="color:var(--neon-red);"' : '';
      return `<div class="alliance-dist-row">
        <span class="name">${a.icon ? a.icon + ' ' : ''}${esc(a.name)}</span>
        <span class="chip ${chipCls}" style="font-size:9px;">${sideLabel(a.side)}</span>
        <span class="num">${a.allocatedPower.toLocaleString()} / ${a.totalPower.toLocaleString()}</span>
        <div class="bar"><div class="bar-fill ${barCls}" style="width:${Math.min(100, a.usedPct)}%"></div></div>
        <span class="pct">${a.usedPct}%</span>
        <span class="num" ${remainCls}>餘 ${a.remainPower.toLocaleString()}</span>
        <span class="num" style="color:var(--text-dim);">${a.cityCount} 城</span>
      </div>`;
    }).join('');
  }

  let currentCityView = 'side';
  let cachedCities = null;

  function renderCities(cityStates) {
    cachedCities = cityStates;
    const el = document.getElementById('summaryCities');
    if(!el) return;
    if(cityStates.length === 0) {
      el.innerHTML = '<div class="text-dim">無城池資料</div>';
      return;
    }

    let groups = [];

    if(currentCityView === 'side') {
      const map = new Map();
      for(const c of cityStates) {
        if(!map.has(c.side)) map.set(c.side, []);
        map.get(c.side).push(c);
      }
      const order = ['self', 'ally', 'enemy', 'common_enemy', 'npc'];
      groups = order.filter(s => map.has(s)).map(s => ({
        key: s,
        title: sideLabel(s),
        cls: sideClass(s),
        cities: map.get(s),
      }));
    } else if(currentCityView === 'alliance') {
      const map = new Map();
      for(const c of cityStates) {
        const key = c.allianceId || '__none__';
        if(!map.has(key)) map.set(key, { name: c.allianceName, icon: c.allianceIcon, cities: [] });
        map.get(key).cities.push(c);
      }
      groups = [...map.entries()].map(([id, g]) => ({
        key: id,
        title: (g.icon ? g.icon + ' ' : '') + g.name,
        cls: '',
        cities: g.cities,
      }));
    } else {
      /* status */
      const survived = cityStates.filter(c => !c.fallen);
      const fallen = cityStates.filter(c => c.fallen);
      if(survived.length > 0) groups.push({ key: 'survived', title: '✅ 存活', cls: 'ok', cities: survived });
      if(fallen.length > 0) groups.push({ key: 'fallen', title: '❌ 淪陷', cls: 'bad', cities: fallen });
    }

    el.innerHTML = groups.map(g => renderCityGroup(g)).join('');

    /* 綁定展開/收起 */
    el.querySelectorAll('.summary-group-header').forEach(h => {
      h.addEventListener('click', () => {
        const body = h.nextElementSibling;
        if(body) body.style.display = body.style.display === 'none' ? '' : 'none';
      });
    });
  }

  function renderCityGroup(g) {
    const rows = g.cities.map(c => {
      const cls = c.fallen ? 'fallen' : (c.wallPct < 0.3 ? 'critical' : '');
      const wallDisplay = c.fallen ? '🏳️ 0 分' : `${(c.wallSec / 60).toFixed(1)} 分`;
      const status = c.fallen
        ? '<span style="color:var(--neon-red);">❌ 淪陷</span>'
        : (c.wallPct < 0.3
          ? '<span style="color:var(--neon-yellow);">⚠️ 危機</span>'
          : '<span style="color:var(--neon-green);">✅ 存活</span>');

      return `<tr class="${cls}">
        <td>${c.isCapital ? '👑 ' : ''}${esc(c.name)}</td>
        <td>${c.allianceIcon ? `<span class="alliance-icon">${c.allianceIcon}</span>` : ''}${esc(c.allianceName)}</td>
        <td class="col-num">${c.atHome}</td>
        <td class="col-num">${c.outbound}</td>
        <td class="col-num">${c.cooldown}</td>
        <td class="col-num">${c.total}</td>
        <td class="col-num">${wallDisplay}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');

    return `<div class="summary-group">
      <div class="summary-group-header">
        <span>${esc(g.title)}</span>
        <span class="count">${g.cities.length} 城</span>
      </div>
      <div class="summary-group-body">
        <table class="summary-city-table">
          <thead><tr>
            <th>城池</th><th>盟</th>
            <th class="col-num">剩餘</th>
            <th class="col-num">外出</th>
            <th class="col-num">冷卻</th>
            <th class="col-num">總計</th>
            <th class="col-num">城牆</th>
            <th>狀態</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderHighlights(h) {
    const el = document.getElementById('summaryHighlights');
    if(!el) return;
    const items = [];
    if(h.selfDefended > 0) items.push({ cls: 'ok', num: h.selfDefended, label: '✅ 成功守住' });
    if(h.selfCritical > 0) items.push({ cls: 'warn', num: h.selfCritical, label: '⚠️ 陷入危機' });
    if(h.selfFallen > 0) items.push({ cls: 'bad', num: h.selfFallen, label: '❌ 城池淪陷' });
    if(h.enemyCaptured > 0) items.push({ cls: 'ok', num: h.enemyCaptured, label: '🎯 打爆敵城' });
    if(h.enemyCritical > 0) items.push({ cls: 'warn', num: h.enemyCritical, label: '⏳ 敵城殘血' });
    if(h.npcFallen > 0) items.push({ cls: 'warn', num: h.npcFallen, label: '🏳️ NPC 淪陷' });

    if(items.length === 0) {
      el.innerHTML = '<div class="text-dim">無重點事件</div>';
      return;
    }
    el.innerHTML = `<div class="summary-highlight">${items.map(i =>
      `<div class="summary-highlight-item ${i.cls}">
        <div class="num">${i.num}</div>
        <div class="label">${i.label}</div>
      </div>`
    ).join('')}</div>`;
  }

  function renderTimeline(lines) {
    const el = document.getElementById('summaryTimeline');
    if(!el) return;
    if(!lines || lines.length === 0) {
      el.innerHTML = '<div class="text-dim">無關鍵事件</div>';
      return;
    }
    el.innerHTML = `<div class="summary-timeline">${lines.map(l => {
      const cls = l.type === 'capture' ? 'event-capture' : 'event-warn';
      return `<div class="summary-timeline-line ${cls}">
        <span class="time">${esc(l.time)}</span>
        <span class="text">${esc(l.text)}</span>
      </div>`;
    }).join('')}</div>`;
  }

  /* ============================================================
     初始化
     ============================================================ */
  function init() {
    /* 視角切換 */
    document.querySelectorAll('.summary-view-tab').forEach(tab => {
      tab.addEventListener('click', function(){
        document.querySelectorAll('.summary-view-tab').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        currentCityView = this.dataset.summaryView || 'side';
        if(cachedCities) renderCities(cachedCities);
      });
    });
  }

  function clear() {
    lastSummary = null;
    render(null);
  }

  return {
    init,
    build,
    render,
    clear,
    getLast() { return lastSummary; },
  };
})();

window.SLG.Summary = Summary;

})();