// Cloudflare Worker: gives the static (GitHub Pages) build data.gov search and CSV loading.
// Deploy: `npx wrangler deploy --config worker/wrangler.jsonc` (or paste into the dashboard editor), then set
// window.PS_API_BASE = 'https://plainsight-proxy.<you>.workers.dev/' in public/index.html.
const ALLOW = [/\.gov$/i, /\.mil$/i, /\.us$/i, /^data\.[a-z0-9-]+\.(org|com|net)$/i, /^fred\.stlouisfed\.org$/i, /^api\.worldbank\.org$/i, /^opendata\.[a-z0-9.-]+$/i,
  /\.edu$/i, /(^|\.)arcgis\.com$/i, /^api\.us\.socrata\.com$/i, /^data\.geospatialhub\.org$/i, /^ourworldindata\.org$/i];
const cors = { 'Access-Control-Allow-Origin': '*' };

// ---------- AI voice: /api/tts/status and /api/tts ----------
// Google Cloud Text-to-Speech, with the key kept here as a Worker secret (never in the site or
// GitHub). Settings, all in the Cloudflare dashboard or wrangler (see worker/README-tts.md):
//   GOOGLE_TTS_KEY      secret  Google API key, restricted to the Cloud Text-to-Speech API
//   TURNSTILE_SECRET    secret  Cloudflare Turnstile secret key (bot check)
//   TURNSTILE_SITEKEY   var     Turnstile site key (public; the site reads it from /api/tts/status)
//   TTS_KV              KV      optional: per-visitor and daily limits that hold across Cloudflare locations
//   TTS_DAILY_CHARS     var     optional daily character budget (default 160000: at most ~$4.80/day on
//                               Chirp 3 HD at $30 per million, about 400 voiceovers)
//   TTS_ORIGINS         var     optional comma list of sites allowed to call (default civiccharts.com)
const VOICES = new Set(['en-US-Chirp3-HD-Charon', 'en-US-Chirp3-HD-Kore', 'en-US-Chirp3-HD-Puck', 'en-US-Chirp3-HD-Aoede']);
const MAX_CHARS = 1000, PER_HOUR = 12;
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }

