/* ============================================================================
 * geminiOcr.js — v8.9.1
 * Gemini AI 辨識封裝（透過 Cloudflare Pages Function /api/ocr 呼叫）
 *  - 全圖辨識（3×3 切片）
 *  - 單點辨識（點擊裁切）
 *  - 自動去重
 *  - 座標換算
 * ========================================================================== */
(function(){
'use strict';

window.SLG = window.SLG || {};

/* ============================================================
   常數
   ============================================================ */
const GEMINI_OCR_ENDPOINT = '/api/ocr';   /* Cloudflare Pages Function 路徑 */
const GEMINI_SLICE_N = 3;                  /* 3×3 切片 */
const GEMINI_SLICE_OVERLAP = 0.10;         /* 切片重疊比例（10%）*/
const GEMINI_REQUEST_TIMEOUT = 60000;      /* 60 秒 */
const GEMINI_MAX_IMAGE_SIZE = 4 * 1024 * 1024;  /* 單次上傳 ≤ 4 MB */

/* ============================================================
   工具：圖片轉 base64（去掉 data:image/... 前綴）
   ============================================================ */
function canvasToBase64(canvas, mimeType, quality){
  const dataUrl = canvas.toDataURL(mimeType || 'image/jpeg', quality !== undefined ? quality : 0.85);
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/* ============================================================
   工具：延遲
   ============================================================ */
function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   工具：解析 AI 回傳 JSON（可能含 markdown fence）
   ============================================================ */
function parseAiJson(text){
  if(!text) return null;
  let s = String(text).trim();
  /* 移除 markdown code fence */
  s = s.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  s = s.replace(/^```\s*/, '').replace(/\s*```$/, '');
  /* 嘗試直接 parse */
  try{
    return JSON.parse(s);
  }catch(e){}
  /* 嘗試抓第一個 { ... } 或 [ ... ] */
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  let start = -1;
  if(firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else if(firstBrace >= 0) start = firstBrace;
  else if(firstBracket >= 0) start = firstBracket;
  if(start < 0) return null;
  /* 找對應的結尾 */
  const isObj = s[start] === '{';
  const endChar = isObj ? '}' : ']';
  const end = s.lastIndexOf(endChar);
  if(end <= start) return null;
  try{
    return JSON.parse(s.slice(start, end + 1));
  }catch(e){
    return null;
  }
}

/* ============================================================
   核心：呼叫 Cloudflare Pages Function
   ============================================================ */
async function callGeminiProxy(imageBase64, prompt, mimeType, timeoutMs){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || GEMINI_REQUEST_TIMEOUT);
  try{
    const resp = await fetch(GEMINI_OCR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64,
        prompt,
        mimeType: mimeType || 'image/jpeg',
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if(!resp.ok){
      let errText = '';
      try{
        const errJson = await resp.json();
        errText = errJson.error || errJson.detail || JSON.stringify(errJson);
      }catch(e){
        errText = await resp.text();
      }
      throw new Error(`HTTP ${resp.status}：${errText}`);
    }
    const data = await resp.json();
    if(data.error){
      throw new Error(data.error + (data.detail ? '：' + data.detail : ''));
    }
    return data;
  }catch(e){
    clearTimeout(timeout);
    if(e.name === 'AbortError'){
      throw new Error('AI 請求逾時（超過 ' + Math.round((timeoutMs || GEMINI_REQUEST_TIMEOUT)/1000) + ' 秒）');
    }
    throw e;
  }
}

/* ============================================================
   Prompt 建構
   ============================================================ */

/**
 * 全圖辨識 Prompt
 * @param {number} sliceIndex - 切片編號（0~8）
 * @param {number} totalSlices - 總切片數
 * @param {object} bounds - { x, y, w, h } 該切片在原圖的像素範圍
 */
function buildFullMapPrompt(sliceIndex, totalSlices, bounds){
  return `你是一個三國題材城戰地圖的分析助手。

這是整張地圖的一個切片（第 ${sliceIndex + 1} / ${totalSlices} 塊）。
此切片在原圖的像素範圍是：x: ${bounds.x} ~ ${bounds.x + bounds.w}, y: ${bounds.y} ~ ${bounds.y + bounds.h}。

請找出切片中所有城池標記。每個城池標記的特徵：
- 一個菱形圖示（藍/紫/紅/綠色）
- 旁邊有文字：城池名稱 + (編號)
  例如：「南秦 (L98)」「朱提 (N39)」「堂琅東水寨」

同時找出圖上所有「路線」（連接兩城的線）：
- 藍色實線、黃色虛線、白色虛線等
- 路線連接兩個城池

回傳 JSON 格式：
{
  "cities": [
    {
      "name": "南秦",
      "code": "L98",
      "x": 120,
      "y": 85,
      "confidence": 0.95
    }
  ],
  "routes": [
    {
      "fromName": "南秦",
      "toName": "南秦西",
      "type": "land",
      "color": "blue"
    }
  ]
}

規則：
1. x, y 是「切片內」的像素座標（相對於切片左上角）
2. confidence 是 0~1 的信心分數
3. 若某城池名稱被遮擋看不清，跳過它
4. 座標應該對準「菱形圖示的中心」
5. 路線用「城池名稱」表示兩端
6. 只回傳 JSON，不要任何其他文字或說明
7. 若此切片沒有任何城池，回傳 {"cities": [], "routes": []}`;
}

/**
 * 單點辨識 Prompt（點擊位置裁切）
 */
function buildClickPrompt(){
  return `這是一張三國城戰地圖的一小塊區域。

請辨識圖中顯示的城池名稱與編號。

回傳 JSON 格式：
{
  "name": "朱提",
  "code": "N39",
  "confidence": 0.95
}

規則：
1. 若圖中有多個城池，只回傳最中心的那一個
2. 若圖中沒有城池，回傳 {"name": null, "code": null, "confidence": 0}
3. 只回傳 JSON，不要任何其他文字`;
}

/* ============================================================
   全圖辨識（3×3 切片）
   ============================================================ */
/**
 * @param {HTMLImageElement|HTMLCanvasElement} source - 原始底圖
 * @param {Function} onProgress - (progress: 0~1, text: string) => void
 * @param {Function} shouldAbort - () => boolean
 * @returns {Promise<Object>} { cities: [...], routes: [...] }
 */
async function detectFullMap(source, onProgress, shouldAbort){
  const natW = source.naturalWidth || source.width || 0;
  const natH = source.naturalHeight || source.height || 0;
  if(natW === 0 || natH === 0) throw new Error('圖片尺寸為 0');

  const N = GEMINI_SLICE_N;
  const sliceW = Math.ceil(natW / N);
  const sliceH = Math.ceil(natH / N);
  const overlapPx = Math.round(Math.min(sliceW, sliceH) * GEMINI_SLICE_OVERLAP);
  const totalSlices = N * N;

  const allCities = [];
  const allRoutes = [];
  let sliceIndex = 0;

  for(let row = 0; row < N; row++){
    for(let col = 0; col < N; col++){
      if(shouldAbort && shouldAbort()){
        throw new Error('已取消');
      }
      const idx = row * N + col;
      const baseX = col * sliceW;
      const baseY = row * sliceH;
      const x0 = Math.max(0, baseX - overlapPx);
      const y0 = Math.max(0, baseY - overlapPx);
      const x1 = Math.min(natW, baseX + sliceW + overlapPx);
      const y1 = Math.min(natH, baseY + sliceH + overlapPx);
      const w = x1 - x0;
      const h = y1 - y0;

      if(onProgress){
        const p = 0.05 + 0.9 * (idx / totalSlices);
        onProgress(p, `切片 ${idx + 1}/${totalSlices}：裁切中...`);
      }

      /* ── 裁切切片 ── */
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(source, x0, y0, w, h, 0, 0, w, h);

      /* ── 轉 base64（JPEG 0.85 兼顧品質與大小）── */
      let base64 = canvasToBase64(canvas, 'image/jpeg', 0.85);
      let mime = 'image/jpeg';

      /* 若太大，降品質 */
      let quality = 0.85;
      while(base64.length * 0.75 > GEMINI_MAX_IMAGE_SIZE && quality > 0.4){
        quality -= 0.15;
        base64 = canvasToBase64(canvas, 'image/jpeg', quality);
      }

      if(onProgress){
        const p = 0.05 + 0.9 * ((idx + 0.5) / totalSlices);
        onProgress(p, `切片 ${idx + 1}/${totalSlices}：AI 辨識中...`);
      }

      /* ── 呼叫 API ── */
      const prompt = buildFullMapPrompt(idx, totalSlices, { x: x0, y: y0, w, h });
      let result;
      try{
        result = await callGeminiProxy(base64, prompt, mime, GEMINI_REQUEST_TIMEOUT);
      }catch(e){
        console.warn(`[切片 ${idx + 1}] AI 辨識失敗`, e);
        /* 單切片失敗不中斷整個流程 */
        continue;
      }

      /* ── 解析回傳 ── */
      const parsed = (typeof result === 'object' && result.cities) ? result
                    : parseAiJson(result.raw || '');
      if(!parsed || !Array.isArray(parsed.cities)) continue;

      /* ── 座標換算（切片座標 → 原圖座標）── */
      for(const c of parsed.cities){
        if(!c || !c.name) continue;
        const globalX = Math.round((c.x || 0) + x0);
        const globalY = Math.round((c.y || 0) + y0);
        allCities.push({
          name: String(c.name).trim(),
          code: c.code ? String(c.code).trim() : '',
          x: globalX,
          y: globalY,
          confidence: typeof c.confidence === 'number' ? c.confidence : 0.8,
          sliceIndex: idx,
        });
      }

      /* ── 路線 ── */
      if(Array.isArray(parsed.routes)){
        for(const r of parsed.routes){
          if(!r || !r.fromName || !r.toName) continue;
          allRoutes.push({
            fromName: String(r.fromName).trim(),
            toName: String(r.toName).trim(),
            type: r.type || 'land',
            color: r.color || 'blue',
            sliceIndex: idx,
          });
        }
      }

      sliceIndex++;

      /* ── 避免觸發速率限制，小延遲 ── */
      if(idx < totalSlices - 1){
        await sleep(300);
      }
    }
  }

  if(onProgress) onProgress(0.98, '合併結果 + 去重...');

  /* ── 去重（城市）── */
  const merged = dedupeCities(allCities);

  /* ── 去重（路線）── */
  const mergedRoutes = dedupeRoutes(allRoutes);

  if(onProgress) onProgress(1.0, `完成：${merged.length} 城 / ${mergedRoutes.length} 路線`);

  return { cities: merged, routes: mergedRoutes };
}

/* ============================================================
   單點辨識（點擊位置）
   ============================================================ */
/**
 * @param {HTMLImageElement|HTMLCanvasElement} source - 原始底圖
 * @param {number} centerX - 點擊位置 X（原圖座標）
 * @param {number} centerY - 點擊位置 Y（原圖座標）
 * @param {number} radius - 裁切半徑（像素）
 * @returns {Promise<Object>} { name, code, confidence }
 */
async function detectAtPoint(source, centerX, centerY, radius){
  const natW = source.naturalWidth || source.width || 0;
  const natH = source.naturalHeight || source.height || 0;
  const R = radius || 120;

  const x0 = Math.max(0, centerX - R);
  const y0 = Math.max(0, centerY - R);
  const x1 = Math.min(natW, centerX + R);
  const y1 = Math.min(natH, centerY + R);
  const w = x1 - x0;
  const h = y1 - y0;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, x0, y0, w, h, 0, 0, w, h);

  let base64 = canvasToBase64(canvas, 'image/jpeg', 0.9);
  let quality = 0.9;
  while(base64.length * 0.75 > GEMINI_MAX_IMAGE_SIZE && quality > 0.5){
    quality -= 0.15;
    base64 = canvasToBase64(canvas, 'image/jpeg', quality);
  }

  const prompt = buildClickPrompt();
  const result = await callGeminiProxy(base64, prompt, 'image/jpeg', GEMINI_REQUEST_TIMEOUT);
  const parsed = (typeof result === 'object' && 'name' in result) ? result
                : parseAiJson(result.raw || '');

  if(!parsed || !parsed.name){
    return { name: null, code: null, confidence: 0 };
  }
  return {
    name: String(parsed.name).trim(),
    code: parsed.code ? String(parsed.code).trim() : '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
  };
}

/* ============================================================
   去重：城市
   ============================================================ */
function dedupeCities(cities){
  if(!Array.isArray(cities)) return [];
  const byKey = new Map();
  const DEDUPE_DIST = 40;  /* 40 px 內視為同一座城 */

  for(const c of cities){
    /* 用「名稱」或「編號」作為主要 key */
    const nameKey = c.name || '';
    const codeKey = c.code || '';
    const mainKey = codeKey ? `c:${codeKey}` : `n:${nameKey}`;

    const existing = byKey.get(mainKey);
    if(!existing){
      byKey.set(mainKey, c);
      continue;
    }
    /* 若信心度更高，替換 */
    if((c.confidence || 0) > (existing.confidence || 0)){
      byKey.set(mainKey, c);
    }
  }

  /* 二次去重：不同 key 但座標很接近的，合併（保留信心高者）*/
  const list = [...byKey.values()];
  const merged = [];
  const used = new Set();

  for(let i = 0; i < list.length; i++){
    if(used.has(i)) continue;
    let best = list[i];
    for(let j = i + 1; j < list.length; j++){
      if(used.has(j)) continue;
      const a = list[i], b = list[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if(dist < DEDUPE_DIST){
        /* 同名 → 合併 */
        if(a.name === b.name && a.code === b.code){
          used.add(j);
          if((b.confidence || 0) > (best.confidence || 0)) best = b;
        }
      }
    }
    merged.push(best);
    used.add(i);
  }

  return merged;
}

/* ============================================================
   去重：路線（無向，A-B = B-A）
   ============================================================ */
function dedupeRoutes(routes){
  if(!Array.isArray(routes)) return [];
  const seen = new Set();
  const out = [];
  for(const r of routes){
    const a = r.fromName || '';
    const b = r.toName || '';
    if(!a || !b || a === b) continue;
    /* 排序後作為 key（無向）*/
    const key = [a, b].sort().join('|');
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ============================================================
   工具：圖片壓縮（用於上傳前）
   ============================================================ */
async function compressImage(file, maxDimension, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const maxD = maxDimension || 3072;
        if(w > maxD || h > maxD){
          const ratio = Math.min(maxD / w, maxD / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if(blob) resolve(blob);
          else reject(new Error('壓縮失敗'));
        }, 'image/jpeg', quality || 0.85);
      };
      img.onerror = () => reject(new Error('圖片載入失敗'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   暴露
   ============================================================ */
Object.assign(window.SLG, {
  GEMINI_OCR_ENDPOINT,
  GEMINI_SLICE_N,
  GEMINI_SLICE_OVERLAP,
  GEMINI_MAX_IMAGE_SIZE,
  callGeminiProxy,
  buildFullMapPrompt,
  buildClickPrompt,
  detectFullMap,
  detectAtPoint,
  dedupeCities,
  dedupeRoutes,
  parseAiJson,
  canvasToBase64,
  compressImage,
});

})();