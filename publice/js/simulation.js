/* ============================================================================
 * simulation.js — 推演引擎（純運算，不依賴 DOM）
 * v8.1
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

/* ── 常數 ── */
const COMBAT_TICK = 30;
const SIM_CHUNK = 500;
const VIZ_SNAPSHOT_INTERVAL = 5;
const DYN_ROUTE_SAMPLE_SEC = 5;

/* ── 工具函式（純函式） ── */
function hhmmToMinutes(hhmm){
  if(!hhmm || typeof hhmm !== 'string') return 0;
  const p = hhmm.split(':');
  return (parseInt(p[0],10)||0)*60 + (parseInt(p[1],10)||0);
}
function minutesToHHMM(mins){
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins/60)).padStart(2,'0') + ':' + String(mins%60).padStart(2,'0');
}
const fmtSimTime = sec => `第 ${Math.floor(sec/60)} 分 ${String(sec%60).padStart(2,'0')} 秒`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const yieldToMain = () => new Promise(r => queueMicrotask(r));

/* ── 兵力配置計算 ── */
function computeAllocation(city){
  const totalTeams = Number(city.totalTeams) || 0;
  let atkPreSum = 0, defPreSum = 0;
  for(const t of (city.attackTargets || [])) atkPreSum += Math.floor(totalTeams * (Number(t.preWarPercent)||0) / 100);
  for(const t of (city.defendTargets || [])) defPreSum += Math.floor(totalTeams * (Number(t.preWarPercent)||0) / 100);
  const allocated = atkPreSum + defPreSum;
  const reserve = totalTeams - allocated;
  return { totalTeams, atkSum: atkPreSum, defSum: defPreSum, allocated, reserve, over: reserve < 0 };
}

/* ============================================================================
 * 推演引擎
 * ========================================================================== */
