
## Changelog (public, keep it current)

`public/changelog.json` feeds civiccharts.com/changelog/. With every user-facing change, add an
entry at the top in the same commit: `{ "date": "YYYY-MM-DD", "title": "...", "text": "..." }`.
- Plain language, one or two sentences at most: what changed and why it helps.
- Add `"major": true` for big features (new data packs, new tools, new formats).
- Simple fixes: title only, e.g. `"Fixed: loading search results on phones"`, no text.
- Skip internal work (CI, the auto-poster, refactors) that visitors never see.
- Only add an entry once the feature actually works for visitors (e.g. after a Worker deploy).
