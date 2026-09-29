/* ============================================================================
 * functions/api/ocr.js — v8.9.1
 * Cloudflare Pages Function：Gemini API 代理（隱藏 API Key）
 * 
 * 路徑：POST /api/ocr
 * 請求：{ imageBase64, prompt, mimeType }
 * 回應：{ cities: [...], routes: [...] } 或 { error: "..." }
 * ========================================================================== */

export async function onRequest(context) {
  const { request, env } = context;

  /* ── CORS 標頭（同網域其實不需要，但保險起見） ── */
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  /* ── OPTIONS 預檢 ── */
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  /* ── 只接受 POST ── */
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  try {
    /* ── 解析請求 ── */
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const { imageBase64, prompt, mimeType } = body || {};

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return jsonResponse({ error: 'Missing imageBase64' }, 400, corsHeaders);
    }
    if (!prompt || typeof prompt !== 'string') {
      return jsonResponse({ error: 'Missing prompt' }, 400, corsHeaders);
    }

    /* ── 檢查環境變數 ── */
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({
        error: 'Server not configured',
        detail: 'GEMINI_API_KEY missing in Pages environment variables'
      }, 500, corsHeaders);
    }

    /* ── 呼叫 Gemini API ── */
    const model = env.GEMINI_MODEL || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const geminiBody = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType || 'image/png',
              data: imageBase64,
            }
          }
        ]
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
      ]
    };

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
      }, 502, corsHeaders);
    }

    /* ── 解析 Gemini 回應 ── */
    const data = await geminiResp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    /* ── 嘗試解析 JSON ── */
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

    return jsonResponse(parsed, 200, corsHeaders);

  } catch (e) {
    return jsonResponse({
      error: 'Function exception',
      message: e.message,
    }, 500, corsHeaders);
  }
}

/* ── 工具：回傳 JSON ── */
function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