async function runSimulation(cities, settings, opts = {}){
  const { onProgress, shouldAbort, snapshotAt = new Set(), onSnapshot, dynSampleAt = new Set(), onDynSample } = opts;
  const timeLimitSec = settings.timeLimitMin * 60;
  const consumeMin = settings.consumeMinPerMin;
  const consumeMax = settings.consumeMaxPerMin;
  const maxRatio = settings.maxLossRatio;
  const minRatio = settings.minLossRatio;
  const siegeEff = settings.siegeEfficiency;
  const marchSec = Math.max(0, Math.round(settings.marchTimeSec || 0));

  const N = cities.length;
  const defStartMins = cities.map(c => hhmmToMinutes(c.defStartTime || '19:00'));
  const minDefStartMin = Math.min(...defStartMins);
  const defStartRel = defStartMins.map(m => m - minDefStartMin);
  const maxDefStartRel = Math.max(...defStartRel);
  const totalSimSec = (maxDefStartRel * 60) + timeLimitSec;

  const cityId = new Array(N), cityName = new Array(N), cityZoneId = new Array(N);
  const cityAllianceId = new Array(N), citySide = new Array(N);
  const avgPower = new Float64Array(N), wallSec = new Float64Array(N);
  const atHome = new Float64Array(N);
  const totalTeams = new Float64Array(N);
  const fallen = new Uint8Array(N);
  const cooldownSec = new Int32Array(N);
  const cooldownMapLocal = Array.from({length:N}, () => new Map());
  const cooldownMapField = Array.from({length:N}, () => new Map());
  const defLossAcc = new Float64Array(N);
  const defStartSecArr = new Int32Array(N);
  const defenseEndSecArr = new Int32Array(N);
  const capitalByAlliance = new Map();
  const marchingOut = Array.from({length:N}, () => []);
  const marchingBack = Array.from({length:N}, () => []);
  const outbound = Array.from({length:N}, () => []);
  const cityHasBeenWarned = new Uint8Array(N);
  const narrativeLines = [];

  function fmtAbsTime(t) {
    const totalSec = (minDefStartMin * 60) + t;
    const h = Math.floor(totalSec / 3600) % 24;
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  for(let i=0;i<N;i++){
    const c = cities[i];
    cityId[i] = c.id; cityName[i] = c.name;
    cityZoneId[i] = c.zoneId || ''; cityAllianceId[i] = c.allianceId || ''; citySide[i] = c.side || 'npc';
    avgPower[i] = c.avgPower || 1;
    wallSec[i] = (c.wallMin || 0) * 60;
    totalTeams[i] = Number(c.totalTeams) || 0;
    cooldownSec[i] = Math.max(1, Math.round((c.cooldownMin || 0) * 60));
    defStartSecArr[i] = defStartRel[i] * 60;
    defenseEndSecArr[i] = defStartSecArr[i] + timeLimitSec;
    if(c.isCapital && c.allianceId && !capitalByAlliance.has(c.allianceId)) capitalByAlliance.set(c.allianceId, i);
  }

  const idxOf = new Map(cityId.map((id, i) => [id, i]));

  for(let i=0;i<N;i++){
    const c = cities[i];
    const total = totalTeams[i];
    atHome[i] = total;
    const routesToAdd = [];
    let preWarTotal = 0;

    const addRoute = (targetId, prePct, postPct, priority, isAttack) => {
      const tIdx = idxOf.get(targetId);
      if(tIdx === undefined) return;
      const pre = clamp(Number(prePct) || 0, 0, 100);
      if(pre <= 0) return;
      const teams = Math.floor(total * pre / 100);
      if(teams <= 0) return;
      preWarTotal += teams;
      routesToAdd.push({ tIdx, teams, prePct: pre, postPct: clamp(Number(postPct)||0,0,100), priority: Number(priority)||99, isAttack });
    };

    for(const t of (c.attackTargets || [])) addRoute(t.cityId, t.preWarPercent, t.postRevivePercent, t.priority, true);
    for(const t of (c.defendTargets || [])) addRoute(t.cityId, t.preWarPercent, t.postRevivePercent, t.priority, false);

    if(preWarTotal > total){
      const scale = total / preWarTotal;
      for(const r of routesToAdd) r.teams = Math.floor(r.teams * scale);
    }

    for(const r of routesToAdd){
      atHome[i] -= r.teams;
      const activeFrom = Math.max(defStartSecArr[i], defStartSecArr[r.tIdx] - marchSec) + marchSec;
      const activeUntil = defStartSecArr[r.tIdx] + timeLimitSec;
      outbound[i].push({
        targetIdx: r.tIdx, count: r.teams, initialCount: r.teams,
        activeFrom, activeUntil, lossAcc: 0, isAttack: r.isAttack,
        postRevivePercent: r.postPct, priority: r.priority,
        consumeThisMin: consumeMin, hasArrived: false,
      });
    }
  }

  const attackersOnCity = Array.from({length:N}, () => []);
  const defendersOnCity = Array.from({length:N}, () => []);
  function rebuildIndexes(){
    for(let i=0;i<N;i++){ attackersOnCity[i].length = 0; defendersOnCity[i].length = 0; }
    for(let i=0;i<N;i++){
      for(let r=0;r<outbound[i].length;r++){
        const route = outbound[i][r];
        if(route.isAttack) attackersOnCity[route.targetIdx].push({ srcIdx:i, routeIdx:r });
        else defendersOnCity[route.targetIdx].push({ srcIdx:i, routeIdx:r });
      }
    }
  }
  rebuildIndexes();

  function findCapitalFor(aid){
    if(!aid) return -1;
    const idx = capitalByAlliance.get(aid);
    if(idx === undefined || fallen[idx]) return -1;
    return idx;
  }

  function sendToFieldCooldown(srcIdx, teams, t){
    if(teams <= 0) return;
    teams = Math.floor(teams);
    if(teams <= 0) return;
    let destIdx = srcIdx;
    if(fallen[srcIdx]){
      const cap = findCapitalFor(cityAllianceId[srcIdx]);
      if(cap < 0) return;
      destIdx = cap;
    }
    if(marchSec > 0){
      marchingBack[destIdx].push({ teams, arrivalAt: t + marchSec });
    } else {
      const alignedT = Math.floor(t / COMBAT_TICK) * COMBAT_TICK;
      const readyAt = alignedT + cooldownSec[destIdx];
      cooldownMapField[destIdx].set(readyAt, (cooldownMapField[destIdx].get(readyAt) || 0) + teams);
    }
  }
  function sendToLocalCooldown(destIdx, teams, t){
    if(teams <= 0) return;
    teams = Math.floor(teams);
    if(teams <= 0) return;
    if(fallen[destIdx]){
      const cap = findCapitalFor(cityAllianceId[destIdx]);
      if(cap < 0) return;
      destIdx = cap;
    }
    const alignedT = Math.floor(t / COMBAT_TICK) * COMBAT_TICK;
    const readyAt = alignedT + cooldownSec[destIdx];
    cooldownMapLocal[destIdx].set(readyAt, (cooldownMapLocal[destIdx].get(readyAt) || 0) + teams);
  }

  function processMarching(t){
    for(let i=0;i<N;i++){
      const q = marchingBack[i];
      for(let k = q.length-1; k >= 0; k--){
        if(t >= q[k].arrivalAt){
          const destIdx = fallen[i] ? (findCapitalFor(cityAllianceId[i]) ?? -1) : i;
          if(destIdx >= 0){
            const readyAt = t + cooldownSec[destIdx];
            cooldownMapField[destIdx].set(readyAt, (cooldownMapField[destIdx].get(readyAt) || 0) + q[k].teams);
          }
          q.splice(k, 1);
        }
      }
    }
    for(let i=0;i<N;i++){
      const q = marchingOut[i];
      for(let k = q.length-1; k >= 0; k--){
        if(t >= q[k].arrivalAt){
          const route = outbound[i].find(r =>
            r.targetIdx === q[k].targetIdx && r.isAttack === q[k].isAttack
          );
          if(route){
            route.count += q[k].teams;
            if(!route.hasArrived){
              route.hasArrived = true;
              narrativeLines.push({ type:'info', text:`【${fmtAbsTime(t)}】${cityName[i]} 的部隊抵達 ${cityName[route.targetIdx]}，戰鬥打響。` });
            }
          }
          q.splice(k, 1);
        }
      }
    }
  }

  function pushMarchingOut(srcIdx, routeIdx, teams, t){
    if(teams <= 0) return;
    if(marchSec > 0){
      const r = outbound[srcIdx][routeIdx];
      marchingOut[srcIdx].push({
        teams, arrivalAt: t + marchSec,
        targetIdx: r.targetIdx, isAttack: r.isAttack,
      });
    } else {
      outbound[srcIdx][routeIdx].count += teams;
    }
  }

  function processCooldown(t){
    for(let i=0;i<N;i++){
      if(fallen[i]) continue;
      const map = cooldownMapLocal[i];
      let revived = 0;
      for(const [readyAt, teams] of map){ if(t >= readyAt){ revived += teams; map.delete(readyAt); } }
      if(revived > 0) atHome[i] += revived;
    }
    for(let i=0;i<N;i++){
      if(fallen[i]) continue;
      const map = cooldownMapField[i];
      let revived = 0;
      for(const [readyAt, teams] of map){ if(t >= readyAt){ revived += teams; map.delete(readyAt); } }
      if(revived <= 0) continue;
      if(outbound[i].length === 0){ atHome[i] += revived; continue; }
      const sorted = outbound[i].map((route, rIdx) => ({ route, rIdx }))
        .filter(x => (x.route.postRevivePercent || 0) > 0)
        .sort((a, b) => (a.route.priority || 99) - (b.route.priority || 99));
      let remaining = revived;
      for(const item of sorted){
        if(remaining <= 0) break;
        const share = Math.floor(revived * item.route.postRevivePercent / 100);
        const assign = Math.min(share, remaining);
        if(assign > 0){
          pushMarchingOut(i, item.rIdx, assign, t);
          remaining -= assign;
          narrativeLines.push({ type:'revive', text:`【${fmtAbsTime(t)}】${cityName[i]} 的復活部隊集結完畢（${assign} 隊），再次出發前往 ${cityName[item.route.targetIdx]}。` });
        }
      }
      if(remaining > 0) atHome[i] += remaining;
    }
  }

  function combatRound(t){
    for(let dIdx=0; dIdx<N; dIdx++){
      if(fallen[dIdx]) continue;
      if(t < defStartSecArr[dIdx] || t > defenseEndSecArr[dIdx]) continue;
      const activeAttackLines = [];
      for(const {srcIdx, routeIdx} of attackersOnCity[dIdx]){
        if(fallen[srcIdx]) continue;
        const route = outbound[srcIdx][routeIdx];
        if(route.count <= 0) continue;
        if(t < route.activeFrom || t > route.activeUntil) continue;
        activeAttackLines.push({ srcIdx, routeIdx, route, attackerCount: route.count });
      }
      if(activeAttackLines.length === 0) continue;

      if(t % 60 === 0){
        for(const line of activeAttackLines){
          const aP = avgPower[line.srcIdx];
          const dP = avgPower[dIdx];
          const ratio = Math.min(aP, dP) / Math.max(aP, dP);
          const pMax = 0.1 + 0.8 * (1 - ratio);
          const isMax = Math.random() < pMax;
          line.route.consumeThisMin = isMax ? consumeMax : consumeMin;
        }
      }

      let totalDef = atHome[dIdx];
      const defLines = [];
      for(const {srcIdx, routeIdx} of defendersOnCity[dIdx]){
        if(fallen[srcIdx]) continue;
        const route = outbound[srcIdx][routeIdx];
        if(route.count <= 0) continue;
        if(t < route.activeFrom || t > route.activeUntil) continue;
        defLines.push({ srcIdx, routeIdx, route, count: route.count });
        totalDef += route.count;
      }

      if(totalDef === 0 && !fallen[dIdx] && !cityHasBeenWarned[dIdx] && activeAttackLines.length > 0){
        cityHasBeenWarned[dIdx] = 1;
        narrativeLines.push({ type:'warn', text:`【${fmtAbsTime(t)}】⚠️ ${cityName[dIdx]} 的守軍全數陣亡，城牆暴露在敵軍面前！` });
      }

      activeAttackLines.sort((a,b) => b.attackerCount - a.attackerCount);
      let remainingDef = totalDef;
      for(const line of activeAttackLines){
        const assigned = Math.min(remainingDef, line.attackerCount);
        line.defAssigned = assigned;
        remainingDef -= assigned;
      }

      let totalDLoss = 0;
      for(const line of activeAttackLines){
        if(line.defAssigned <= 0) continue;
        const halfConsume = (line.route.consumeThisMin || consumeMin) / 2;
        const aP = avgPower[line.srcIdx];
        const dP = avgPower[dIdx];
        const totAvg = aP + dP;
        let aRatio = clamp(dP / totAvg, minRatio, maxRatio);
        let dRatio = clamp(aP / totAvg, minRatio, maxRatio);
        line.route.lossAcc += halfConsume * aRatio;
        const aKills = Math.floor(line.route.lossAcc);
        if(aKills > 0){
          const actual = Math.min(aKills, line.route.count);
          line.route.lossAcc -= actual;
          line.route.count -= actual;
          sendToFieldCooldown(line.srcIdx, actual, t);
        }
        totalDLoss += halfConsume * dRatio;
      }

      let totalDKills = Math.floor(totalDLoss);
      defLossAcc[dIdx] += totalDLoss - totalDKills;
      if(defLossAcc[dIdx] >= 1){
        const extra = Math.floor(defLossAcc[dIdx]);
        totalDKills += extra;
        defLossAcc[dIdx] -= extra;
      }
      for(const dl of defLines){
        if(totalDKills <= 0) break;
        const deduct = Math.min(dl.route.count, totalDKills);
        dl.route.count -= deduct;
        totalDKills -= deduct;
        sendToFieldCooldown(dl.srcIdx, deduct, t);
      }
      if(totalDKills > 0 && atHome[dIdx] > 0){
        const deduct = Math.min(atHome[dIdx], totalDKills);
        atHome[dIdx] -= deduct;
        totalDKills -= deduct;
        sendToLocalCooldown(dIdx, deduct, t);
      }

      let totalSiege = 0;
      for(const line of activeAttackLines){
        const currentCount = line.route.count;
        const siegeTeams = currentCount - line.defAssigned;
        if(siegeTeams > 0) totalSiege += siegeTeams;
      }
      if(totalSiege > 0 && wallSec[dIdx] > 0){
        wallSec[dIdx] -= totalSiege * siegeEff * COMBAT_TICK;
        if(wallSec[dIdx] <= 0){
          wallSec[dIdx] = 0;
          fallen[dIdx] = 1;
          narrativeLines.push({ type:'capture', text:`【${fmtAbsTime(t)}】💥 ${cityName[dIdx]} 城牆歸零，城池正式淪陷！` });
          atHome[dIdx] = 0;
          const cap = findCapitalFor(cityAllianceId[dIdx]);
          if(cap >= 0){
            for(const [readyAt, teams] of cooldownMapLocal[dIdx]) cooldownMapLocal[cap].set(readyAt, (cooldownMapLocal[cap].get(readyAt) || 0) + teams);
            cooldownMapLocal[dIdx].clear();
            for(const [readyAt, teams] of cooldownMapField[dIdx]) cooldownMapField[cap].set(readyAt, (cooldownMapField[cap].get(readyAt) || 0) + teams);
            cooldownMapField[dIdx].clear();
          } else {
            cooldownMapLocal[dIdx].clear();
            cooldownMapField[dIdx].clear();
          }
          for(let i=0;i<N;i++){
            if(i === dIdx){ outbound[i].length = 0; continue; }
            const keep = [];
            for(let rIdx=0; rIdx<outbound[i].length; rIdx++){
              if(outbound[i][rIdx].targetIdx !== dIdx) keep.push(outbound[i][rIdx]);
            }
            outbound[i] = keep;
          }
          for(const q of marchingOut[dIdx]){ if(cap >= 0) cooldownMapField[cap].set(t + cooldownSec[cap], (cooldownMapField[cap].get(t + cooldownSec[cap]) || 0) + q.teams); }
          marchingOut[dIdx].length = 0;
          for(const q of marchingBack[dIdx]){ if(cap >= 0) cooldownMapField[cap].set(t + cooldownSec[cap], (cooldownMapField[cap].get(t + cooldownSec[cap]) || 0) + q.teams); }
          marchingBack[dIdx].length = 0;
          for(let i=0;i<N;i++){
            if(i === dIdx) continue;
            const q = marchingOut[i];
            for(let k=q.length-1; k>=0; k--){
              if(q[k].targetIdx === dIdx){
                marchingBack[i].push({ teams: q[k].teams, arrivalAt: q[k].arrivalAt });
                q.splice(k, 1);
              }
            }
          }
          rebuildIndexes();
        }
      }
    }
  }

  function emitSnapshot(sec){
    if(!onSnapshot) return;
    const snap = new Array(N);
    for(let i=0;i<N;i++){
      let outCnt = 0; for(const r of outbound[i]) outCnt += r.count;
      let localCd = 0; for(const v of cooldownMapLocal[i].values()) localCd += v;
      let fieldCd = 0; for(const v of cooldownMapField[i].values()) fieldCd += v;
      let mo = 0, mb = 0;
      for(const q of marchingOut[i]) mo += q.teams;
      for(const q of marchingBack[i]) mb += q.teams;
      let siegeTeams = 0, siegeLines = 0;
      if(!fallen[i] && sec >= defStartSecArr[i] && sec <= defenseEndSecArr[i]){
        for(const {srcIdx, routeIdx} of attackersOnCity[i]){
          if(fallen[srcIdx]) continue;
          const r = outbound[srcIdx][routeIdx];
          if(r.count > 0 && sec >= r.activeFrom && sec <= r.activeUntil){ siegeTeams += r.count; siegeLines++; }
        }
      }
      snap[i] = { id: cityId[i], r: atHome[i], o: outCnt, c: localCd + fieldCd, w: wallSec[i], f: fallen[i], si: siegeTeams, sl: siegeLines };
    }
    onSnapshot(sec, snap);
  }

  function emitDynSample(sec){
    if(!onDynSample) return;
    const rows = [];
    for(let sIdx=0; sIdx<N; sIdx++){
      for(let rIdx=0; rIdx<outbound[sIdx].length; rIdx++){
        const route = outbound[sIdx][rIdx];
        const tIdx = route.targetIdx;
        if(sec < route.activeFrom && route.count <= 0) continue;
        let srcFieldCd = 0; for(const v of cooldownMapField[sIdx].values()) srcFieldCd += v;
        let srcMarchBack = 0; for(const q of marchingBack[sIdx]) srcMarchBack += q.teams;
        let tgtLocalCd = 0; for(const v of cooldownMapLocal[tIdx].values()) tgtLocalCd += v;
        let tgtMarchBack = 0; for(const q of marchingBack[tIdx]) tgtMarchBack += q.teams;
        rows.push({
          sec,
          srcCity: cityName[sIdx], srcId: cityId[sIdx], srcSide: citySide[sIdx],
          isAttack: route.isAttack,
          tgtCity: cityName[tIdx], tgtId: cityId[tIdx], tgtSide: citySide[tIdx],
          zoneId: cityZoneId[sIdx],
          consumeThisMin: route.consumeThisMin,
          ownRemain: Math.round(route.count),
          ownCd: Math.round(srcFieldCd),
          ownMarch: Math.round(srcMarchBack),
          tgtRemain: Math.round(atHome[tIdx]),
          tgtCd: Math.round(tgtLocalCd),
          tgtMarch: Math.round(tgtMarchBack),
          wallSec: wallSec[tIdx],
          tgtFallen: !!fallen[tIdx],
        });
      }
    }
    onDynSample(sec, rows);
  }

  let chunkCount = 0;
  const totalTicksEst = totalSimSec + 1;
  const criticalEvents = [];
  let t = 0;

  while(t <= totalSimSec){
    if(shouldAbort && shouldAbort()) return {criticalEvents, aborted:true, minDefStartMin, totalSimSec, narrativeLines};
    if(chunkCount >= SIM_CHUNK){
      chunkCount = 0;
      if(onProgress) onProgress({progress: t / totalTicksEst, t});
      await yieldToMain();
    }
    processMarching(t);
    processCooldown(t);
    if(t > 0 && t % COMBAT_TICK === 0) combatRound(t);
    t++;
    chunkCount++;
    if(snapshotAt.has(t)) emitSnapshot(t);
    if(dynSampleAt.has(t)) emitDynSample(t);
  }

  if(onProgress) onProgress({progress: 1, t});

  const finalStates = [];
  for(let i=0;i<N;i++){
    let outCnt = 0; for(const r of outbound[i]) outCnt += r.count;
    let lc = 0; for(const v of cooldownMapLocal[i].values()) lc += v;
    let fc = 0; for(const v of cooldownMapField[i].values()) fc += v;
    let mb = 0; for(const q of marchingBack[i]) mb += q.teams;
    let mo = 0; for(const q of marchingOut[i]) mo += q.teams;
    finalStates.push({ id: cityId[i], name: cityName[i], atHome: Math.round(atHome[i]), outbound: Math.round(outCnt), cooldown: lc + fc, marchingBack: mb, marchingOut: mo, wallSec: wallSec[i], fallen: !!fallen[i] });
  }
  return { criticalEvents, aborted:false, minDefStartMin, totalSimSec, finalStates, narrativeLines };
}

/* ============================================================================
 * Web Worker 封裝
 * ========================================================================== */
const WORKER_SOURCE = `
const hhmmToMinutes = ${hhmmToMinutes.toString()};
const minutesToHHMM = ${minutesToHHMM.toString()};
const computeAllocation = ${computeAllocation.toString()};
const yieldToMain = ${yieldToMain.toString()};
const fmtSimTime = ${fmtSimTime.toString()};
const clamp = ${clamp.toString()};
const COMBAT_TICK = 30;
const runSimulation = ${runSimulation.toString()};
const SIM_CHUNK = 500;
self.onmessage = async (e) => {
  const { type, payload } = e.data || {};
  if(type === 'abort'){ self.__abort = true; return; }
  if(type !== 'run') return;
  const { cities, settings, snapshotsAt, dynSampleAt, runId } = payload;
  const snapSet = new Set(snapshotsAt || []);
  const dynSet = new Set(dynSampleAt || []);
  try {
    const result = await runSimulation(cities, settings, {
      onProgress: ({progress, t}) => self.postMessage({type:'progress', runId, progress, t}),
      shouldAbort: () => self.__abort === true,
      snapshotAt: snapSet,
      onSnapshot: (sec, snap) => self.postMessage({type:'snapshot', runId, sec, snap}),
      dynSampleAt: dynSet,
      onDynSample: (sec, rows) => self.postMessage({type:'dyn_sample', runId, sec, rows}),
    });
    self.postMessage({type:'done', runId, result});
  } catch(err){
    self.postMessage({type:'error', runId, error: String(err && err.stack || err)});
  }
};
`;

let simWorker = null;
let simWorkerUrl = null;
let simWorkerAvailable = null;
let simRunId = 0;

function getWorker(){
  if(simWorkerAvailable === false) return null;
  if(simWorker) return simWorker;
  try{
    const blob = new Blob([WORKER_SOURCE], {type:'application/javascript'});
    simWorkerUrl = URL.createObjectURL(blob);
    simWorker = new Worker(simWorkerUrl);
    simWorkerAvailable = true;
    console.log('%c[Worker] 已啟動', 'color:#22ff88;font-weight:bold');
    return simWorker;
  }catch(e){
    simWorkerAvailable = false; simWorker = null;
    if(simWorkerUrl){ try{ URL.revokeObjectURL(simWorkerUrl); }catch(_){} simWorkerUrl = null; }
    console.warn('%c[Worker] 無法啟動，改用主執行緒同步模式', 'color:#ffcc00;font-weight:bold', e.message);
    return null;
  }
}

function releaseWorker(){
  if(simWorkerUrl){ try{ URL.revokeObjectURL(simWorkerUrl); }catch(_){} simWorkerUrl = null; }
}

/* ── 暴露到全域 ── */
Object.assign(window.SLG, {
  COMBAT_TICK, SIM_CHUNK, VIZ_SNAPSHOT_INTERVAL, DYN_ROUTE_SAMPLE_SEC,
  hhmmToMinutes, minutesToHHMM, fmtSimTime, clamp, yieldToMain,
  computeAllocation,
  runSimulation,
  getWorker, releaseWorker,
  get simRunId(){ return simRunId; },
  set simRunId(v){ simRunId = v; },
  bumpSimRunId(){ return ++simRunId; },
});

})();
