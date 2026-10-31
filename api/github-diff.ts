// Vercel Serverless Function: POST /api/github-diff
// Self-contained to avoid ESM relative module resolution issues on Vercel runtime.

const MAX_DIFF_CHARS = 60000;

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
    console.error('sendJson error in github-diff:', err);
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

async function fetchGitHubDiffData(url: string) {
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
  if (!rawDiff || !rawDiff.trim()) {
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

export default async function handler(req: any, res?: any) {
  try {
    if (req.method === 'OPTIONS') {
      if (res && res.setHeader) res.setHeader('Allow', 'GET, POST, OPTIONS');
      return sendJson(res, 200, { ok: true });
    }

    const body = await parseRequestBody(req);
    const url = body.url || (req.query && req.query.url);

    if (!url) {
      return sendJson(res, 400, { error: 'GitHub PR URL is required.' });
    }

    const data = await fetchGitHubDiffData(url);
    return sendJson(res, 200, data);
  } catch (err: any) {
    console.error('Error fetching GitHub PR diff:', err);
    const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
    const message = err.message || 'Failed to fetch GitHub PR diff.';
    return sendJson(res, status, { error: message });
  }
}
