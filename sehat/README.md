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

## Adding an article
Push an object into `SEHAT.articles` in the matching `data/*.js` file (add a new file to `index.html` for a new subspecialty):

```js
{
  id: 'url-slug', specialty: 'cardiology',
  title: 'ਪੰਜਾਬੀ ਸਿਰਲੇਖ', short: 'sidebar title (optional)', en: 'English name',
  aka: ['other Punjabi names'], keywords: ['english', 'romanised', 'drug names'],
  summary: 'one or two sentences', key: ['take-home points'],
  sections: { what: [], why: [], symptoms: [], diagnosis: [], treatment: [], help: [] },
  reviewed: '' // e.g. 'Dr X, 2026-12' once reviewed
}
```

Section blocks: a string (paragraph), `{ h }` sub-heading, `{ ul: [] }`, `{ like }` analogy callout ("ਮਿਸਾਲ ਨਾਲ ਸਮਝੋ"), `{ note }`, `{ meds: [{ name, ex, why, tip }] }`,
`{ call911: [] }`, `{ callDoc: [] }`. `**bold**` is supported.

## Writing rules
- Gurmukhi, everyday ਠੇਠ Punjabi; avoid Hindi/Sanskrit-heavy terms. Keep drug names in English (as on Canadian labels) next to the Punjabi.
- Every article has at least one `{ like }` analogy from everyday life (ਖਾਲ਼, ਪਾਈਪ, ਚਾਬੀ-ਜਿੰਦਾ, ਖੇਤ).
- Every treatment explains *why* it works in plain terms, with practical tips that support adherence.
- Canadian framing: SI units, 911/811, Canadian brand names.
- Keep `draft: true` until each article has clinician and native-speaker review.
