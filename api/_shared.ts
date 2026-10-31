import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

export const CANDIDATE_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];

export const MAX_DIFF_CHARS = 60000;
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // 4 MB limit

export class MissingApiKeyError extends Error {
  constructor() {
    super('Server is missing GEMINI_API_KEY');
    this.name = 'MissingApiKeyError';
  }
}

export function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new MissingApiKeyError();
  }
  return new GoogleGenAI({ apiKey });
}

export const SYSTEM_INSTRUCTION = `You are SpeakPR, an expert developer pull request authoring intelligence.
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

export const SCHEMA_CONFIG = {
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

export function truncateDiff(diffText: string, maxChars = MAX_DIFF_CHARS): { diff: string; wasShortened: boolean } {
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

export function sanitizePRData(data: any, wasShortened: boolean) {
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

export async function fetchGitHubDiffData(url: string) {
  if (!url || typeof url !== 'string') {
    throw { status: 400, message: 'GitHub PR URL is required.' };
  }

  // Match github.com/:owner/:repo/pull/:number
  const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) {
    throw {
      status: 400,
      message: 'Invalid GitHub PR link. Expected format: https://github.com/owner/repo/pull/123'
    };
  }

  const [, owner, repo, pullNumber] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.diff',
    'User-Agent': 'speakpr'
  };

  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const ghRes = await fetch(apiUrl, { headers });

  if (ghRes.status === 404) {
    throw {
      status: 404,
      message: 'Pull request not found. Make sure the repository is public and the PR number is correct.'
    };
  }

  if (ghRes.status === 403) {
    throw {
      status: 403,
      message: 'GitHub API rate limit exceeded or access forbidden. Please paste the unified diff directly.'
    };
  }

  if (!ghRes.ok) {
    throw {
      status: ghRes.status,
      message: `GitHub API error (${ghRes.status}): ${ghRes.statusText}`
    };
  }

  const rawDiff = await ghRes.text();
  if (!rawDiff.trim()) {
    throw {
      status: 400,
      message: 'This pull request contains no code diff or changes.'
    };
  }

  const { diff: diffText, wasShortened } = truncateDiff(rawDiff, MAX_DIFF_CHARS);
  const lines = diffText.split('\n');

  let filename = `PR #${pullNumber} (${owner}/${repo})`;
  const fileMatch = diffText.match(/diff --git a\/(.+?) b\//);
  if (fileMatch && fileMatch[1]) {
    filename = fileMatch[1];
  }

  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return {
    diff: diffText,
    wasShortened,
    totalLines: lines.length,
    filename,
    additions,
    deletions,
    prNumber: pullNumber,
    owner,
    repo
  };
}

export function sendJson(res: any, status: number, data: any) {
  try {
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json');
    }
    if (res && typeof res.status === 'function' && typeof res.json === 'function') {
      return res.status(status).json(data);
    }
    if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    if (res && typeof res.end === 'function') {
      res.statusCode = status;
      return res.end(JSON.stringify(data));
    }
  } catch (err) {
    console.error('sendJson error:', err);
  }
}

export async function parseRequestBody(req: any): Promise<any> {
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

  if (typeof req.on === 'function') {
    return new Promise((resolve) => {
      let bodyStr = '';
      req.on('data', (chunk: any) => {
        bodyStr += chunk;
      });
      req.on('end', () => {
        if (!bodyStr || !bodyStr.trim()) return resolve({});
        try {
          resolve(JSON.parse(bodyStr));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => {
        resolve({});
      });
    });
  }

  return {};
}
