import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

// Helper to get Gemini client
function getGenAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }
  return new GoogleGenAI({ apiKey });
}

// GitHub PR diff fetcher endpoint
app.post('/api/github-diff', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'GitHub PR URL is required.' });
    }

    // Match github.com/:owner/:repo/pull/:number
    const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid GitHub PR link. Expected format: https://github.com/owner/repo/pull/123'
      });
    }

    const [, owner, repo, pullNumber] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': 'SpeakPR-App/1.0'
    };

    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    const ghRes = await fetch(apiUrl, { headers });

    if (ghRes.status === 404) {
      return res.status(404).json({
        error: 'Pull request not found. Make sure the repository is public and the PR number is correct.'
      });
    }

    if (ghRes.status === 403) {
      return res.status(403).json({
        error: 'GitHub API rate limit exceeded or access forbidden. Please paste the unified diff directly.'
      });
    }

    if (!ghRes.ok) {
      return res.status(ghRes.status).json({
        error: `GitHub API error (${ghRes.status}): ${ghRes.statusText}`
      });
    }

    let diffText = await ghRes.text();
    if (!diffText.trim()) {
      return res.status(400).json({
        error: 'This pull request contains no code diff or changes.'
      });
    }

    let wasShortened = false;
    const MAX_CHARS = 60000;

    if (diffText.length > MAX_CHARS) {
      const lastNewline = diffText.lastIndexOf('\n', MAX_CHARS);
      const cutIndex = lastNewline > 0 ? lastNewline : MAX_CHARS;
      diffText = diffText.slice(0, cutIndex) + `\n\n# ... Diff shortened to first 60,000 characters for analysis`;
      wasShortened = true;
    }

    const lines = diffText.split('\n');

    // Extract filename from diff if available
    let filename = `PR #${pullNumber} (${owner}/${repo})`;
    const fileMatch = diffText.match(/diff --git a\/(.+?) b\//);
    if (fileMatch && fileMatch[1]) {
      filename = fileMatch[1];
    }

    // Compute additions and deletions
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    return res.json({
      diff: diffText,
      wasShortened,
      totalLines: lines.length,
      filename,
      additions,
      deletions,
      prNumber: pullNumber,
      owner,
      repo
    });
  } catch (err: any) {
    console.error('Error fetching GitHub PR:', err);
    return res.status(500).json({
      error: err.message || 'Failed to fetch GitHub PR diff.'
    });
  }
});

// Gemini PR description generation endpoint
app.post('/api/generate-pr', async (req, res) => {
  try {
    const { diff, reasoning } = req.body;

    if (!diff || !diff.trim()) {
      return res.status(400).json({ error: 'Diff cannot be empty.' });
    }
    if (!reasoning || !reasoning.trim()) {
      return res.status(400).json({ error: 'Reasoning cannot be empty.' });
    }

    const ai = getGenAI();

    const systemInstruction = `You are SpeakPR, an expert developer pull request authoring intelligence.
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

    let effectiveDiff = diff;
    let wasShortened = false;
    const MAX_DIFF_CHARS = 60000;
    if (effectiveDiff.length > MAX_DIFF_CHARS) {
      const lastNewline = effectiveDiff.lastIndexOf('\n', MAX_DIFF_CHARS);
      const cutIndex = lastNewline > 0 ? lastNewline : MAX_DIFF_CHARS;
      effectiveDiff = effectiveDiff.slice(0, cutIndex) + `\n\n# ... Diff shortened to first 60,000 characters for analysis`;
      wasShortened = true;
    }

    const prompt = `GIT DIFF:
\`\`\`diff
${effectiveDiff}
\`\`\`

DEVELOPER'S SPOKEN / TYPED REASONING:
"""
${reasoning.slice(0, 8000)}
"""

Generate the structured PR description, changelog, and flags now.`;

    // Put gemini-3.8-flash first, and fallback across verified available models
    const candidateModels = ['gemini-3.8-flash', 'gemini-2.5-flash'];
    let lastError: any = null;
    let data: any = null;

    const schemaConfig = {
      systemInstruction,
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

    for (const model of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: schemaConfig
        });

        const text = response.text;
        if (text) {
          data = JSON.parse(text);
          break;
        }
      } catch (err: any) {
        // If a model returns "not found", "unavailable", 404, 503, or any error, skip it and try next
        console.warn(`Model candidate ${model} failed, trying next candidate:`, err.message || err);
        lastError = err;
      }
    }

    if (!data) {
      return res.status(503).json({
        error: 'Unable to generate PR description at this time. All model candidates were unavailable. Please click Retry.'
      });
    }

    // Validate and sanitize data
    const sanitized = {
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

    return res.json(sanitized);
  } catch (err: any) {
    console.error('Error in /api/generate-pr:', err);
    return res.status(500).json({
      error: 'Failed to generate PR description. Please click Retry.'
    });
  }
});

// Audio transcription endpoint for MediaRecorder fallback
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'Audio data is required.' });
    }

    const ai = getGenAI();
    const candidateModels = ['gemini-3.8-flash', 'gemini-2.5-flash'];
    let transcribedText = '';

    const cleanBase64 = audio.includes('base64,') ? audio.split('base64,')[1] : audio;
    const resolvedMime = mimeType || 'audio/webm';

    for (const model of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                mimeType: resolvedMime,
                data: cleanBase64
              }
            },
            {
              text: 'Transcribe the spoken reasoning in this audio accurately and cleanly. Return ONLY the transcribed text, without any additional explanations, quotes, markdown formatting, or timestamps.'
            }
          ]
        });

        const text = response.text?.trim();
        if (text) {
          transcribedText = text;
          break;
        }
      } catch (err: any) {
        console.warn(`Model candidate ${model} transcription failed, trying next candidate:`, err.message || err);
      }
    }

    if (!transcribedText) {
      return res.status(503).json({
        error: 'Unable to transcribe audio at this time. Please speak clearly or type your reasoning.'
      });
    }

    return res.json({ text: transcribedText });
  } catch (err: any) {
    console.error('Error in /api/transcribe:', err);
    return res.status(500).json({
      error: 'Failed to transcribe audio. Please try again.'
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
      root: __dirname
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SpeakPR server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
