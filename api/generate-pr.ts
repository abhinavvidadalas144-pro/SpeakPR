// Vercel Serverless Function: POST /api/generate-pr
// Self-contained to avoid ESM relative module resolution issues on Vercel runtime.

import { GoogleGenAI } from '@google/genai';

const CANDIDATE_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
const MAX_DIFF_CHARS = 60000;

const SYSTEM_INSTRUCTION = `You are SpeakPR, an expert developer pull request authoring intelligence.
Your task is to analyze a unified Git diff and the developer's spoken or typed reasoning.
Produce a comprehensive, structured pull request description with grounded evidence, a one-line changelog, and review flags.

STRICT INSTRUCTIONS:
1. You must use ONLY information directly from the diff and the developer's reasoning actually provided.
2. Never invent test results, benchmarks, file names or numbers.
3. If information is missing or unclear, say "not mentioned" instead of guessing.
4. Never claim the change is verified or bug-free.
5. Review flags are checks, not proof of correctness. Create at most 3 flags (0 to 3 items). Every flag must be strictly about the diff and reasoning actually provided:
   - "Change not mentioned": the diff changes something the developer never mentioned.
   - "Claim without matching change": the developer said something the diff does not show.
   - For each flag, provide a concise explanation ("message") and the direct quoted line or file ("evidence").
6. PR Description sections:
   - summary: Clear summary of what this PR accomplishes based strictly on the diff and reasoning.
   - why: The motivation and context driving the change as stated in reasoning.
   - alternatives: Alternatives considered and why the chosen approach was taken (say "not mentioned" if absent).
   - risks_and_testing: Concrete risks and testing verification mentioned by developer (say "not mentioned" if absent).
7. changelog: A single concise line suitable for release notes.

Return ONLY valid JSON matching this schema:
{
  "summary": "string",
  "why": "string",
  "alternatives": "string",
  "risks_and_testing": "string",
  "changelog": "string",
  "flags": [
    {
      "type": "Change not mentioned" | "Claim without matching change",
      "message": "string",
      "evidence": "string"
    }
  ]
}`;

const SCHEMA_CONFIG = {
  systemInstruction: SYSTEM_INSTRUCTION,
  responseMimeType: 'application/json',
  responseSchema: {
    type: 'OBJECT' as any,
    properties: {
      summary: { type: 'STRING' as any },
      why: { type: 'STRING' as any },
      alternatives: { type: 'STRING' as any },
      risks_and_testing: { type: 'STRING' as any },
      changelog: { type: 'STRING' as any },
      flags: {
        type: 'ARRAY' as any,
        items: {
          type: 'OBJECT' as any,
          properties: {
            type: {
              type: 'STRING' as any,
              enum: ['Change not mentioned', 'Claim without matching change']
            },
            message: { type: 'STRING' as any },
            evidence: { type: 'STRING' as any }
          },
          required: ['type', 'message', 'evidence']
        }
      }
    },
    required: ['summary', 'why', 'alternatives', 'risks_and_testing', 'changelog', 'flags']
  }
};

function truncateDiff(diffText: string, maxChars = MAX_DIFF_CHARS): { diff: string; wasShortened: boolean } {
  if (diffText.length <= maxChars) {
    return { diff: diffText, wasShortened: false };
  }
  const lastNewline = diffText.lastIndexOf('\n', maxChars);
  const cutIndex = lastNewline > 0 ? lastNewline : maxChars;
  return {
    diff: diffText.slice(0, cutIndex) + `\n\n# ... Diff shortened to first 60,000 characters for analysis`,
    wasShortened: true
  };
}

function sanitizePRData(data: any, wasShortened: boolean) {
  return {
    summary: typeof data.summary === 'string' ? data.summary : '',
    why: typeof data.why === 'string' ? data.why : '',
    alternatives: typeof data.alternatives === 'string' ? data.alternatives : '',
    risks_and_testing: typeof data.risks_and_testing === 'string' ? data.risks_and_testing : '',
    changelog: typeof data.changelog === 'string' ? data.changelog : (Array.isArray(data.changelog) ? data.changelog.join(' ') : ''),
    flags: Array.isArray(data.flags) ? data.flags.slice(0, 3).map((f: any) => ({
      type: (f.type === 'Change not mentioned' || f.type === 'Claim without matching change') ? f.type : 'Change not mentioned',
      message: typeof f.message === 'string' ? f.message : (f.explanation || ''),
      evidence: typeof f.evidence === 'string' ? f.evidence : ''
    })) : [],
    wasShortened
  };
}

function sendJson(res: any, status: number, data: any) {
  try {
    if (res) {
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(status).json(data);
      }
      if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify(data));
      }
      if (typeof res.end === 'function') {
        res.statusCode = status;
        return res.end(JSON.stringify(data));
      }
    }
  } catch (err) {
    console.error('sendJson error in generate-pr:', err);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function parseRequestBody(req: any): Promise<any> {
  if (!req) return {};

  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object') {
      return req.body;
    }
  }

  // If request has already ended or is complete, don't wait on stream events
  if (req.readableEnded || req.complete) {
    return {};
  }

  if (typeof req.json === 'function') {
    try {
      return await req.json();
    } catch {
      return {};
    }
  }

  if (typeof req.on === 'function') {
    return new Promise((resolve) => {
      let bodyStr = '';
      const timer = setTimeout(() => resolve({}), 2000);
      req.on('data', (chunk: any) => {
        bodyStr += chunk;
      });
      req.on('end', () => {
        clearTimeout(timer);
        if (!bodyStr || !bodyStr.trim()) return resolve({});
        try {
          resolve(JSON.parse(bodyStr));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => {
        clearTimeout(timer);
        resolve({});
      });
    });
  }

  return {};
}

export default async function handler(req: any, res?: any) {
  try {
    if (req.method === 'OPTIONS') {
      if (res && res.setHeader) res.setHeader('Allow', 'POST, OPTIONS');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method !== 'POST') {
      if (res && res.setHeader) res.setHeader('Allow', 'POST, OPTIONS');
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      return sendJson(res, 500, { error: 'Server is missing GEMINI_API_KEY' });
    }

    const ai = new GoogleGenAI({ apiKey });
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
