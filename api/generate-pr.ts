import {
  CANDIDATE_MODELS,
  MissingApiKeyError,
  SCHEMA_CONFIG,
  getGenAI,
  parseRequestBody,
  sanitizePRData,
  sendJson,
  truncateDiff
} from './_shared';

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'OPTIONS') {
      if (res.setHeader) res.setHeader('Allow', 'POST, OPTIONS');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== 'POST') {
      if (res.setHeader) res.setHeader('Allow', 'POST, OPTIONS');
      return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
    }

    const body = await parseRequestBody(req);
    const { diff, reasoning } = body;

    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return sendJson(res, 400, { error: 'Diff cannot be empty.' });
    }
    if (!reasoning || typeof reasoning !== 'string' || !reasoning.trim()) {
      return sendJson(res, 400, { error: 'Reasoning cannot be empty.' });
    }

    let ai;
    try {
      ai = getGenAI();
    } catch (err) {
      if (err instanceof MissingApiKeyError || !process.env.GEMINI_API_KEY) {
        return sendJson(res, 500, { error: 'Server is missing GEMINI_API_KEY' });
      }
      throw err;
    }

    const { diff: effectiveDiff, wasShortened } = truncateDiff(diff);

    const prompt = `GIT DIFF:
\`\`\`diff
${effectiveDiff}
\`\`\`

DEVELOPER'S SPOKEN / TYPED REASONING:
"""
${reasoning.slice(0, 8000)}
"""

Generate the structured PR description, changelog, and flags now.`;

    let data: any = null;

    for (const model of CANDIDATE_MODELS) {
      try {
        let timer: any;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Model ${model} timed out after 15s`)), 15000);
        });
        const callPromise = ai.models.generateContent({
          model,
          contents: prompt,
          config: SCHEMA_CONFIG
        });

        const response: any = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timer);

        const text = response?.text;
        if (text) {
          data = JSON.parse(text);
          break;
        }
      } catch (err: any) {
        console.warn(`Model candidate ${model} failed, trying next candidate:`, err.message || err);
      }
    }

    if (!data) {
      return sendJson(res, 503, {
        error: 'Unable to generate PR description at this time. All model candidates were unavailable. Please click Retry.'
      });
    }

    const sanitized = sanitizePRData(data, wasShortened);
    return sendJson(res, 200, sanitized);
  } catch (err: any) {
    console.error('Error in /api/generate-pr:', err);
    return sendJson(res, 500, {
      error: 'Failed to generate PR description. Please click Retry.'
    });
  }
}
