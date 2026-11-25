// Tells search engines (Bing, and through it ChatGPT search and Copilot; also Yandex, Seznam,
// Naver) which pages changed, right after each deploy, so new numbers are found in hours, not days.
// Compares out/page-signatures.json (written by build-pages.mjs) with indexnow-state.json (what
// was last submitted, committed by the workflow) and submits only the pages whose data changed.
// The key is public by design: IndexNow checks that https://civiccharts.com/<key>.txt holds it.
//   node scripts/indexnow.mjs           (DRY_RUN=1 prints instead of submitting)
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOST = 'civiccharts.com', KEY = '268dad0167848bfa1a731fdfe7d7b70d';
const STATE = path.join(ROOT, 'indexnow-state.json');
const read = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

export async function run({ dry = !!process.env.DRY_RUN } = {}) {
  const sigs = await read(path.join(ROOT, 'out', 'page-signatures.json'), null);
  if (!sigs) { console.log('No page signatures (build-pages.mjs did not run); nothing to submit.'); return []; }
  const prev = await read(STATE, {});
  const changed = Object.keys(sigs).filter(u => prev[u] !== sigs[u]);
  if (!changed.length) { console.log('IndexNow: no pages changed.'); return []; }
  console.log(`IndexNow: ${changed.length} changed page(s)${changed.length <= 10 ? `: ${changed.join(', ')}` : ''}.`);
  if (dry) return changed;
  for (let i = 0; i < changed.length; i += 10000) {
    const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: changed.slice(i, i + 10000) }) });
    // 200 and 202 both mean accepted (202: key validation pending, normal on the first submission).
    if (![200, 202].includes(r.status)) throw new Error(`IndexNow answered ${r.status} ${(await r.text()).slice(0, 200)}`);
    console.log(`IndexNow: accepted (${r.status}).`);
  }
  await fs.writeFile(STATE, JSON.stringify(sigs, null, 0) + '\n');
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
