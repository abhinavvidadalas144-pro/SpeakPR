import {
  CANDIDATE_MODELS,
  MAX_AUDIO_BYTES,
  MissingApiKeyError,
  getGenAI,
  parseRequestBody,
  sendJson
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
    const { audio, mimeType } = body;

    if (!audio || typeof audio !== 'string') {
      return sendJson(res, 400, { error: 'Audio data is required.' });
    }

    const cleanBase64 = audio.includes('base64,') ? audio.split('base64,')[1] : audio;
    const approximateBinaryBytes = Math.floor((cleanBase64.length * 3) / 4);

    if (approximateBinaryBytes > MAX_AUDIO_BYTES) {
      return sendJson(res, 413, {
        error: 'Audio file exceeds the 4 MB limit. Please record a shorter message or type your reasoning.'
      });
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

    const resolvedMime = mimeType || 'audio/webm';
    let transcribedText = '';

    for (const model of CANDIDATE_MODELS) {
      try {
        let timer: any;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Model ${model} timed out after 15s`)), 15000);
        });
        const callPromise = ai.models.generateContent({
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

        const response: any = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timer);

        const text = response?.text?.trim();
        if (text) {
          transcribedText = text;
          break;
        }
      } catch (err: any) {
        console.warn(`Model candidate ${model} transcription failed, trying next candidate:`, err.message || err);
      }
    }

    if (!transcribedText) {
      return sendJson(res, 503, {
        error: 'Unable to transcribe audio at this time. Please speak clearly or type your reasoning.'
      });
    }

    return sendJson(res, 200, { text: transcribedText });
  } catch (err: any) {
    console.error('Error in /api/transcribe:', err);
    return sendJson(res, 500, {
      error: 'Failed to transcribe audio. Please try again.'
    });
  }
}
