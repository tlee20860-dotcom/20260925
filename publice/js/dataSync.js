/* ============================================================================
 * dataSync.js — v8.9.9 統一資料同步管理器
 * 職責：
 *   ① 城池 ↔ 地圖節點（三向同步：city.mapNode / activeMapNodes / Firebase）
 *   ② 城池刪除 → 連動清路線 + 宣戰
 *   ③ 路線孤兒清理（端點城池不存在）+ 跨圖清理
 *   ④ 宣戰孤兒清理（來源/目標城池不存在）+ 跨圖清理
 *   ⑤ 戰區孤兒清理
 *   ⑥ 一鍵修復（節點 + 路線 + 宣戰 + 戰區）
 *   ⑦ 舊資料遷移（zone.mapId 推斷）
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

const {
  state, emit, EVT,
  uid, logSystem,
  markDirty, tickLamport, flushPatches,
  saveState,
} = window.SLG;

/* ============================================================
   DataSyncManager
   ============================================================ */
const DataSyncManager = (() => {

  /* ── 內部工具 ── */
  function _cityNodeId(city){
    if(!city) return '';
    return city.code || ('n_' + city.id);
  }

  function _getActiveMapNodes(){
    if(window.SLG.GameMap && typeof window.SLG.GameMap.getActiveMapNodes === 'function'){
      return window.SLG.GameMap.getActiveMapNodes();
    }
    return null;
  }

  function _getActiveMapId(){
    return state.mapLibrary.activeMapId || '';
  }

  function _findCity(cityId){
    return state.cities.find(c => c.id === cityId) || null;
  }

  /* ══════════════════════════════════════════════════════
     ① 設定節點（新增 / 更新，三向同步）
     @param {string} cityId
     @param {number} x
     @param {number} y
     @param {Object} opts - { source, mapId, silent }
     ══════════════════════════════════════════════════════ */
  function setNode(cityId, x, y, opts = {}){
    const city = _findCity(cityId);
    if(!city){
      console.warn('[DataSync.setNode] 找不到城池', cityId);
      return false;
    }

    const mapId = opts.mapId || _getActiveMapId();
    const nodeId = _cityNodeId(city);
    const source = opts.source || 'manual';
    const rx = Math.round(Number(x) || 0);
    const ry = Math.round(Number(y) || 0);

    /* --- 1. city.mapNode --- */
    city.mapNode = {
      mapId,
      nodeId,
      x: rx,
      y: ry,
      method: source,
    };
    state.entityRev.city[cityId] = (state.entityRev.city[cityId] || 0) + 1;
    markDirty('city', cityId);

    /* --- 2. activeMapNodes（GameMap 記憶體快取）--- */
    const amn = _getActiveMapNodes();
    if(amn){
      amn[nodeId] = {
        name: city.name,
        code: city.code || '',
        x: rx,
        y: ry,
        namedCityId: city.id,
        source,
      };
    }

    /* --- 3. state.mapLibrary.loaded[mapId].nodes（本機快取）--- */
    if(mapId){
      const loaded = state.mapLibrary.loaded[mapId];
      if(loaded){
        if(!loaded.nodes) loaded.nodes = {};
        loaded.nodes[nodeId] = {
          name: city.name,
          code: city.code || '',
          x: rx,
          y: ry,
          namedCityId: city.id,
          source,
        };
      }
    }

    /* --- 4. Firebase（異步）--- */
    if(mapId && window.SLG.writeNodeToMapLibrary){
      window.SLG.writeNodeToMapLibrary(mapId, nodeId, {
        name: city.name,
        code: city.code || '',
        x: rx,
        y: ry,
        source,
      }).catch(err => console.warn('[DataSync] Firebase 節點寫入失敗', err));
    }

    tickLamport();
    flushPatches();
    saveState('important');
    return true;
  }

  /* ══════════════════════════════════════════════════════
     ② 刪除節點（僅刪節點，保留城池）
     @param {string} cityId
     @param {Object} opts - { silent }
     ══════════════════════════════════════════════════════ */
  async function deleteNode(cityId, opts = {}){
    const city = _findCity(cityId);
    if(!city) return false;

    const mapId = (city.mapNode && city.mapNode.mapId) || _getActiveMapId();
    const nodeId = _cityNodeId(city);

    /* --- 1. Firebase（先等完成，避免 watcher 又拉回來）--- */
    if(mapId && window.SLG.removeNodeFromMapLibrary){
      try{
        await window.SLG.removeNodeFromMapLibrary(mapId, nodeId);
      }catch(err){
        console.warn('[DataSync] Firebase 節點刪除失敗', err);
        if(!opts.silent){
          alert(
            '⚠️ 雲端節點刪除失敗：' + (err.message || err) +
            '\n\n本機已移除，但雲端仍保留。\n' +
            '請確認：① 已登入 ② 網路正常'
          );
        }
      }
    }

    /* --- 2. city.mapNode --- */
    if(city.mapNode){
      delete city.mapNode;
      state.entityRev.city[cityId] = (state.entityRev.city[cityId] || 0) + 1;
      markDirty('city', cityId);
    }

    /* --- 3. activeMapNodes --- */
    const amn = _getActiveMapNodes();
    if(amn && amn[nodeId]){
      delete amn[nodeId];
    }

    /* --- 4. mapLibrary.loaded（雙保險）--- */
    if(mapId){
      const loaded = state.mapLibrary.loaded[mapId];
      if(loaded && loaded.nodes && loaded.nodes[nodeId]){
        delete loaded.nodes[nodeId];
      }
    }

    tickLamport();
    flushPatches();
    saveState('important');
    return true;
  }

  /* ══════════════════════════════════════════════════════
     ③ 城池改名 → 同步節點名稱
     ══════════════════════════════════════════════════════ */
  function renameCity(cityId){
    const city = _findCity(cityId);
    if(!city || !city.mapNode) return false;
    return setNode(cityId, city.mapNode.x, city.mapNode.y, {
      source: city.mapNode.method || 'manual',
      mapId: city.mapNode.mapId,
    });
  }

  /* ══════════════════════════════════════════════════════
     ④ 刪除城池（連動：節點 + 路線 + 宣戰）
     ══════════════════════════════════════════════════════ */
  async function deleteCityCascade(cityId){
    const city = _findCity(cityId);
    if(!city) return { routesRemoved: 0, warsRemoved: 0 };

    /* --- 1. 刪節點（含 Firebase）--- */
    await deleteNode(cityId, { silent: true });

    /* --- 2. 清理相關路線 --- */
    const routesBefore = state.routes.length;
    state.routes = state.routes.filter(r =>
      r.cityAId !== cityId && r.cityBId !== cityId
    );
    const routesRemoved = routesBefore - state.routes.length;

    /* --- 3. 清理其他城池指向此城的宣戰 --- */
    let warsRemoved = 0;
    for(const o of state.cities){
      if(o.id === cityId) continue;

      if(o.attackTargets && o.attackTargets.length > 0){
        const before = o.attackTargets.length;
        o.attackTargets = o.attackTargets.filter(t => t.cityId !== cityId);
        const diff = before - o.attackTargets.length;
        if(diff > 0){
          warsRemoved += diff;
          state.entityRev.city[o.id] = (state.entityRev.city[o.id] || 0) + 1;
          markDirty('city', o.id);
        }
      }
      if(o.defendTargets && o.defendTargets.length > 0){
        const before = o.defendTargets.length;
        o.defendTargets = o.defendTargets.filter(t => t.cityId !== cityId);
        const diff = before - o.defendTargets.length;
        if(diff > 0){
          warsRemoved += diff;
          state.entityRev.city[o.id] = (state.entityRev.city[o.id] || 0) + 1;
          markDirty('city', o.id);
        }
      }
    }

    /* --- 4. 刪除城池本體 --- */
    if(typeof window.SLG.deleteEntity === 'function'){
      window.SLG.deleteEntity('city', cityId);
    } else {
      const idx = state.cities.findIndex(c => c.id === cityId);
      if(idx >= 0){
        state.cities.splice(idx, 1);
        state.entityRev.city[cityId] = (state.entityRev.city[cityId] || 0) + 1;
        markDirty('cityDeleted', cityId);
      }
    }

    /* --- 5. 重算防守開始時間 --- */
    if(window.SLG.computeDefStartTimes){
      window.SLG.computeDefStartTimes(state.cities);
    }

    tickLamport();
    flushPatches();
    saveState('important');

    if(routesRemoved > 0 || warsRemoved > 0){
      logSystem(`🗑️ 刪城連動：路線 -${routesRemoved}，宣戰 -${warsRemoved}`);
    }
    return { routesRemoved, warsRemoved };
  }

  /* ══════════════════════════════════════════════════════
     ⑤ 路線孤兒清理 + 跨圖清理
     ══════════════════════════════════════════════════════ */
  function reconcileRoutes(){
    const cityIds = new Set(state.cities.map(c => c.id));
    const cityMap = new Map(state.cities.map(c => [c.id, c]));
    const requireSameMap = !!state.settings.routeRequireSameMap;

    const before = state.routes.length;
    const seen = new Set();

    state.routes = state.routes.filter(r => {
      /* 端點城池不存在 */
      if(!cityIds.has(r.cityAId) || !cityIds.has(r.cityBId)) return false;

      /* 跨圖檢查 */
      if(requireSameMap){
        const a = cityMap.get(r.cityAId);
        const b = cityMap.get(r.cityBId);
        const ma = (a && a.mapNode && a.mapNode.mapId) || '';
        const mb = (b && b.mapNode && b.mapNode.mapId) || '';
        if(ma && mb && ma !== mb) return false;
      }

      /* 重複路線（無向） */
      const key = [r.cityAId, r.cityBId].sort().join('|');
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const removed = before - state.routes.length;
    if(removed > 0){
      saveState('important');
      logSystem(`🧹 路線清理：移除 ${removed} 條`);
    }
    return { removed };
  }

  /* ══════════════════════════════════════════════════════
     ⑥ 宣戰孤兒清理 + 跨圖清理
     ══════════════════════════════════════════════════════ */
  function reconcileWars(){
    const cityIds = new Set(state.cities.map(c => c.id));
    const cityMap = new Map(state.cities.map(c => [c.id, c]));
    const requireSameMap = !!state.settings.warRequireSameMap;

    let removed = 0;
    const touched = new Set();

    for(const city of state.cities){
      const myMapId = (city.mapNode && city.mapNode.mapId) || '';

      const cleanList = (arr) => {
        if(!arr || arr.length === 0) return arr;
        const before = arr.length;
        const seen = new Set();
        const filtered = arr.filter(t => {
          /* 目標城池不存在 */
          if(!t.cityId || !cityIds.has(t.cityId)) return false;

          /* 重複 */
          if(seen.has(t.cityId)) return false;
          seen.add(t.cityId);

          /* 跨圖檢查 */
          if(requireSameMap){
            const tgt = cityMap.get(t.cityId);
            const tgtMapId = (tgt && tgt.mapNode && tgt.mapNode.mapId) || '';
            if(myMapId && tgtMapId && myMapId !== tgtMapId) return false;
          }
          return true;
        });
        const diff = before - filtered.length;
        if(diff > 0){
          removed += diff;
          touched.add(city.id);
        }
        return filtered;
      };

      city.attackTargets = cleanList(city.attackTargets);
      city.defendTargets = cleanList(city.defendTargets);
    }

    if(removed > 0){
      for(const id of touched){
        state.entityRev.city[id] = (state.entityRev.city[id] || 0) + 1;
        markDirty('city', id);
      }
      tickLamport();
      flushPatches();
      saveState('important');
      logSystem(`🧹 宣戰清理：移除 ${removed} 條`);
    }
    return { removed };
  }

  /* ══════════════════════════════════════════════════════
     ⑦ 節點全量修復（city.mapNode ↔ 地圖庫）
     ══════════════════════════════════════════════════════ */
  async function reconcileMapNodes(mapId){
    if(!mapId) return { fixed: 0, removed: 0 };
    const loaded = state.mapLibrary.loaded[mapId];
    if(!loaded || !loaded.nodes){
      return { fixed: 0, removed: 0 };
    }
    const nodes = loaded.nodes;

    let fixed = 0;
    let removed = 0;

    /* --- A. 補回：city.mapNode 有，地圖庫缺 --- */
    for(const c of state.cities){
      if(!c.mapNode) continue;
      if(c.mapNode.mapId && c.mapNode.mapId !== mapId) continue;

      const nodeId = c.mapNode.nodeId || _cityNodeId(c);
      if(!nodes[nodeId]){
        nodes[nodeId] = {
          name: c.name,
          code: c.code || '',
          x: Math.round(c.mapNode.x),
          y: Math.round(c.mapNode.y),
          namedCityId: c.id,
          source: c.mapNode.method || 'manual',
        };
        fixed++;
      }
    }

    /* --- B. 刪除：地圖庫有，找不到對應城池 --- */
    const cityIds = new Set(state.cities.map(c => c.id));
    const cityCodes = new Set(state.cities.map(c => c.code).filter(Boolean));
    const cityNames = new Set(state.cities.map(c => c.name));
    const toDelete = [];

    for(const nid in nodes){
      const n = nodes[nid];
      if(!n) continue;
      let matched = false;
      if(n.namedCityId && cityIds.has(n.namedCityId)) matched = true;
      if(!matched && n.code && cityCodes.has(n.code)) matched = true;
      if(!matched && n.name && cityNames.has(n.name)) matched = true;
      if(!matched) toDelete.push(nid);
    }

    for(const nid of toDelete){
      delete nodes[nid];
      removed++;
    }

    /* --- C. 上傳 Firebase --- */
    if(fixed > 0 || removed > 0){
      if(window.SLG.updateMapNodes){
        try{
          await window.SLG.updateMapNodes(mapId, nodes);
        }catch(err){
          console.warn('[DataSync] 節點上傳失敗', err);
        }
      }
      /* 同步 activeMapNodes */
      const amn = _getActiveMapNodes();
      if(amn){
        for(const nid in nodes){
          if(!amn[nid]) amn[nid] = nodes[nid];
        }
        for(const nid of toDelete){
          delete amn[nid];
        }
      }
      logSystem(`🔧 節點修復：補回 ${fixed}，刪除 ${removed}`);
    }

    return { fixed, removed };
  }

  /* ══════════════════════════════════════════════════════
     ⑧ 戰區孤兒清理（mapId 不存在）
     ══════════════════════════════════════════════════════ */
  function reconcileZones(){
    const mapIds = new Set(Object.keys(state.mapLibrary.index || {}));
    let removed = 0;

    /* 若地圖庫完全空（未登入或未載入），跳過 */
    if(mapIds.size === 0) return { removed: 0 };

    state.zones = state.zones.filter(z => {
      if(!z.mapId) return true;         /* 無 mapId 保留（尚未遷移） */
      if(mapIds.has(z.mapId)) return true;
      removed++;
      return false;
    });

    if(removed > 0){
      saveState('important');
      logSystem(`🧹 戰區清理：移除 ${removed} 個`);
    }
    return { removed };
  }

  /* ══════════════════════════════════════════════════════
     ⑨ 一鍵全修復
     ══════════════════════════════════════════════════════ */
  async function reconcileAll(){
    const mapId = _getActiveMapId();
    const result = {
      nodeFixed: 0,
      nodeRemoved: 0,
      routesRemoved: 0,
      warsRemoved: 0,
      zonesRemoved: 0,
      hadMap: !!mapId,
    };

    /* --- 節點修復 --- */
    if(mapId){
      const r = await reconcileMapNodes(mapId);
      result.nodeFixed = r.fixed;
      result.nodeRemoved = r.removed;
    }

    /* --- 路線清理 --- */
    const rr = reconcileRoutes();
    result.routesRemoved = rr.removed;

    /* --- 宣戰清理 --- */
    const rw = reconcileWars();
    result.warsRemoved = rw.removed;

    /* --- 戰區清理 --- */
    const rz = reconcileZones();
    result.zonesRemoved = rz.removed;

    /* --- 觸發全局重繪 --- */
    emit(EVT.ROUTES_UPDATED);
    if(window.SLG.GameMap && typeof window.SLG.GameMap.invalidateLayout === 'function'){
      window.SLG.GameMap.invalidateLayout();
    }
    emit(EVT.DATA);

    return result;
  }

  return {
    setNode,
    deleteNode,
    renameCity,
    deleteCityCascade,
    reconcileRoutes,
    reconcileWars,
    reconcileMapNodes,
    reconcileZones,
    reconcileAll,
  };
})();

/* ============================================================
   資料遷移：舊 zone 補 mapId
   優先序：
     ① 找該戰區第一個城池的 mapNode.mapId
     ② 若無 → 用當前使用中地圖
     ③ 若無 → 用第一個地圖
     ④ 若仍無 → 空字串（未綁定）
   ============================================================ */
function migrateZonesForMap(){
  let changed = false;
  const activeMapId = state.mapLibrary.activeMapId || '';

  for(const zone of state.zones){
    if(zone.mapId) continue;   /* 已有，跳過 */

    /* 推斷策略 ①：找該戰區第一個城池的 mapNode.mapId */
    const citiesInZone = state.cities.filter(c => c.zoneId === zone.id);
    let inferred = '';
    for(const c of citiesInZone){
      if(c.mapNode && c.mapNode.mapId){
        inferred = c.mapNode.mapId;
        break;
      }
    }

    /* 推斷策略 ②：當前使用中地圖 */
    if(!inferred) inferred = activeMapId;

    /* 推斷策略 ③：第一個地圖 */
    if(!inferred && state.mapLibrary.index){
      const firstMap = Object.keys(state.mapLibrary.index)[0];
      if(firstMap) inferred = firstMap;
    }

    zone.mapId = inferred;
    changed = true;
  }

  if(changed){
    saveState();
    logSystem('🔀 已遷移戰區 mapId');
  }
  return changed;
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  DataSyncManager,
  migrateZonesForMap,
});

})();