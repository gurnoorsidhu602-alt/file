# ਸਿਹਤ ਦੀ ਸਮਝ — Punjabi patient education

Standalone static site served at `/sehat/` (also `/punjabi` and `/patient-education` redirect here).
Public, no login, and not linked from the One Line Pimp, case simulator or textbook pages.
It only needs a static file server, so this folder can also be deployed on its own (e.g. a Render static site with publish directory `sehat`).

## Files
- `index.html` — page shell, disclaimer, script list
- `app.js` — layout modelled on the IM textbook: numbered chapter tree, search results by section (Punjabi, English, romanised; ignores nukta/addak/tippi/bindi), article page with "on this page" list, previous/next, read marks (this browser only). Links: `#/a/heart-failure`, `#/a/heart-failure?s=treatment`, `#/search?q=sugar` (old `#/heart-failure` links still work)
- `style.css` — self-contained styles (tokens copied from `/assets/theme.css`), light/dark, text size, print, mobile slide-out menu
- `data/specialties.js` — chapters, numbered like the textbook (01 Cardiology … 18 After the ICU), and the `draft` flag
- `data/<chapter>.js` — articles; within a chapter they appear in the order pushed
- `data/shared.js` — reusable "when to get help" block lists (`SEHAT.shared`) so linked articles give identical advice: `chestPain`, `stroke`, `giBleed`, `thinner`, `chemoFever`, `confusion`, `foot`, `sickDay`, `sglt2`, `severeRash`
- `data/sources.js` — `SEHAT.sources` (S01…), `SEHAT.siteRefs` (shown on every article) and `SEHAT.refs` (article id → source ids). Every article must have an entry.

Region: the site is written for **British Columbia**. The footer carries 911, 8-1-1 (with the line to ask for a Punjabi interpreter) and BC Drug and Poison Information 1-800-567-8911.

## Adding an article
Push an object into `SEHAT.articles` in the matching `data/*.js` file (add a new file to `index.html` for a new subspecialty):

```js
{
  id: 'url-slug', specialty: 'cardiology',
  title: 'ਪੰਜਾਬੀ ਸਿਰਲੇਖ', short: 'sidebar title (optional)', en: 'English name',
  aka: ['other Punjabi names'], keywords: ['english', 'romanised', 'drug names'],
  summary: 'one or two sentences', key: ['take-home points'],
  action: { h: 'heading', steps: ['numbered first-aid steps'] }, // optional red box under the title for time-critical pages; or blocks: [tier blocks / { use }]
  sections: { what: [], why: [], symptoms: [], diagnosis: [], treatment: [], help: [] },
  review: { clinical: 'Dr X (specialty)', language: 'Name', date: '2026-12' }, // shown as "pending" until filled
  refs: ['S99'] // optional extra source ids; the main mapping is in data/sources.js
}
```

Section blocks: a string (paragraph), `{ h }` sub-heading, `{ ul: [] }`, `{ ol: [] }`, `{ like }` analogy callout ("ਮਿਸਾਲ ਨਾਲ ਸਮਝੋ"), `{ note }`, `{ meds: [{ name, ex, why, tip }] }`, `{ use: 'sharedName' }`. `**bold**` is supported.

### Urgency tiers
Use one tier per level of urgency; never mix levels in one list:

| block | box heading | colour |
|---|---|---|
| `{ call911: [] }` | ਹੁਣੇ 911 ਉੱਤੇ ਫ਼ੋਨ ਕਰੋ ਜੇ | red |
| `{ poison: [] }` | ਹੁਣੇ ਜ਼ਹਿਰ ਅਤੇ ਦਵਾਈ ਜਾਣਕਾਰੀ ਕੇਂਦਰ ਨੂੰ ਫ਼ੋਨ ਕਰੋ ਜੇ | red |
| `{ goED: [] }` | ਹੁਣੇ ਹਸਪਤਾਲ ਦੇ ਐਮਰਜੈਂਸੀ ਵਿਭਾਗ ਜਾਓ ਜੇ | orange |
| `{ today: [] }` | ਅੱਜ ਹੀ ਡਾਕਟਰੀ ਜਾਂਚ ਕਰਵਾਓ ਜੇ | amber |
| `{ book: [] }` | ਆਪਣੇ ਡਾਕਟਰ ਨਾਲ ਮੁਲਾਕਾਤ ਲਵੋ ਜੇ | blue |

Each tier block may carry `act: '…'` — an instruction sentence (e.g. "do not drive yourself") shown under the list; keep directions out of the symptom lists. Within a section, all blocks of the same tier (including those pulled in with `{ use }`) are merged into one box, duplicates removed, and the boxes sorted most-urgent first; each box ends with a fixed fallback line. The old `callDoc` block still renders but is deprecated — don't use it.

## House style (Punjabi)
- ਜੀਅ ਕੱਚਾ ਹੋਣਾ (nausea), not ਕੱਚ.
- ਲਹੂ ਵਿੱਚ ਸ਼ੱਕਰ for the measured blood glucose; ਖੰਡ only for dietary sugar.
- ਦਵਾਈ ਦੀ ਮਾਤਰਾ for dose where ਖ਼ੁਰਾਕ could be read as "diet".
- ਦਿਮਾਗ਼ ਦਾ ਦੌਰਾ (ਸਟ੍ਰੋਕ) for stroke; ਅਧਰੰਗ only for paralysis.
- ਸਿਰ ਦਰਦ (no hyphen); ਦਿਲ ਤੇਜ਼ ਜਾਂ ਬੇਤਰਤੀਬ ਧੜਕਣਾ for palpitations; ਵਿਅਕਤੀ rather than ਬੰਦਾ.

## Writing rules
- Gurmukhi, everyday ਠੇਠ Punjabi; avoid Hindi/Sanskrit-heavy terms. Keep drug names in English (as on Canadian labels) next to the Punjabi.
- Every article has at least one `{ like }` analogy from everyday life (ਖਾਲ਼, ਪਾਈਪ, ਚਾਬੀ-ਜਿੰਦਾ, ਖੇਤ).
- Every treatment explains *why* it works in plain terms, with practical tips that support adherence.
- Canadian framing: SI units, 911/811, Canadian brand names.
- Keep `draft: true` until each article has clinician and native-speaker review (fill `review` per article).
