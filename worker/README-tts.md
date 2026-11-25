# AI voiceovers: setup

The site never holds the Google key. The browser sends the script to the Cloudflare Worker
(`worker/proxy.js`), the Worker calls Google Cloud Text-to-Speech with a key stored as a Worker
secret, and MP3 audio comes back. Anyone who copies this repo gets the code, not the key.

Until the Worker has `GOOGLE_TTS_KEY`, the site hides the AI voice buttons (it asks
`/api/tts/status`). Music works without any of this.

## 1. Google Cloud (done: API enabled)

1. **API key:** APIs & Services → Credentials → Create credentials → API key.
   - API restrictions: **Restrict key → Cloud Text-to-Speech API** only.
   - Application restrictions: **None**. The Worker calls Google from Cloudflare's servers, so
     a website or IP restriction would block it.
2. **Budget alerts** (Billing → Budgets & alerts → Create budget). Alerts email you; they do
   not stop spending. The Worker's daily cap (step 3) is what stops spending.
   - "TTS early warning": scope to this project, amount **$5/month**, alert at 100%. Usage
     beyond the free tier (1 million characters a month) is what triggers it, so this fires
     the first time real money is spent.
   - "TTS ceiling": **$150/month** (about $5/day), alerts at 50%, 90%, 100%.
3. **Burst brake (optional):** APIs & Services → Cloud Text-to-Speech API → Quotas & System
   Limits → lower requests per minute to about 60. This limits a sudden flood; it is not a
   daily cap.

## 2. Cloudflare Turnstile (free bot check)

Cloudflare dashboard → Turnstile → Add widget.
- Hostnames: `civiccharts.com`, `www.civiccharts.com`.
- Widget mode: **Managed** (most visitors never see a challenge).
- Copy the **site key** (public) and **secret key**.

## 3. Worker settings

Cloudflare dashboard → Workers & Pages → `plainsight-proxy` → Settings.

| Name | Type | Value |
|---|---|---|
| `GOOGLE_TTS_KEY` | Secret | the Google API key |
| `TURNSTILE_SECRET` | Secret | Turnstile secret key |
| `TURNSTILE_SITEKEY` | Text variable | Turnstile site key |
| `TTS_DAILY_CHARS` | Text variable | `160000` (default; ≈ $4.80/day max on Chirp 3 HD, ~400 voiceovers) |
| `TTS_KV` | KV namespace binding | create a namespace named `tts-limits` and bind it |

`TTS_KV` makes the per-visitor limit (12 an hour) and the daily cap hold across all of
Cloudflare's locations. Without it, only the bot check, the 1,000-character cap and Google's
quota apply. Daily usage is visible in the KV namespace as `day:YYYY-MM-DD` (characters).

## Media links for Instagram (auto-poster)

The Worker also serves `/media/<name>.mp4` so Instagram can fetch videos from a public address.
The auto-poster uploads with the `MEDIA_UPLOAD_TOKEN` secret (set the same random value on the
Worker and in the civic-charts-social repo); files live in `TTS_KV` and expire after 3 days.

## Reddit feed (auto-poster)

`/feed/reddit.json` lists the newest 50 posts for the Civic Charts app on Reddit (see
civic-charts-social/reddit-app). The auto-poster adds to it with the same `MEDIA_UPLOAD_TOKEN`;
it's stored in `TTS_KV` under `feed:reddit`. Nothing else to set up.

## MCP server for AI assistants (/mcp)

`POST /mcp` is a read-only, stateless MCP server (Streamable HTTP, JSON responses) for Claude,
ChatGPT, Perplexity and other MCP clients. Tools: `search_charts`, `get_chart` (with an optional
state or county), `latest_releases`, `whats_new`. It reads `civiccharts.com/ai/index.json`, which
`scripts/build-pages.mjs` writes on every deploy, cached for 10 minutes; county values come from
`data/<id>.json`. No secrets or settings needed. The Claude plugin (connector plus a skill with
usage instructions) is in `plugins/civic-charts`, listed by `.claude-plugin/marketplace.json`.

## 4. Deploy the new Worker code

From a computer with Node, in the repo folder:

```bash
npx wrangler deploy --config worker/wrangler.jsonc
```

Or paste `worker/proxy.js` into the Worker's online editor (Edit code → replace all → Deploy).

Check: `https://plainsight-proxy.misty-brook-457e.workers.dev/api/tts/status` should show
`"enabled": true` and your site key. The voiceover buttons then appear on civiccharts.com.

## Costs

Chirp 3 HD voices: 1 million characters free each month, then $30 per million. A 30-second
script is about 400 characters, so roughly 2,500 free voiceovers a month and about 1.2¢ each
after. Repeating the same script and voice is served from the Worker's cache at no cost.

## Watching usage

- GA4 event `ai_voice` (voice, characters) counts voiceovers made on the site.
- Google Cloud → Text-to-Speech API → Metrics shows requests and errors.
- Worker logs (Cloudflare → the Worker → Logs) record Google errors.
- If the daily cap is hit, visitors see "The voice service has reached today's limit."

## Testing locally

```bash
TTS_FAKE=1 node server.js
```

This answers with a synthetic voice, to test voiceover, music ducking and export without a
key. Use `GOOGLE_TTS_KEY=... node server.js` to call Google for real from your machine.
