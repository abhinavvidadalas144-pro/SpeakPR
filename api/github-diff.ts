import { fetchGitHubDiffData, parseRequestBody } from './_shared';

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
    const { url } = body;

    const data = await fetchGitHubDiffData(url);
    return res.status(200).json(data);
  } catch (err: any) {
    console.error('Error fetching GitHub PR diff:', err);
    const status = err.status || 500;
    const message = err.message || 'Failed to fetch GitHub PR diff.';
    return res.status(status).json({ error: message });
  }
}
