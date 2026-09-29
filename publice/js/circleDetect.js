/* ============================================================================
 * circleDetect.js — v8.9.0
 * 彩色菱形 / 圓形偵測（供節點校準用）
 *  - 純前端 Canvas 像素分析
 *  - Web Worker 執行，不卡 UI
 *  - 支援：顏色篩選 + 形狀偵測 + 附近文字驗證
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

/* ============================================================
   常數
   ============================================================ */
const CD_DEFAULTS = {
  /* 顏色條件（HSV 範圍） */
  minSaturation: 0.25,      /* 最小飽和度 */
  minValue: 0.35,           /* 最小亮度 */
  maxValue: 1.0,            /* 最大亮度（排除純白） */
  /* 形狀條件 */
  minArea: 60,              /* 最小候選面積（像素） */
  maxArea: 1200,            /* 最大候選面積 */
  minSize: 8,               /* 最小邊長 */
  maxSize: 40,              /* 最大邊長 */
  maxAspect: 1.6,           /* 最大寬高比（含菱形） */
  /* 連通性 */
  minDensity: 0.3,          /* 內部密度（實心程度） */
  /* 文字驗證 */
  textSearchRadius: 80,     /* 文字搜尋半徑（像素） */
  minTextPixels: 30,        /* 附近最小白色像素數 */
  /* 去重 */
  dedupeDist: 18,           /* 距離小於此值視為同一候選 */
};

/* ============================================================
   工具：RGB → HSV
   ============================================================ */
