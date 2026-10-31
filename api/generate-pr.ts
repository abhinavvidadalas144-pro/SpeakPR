import {
  CANDIDATE_MODELS,
  MissingApiKeyError,
  SCHEMA_CONFIG,
  getGenAI,
  parseRequestBody,
  sanitizePRData,
  truncateDiff
} from './_shared';

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = parseRequestBody(req);
    const { diff, reasoning } = body;

    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return res.status(400).json({ error: 'Diff cannot be empty.' });
    }
    if (!reasoning || typeof reasoning !== 'string' || !reasoning.trim()) {
      return res.status(400).json({ error: 'Reasoning cannot be empty.' });
    }

    let ai;
    try {
      ai = getGenAI();
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });
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
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: SCHEMA_CONFIG
        });

        const text = response.text;
        if (text) {
          data = JSON.parse(text);
          break;
        }
      } catch (err: any) {
        console.warn(`Model candidate ${model} failed, trying next candidate:`, err.message || err);
      }
    }

    if (!data) {
      return res.status(503).json({
        error: 'Unable to generate PR description at this time. All model candidates were unavailable. Please click Retry.'
      });
    }

    const sanitized = sanitizePRData(data, wasShortened);
    return res.status(200).json(sanitized);
  } catch (err: any) {
    console.error('Error in /api/generate-pr:', err);
    return res.status(500).json({
      error: 'Failed to generate PR description. Please click Retry.'
    });
  }
}
