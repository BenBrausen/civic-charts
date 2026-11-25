// Builds the deployable site in _site/: a copy of public/ plus, for every dataset,
// a page at /<id>/ with its own title, description, link-preview image, Google Dataset
// markup and crawlable text (summary, facts, how to read it, source, related charts).
// Also writes sitemap.xml and feed.xml (RSS of new data releases).
//
// Each page's text and image come from the real app via its render hook
// (?render=1), so pages say exactly what the charts say, claim check included.
//   node scripts/build-pages.mjs            (needs Playwright + Chromium)
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUB = path.join(ROOT, 'public'), SITE = path.join(ROOT, '_site');
const ORIGIN = 'https://civiccharts.com';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain' };

// 1. Start from an exact copy of public/, so a failure below still deploys the app.
await fs.rm(SITE, { recursive: true, force: true });
await fs.cp(PUB, SITE, { recursive: true });
const template = await fs.readFile(path.join(PUB, 'index.html'), 'utf8');
const catalog = JSON.parse(await fs.readFile(path.join(PUB, 'data/catalog.json'), 'utf8'));
const registry = JSON.parse(await fs.readFile(path.join(PUB, 'sources/registry.json'), 'utf8'));
let releases = []; try { releases = JSON.parse(await fs.readFile(path.join(PUB, 'data/releases.json'), 'utf8')); } catch { }
const topicName = id => registry.topics.find(t => t.id === id)?.name || 'More data';

// 2. Serve _site locally and read every chart through the render hook.
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(SITE, path.normalize(p)); if (!f.startsWith(SITE)) throw new Error('forbidden');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(await fs.readFile(f));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
const infos = {};
for (const c of catalog) {
  try {
    await page.goto(`${base}/?d=${encodeURIComponent(c.id)}&render=1&size=link&format=image`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.CC_RENDER?.ready, null, { timeout: 60000 });
    const info = await page.evaluate(() => window.CC_RENDER.info);
    const png = await page.evaluate(() => window.CC_RENDER.image());
    await fs.mkdir(path.join(SITE, c.id), { recursive: true });
    await fs.writeFile(path.join(SITE, c.id, 'og.png'), Buffer.from(png.split(',')[1], 'base64'));
    // State maps: every state's own takeaway, for the state pages (/states/<state>/<chart>/).
    if (c.geo === 'us-states') { info.places = await page.evaluate(() => window.CC_RENDER.places?.() || []); info.us = await page.evaluate(() => window.CC_RENDER.usText?.() || {}); }
    infos[c.id] = info;
    console.log('page', c.id.padEnd(24), cut(info.headline, 70));
  } catch (e) { console.error('FAIL', c.id, e.message); }
}
await browser.close(); server.close();