function rgbToHsv(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if(d !== 0){
    if(max === r) h = ((g - b) / d) % 6;
    else if(max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if(h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

/* ============================================================
   檢查像素是否為「候選色」（彩色、非灰、非背景）
   ============================================================ */
function isCandidateColor(r, g, b, opts){
  const { s, v } = rgbToHsv(r, g, b);
  if(s < opts.minSaturation) return false;
  if(v < opts.minValue) return false;
  if(v > opts.maxValue) return false;
  /* 排除背景深藍色（B 明顯大於 R 且 G 且整體偏暗） */
  if(b > r && b > g && v < 0.55 && b - r > 30) return false;
  return true;
}

/* ============================================================
   檢查像素是否為「白色文字」（用於驗證附近有文字）
   ============================================================ */
function isWhiteText(r, g, b){
  return r > 200 && g > 200 && b > 200;
}

/* ============================================================
   主要偵測函式（在 Worker 內執行）
   @param {ImageData} imgData
   @param {Object} opts
   @returns {Array} [{id, x, y, radius, type, confidence}]
   ============================================================ */
function detectCandidates(imgData, opts){
  opts = Object.assign({}, CD_DEFAULTS, opts || {});
  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;

  /* ── Step 1：產生「候選色」遮罩 ── */
  const mask = new Uint8Array(w * h);
  for(let i = 0; i < w * h; i++){
    const idx = i * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    if(isCandidateColor(r, g, b, opts)) mask[i] = 1;
  }

  /* ── Step 2：連通區域分析（flood fill）── */
  const visited = new Uint8Array(w * h);
  const regions = [];

  for(let y = 0; y < h; y++){
    for(let x = 0; x < w; x++){
      const i = y * w + x;
      if(!mask[i] || visited[i]) continue;

      /* BFS flood fill */
      const stack = [[x, y]];
      const pixels = [];
      visited[i] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;

      while(stack.length > 0){
        const [cx, cy] = stack.pop();
        const ci = cy * w + cx;
        pixels.push(ci);
        if(cx < minX) minX = cx;
        if(cx > maxX) maxX = cx;
        if(cy < minY) minY = cy;
        if(cy > maxY) maxY = cy;

        /* 4 鄰域 */
        const neighbors = [
          [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]
        ];
        for(const [nx, ny] of neighbors){
          if(nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if(!visited[ni] && mask[ni]){
            visited[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      /* 過濾：大小範圍 */
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const area = pixels.length;
      if(bw < opts.minSize || bh < opts.minSize) continue;
      if(bw > opts.maxSize || bh > opts.maxSize) continue;
      if(area < opts.minArea || area > opts.maxArea) continue;
      const aspect = Math.max(bw / bh, bh / bw);
      if(aspect > opts.maxAspect) continue;

      /* 檢查密度（避免空框） */
      const density = area / (bw * bh);
      if(density < opts.minDensity) continue;

      /* 中心點 */
      const cx0 = (minX + maxX) / 2;
      const cy0 = (minY + maxY) / 2;

      /* 判斷形狀類型（用簡單啟發式）：
         圓形：寬高比接近 1，面積/π 開根號 ≈ 半徑，半徑 ≈ 寬/2
         菱形：面積 ≈ (對角線乘積)/2 ≈ (寬×高)/2，密度約 0.5
      */
      const densityIdealCircle = Math.PI / 4;   /* 圓形內接於方形：π/4 ≈ 0.785 */
      const densityIdealDiamond = 0.5;          /* 菱形：對角線方形：0.5 */

      const distCircle = Math.abs(density - densityIdealCircle);
      const distDiamond = Math.abs(density - densityIdealDiamond);
      const type = distCircle < distDiamond ? 'circle' : 'diamond';

      /* 信心分數（1.0 最好） */
      let confidence = 1.0;
      confidence -= Math.min(distCircle, distDiamond) * 1.2;
      if(aspect > 1.2) confidence -= (aspect - 1.2) * 0.3;
      confidence = Math.max(0.3, Math.min(1.0, confidence));

      regions.push({
        minX, maxX, minY, maxY,
        cx: cx0, cy: cy0,
        w: bw, h: bh,
        area,
        density,
        type,
        confidence,
      });
    }
  }

  /* ── Step 3：附近文字驗證 ── */
  const validRegions = [];
  for(const r of regions){
    const hasText = checkNearbyText(data, w, h, r, opts);
    if(hasText) validRegions.push(r);
  }

  /* ── Step 4：去重 ── */
  const deduped = [];
  for(const r of validRegions){
    let merged = false;
    for(const d of deduped){
      const dx = d.cx - r.cx;
      const dy = d.cy - r.cy;
      if(Math.hypot(dx, dy) < opts.dedupeDist){
        /* 保留信心分數較高者 */
        if(r.confidence > d.confidence){
          Object.assign(d, r);
        }
        merged = true;
        break;
      }
    }
    if(!merged) deduped.push(r);
  }

  /* ── Step 5：排序（信心分數高的優先）── */
  deduped.sort((a, b) => b.confidence - a.confidence);

  /* ── Step 6：產生最終結果（含唯一 ID）── */
  return deduped.map((r, i) => ({
    id: 'c_' + i.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    x: Math.round(r.cx),
    y: Math.round(r.cy),
    w: r.w,
    h: r.h,
    radius: Math.round(Math.max(r.w, r.h) / 2),
    type: r.type,
    confidence: Math.round(r.confidence * 100) / 100,
    source: 'auto',
  }));
}

/* ============================================================
   檢查候選附近是否有白色文字像素
   ============================================================ */
function checkNearbyText(data, w, h, region, opts){
  const R = opts.textSearchRadius;
  const x0 = Math.max(0, region.minX - R);
  const x1 = Math.min(w - 1, region.maxX + R);
  const y0 = Math.max(0, region.minY - R);
  const y1 = Math.min(h - 1, region.maxY + R);

  let count = 0;
  const step = 2;   /* 每 2 px 採樣一次，加速 */
  for(let y = y0; y <= y1; y += step){
    for(let x = x0; x <= x1; x += step){
      /* 跳過候選本身的區域 */
      if(x >= region.minX && x <= region.maxX &&
         y >= region.minY && y <= region.maxY) continue;
      const idx = (y * w + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      if(isWhiteText(r, g, b)){
        count++;
        if(count >= opts.minTextPixels) return true;
      }
    }
  }
  return count >= opts.minTextPixels;
}

/* ============================================================
   Web Worker 封裝
   ============================================================ */
const WORKER_SOURCE = `
  const CD_DEFAULTS = ${JSON.stringify(CD_DEFAULTS)};
  const rgbToHsv = ${rgbToHsv.toString()};
  const isCandidateColor = ${isCandidateColor.toString()};
  const isWhiteText = ${isWhiteText.toString()};
  const detectCandidates = ${detectCandidates.toString()};
  const checkNearbyText = ${checkNearbyText.toString()};

  self.onmessage = (e) => {
    const msg = e.data || {};
    if(msg.type === 'detect'){
      try{
        const { imgData, opts, runId } = msg;
        /* imgData 從主執行緒傳入（結構化複製） */
        const result = detectCandidates(imgData, opts || {});
        self.postMessage({ type:'done', runId, candidates: result });
      }catch(err){
        self.postMessage({ type:'error', runId: msg.runId, error: String(err && err.stack || err) });
      }
    }
  };
`;

let cdWorker = null;
let cdWorkerUrl = null;
let cdWorkerAvailable = null;
let cdRunId = 0;

function getCdWorker(){
  if(cdWorkerAvailable === false) return null;
  if(cdWorker) return cdWorker;
  try{
    const blob = new Blob([WORKER_SOURCE], { type:'application/javascript' });
    cdWorkerUrl = URL.createObjectURL(blob);
    cdWorker = new Worker(cdWorkerUrl);
    cdWorkerAvailable = true;
    console.log('%c[CircleDetect Worker] 已啟動', 'color:#22ff88;font-weight:bold');
    return cdWorker;
  }catch(e){
    cdWorkerAvailable = false;
    cdWorker = null;
    if(cdWorkerUrl){ try{ URL.revokeObjectURL(cdWorkerUrl); }catch(_){} cdWorkerUrl = null; }
    console.warn('%c[CircleDetect] Worker 無法啟動，改用主執行緒同步模式', 'color:#ffcc00;font-weight:bold', e.message);
    return null;
  }
}

function releaseCdWorker(){
  if(cdWorkerUrl){
    try{ URL.revokeObjectURL(cdWorkerUrl); }catch(_){}
    cdWorkerUrl = null;
  }
  if(cdWorker){
    try{ cdWorker.terminate(); }catch(_){}
    cdWorker = null;
    cdWorkerAvailable = null;
  }
}

/* ============================================================
   公開 API
   ============================================================ */

/**
 * 偵測圖片中的菱形/圓形候選
 * @param {HTMLImageElement|HTMLCanvasElement} source - 圖片或畫布
 * @param {Object} opts - 選項（可選）
 * @param {Function} onProgress - (progress: 0~1, text: string) => void
 * @returns {Promise<Array>} 候選陣列
 */
async function detectFromImage(source, opts, onProgress){
  return new Promise((resolve, reject) => {
    if(!source) { reject(new Error('缺少圖片來源')); return; }

    /* ── 準備離屏畫布 ── */
    const w = source.naturalWidth || source.width || 0;
    const h = source.naturalHeight || source.height || 0;
    if(w === 0 || h === 0){ reject(new Error('圖片尺寸為 0')); return; }

    let canvas;
    try{
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0);
      if(onProgress) onProgress(0.1, '讀取圖片像素...');
      const imgData = ctx.getImageData(0, 0, w, h);
      if(onProgress) onProgress(0.2, '分析顏色與形狀...');

      /* ── 用 Worker 或主執行緒執行 ── */
      const worker = getCdWorker();
      if(worker){
        const runId = ++cdRunId;
        const handler = (e) => {
          const msg = e.data || {};
          if(msg.runId !== runId) return;
          worker.removeEventListener('message', handler);
          if(msg.type === 'done'){
            if(onProgress) onProgress(1.0, `完成，找到 ${msg.candidates.length} 個候選`);
            resolve(msg.candidates || []);
          } else if(msg.type === 'error'){
            reject(new Error(msg.error || '未知錯誤'));
          }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type:'detect', runId, imgData, opts: opts || CD_DEFAULTS });
        if(onProgress) onProgress(0.3, '正在偵測候選...');
        return;
      }

      /* 主執行緒備援 */
      if(onProgress) onProgress(0.3, '正在偵測候選...');
      setTimeout(() => {
        try{
          const result = detectCandidates(imgData, opts || {});
          if(onProgress) onProgress(1.0, `完成，找到 ${result.length} 個候選`);
          resolve(result);
        }catch(err){ reject(err); }
      }, 20);

    }catch(e){
      /* 可能是 CORS 導致 getImageData 失敗 */
      if(e && e.name === 'SecurityError'){
        reject(new Error('圖片跨域限制，無法讀取像素。\n請確認圖片來源允許 CORS。'));
      } else {
        reject(e);
      }
    }
  });
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  CD_DEFAULTS,
  rgbToHsv,
  detectCandidates,
  detectFromImage,
  getCdWorker,
  releaseCdWorker,
});

})();
