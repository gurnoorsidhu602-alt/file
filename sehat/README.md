# ਸਿਹਤ ਦੀ ਸਮਝ — Punjabi patient education

Standalone static site served at `/sehat/` (also `/punjabi` and `/patient-education` redirect here).
Public, no login, and not linked from the One Line Pimp, case simulator or textbook pages.
It only needs a static file server, so this folder can also be deployed on its own (e.g. a Render static site with publish directory `sehat`).

## Files
- `index.html` — page shell, disclaimer, script list
- `app.js` — search (Punjabi, English, romanised; ignores nukta/addak/tippi/bindi differences), subspecialty filter, article view, hash links (`#/heart-failure`, `#/heart-failure/treatment`)
- `style.css` — self-contained styles, light/dark, adjustable text size, print layout
- `data/specialties.js` — subspecialty list and the `draft` flag (shows the review banner)
- `data/<subspecialty>.js` — articles

## Adding an article
Push an object into `SEHAT.articles` in the matching `data/*.js` file (add a new file to `index.html` for a new subspecialty):

```js
{
  id: 'url-slug', specialty: 'cardiology',
  title: 'ਪੰਜਾਬੀ ਸਿਰਲੇਖ', en: 'English name',
  aka: ['other Punjabi names'], keywords: ['english', 'romanised', 'drug names'],
  summary: 'one or two sentences', key: ['take-home points'],
  sections: { what: [], why: [], symptoms: [], diagnosis: [], treatment: [], help: [] },
  reviewed: '' // e.g. 'Dr X, 2026-12' once reviewed
}
```

Section blocks: a string (paragraph), `{ h }` sub-heading, `{ ul: [] }`, `{ note }`, `{ meds: [{ name, ex, why, tip }] }`,
`{ call911: [] }`, `{ callDoc: [] }`. `**bold**` is supported.

## Writing rules
- Gurmukhi, everyday ਠੇਠ Punjabi; avoid Hindi/Sanskrit-heavy terms. Keep drug names in English (as on Canadian labels) next to the Punjabi.
- Every treatment explains *why* it works in plain terms, with practical tips that support adherence.
- Canadian framing: SI units, 911/811, Canadian brand names.
- Keep `draft: true` until each article has clinician and native-speaker review.
