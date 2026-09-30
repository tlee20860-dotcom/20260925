/* ============================================================================
 * functions/api/ocr.js — v8.9.3
 * 代理 OpenRouter API（使用免费视觉模型）
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

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();
    const { imageBase64, prompt, mimeType } = body || {};

    if (!imageBase64 || !prompt) {
      return jsonResponse({ error: 'Missing imageBase64 or prompt' }, 400);
    }

    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'OPENROUTER_API_KEY missing in environment variables' }, 500);
    }

    // 使用你在 Cloudflare 设置的模型，或默认使用 Qwen
    const model = env.OPENROUTER_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ya-sandbox.pages.dev',
        'X-Title': 'SLG Sandbox',
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
          ]
        }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenRouter API error (${response.status}):`, errorText);
      return jsonResponse({
        error: 'OpenRouter API error',
        status: response.status,
        detail: errorText,
      }, 502);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '{}';

    // 解析 AI 返回的 JSON
    let parsed;
    try {
      let cleanText = text.trim();
      if (cleanText.startsWith('```json')) cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      else if (cleanText.startsWith('```')) cleanText = cleanText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      parsed = JSON.parse(cleanText);
    } catch (e) {
      parsed = { raw: text, parseError: e.message };
    }

    return jsonResponse(parsed, 200);

  } catch (e) {
    console.error('Function exception:', e);
    return jsonResponse({ error: 'Function exception', message: e.message }, 500);
  }
}
