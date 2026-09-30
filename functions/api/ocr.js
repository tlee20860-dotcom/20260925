/* ============================================================================
 * functions/api/ocr.js — v8.9.4
 * 使用智譜 GLM-4.6V-Flash（免費視覺模型）
 * ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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
    var body = await request.json();
    var imageBase64 = body.imageBase64;
    var prompt = body.prompt;
    var mimeType = body.mimeType || 'image/jpeg';

    if (!imageBase64 || !prompt) {
      return jsonResponse({ error: 'Missing imageBase64 or prompt' }, 400);
    }

    var apiKey = env.ZHIPU_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'ZHIPU_API_KEY missing in environment variables' }, 500);
    }

    var model = env.ZHIPU_MODEL || 'glm-4.6v-flash';

    // 使用 z.ai 全球 API 端點
    var response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + imageBase64 } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      var errorText = await response.text();
      console.error('Zhipu API error (' + response.status + '):', errorText);
      return jsonResponse({
        error: 'Zhipu API error',
        status: response.status,
        detail: errorText
      }, 502);
    }

    var data = await response.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';

    var parsed;
    try {
      var cleanText = text.trim();
      if (cleanText.indexOf('```json') === 0) {
        cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanText.indexOf('```') === 0) {
        cleanText = cleanText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      var firstBrace = cleanText.indexOf('{');
      var lastBrace = cleanText.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        cleanText = cleanText.slice(firstBrace, lastBrace + 1);
      }
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