async function tts(req, env, ctx, path) {
  const origins = (env.TTS_ORIGINS || 'https://civiccharts.com,https://www.civiccharts.com').split(',').map(x => x.trim());
  const origin = req.headers.get('Origin') || '';
  const okOrigin = origins.includes(origin);
  const h = { 'Access-Control-Allow-Origin': okOrigin ? origin : origins[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (path === '/api/tts/status') return json({ enabled: !!env.GOOGLE_TTS_KEY, sitekey: env.TURNSTILE_SITEKEY || null, voices: [...VOICES], maxChars: MAX_CHARS }, 200, h);
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, h);
  if (!env.GOOGLE_TTS_KEY) return json({ error: 'AI voices are not set up.' }, 503, h);
  if (!okOrigin) return json({ error: 'This site is not allowed to use the voice service.' }, 403, h);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400, h); }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim(), voice = String(body.voice || '');
  if (!text) return json({ error: 'Write a script first.' }, 400, h);
  if (text.length > MAX_CHARS) return json({ error: `Scripts can be up to ${MAX_CHARS} characters.` }, 400, h);
  if (!VOICES.has(voice)) return json({ error: 'Unknown voice.' }, 400, h);
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

  // Bot check: every request needs a fresh Turnstile token once a secret is set.
  if (env.TURNSTILE_SECRET) {
    const form = new FormData(); form.append('secret', env.TURNSTILE_SECRET); form.append('response', String(body.token || '')); form.append('remoteip', ip);
    const v = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })).json().catch(() => ({}));
    if (!v.success) return json({ error: 'The bot check failed. Reload the page and try again.' }, 403, h);
  }

  // Same text and voice: serve the saved audio (free, instant).
  const cacheKey = new Request(`https://tts.cache/${await sha(voice + '|' + text)}.mp3`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { ...h, 'Content-Type': 'audio/mpeg', 'X-Cache': 'HIT' } });

  // Limits: per visitor per hour, and a daily character budget for the whole site.
  const hour = new Date().toISOString().slice(0, 13), day = hour.slice(0, 10);
  const daily = +(env.TTS_DAILY_CHARS || 160000);
  if (env.TTS_KV) {
    const [n, used] = await Promise.all([env.TTS_KV.get(`ip:${ip}:${hour}`), env.TTS_KV.get(`day:${day}`)]);
    if (+n >= PER_HOUR) return json({ error: `That's ${PER_HOUR} voiceovers this hour. Try again later.` }, 429, h);
    if (+used + text.length > daily) return json({ error: 'The voice service has reached today\'s limit. Try again tomorrow.' }, 429, h);
    ctx.waitUntil(Promise.all([
      env.TTS_KV.put(`ip:${ip}:${hour}`, String(+n + 1), { expirationTtl: 7200 }),
      env.TTS_KV.put(`day:${day}`, String(+used + text.length), { expirationTtl: 172800 }),
    ]));
  }

  const g = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_TTS_KEY },
    body: JSON.stringify({ input: { text }, voice: { languageCode: 'en-US', name: voice }, audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 } }),
  });
  if (!g.ok) { console.log('Google TTS', g.status, (await g.text()).slice(0, 300)); return json({ error: g.status === 429 ? 'The voice service is busy. Try again in a minute.' : 'The voice service had a problem. Try again later.' }, 502, h); }
  const { audioContent } = await g.json();
  const bytes = Uint8Array.from(atob(audioContent), c => c.charCodeAt(0));
  const res = new Response(bytes, { headers: { ...h, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=2592000' } });
  ctx.waitUntil(caches.default.put(cacheKey, new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=2592000' } })));
  return res;
}

// ---------- short-lived media links: /media/<name>.mp4 ----------
// Instagram's API only accepts video from a public web address. The auto-poster uploads a video
// here (PUT, with the MEDIA_UPLOAD_TOKEN secret), Instagram fetches it, and it expires after 3 days.
// Stored in the TTS_KV namespace under "media:". Names are random, so links can't be guessed.
async function media(req, env, name) {
  const h = { 'Access-Control-Allow-Origin': '*' };
  if (!/^[a-z0-9-]{16,80}\.(mp4|jpg)$/.test(name)) return new Response('Not found', { status: 404, headers: h });
  if (!env.TTS_KV) return new Response('Media storage is not set up', { status: 503, headers: h });
  const type = name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  if (req.method === 'PUT') {
    if (!env.MEDIA_UPLOAD_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.MEDIA_UPLOAD_TOKEN}`) return new Response('Not allowed', { status: 403, headers: h });
    const body = await req.arrayBuffer();
    if (body.byteLength > 25 * 1024 * 1024) return new Response('Files can be up to 25 MB', { status: 413, headers: h });
    await env.TTS_KV.put(`media:${name}`, body, { expirationTtl: 3 * 86400, metadata: { type } });
    return new Response(JSON.stringify({ url: new URL(req.url).toString(), bytes: body.byteLength }), { status: 201, headers: { ...h, 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Use GET', { status: 405, headers: h });
  const value = await env.TTS_KV.get(`media:${name}`, { type: 'arrayBuffer' });
  if (!value) return new Response('Not found or expired', { status: 404, headers: h });
  return new Response(req.method === 'HEAD' ? null : value, { headers: { ...h, 'Content-Type': type, 'Content-Length': String(value.byteLength), 'Cache-Control': 'public, max-age=86400' } });
}

// ---------- Reddit feed: /feed/reddit.json ----------
// Reddit no longer gives out API keys, so the Civic Charts app on Reddit's Developer Platform
// (Devvit) reads this list every 15 minutes and posts new items to each subreddit it's installed
// on. The auto-poster adds an item (POST /feed/reddit, with the MEDIA_UPLOAD_TOKEN secret) after
// uploading the video to /media/. Only the newest 50 items are kept; videos expire after 3 days.
const FEED_MAX = 50;
async function feed(req, env) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (!env.TTS_KV) return new Response('{"error":"storage is not set up"}', { status: 503, headers: h });
  const items = (await env.TTS_KV.get('feed:reddit', { type: 'json' })) || [];
  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Response(req.method === 'HEAD' ? null : JSON.stringify({ updated: items[0]?.created || null, items }), { headers: { ...h, 'Cache-Control': 'no-store' } });
  }
  if (req.method !== 'POST') return new Response('{"error":"use GET or POST"}', { status: 405, headers: h });
  if (!env.MEDIA_UPLOAD_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.MEDIA_UPLOAD_TOKEN}`) return new Response('{"error":"not allowed"}', { status: 403, headers: h });
  let it;
  try { it = await req.json(); } catch { return new Response('{"error":"send JSON"}', { status: 400, headers: h }); }
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const url = v => (/^https:\/\/[^\s]+$/.test(v || '') ? v.slice(0, 500) : '');
  const item = {
    id: str(it.id, 120), dataset: str(it.dataset, 80), title: str(it.title, 300), comment: str(it.comment, 9000),
    page: url(it.page), video: url(it.video), poster: url(it.poster), topic: str(it.topic, 40), geo: str(it.geo, 40),
    created: new Date().toISOString(),
  };
  if (!item.id || !item.title || !item.page) return new Response('{"error":"id, title and page are required"}', { status: 400, headers: h });
  const next = [item, ...items.filter(x => x.id !== item.id)].slice(0, FEED_MAX);
  await env.TTS_KV.put('feed:reddit', JSON.stringify(next));
  return new Response(JSON.stringify({ ok: true, item, count: next.length }), { status: 201, headers: h });
}

// ---------- hourly kick for the auto-poster ----------
// GitHub drops most scheduled runs on quiet repos, so the poster's posting slots were missed.
// A Cloudflare Cron Trigger (Settings -> Triggers, "17 14-23,0-1 * * *": hourly in posting hours) starts
// the "Propose and post" workflow. Needs the secret GH_DISPATCH_TOKEN: a fine-grained GitHub token
// for the civic-charts-social repo with "Actions: Read and write". Optional: POSTER_REPO and
// POSTER_WORKFLOW override the defaults below.
async function kickPoster(env) {
  if (!env.GH_DISPATCH_TOKEN) return 'GH_DISPATCH_TOKEN not set';
  const repo = env.POSTER_REPO || 'BenBrausen/civic-charts-social', wf = env.POSTER_WORKFLOW || 'propose.yml';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'civic-charts-worker', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  const out = r.status === 204 ? 'started' : `GitHub answered ${r.status} ${(await r.text()).slice(0, 200)}`;
  console.log('poster kick:', out);
  return out;
}

// Weekday mornings (the 14:17 UTC run, 8:17 am Central): also refresh the site's data, so big
// 7:30 am releases (jobs report, CPI) are picked up within the hour instead of at noon. Uses the
// same GH_DISPATCH_TOKEN, which then also needs "Actions: Read and write" on the civic-charts repo.
async function kickRefresh(env) {
  if (!env.GH_DISPATCH_TOKEN) return 'GH_DISPATCH_TOKEN not set';
  const repo = env.SITE_REPO || 'BenBrausen/civic-charts';
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/refresh-and-deploy.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'civic-charts-worker', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  const out = r.status === 204 ? 'started' : `GitHub answered ${r.status} ${(await r.text()).slice(0, 200)}`;
  console.log('site refresh kick:', out);
  return out;
}

// ---------- MCP server for AI assistants: POST /mcp ----------
// Lets Claude, ChatGPT, Perplexity and other MCP clients look up Civic Charts: search charts,
// get one with its facts, source and links (optionally for a state or county), list new
// releases, and see what's new. Read-only and stateless (no sessions, no sign-in). Answers come
// from /ai/index.json, which the site build writes from the same text as the chart pages, cached
// here for 10 minutes, so most calls answer in milliseconds.
const SITE = 'https://civiccharts.com';
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_INSTRUCTIONS = `Civic Charts has charts and maps of official U.S. public data (jobs, prices, housing, rent, gas, wages, health, climate, crime, elections, federal spending), each built straight from the publisher's data with the source cited.
Use it whenever someone asks about a U.S. statistic, a trend, or how states or counties compare, especially "latest" or "current" numbers.
- Start with search_charts, then get_chart for the numbers. Pass place (a state, or a county like "Hennepin County, MN") to get_chart when the question is about one place.
- Only state numbers that the tools return, with their date ("as of October 2026"). Never estimate or fill gaps.
- Always cite the source publisher with its link, and give the Civic Charts chart page link so the person can see the chart, check the data, or make a shareable image or video from it.
- For "what's new" or "what changed this week", use latest_releases.`;
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
// Everyday words people use for the same data.
const SYNONYMS = { jobs: 'unemployment employment job jobless labor', unemployment: 'jobless job jobs labor', inflation: 'cpi prices price cost living', prices: 'inflation cpi price cost', cost: 'prices inflation affordability living', gas: 'gasoline gas fuel', rent: 'rent rents renters housing', housing: 'home homes house rent mortgage', mortgage: 'mortgage rates housing', wages: 'wage pay paycheck earnings income', pay: 'wages wage earnings income', income: 'income earnings household', crime: 'crime violent property murder', debt: 'debt deficit federal', deficit: 'deficit debt spending', weather: 'temperature climate drought', climate: 'temperature drought climate', groceries: 'grocery food eggs prices', food: 'grocery food', electricity: 'electricity power energy', vote: 'election elections president presidential', election: 'election elections presidential vote', minimum: 'minimum wage' };
let aiCache = { at: 0, data: null };
async function aiIndex() {
  if (aiCache.data && Date.now() - aiCache.at < 600e3) return aiCache.data;
  const r = await fetch(`${SITE}/ai/index.json`, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!r.ok) throw new Error(`Civic Charts index unavailable (${r.status})`);
  aiCache = { at: Date.now(), data: await r.json() };
  return aiCache.data;
}
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
const STOP = new Set('the of in and for to by on what whats is are was how much many does do did a an my me show latest current now today chart data rate rates us usa united states state states per'.split(' '));
function findState(q) {
  const t = ` ${String(q).toLowerCase()} `;
  for (const [ab, name] of Object.entries(STATES)) if (t.includes(` ${name.toLowerCase()} `) || t.includes(` ${name.toLowerCase()}'`) || new RegExp(`[ ,(]${ab.toLowerCase()}[ ,).?]`).test(t) && ab !== 'IN' && ab !== 'OR' && ab !== 'ME') return name;
  return null;
}
// "Hennepin County, MN" or "Orleans Parish, Louisiana" -> the name the data uses ("Hennepin County, MN").
function findCounty(q) {
  const m = /([a-z][a-z .'-]*?\s(?:county|parish|borough|census area))\s*,?\s*([a-z]{2}\b|[a-z][a-z ]+)/i.exec(String(q));
  if (!m) return null;
  const st = m[2].trim(), ab = st.length === 2 ? st.toUpperCase() : Object.keys(STATES).find(k => STATES[k].toLowerCase() === st.toLowerCase());
  const words = m[1].trim().split(/\s+/);
  while (words.length > 2 && /^(rent|in|for|the|what|is|whats|of)$/i.test(words[0])) words.shift();
  const name = words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return ab && STATES[ab] ? `${name}, ${ab}` : null;
}
function searchCharts(idx, query, limit = 5) {
  const qw = words(query).filter(w => !STOP.has(w));
  const terms = new Set(qw.flatMap(w => [w, ...(SYNONYMS[w] || '').split(' ').filter(Boolean)]));
  const county = findCounty(query), state = county ? null : findState(query);
  const scored = idx.charts.map(c => {
    const title = words(c.title), head = words(c.headline), other = words(`${c.description} ${c.topicName} ${c.unit} ${c.source?.publisher}`);
    let s = 0;
    for (const t of terms) { const direct = qw.includes(t) ? 1 : 0.5; if (title.includes(t)) s += 3 * direct; if (head.includes(t)) s += 1 * direct; if (other.includes(t)) s += 1 * direct; }
    if (state && (c.geo === 'us-states' || c.geo === 'us-counties')) s += 1.5;
    if (county) s += c.geo === 'us-counties' ? 2 : c.geo === 'us-states' ? 0 : -1;
    // "Gas prices" means the plain price; the inflation-adjusted twin only when asked for.
    if (/adjusted for inflation|inflation-adjusted/i.test(`${c.title} ${c.headline}`) && !qw.some(w => ['inflation', 'adjusted', 'real', 'dollars'].includes(w))) s -= 2;
    if (c.released && Date.now() - Date.parse(c.released) < 14 * 864e5) s += 0.5;
    return { c, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
  return { state, county, results: scored.map(x => x.c) };
}
// Values with their units ("$11.41", "4.1%"), and dates as people say them ("2024", "Oct 2026").
function fmtVal(v, c) {
  if (v == null) return null;
  const f = c.unitFormat || {}, d = f.decimals ?? (Math.abs(v) < 100 ? 2 : 0);
  const n = Number(v).toLocaleString('en-US', { minimumFractionDigits: f.format === 'usd' && Math.abs(v) < 100 ? 2 : 0, maximumFractionDigits: Math.max(d, f.format === 'usd' && Math.abs(v) < 100 ? 2 : 0) });
  return f.format === 'usd' ? `$${n}` : f.format === 'pct' ? `${n}%` : `${n}${c.unit ? ` (${c.unit})` : ''}`;
}
function fmtAsOf(t, c) {
  const s = String(t || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const [y, m, dd] = s.split('-'), mon = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[+m - 1];
  if (['annual', 'fiscal', 'quadrennial'].includes(c.frequency)) return y;
  if (c.frequency === 'monthly') return `${mon} ${y}`;
  if (c.frequency === 'quarterly') return `Q${Math.ceil(+m / 3)} ${y}`;
  return `${mon} ${+dd}, ${y}`;
}
function chartBrief(c) {
  return [`**${c.title}**`, c.headline, c.latestText ? `Latest: ${c.latestText}.` : '', `Source: ${[c.source?.publisher, c.source?.dataset].filter(Boolean).join(', ')}${c.source?.url ? ` (${c.source.url})` : ''}.`, `Chart: ${c.page}`].filter(Boolean).join('\n');
}
async function placeValue(c, place) {
  const want = String(place).trim().toLowerCase();
  if (c.geo === 'us-states' && c.places) {
    const name = Object.keys(c.places).find(n => n.toLowerCase() === want) || findState(place) && Object.keys(c.places).find(n => n === findState(place));
    if (!name) return null;
    const ranked = Object.entries(c.places).sort((a, b) => b[1] - a[1]), rank = 1 + ranked.filter(([, v]) => v > c.places[name]).length;
    const ties = ranked.filter(([, v]) => v === c.places[name]).length;
    const page = c.statePages ? c.statePages.replace('{state}', name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')) : null;
    return { place: name, value: c.places[name], asOf: c.placesAsOf, rank, of: ranked.length, tied: ties > 1, page };
  }
  if (c.geo === 'us-counties') {
    const r = await fetch(c.data, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r.ok) return null;
    const ds = await r.json(), li = ds.times.length - 1;
    const norm = s => s.toLowerCase().replace(/\s+(county|parish|borough|census area|municipality)\b/, '').replace(/[^a-z, ]/g, '').trim();
    // "median income cook county, IL" -> try "cook county, IL", then shorter, against real names.
    const [namePart, stPart = ''] = String(place).split(',');
    const ws = namePart.trim().split(/\s+/), tries = ws.map((_, k) => `${ws.slice(k).join(' ')},${stPart}`.toLowerCase().replace(/\s+,/, ','));
    const e = ds.entities.find(x => x.name.toLowerCase() === want)
      || tries.map(t => ds.entities.find(x => x.name.toLowerCase() === t.replace(/,\s*/, ', ') || norm(x.name) === norm(t))).find(Boolean);
    if (!e || e.values[li] == null) return null;
    const vals = ds.entities.map(x => x.values[li]).filter(v => v != null);
    return { place: e.name, value: e.values[li], asOf: ds.times[li], rank: 1 + vals.filter(v => v > e.values[li]).length, of: vals.length, tied: vals.filter(v => v === e.values[li]).length > 1 };
  }
  return null;
}
const MCP_TOOLS = [
  { name: 'search_charts', title: 'Search Civic Charts',
    description: 'Find charts and maps of official U.S. data by topic or question, e.g. "gas prices", "rent in Minnesota", "unemployment by state". Returns the best matches with their headline, latest value, source and chart link.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the person wants to know, in their words.' }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, required: ['query'] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_chart', title: 'Get a chart',
    description: 'One chart in full: headline, key facts, how to read it, latest value and date, source with link, chart page and preview image. Pass place for one state (e.g. "Minnesota") or county (e.g. "Hennepin County, MN") to get its value and rank.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Chart id from search_charts, e.g. "gas-price".' }, place: { type: 'string', description: 'Optional state or county.' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'latest_releases', title: 'Newest data releases',
    description: 'Official data released most recently (new jobs numbers, prices, drought and more), newest first, each with its headline and chart link.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'whats_new', title: "What's new on Civic Charts",
    description: 'Recent new features and datasets on Civic Charts itself (not data releases).',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
];
async function callTool(name, a = {}) {
  const idx = await aiIndex();
  const out = (text, data) => ({ content: [{ type: 'text', text }], structuredContent: data });
  if (name === 'search_charts') {
    const { state, county, results } = searchCharts(idx, a.query || '', Math.min(10, Math.max(1, +a.limit || 5)));
    if (!results.length) return out(`No Civic Charts chart matches "${a.query}". Browse all charts at ${SITE}/.`, { results: [] });
    const withPlace = [];
    for (const c of results) withPlace.push({ ...c, placeValue: county || state ? await placeValue(c, county || state).catch(() => null) : null });
    const text = withPlace.map(c => `${chartBrief(c)}${c.placeValue ? `\n${c.placeValue.place}: ${fmtVal(c.placeValue.value, c)} as of ${fmtAsOf(c.placeValue.asOf, c)}, ${c.placeValue.tied ? 'tied at ' : ''}#${c.placeValue.rank} of ${c.placeValue.of}.${c.placeValue.page ? ` ${c.placeValue.place} page: ${c.placeValue.page}` : ''}` : ''}\n(id: ${c.id})`).join('\n\n');
    return out(text, { results: withPlace.map(c => ({ id: c.id, title: c.title, headline: c.headline, latestText: c.latestText, source: c.source, page: c.page, image: c.image, placeValue: c.placeValue })) });
  }
  if (name === 'get_chart') {
    const c = idx.charts.find(x => x.id === a.id) || searchCharts(idx, a.id || '', 1).results[0];
    if (!c) return { ...out(`No chart with id "${a.id}". Use search_charts first.`, {}), isError: true };
    const pv = a.place ? await placeValue(c, a.place).catch(() => null) : null;
    const text = [chartBrief(c), pv ? `${pv.place}: ${fmtVal(pv.value, c)} as of ${fmtAsOf(pv.asOf, c)}, ${pv.tied ? 'tied at ' : ''}#${pv.rank} of ${pv.of} (highest = #1).${pv.page ? `\n${pv.place} page (answer, trend and all states): ${pv.page}` : ''}` : a.place ? `No value for "${a.place}" in this chart${c.geo ? '' : ' (it is a national chart)'}.` : '',
      c.facts?.length ? `Key facts:\n${c.facts.map(f => `- ${f}`).join('\n')}` : '', c.howToRead ? `How to read it: ${c.howToRead}` : '',
      `Preview image: ${c.image}`, `Raw data (JSON): ${c.data}`].filter(Boolean).join('\n\n');
    return out(text, { ...c, places: undefined, placeValue: pv });
  }
  if (name === 'latest_releases') {
    const n = Math.min(20, Math.max(1, +a.limit || 8)), seen = new Set(), list = [];
    for (const r of idx.releases || []) { if (seen.has(r.id)) continue; seen.add(r.id); const c = idx.charts.find(x => x.id === r.id); if (c) list.push({ ...r, headline: c.headline, page: c.page, source: c.source }); if (list.length >= n) break; }
    return out(list.map(r => `**${r.title}** (released ${String(r.released).slice(0, 10)}, data through ${r.lastObservation})\n${r.headline}\nSource: ${r.source?.publisher}. Chart: ${r.page}`).join('\n\n') || 'No recent releases.', { releases: list });
  }
  if (name === 'whats_new') return out((idx.changelog || []).map(e => `${e.date}${e.major ? ' (major)' : ''}: ${e.title}${e.text ? `. ${e.text}` : ''}`).join('\n') + `\nFull list: ${SITE}/changelog/`, { changelog: idx.changelog || [] });
  return { ...out(`Unknown tool ${name}`, {}), isError: true };
}
async function mcp(req) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method !== 'POST') return new Response(JSON.stringify({ name: 'Civic Charts MCP server', use: 'POST JSON-RPC (MCP Streamable HTTP)', tools: MCP_TOOLS.map(t => t.name) }), { status: req.method === 'GET' ? 405 : 405, headers: { ...h, Allow: 'POST', 'Content-Type': 'application/json' } });
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers: { ...h, 'Content-Type': 'application/json' } }); }
  const one = async m => {
    if (m?.id === undefined) return null; // notification
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result }), err = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    try {
      switch (m.method) {
        case 'initialize': {
          const asked = m.params?.protocolVersion;
          return ok({ protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'civic-charts', title: 'Civic Charts', version: '1.0.0', websiteUrl: SITE }, instructions: MCP_INSTRUCTIONS });
        }
        case 'ping': return ok({});
        case 'tools/list': return ok({ tools: MCP_TOOLS });
        case 'tools/call': return ok(await callTool(m.params?.name, m.params?.arguments));
        case 'resources/list': return ok({ resources: [] });
        case 'resources/templates/list': return ok({ resourceTemplates: [] });
        case 'prompts/list': return ok({ prompts: [] });
        default: return err(-32601, `Method not found: ${m.method}`);
      }
    } catch (e) { return m.method === 'tools/call' ? ok({ content: [{ type: 'text', text: `Civic Charts error: ${e.message}` }], isError: true }) : err(-32603, e.message); }
  };
  const res = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (res === null || (Array.isArray(res) && !res.length)) return new Response(null, { status: 202, headers: h });
  return new Response(JSON.stringify(res), { headers: { ...h, 'Content-Type': 'application/json' } });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(kickPoster(env));
    const t = new Date(event.scheduledTime || Date.now());
    if (t.getUTCHours() === 14 && t.getUTCDay() >= 1 && t.getUTCDay() <= 5) ctx.waitUntil(kickRefresh(env));
  },
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/media/')) return media(req, env, u.pathname.slice(7));
    if (u.pathname === '/feed/reddit.json' || u.pathname === '/feed/reddit') return feed(req, env);
    if (u.pathname === '/mcp' || u.pathname === '/mcp/') return mcp(req);
    if (u.pathname === '/api/tts' || u.pathname === '/api/tts/status') return tts(req, env, ctx, u.pathname);
    let target;
    if (u.pathname === '/api/search') {
      target = new URL('https://catalog.data.gov/search');
      u.searchParams.forEach((v, k) => target.searchParams.set(k, v));
    } else if (u.pathname === '/api/proxy') {
      try { target = new URL(u.searchParams.get('url')); } catch { return new Response('Bad URL', { status: 400, headers: cors }); }
      if (!ALLOW.some(r => r.test(target.hostname))) return new Response('Host not on the public-data allowlist', { status: 403, headers: cors });
    } else return new Response('Not found', { status: 404, headers: cors });
    const cache = caches.default, key = new Request(target.toString());
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { 'User-Agent': 'civiccharts/1.0 (public data visualizer)' } });
      if (!up.ok) return new Response(`Upstream HTTP ${up.status}`, { status: 502, headers: cors });
      if (+up.headers.get('content-length') > 40e6) return new Response('File is larger than 40 MB', { status: 413, headers: cors });
      res = new Response(up.body, { headers: { ...cors, 'Content-Type': up.headers.get('content-type') || 'text/plain', 'Cache-Control': 'public, max-age=3600' } });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    return res;
  },
};
