const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FREE_LIMIT = 3;

// In-memory rate limiting (resets on restart - good enough for MVP)
const usageMap = new Map();

function getUsageKey(ip) {
  const today = new Date().toISOString().split('T')[0];
  return `${ip}_${today}`;
}

function checkRateLimit(ip) {
  const key = getUsageKey(ip);
  const count = usageMap.get(key) || 0;
  return count;
}

function incrementUsage(ip) {
  const key = getUsageKey(ip);
  const count = (usageMap.get(key) || 0) + 1;
  usageMap.set(key, count);
  return count;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.post('/api/generate', async (req, res) => {
  const { review, tone, platform, businessName } = req.body;

  if (!review || review.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a review (minimum 10 characters).' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const isPro = req.headers['x-pro-token'] === process.env.PRO_SECRET;

  if (!isPro) {
    const usage = checkRateLimit(ip);
    if (usage >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'Daily limit reached',
        limit: FREE_LIMIT,
        upgrade: true
      });
    }
  }

  const prompt = `You are a professional review response writer for ${businessName || 'a business'}.

A customer left this review on ${platform || 'Google'}:
"${review}"

Write exactly 3 different professional response options in a ${tone || 'Professional'} tone.
Each response should:
- Acknowledge the customer's experience
- Be 2-4 sentences long
- Feel authentic, not corporate
- Be appropriate for public posting on ${platform || 'Google'}
- Not include any placeholders like [NAME] — write complete, ready-to-post responses

Return ONLY valid JSON, no other text:
{"responses":[{"id":1,"text":"..."},{"id":2,"text":"..."},{"id":3,"text":"..."}]}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
    }

    const data = await response.json();
    let text = data.content[0].text.trim();
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text);

    const responses = parsed.responses.map(r => ({
      ...r,
      character_count: r.text.length
    }));

    if (!isPro) incrementUsage(ip);

    const remaining = isPro ? null : Math.max(0, FREE_LIMIT - checkRateLimit(ip));

    res.json({ success: true, responses, remaining });

  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: 'Failed to generate responses. Please try again.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ReviewReply API running on port ${PORT}`));