// 3. Write each dataset page.
const pageTitle = info => {
  const [val, dateRaw] = String(info.latestText || '').split(' · '), date = (dateRaw || '').replace(/^through /, '');
  const v = (val || '').replace(/^(Contiguous )?U\.S\.: /, 'U.S. '); // on map pages the value is the national figure; say so
  // A question title ("Are wages keeping up with prices?") reads badly with a bare value after it.
  let t = v && !info.title.endsWith('?') && !/\b(states|counties|countries|events)\b/.test(v) && date ? `${info.title}: ${v} (${date})` : date ? `${info.title} (${date})` : info.title;
  if (t.length > 62) t = date ? `${info.title} (${date})` : info.title;
  return `${t} | Civic Charts`;
};
const related = c => catalog.filter(x => x.id !== c.id && x.topic === c.topic && infos[x.id] && (!x.reframes || x.reframes[0] === x.id)).slice(0, 8);
function staticBody(c, info) {
  const facts = info.facts.slice(0, 5).map(f => `<li>${esc(f)}</li>`).join('');
  const read = info.howToRead.length ? `<div class="howto"><b>How to read it</b> ${info.howToRead.map(esc).join(' ')}</div>` : '';
  const src = info.source || {};
  const rel = related(c).map(x => `<li><a href="/${x.id}/">${esc(infos[x.id].title)}</a></li>`).join('');
  return `<div class="static-intro"><h2>${esc(info.title)}</h2><p class="headline">${esc(info.headline)}</p><ul class="facts">${facts}</ul>${read}
<p class="muted">Source: ${src.url ? `<a href="${esc(src.url)}" rel="noopener">${esc(src.publisher)}</a>` : esc(src.publisher)}${src.dataset ? ', ' + esc(src.dataset) : ''}. Updated automatically from the official data. <a href="/about/#how-every-chart-is-checked">How we check the data</a>.</p>
<p class="muted">Cite: Civic Charts. "${esc(info.title)}." Data: ${esc(src.publisher)}${src.dataset ? ', ' + esc(src.dataset) : ''}. ${ORIGIN}/${c.id}/</p>
${rel ? `<h2>More ${esc(topicName(c.topic).toLowerCase())} charts</h2><ul class="static-links">${rel}</ul>` : ''}<p><a href="/">All charts on Civic Charts</a></p></div>`;
}
function datasetLd(c, info) {
  const src = info.source || {};
  const desc = cut(`${info.description || ''} ${info.headline}`.trim(), 4900);
  return {
    '@context': 'https://schema.org', '@type': 'Dataset', name: info.title, description: desc.length >= 50 ? desc : `${desc} Charted from official data by Civic Charts.`,
    url: `${ORIGIN}/${c.id}/`, isAccessibleForFree: true, keywords: [topicName(c.topic), src.publisher, 'open data', 'chart'].filter(Boolean),
    creator: { '@type': 'Organization', name: src.publisher }, ...(src.url ? { isBasedOn: src.url } : {}),
    includedInDataCatalog: { '@type': 'DataCatalog', name: 'Civic Charts', url: ORIGIN + '/' },
    distribution: [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${ORIGIN}/data/${c.id}.json` }],
    ...(c.firstObservation && c.lastObservation ? { temporalCoverage: `${String(c.firstObservation).slice(0, 10)}/${String(c.lastObservation).slice(0, 10)}` } : {}),
    spatialCoverage: c.geo === 'world' ? 'World' : 'United States', dateModified: String(info.retrieved || '').slice(0, 10) || undefined,
  };
}
function withHead(html, { title, desc, url, image, imageW, imageH, alt, ld, pageD }) {
  const set = (re, tag) => { if (!re.test(html)) throw new Error('template changed: ' + re); html = html.replace(re, tag); };
  set(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  set(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`);
  set(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(url)}">`);
  set(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(url)}">`);
  set(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title.replace(/ \| Civic Charts$/, ''))}">`);
  set(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`);
  set(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${esc(image)}">`);
  set(/<meta property="og:image:width" content="[^"]*">/, `<meta property="og:image:width" content="${imageW}">`);
  set(/<meta property="og:image:height" content="[^"]*">/, `<meta property="og:image:height" content="${imageH}">`);
  set(/<meta property="og:image:alt" content="[^"]*">/, `<meta property="og:image:alt" content="${esc(cut(alt, 400))}">`);
  const extra = `<link rel="alternate" type="application/rss+xml" title="Civic Charts: new data releases" href="${ORIGIN}/feed.xml">\n`
    + (ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>\n` : '')
    + (pageD ? `<script>window.CC_PAGE = { d: ${JSON.stringify(pageD)} };</script>\n` : '');
  return html.replace('</head>', extra + '</head>');
}
for (const c of catalog) {
  const info = infos[c.id]; if (!info) continue;
  let html = withHead(template, {
    title: pageTitle(info), desc: cut(`${info.headline} Source: ${info.source?.publisher}.`, 158), url: `${ORIGIN}/${c.id}/`,
    image: `${ORIGIN}/${c.id}/og.png`, imageW: info.width, imageH: info.height, alt: info.altText, ld: datasetLd(c, info), pageD: c.id,
  });
  html = html.replace('<aside class="panel insight" id="insight"></aside>', `<aside class="panel insight" id="insight">${staticBody(c, info)}</aside>`);
  await fs.writeFile(path.join(SITE, c.id, 'index.html'), html);
}

// 4. Homepage: crawlable list of every chart, grouped by topic (the app replaces it on load).
const byTopic = {};
for (const c of catalog) if (infos[c.id]) (byTopic[topicName(c.topic)] ||= []).push(c);
const list = Object.entries(byTopic).map(([t, cs]) => `<h2>${esc(t)}</h2><ul class="static-links">${cs.map(c => `<li><a href="/${c.id}/">${esc(infos[c.id].title)}</a></li>`).join('')}</ul>`).join('');
let home = template.replace('</head>', `<link rel="alternate" type="application/rss+xml" title="Civic Charts: new data releases" href="${ORIGIN}/feed.xml">\n</head>`);
home = home.replace('<aside class="panel insight" id="insight"></aside>', `<aside class="panel insight" id="insight"><div class="static-intro"><h2>Charts from official public data</h2>${list}</div></aside>`);
await fs.writeFile(path.join(SITE, 'index.html'), home);

// 4b. State pages: /states/ (all states), /states/<state>/ (every number for one state) and
// /states/<state>/<chart>/ (one answer: the state's value, rank, trend and the full table).
// Text comes from the chart's own analysis for that state (same checks as the charts).
const slug = name => name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
const measureOf = info => info.title.replace(/\s+by state$/i, '').replace(/^State\s+/i, '');
const STATE_CSS = `:root{--bg:#f6f5f1;--fg:#1b1b1b;--muted:#555;--line:#ddd9cf;--accent:#1d4e89;--hi:#e8f0fb;--box:#fff}@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ececec;--muted:#aaa;--line:#333;--accent:#8db4ff;--hi:#1d2736;--box:#222}}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,-apple-system,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{font-size:30px;line-height:1.2;margin:0 0 10px}h2{font-size:20px;margin:30px 0 8px}.answer{font-size:20px;line-height:1.5}.muted{color:var(--muted);font-size:15px}a{color:var(--accent)}nav{margin-bottom:22px;font-size:15px}nav a{text-decoration:none;font-weight:600}table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}td.v,th.v{text-align:right;font-variant-numeric:tabular-nums}tr.me td{background:var(--hi);font-weight:700}.chart{width:100%;height:auto;border-radius:10px;border:1px solid var(--line);background:var(--box)}.btn{display:inline-block;padding:10px 14px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:6px 0}ul.list{padding-left:18px}ul.list li{margin:8px 0}footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}`;
const statePage = ({ title, desc, url, image, ld, body }) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}"><link rel="icon" href="/favicon.ico" sizes="any">
<meta property="og:type" content="article"><meta property="og:title" content="${esc(title.replace(/ \| Civic Charts$/, ''))}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<style>${STATE_CSS}</style>${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head><body><main>${body}
<footer class="muted">Data from official public sources, checked against the numbers before publishing. <a href="/about/">About Civic Charts</a> · <a href="/">All charts</a> · <a href="mailto:corrections@civiccharts.com">Report an error</a></footer>
</main></body></html>
`;
const stateCharts = catalog.filter(c => c.geo === 'us-states' && infos[c.id]?.places?.length && (!c.reframes || c.reframes[0] === c.id));
const states = new Map(); // code -> { name, slug, items: [{ c, info, p }] }
for (const c of stateCharts) for (const p of infos[c.id].places) {
  const st = states.get(p.code) || { name: p.name, slug: slug(p.name), items: [] };
  st.items.push({ c, info: infos[c.id], p }); states.set(p.code, st);
}
const stateUrls = [];
for (const [code, st] of [...states].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const dir = path.join(SITE, 'states', st.slug);
  for (const { c, info, p } of st.items) {
    const measure = measureOf(info), url = `${ORIGIN}/states/${st.slug}/${c.id}/`, src = info.source || {};
    const ranked = info.places.slice().sort((a, b) => b.value - a.value);
    const rankOf = x => 1 + ranked.filter(y => y.value > x.value).length, tied = x => ranked.filter(y => y.value === x.value).length > 1;
    const rows = ranked.map(x => `<tr${x.code === code ? ' class="me"' : ''}><td>${tied(x) ? 'T-' : ''}${rankOf(x)}</td><td>${x.code === code ? esc(x.name) : `<a href="/states/${slug(x.name)}/${c.id}/">${esc(x.name)}</a>`}</td><td class="v">${esc(x.valueText)}</td></tr>`).join('');
    const facts = p.facts.filter(f => !/^Latest:/.test(f)).slice(0, 4).map(f => `<li>${esc(f)}</li>`).join('');
    const title = `${st.name} ${measure}: ${p.valueText} (${info.us?.asOf || ''}) | Civic Charts`;
    const body = `<nav><a href="/">Civic Charts</a> › <a href="/states/">States</a> › <a href="/states/${st.slug}/">${esc(st.name)}</a></nav>
<h1>${esc(measure)} in ${esc(st.name)}</h1>
<p class="answer">${esc(p.headline)}</p>
<a class="btn" href="/${c.id}/?state=${code}">Open the interactive chart for ${esc(st.name)}</a>
<h2>Key facts</h2><ul class="list">${facts}</ul>
${info.howToRead?.length ? `<p><b>How to read it:</b> ${esc(info.howToRead.join(' '))}</p>` : ''}
<h2>All states (${esc(info.us?.asOf || '')})</h2>
<table><thead><tr><th>Rank</th><th>State</th><th class="v">${esc(info.us?.unit || 'Value')}</th></tr></thead><tbody>${rows}</tbody></table>
${info.us?.us ? `<p class="muted">U.S.: ${esc(info.us.us)}. Rank 1 is the highest value; "T-" marks a tie.</p>` : '<p class="muted">Rank 1 is the highest value; "T-" marks a tie.</p>'}
<h2>Source</h2><p class="muted">${src.url ? `<a href="${esc(src.url)}" rel="noopener">${esc(src.publisher)}</a>` : esc(src.publisher)}${src.dataset ? `, ${esc(src.dataset)}` : ''}. Retrieved ${esc(String(info.retrieved || '').slice(0, 10))}, updated automatically. <a href="/about/#how-every-chart-is-checked">How we check the data</a>.</p>
<p class="muted">Cite: Civic Charts. "${esc(measure)} in ${esc(st.name)}." Data: ${esc(src.publisher)}. ${url}</p>
<p><a href="/states/${st.slug}/">More ${esc(st.name)} numbers</a> · <a href="/${c.id}/">${esc(info.title)}, all states</a></p>`;
    const ld = { '@context': 'https://schema.org', '@type': 'Dataset', name: `${measure} in ${st.name}`, description: p.headline, url, isAccessibleForFree: true,
      spatialCoverage: { '@type': 'Place', name: `${st.name}, United States` }, creator: { '@type': 'Organization', name: src.publisher }, ...(src.url ? { isBasedOn: src.url } : {}),
      includedInDataCatalog: { '@type': 'DataCatalog', name: 'Civic Charts', url: ORIGIN + '/' }, dateModified: String(info.retrieved || '').slice(0, 10) || undefined };
    await fs.mkdir(path.join(dir, c.id), { recursive: true });
    await fs.writeFile(path.join(dir, c.id, 'index.html'), statePage({ title, desc: cut(`${p.headline} Source: ${src.publisher}.`, 158), url, image: `${ORIGIN}/${c.id}/og.png`, ld, body }));
    stateUrls.push(url);
  }
  // The state's hub: every number, grouped by topic.
  const byT = {};
  for (const it of st.items) (byT[topicName(it.c.topic)] ||= []).push(it);
  // Most-looked-up topics first.
  const ORDER = ['economy', 'prices', 'housing', 'health', 'people', 'environment', 'safety', 'government', 'technology', 'elections', 'world'];
  const rankT = t => { const i = ORDER.indexOf(st.items.find(x => topicName(x.c.topic) === t)?.c.topic); return i < 0 ? 99 : i; };
  const sections = Object.entries(byT).sort((a, b) => rankT(a[0]) - rankT(b[0]) || a[0].localeCompare(b[0])).map(([t, its]) => `<h2>${esc(t)}</h2><ul class="list">${its.map(({ c, info, p }) => `<li><a href="/states/${st.slug}/${c.id}/"><b>${esc(measureOf(info))}</b></a>: ${esc(p.headline)}</li>`).join('')}</ul>`).join('');
  const hubUrl = `${ORIGIN}/states/${st.slug}/`;
  await fs.writeFile(path.join(dir, 'index.html'), statePage({ title: `${st.name} by the Numbers: Jobs, Wages, Housing and More | Civic Charts`,
    desc: `The latest official numbers for ${st.name}: ${st.items.slice(0, 4).map(x => measureOf(x.info).toLowerCase()).join(', ')} and more, each with its rank among states and its source.`, url: hubUrl,
    body: `<nav><a href="/">Civic Charts</a> › <a href="/states/">States</a></nav><h1>${esc(st.name)} by the numbers</h1><p class="answer">The latest official data for ${esc(st.name)}, compared with every state and the U.S. ${st.items.length} measures, each from its original source.</p>${sections}` }));
  stateUrls.push(hubUrl);
}
await fs.mkdir(path.join(SITE, 'states'), { recursive: true });
await fs.writeFile(path.join(SITE, 'states', 'index.html'), statePage({ title: 'Data by State: The Latest Official Numbers for Every State | Civic Charts',
  desc: 'Pick a state for its latest official numbers on jobs, wages, housing, health and more, each ranked against every state with its source.', url: `${ORIGIN}/states/`,
  body: `<nav><a href="/">Civic Charts</a></nav><h1>Data by state</h1><p class="answer">Pick a state for its latest official numbers, each ranked against every state, with the source.</p><ul class="list">${[...states.values()].sort((a, b) => a.name.localeCompare(b.name)).map(st => `<li><a href="/states/${st.slug}/">${esc(st.name)}</a></li>`).join('')}</ul>` }));
stateUrls.push(`${ORIGIN}/states/`);

// 4c. What each page shows, as a fingerprint, so IndexNow (scripts/indexnow.mjs) only tells
// search engines about pages whose data actually changed, not every page on every refresh.
const sigs = {};
const sig = (...parts) => parts.map(x => String(x ?? '')).join('|');
for (const c of catalog) if (infos[c.id]) sigs[`${ORIGIN}/${c.id}/`] = sig(c.lastObservation, infos[c.id].headline);
for (const [, st] of states) {
  for (const { c, p } of st.items) sigs[`${ORIGIN}/states/${st.slug}/${c.id}/`] = sig(c.lastObservation, p.headline);
  sigs[`${ORIGIN}/states/${st.slug}/`] = sig(...st.items.map(x => x.c.lastObservation));
}
sigs[`${ORIGIN}/`] = sig(catalog.length, releases[0]?.released);
sigs[`${ORIGIN}/states/`] = sig(states.size);
for (const f of ['about', 'changelog', 'privacy', 'terms', 'ai']) {
  try { sigs[`${ORIGIN}/${f}/`] = sig((await fs.readFile(path.join(PUB, f, 'index.html'), 'utf8')).length, f === 'changelog' ? (await fs.readFile(path.join(PUB, 'changelog.json'), 'utf8')).length : ''); } catch { }
}
await fs.mkdir(path.join(ROOT, 'out'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'out', 'page-signatures.json'), JSON.stringify(sigs));

// 5. Sitemap with every page.
const day = t => String(t || '').slice(0, 10);
const urls = [`  <url><loc>${ORIGIN}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
  ...catalog.filter(c => infos[c.id]).map(c => `  <url><loc>${ORIGIN}/${c.id}/</loc>${day(c.released || c.retrieved) ? `<lastmod>${day(c.released || c.retrieved)}</lastmod>` : ''}<changefreq>${['weekly', 'real-time'].includes(c.frequency) ? 'daily' : 'weekly'}</changefreq></url>`),
  ...stateUrls.map(u => `  <url><loc>${u}</loc><changefreq>weekly</changefreq></url>`),
  ...['about', 'changelog'].map(p => `  <url><loc>${ORIGIN}/${p}/</loc></url>`)];
await fs.writeFile(path.join(SITE, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);

// 6. RSS feed of new releases. The newest release of each dataset carries its current headline.
const seen = new Set();
const items = releases.slice(0, 50).map(r => {
  const info = infos[r.id], first = !seen.has(r.id); seen.add(r.id);
  const desc = first && info ? `${info.headline} Source: ${info.source?.publisher}.` : `New ${r.publisher || 'official'} data for ${r.title}, through ${day(r.lastObservation)}.`;
  return `  <item><title>${esc(`New data: ${info?.title || r.title}`)}</title><link>${ORIGIN}/${r.id}/</link><guid isPermaLink="false">${esc(r.id + '@' + r.released)}</guid><pubDate>${new Date(r.released).toUTCString()}</pubDate><description>${esc(desc)}</description></item>`;
});
await fs.writeFile(path.join(SITE, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
  <title>Civic Charts: new data releases</title><link>${ORIGIN}/</link>
  <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>New official public data as it's released, charted with the source cited.</description><language>en-us</language>
${items.join('\n')}
</channel></rss>
`);
// 7. Changelog page, pre-rendered from changelog.json so it reads without JavaScript.
const changelog = JSON.parse(await fs.readFile(path.join(PUB, 'changelog.json'), 'utf8').catch(() => '[]'));
{
  const fmtDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  let last = '', li = '';
  for (const e of changelog) {
    if (e.date !== last) { li += `<li class="day">${fmtDay(e.date)}</li>`; last = e.date; }
    li += `<li class="e${e.major ? ' major' : ''}">${e.major ? '<span class="tag">New</span>' : ''}<b>${esc(e.title)}</b>${e.text ? `<span>${esc(e.text)}</span>` : ''}</li>`;
  }
  const f = path.join(SITE, 'changelog', 'index.html');
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('<!--LOG-->', li));
}

// 8. For AI tools (the MCP server on the Worker, and crawlers): one compact summary of every
// chart, from the same render-hook text as the pages. State maps carry every state's latest
// value, so "what's Minnesota's rate?" is answered from this file alone; county maps are looked
// up from data/<id>.json on demand.
const ai = [];
for (const c of catalog) {
  const info = infos[c.id]; if (!info) continue;
  const item = {
    id: c.id, title: info.title, topic: c.topic, topicName: topicName(c.topic), geo: c.geo || null, frequency: c.frequency,
    headline: info.headline, facts: (info.facts || []).slice(0, 5), howToRead: (info.howToRead || [])[0] || null,
    latest: c.latest || null, latestText: info.latestText || null, lastObservation: c.lastObservation, released: c.released || null, retrieved: info.retrieved,
    unit: c.unit?.label || null, unitFormat: c.unit ? { format: c.unit.format, decimals: c.unit.decimals } : null, description: cut(info.description || '', 400),
    source: { publisher: info.source?.publisher, dataset: info.source?.dataset, url: info.source?.url },
    page: `${ORIGIN}/${c.id}/`, image: `${ORIGIN}/${c.id}/og.png`, data: `${ORIGIN}/data/${c.id}.json`,
  };
  if (c.geo === 'us-states') {
    try {
      const ds = JSON.parse(await fs.readFile(path.join(PUB, 'data', `${c.id}.json`), 'utf8'));
      const li = (ds.times || []).length - 1;
      if (li >= 0) item.places = Object.fromEntries((ds.entities || []).filter(e => e.values?.[li] != null).map(e => [e.name, e.values[li]]));
      item.placesAsOf = ds.times?.[li] ?? null;
      if (stateCharts.some(x => x.id === c.id)) item.statePages = `${ORIGIN}/states/{state}/${c.id}/`;
    } catch { /* no per-state values */ }
  }
  ai.push(item);
}
await fs.mkdir(path.join(SITE, 'ai'), { recursive: true });
await fs.writeFile(path.join(SITE, 'ai', 'index.json'), JSON.stringify({ updated: new Date().toISOString(), site: ORIGIN, count: ai.length,
  releases: releases.slice(0, 30).map(r => ({ id: r.id, title: r.title, released: r.released, lastObservation: r.lastObservation })), changelog: changelog.slice(0, 15), charts: ai }));
await fs.writeFile(path.join(SITE, 'llms.txt'), `# Civic Charts

> Charts and maps of official U.S. public data (BLS, Census, BEA, NOAA, HUD, EIA, FBI and more), each citing its source. Free, no account. Numbers come straight from the publisher; every chart's text is checked against the data.

- [All charts with headline, key facts, latest value, source and links (JSON)](${ORIGIN}/ai/index.json)
- [MCP server for AI assistants](https://plainsight-proxy.misty-brook-457e.workers.dev/mcp): search charts, get a chart with its facts and source, get a state's value, list new releases
- [New data releases (RSS)](${ORIGIN}/feed.xml)
- [What's new](${ORIGIN}/changelog/)

## Charts
${ai.map(a => `- [${a.title}](${a.page}): ${a.headline}`).join('\n')}
`);

console.log(`\n${Object.keys(infos).length} of ${catalog.length} dataset pages, sitemap with ${urls.length} URLs, feed with ${items.length} releases.`);
