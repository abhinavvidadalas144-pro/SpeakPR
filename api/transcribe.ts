// Vercel Serverless Function: POST /api/transcribe
// Self-contained to avoid ESM relative module resolution issues on Vercel runtime.

import { GoogleGenAI } from '@google/genai';

const CANDIDATE_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // 4 MB limit

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
    console.error('sendJson error in transcribe:', err);
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
    const { audio, mimeType } = body;

    if (!audio || typeof audio !== 'string') {
      return sendJson(res, 400, { error: 'Audio data is required.' });
    }

    let base64Data = audio;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }

    const byteEstimate = (base64Data.length * 3) / 4;
    if (byteEstimate > MAX_AUDIO_BYTES) {
      return sendJson(res, 400, { error: 'Audio file too large. Maximum size is 4MB.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      return sendJson(res, 500, { error: 'Server is missing GEMINI_API_KEY' });
    }

    const ai = new GoogleGenAI({ apiKey });

    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType || 'audio/webm'
            }
          },
          {
            text: 'Transcribe the spoken audio verbatim in English (Indian English accent context). Return ONLY the transcribed text. Do not add explanations, conversational commentary, or formatting.'
          }
        ]
      }
    ];

    let text = '';
    for (const model of CANDIDATE_MODELS) {
      try {
        let timer: any;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Model ${model} timed out after 15s`)), 15000);
        });
        const callPromise = ai.models.generateContent({
          model,
          contents: contents as any
        });

        const response: any = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timer);

        if (response && response.text) {
          text = response.text.trim();
          break;
        }
      } catch (err: any) {
        console.warn(`Transcribe model ${model} failed, trying next:`, err.message || err);
      }
    }

    if (!text) {
      return sendJson(res, 503, { error: 'Could not transcribe audio. Please try speaking again or type in the box.' });
    }

    return sendJson(res, 200, { text });
  } catch (err: any) {
    console.error('Error in /api/transcribe:', err);
    return sendJson(res, 500, { error: 'Audio transcription failed. Please try again.' });
  }
}
