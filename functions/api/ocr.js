/* ============================================================================
 * functions/api/ocr.js — v8.9.3
 * Gemini API 代理（使用 Durable Object 繞過地區限制）
 * 
 * 路徑：POST /api/ocr
 * 請求：{ imageBase64, prompt, mimeType }
 * 回應：{ cities: [...], routes: [...] } 或 { name, code } 或 { error }
 * ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/* ============================================================================
 * Durable Object：固定路由到美國西部，繞過 Gemini 地區限制
 * ========================================================================== */
export class GeminiProxy {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      /* ── 解析請求 ── */
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { imageBase64, prompt, mimeType } = body || {};

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return jsonResponse({ error: 'Missing imageBase64' }, 400);
      }
      if (!prompt || typeof prompt !== 'string') {
        return jsonResponse({ error: 'Missing prompt' }, 400);
      }

      /* ── 讀取環境變數 ── */
      const apiKey = this.env.GEMINI_API_KEY;
      if (!apiKey) {
        return jsonResponse({
          error: 'Server not configured',
          detail: 'GEMINI_API_KEY missing in Pages environment variables',
        }, 500);
      }

      /* ── 模型名稱（預設 gemini-2.5-flash）── */
      const model = this.env.GEMINI_MODEL || 'gemini-2.5-flash';

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const geminiBody = {
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType || 'image/jpeg',
                data: imageBase64,
              },
            },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      };

      /* ── 呼叫 Gemini ── */
      const geminiResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiResp.ok) {
        let detail = '';
        try {
          const errJson = await geminiResp.json();
          detail = errJson.error?.message || JSON.stringify(errJson);
        } catch (e) {
          detail = await geminiResp.text();
        }
        return jsonResponse({
          error: 'Gemini API error',
          status: geminiResp.status,
          detail: detail,
          model: model,
          from: 'us-west',  // 標示 Durable Object 位置
        }, 502);
      }

      /* ── 解析回應 ── */
      const data = await geminiResp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

      let parsed;
      try {
        let cleanText = text.trim();
        if (cleanText.startsWith('```json')) {
          cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanText.startsWith('```')) {
          cleanText = cleanText.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        parsed = JSON.parse(cleanText);
      } catch (e) {
        parsed = { raw: text, parseError: e.message };
      }

      return jsonResponse(parsed, 200);

    } catch (e) {
      return jsonResponse({
        error: 'GeminiProxy exception',
        message: e.message,
        stack: e.stack,
      }, 500);
    }
  }
}

/* ============================================================================
 * Pages Function 入口
 * ========================================================================== */
export async function onRequest(context) {
  const { request, env } = context;

  /* ── OPTIONS 預檢 ── */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  /* ── 只接受 POST ── */
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  /* ── 檢查 Durable Object 綁定 ── */
  if (!env.GEMINI_PROXY) {
    return jsonResponse({
      error: 'Durable Object not bound',
      detail: '請確認 wrangler.toml 已正確配置 GEMINI_PROXY 綁定',
      hint: '參考交付說明中的 wrangler.toml 範例',
    }, 500);
  }

  /* ── 轉發到 Durable Object（固定美國西部）── */
  try {
    const id = env.GEMINI_PROXY.idFromName('global-gemini-proxy');
    let stub;
    try {
      stub = env.GEMINI_PROXY.get(id, { locationHint: 'wnam' });
    } catch (e) {
      /* 若 runtime 不支援 locationHint，退回一般 get */
      stub = env.GEMINI_PROXY.get(id);
    }
    return await stub.fetch(request);
  } catch (e) {
    return jsonResponse({
      error: 'Durable Object binding failed',
      message: e.message,
      hint: '請確認 wrangler.toml 已正確配置 GEMINI_PROXY 綁定',
    }, 500);
  }
}
