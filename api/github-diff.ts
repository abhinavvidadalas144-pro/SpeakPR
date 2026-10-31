import { fetchGitHubDiffData, parseRequestBody, sendJson } from './_shared';

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
    const { url } = body;

    const data = await fetchGitHubDiffData(url);
    return sendJson(res, 200, data);
  } catch (err: any) {
    console.error('Error fetching GitHub PR diff:', err);
    const status = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
    const message = err.message || 'Failed to fetch GitHub PR diff.';
    return sendJson(res, status, { error: message });
  }
}
