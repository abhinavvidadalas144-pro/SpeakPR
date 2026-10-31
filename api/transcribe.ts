import {
  CANDIDATE_MODELS,
  MAX_AUDIO_BYTES,
  MissingApiKeyError,
  getGenAI,
  parseRequestBody
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
    const { audio, mimeType } = body;

    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'Audio data is required.' });
    }

    const cleanBase64 = audio.includes('base64,') ? audio.split('base64,')[1] : audio;
    const approximateBinaryBytes = Math.floor((cleanBase64.length * 3) / 4);

    if (approximateBinaryBytes > MAX_AUDIO_BYTES) {
      return res.status(413).json({
        error: 'Audio file exceeds the 4 MB limit. Please record a shorter message or type your reasoning.'
      });
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

    const resolvedMime = mimeType || 'audio/webm';
    let transcribedText = '';

    for (const model of CANDIDATE_MODELS) {
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

    return res.status(200).json({ text: transcribedText });
  } catch (err: any) {
    console.error('Error in /api/transcribe:', err);
    return res.status(500).json({
      error: 'Failed to transcribe audio. Please try again.'
    });
  }
}
