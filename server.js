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

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy – ReviewReply.ai</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 24px; color: #222; line-height: 1.7; }
    h1 { font-size: 2rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; }
    p, li { font-size: 0.97rem; }
    a { color: #4f6ef7; }
    footer { margin-top: 3rem; font-size: 0.85rem; color: #888; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>ReviewReply.ai</strong> &mdash; Last updated: March 20, 2026</p>

  <h2>1. Overview</h2>
  <p>ReviewReply.ai ("we", "our", or "the Service") is a web tool that generates professional responses to customer reviews. We are committed to protecting your privacy.</p>

  <h2>2. Data We Collect</h2>
  <ul>
    <li><strong>Review text:</strong> When you generate a response, the review text you paste is sent to our API for processing. This data is not stored after the response is returned.</li>
    <li><strong>IP address:</strong> Used solely for rate-limiting free-tier usage. Not stored beyond the current day.</li>
    <li><strong>Account email (paid plans):</strong> If you subscribe to a paid plan, we store your email address and subscription status via Stripe.</li>
  </ul>

  <h2>3. Data We Do NOT Collect</h2>
  <ul>
    <li>Browsing history or any data beyond what you explicitly paste</li>
    <li>Personal identifiable information (name, address, phone)</li>
    <li>Cookies or tracking pixels</li>
  </ul>

  <h2>4. How We Use Data</h2>
  <p>Review text is processed in real time to generate response suggestions and is immediately discarded. We do not sell, share, or use your data for advertising or profiling.</p>

  <h2>5. Third-Party Services</h2>
  <ul>
    <li><strong>Anthropic:</strong> Review text is sent to Anthropic's API to generate responses. See <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener">Anthropic's Privacy Policy</a>.</li>
    <li><strong>Stripe:</strong> Payment processing for paid plans. See <a href="https://stripe.com/privacy" target="_blank" rel="noopener">Stripe's Privacy Policy</a>.</li>
  </ul>

  <h2>6. Data Retention</h2>
  <p>Review text is not retained. IP-based rate limit counters reset daily. Account information is retained while your subscription is active and deleted upon request.</p>

  <h2>7. Your Rights</h2>
  <p>You may request deletion of your account and associated data at any time. We will action requests within 30 days.</p>

  <h2>8. Security</h2>
  <p>All data in transit is encrypted via HTTPS/TLS. We do not store review content on our servers.</p>

  <h2>9. Changes to This Policy</h2>
  <p>We may update this policy occasionally. The "Last updated" date above will reflect any changes.</p>

  <h2>10. Contact</h2>
  <p>Questions? Reach us via the contact form on our website.</p>

  <footer>&copy; 2026 ReviewReply.ai. All rights reserved.</footer>
</body>
</html>`);
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
