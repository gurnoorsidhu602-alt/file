// Canadian clinical units.
//
// Two layers:
//  1. CANADIAN_UNITS_RULE is appended to every AI system prompt (lib/ai.js), so
//     the models are told exactly which units Canadian labs and charts use.
//  2. toCanadianText / toCanadianDeep / normalizeTestDef convert conventional
//     (US) units that a model still emits, before anything is stored or shown.
//
// Canadian convention is mostly SI, with a few deliberate exceptions that stay
// as Canadian labs report them: blood pressure and blood gases in mmHg, HbA1c
// in %, ESR in mm/h, INR unitless.

export const CANADIAN_UNITS_RULE = `UNITS (mandatory): use Canadian clinical units only, as a Canadian hospital lab and chart would report them.
- Chemistry: Na, K, Cl, HCO3, anion gap, urea, glucose, Ca, Mg, phosphate, lactate, ketones, lipids in mmol/L; creatinine, bilirubin, urate, ammonia, acetaminophen in umol/L; albumin and total protein in g/L; osmolality in mmol/kg; urea (never "BUN").
- Hematology: hemoglobin in g/L (e.g. 132, never 13.2 g/dL); WBC, neutrophils, platelets in x10^9/L; fibrinogen in g/L.
- Cardiac/endocrine: hs-troponin in ng/L; NT-proBNP in ng/L; TSH in mIU/L; free T4 in pmol/L; cortisol in nmol/L; B12 in pmol/L; ferritin in ug/L; CRP in mg/L.
- Keep as Canadian labs report: BP, pCO2 and pO2 in mmHg; HbA1c in %; ESR in mm/h; INR unitless.
- Temperature in degrees C; weight in kg; height in cm; fluid volumes in mL/L; doses in metric units.
- Never use mg/dL, g/dL, mEq/L, ng/mL troponin, K/uL, /mm3, degrees F, lb, feet or inches, including in explanations and options.`;

const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };
const fmt = (x, dp) => round(x, dp).toFixed(dp);

// Analyte-specific conversions from conventional units.
// re: analyte name as it appears in text or a test name.
// from: conventional unit regex. f: multiply factor. dp: decimals.
const MG_DL = 'mg\\s*/\\s*d[lL]';
const G_DL = 'g\\s*/\\s*d[lL]';
const UG_DL = '(?:µg|ug|mcg)\\s*/\\s*d[lL]';
const NG_ML = 'ng\\s*/\\s*m[lL]';
const PG_ML = 'pg\\s*/\\s*m[lL]';
const UG_ML = '(?:µg|ug|mcg)\\s*/\\s*m[lL]';
const NG_DL = 'ng\\s*/\\s*d[lL]';
const MEQ = 'mEq\\s*/\\s*[lL]';

const CONVERSIONS = [
  { re: 'blood urea nitrogen|BUN|urea(?: nitrogen)?', from: MG_DL, f: 0.357, dp: 1, to: 'mmol/L', rename: 'urea' },
  { re: '(?:fasting |random |capillary |point[- ]of[- ]care |poc |blood |serum |plasma )?glucose|blood sugar|BG|CBG|FBG', from: MG_DL, f: 1 / 18.016, dp: 1, to: 'mmol/L' },
  { re: 'creatinine|Cr|SCr', from: MG_DL, f: 88.4, dp: 0, to: 'µmol/L' },
  { re: '(?:total |direct |indirect |conjugated |unconjugated )?bilirubin|T\\.? ?bili|bili', from: MG_DL, f: 17.1, dp: 0, to: 'µmol/L' },
  { re: '(?:total |corrected |serum )?calcium|Ca(?:2\\+|\\+\\+)?', from: MG_DL, f: 0.2495, dp: 2, to: 'mmol/L' },
  { re: '(?:ionized |ionised )calcium|iCa', from: MG_DL, f: 0.2495, dp: 2, to: 'mmol/L' },
  { re: 'magnesium|Mg(?:2\\+)?', from: MG_DL, f: 0.4114, dp: 2, to: 'mmol/L' },
  { re: 'phosph(?:ate|orus)|PO4|Phos', from: MG_DL, f: 0.3229, dp: 2, to: 'mmol/L' },
  { re: '(?:total |LDL |HDL |non-HDL )?cholesterol|LDL(?:-C)?|HDL(?:-C)?|non-HDL(?:-C)?', from: MG_DL, f: 0.02586, dp: 2, to: 'mmol/L' },
  { re: 'triglycerides?|TG', from: MG_DL, f: 0.01129, dp: 2, to: 'mmol/L' },
  { re: 'uric acid|urate', from: MG_DL, f: 59.48, dp: 0, to: 'µmol/L' },
  { re: 'lactate|lactic acid', from: MG_DL, f: 0.111, dp: 1, to: 'mmol/L' },
  { re: 'ethanol|alcohol|EtOH|blood alcohol', from: MG_DL, f: 0.217, dp: 1, to: 'mmol/L' },
  { re: 'CRP|C-reactive protein', from: MG_DL, f: 10, dp: 0, to: 'mg/L' },
  { re: 'salicylates?|ASA level', from: MG_DL, f: 0.0724, dp: 2, to: 'mmol/L' },
  { re: '(?:serum )?albumin|alb|total protein|protein', from: G_DL, f: 10, dp: 0, to: 'g/L' },
  { re: 'h(?:a)?emoglobin|Hgb|Hb', from: G_DL, f: 10, dp: 0, to: 'g/L' },
  { re: 'MCHC', from: G_DL, f: 10, dp: 0, to: 'g/L' },
  { re: 'ammonia|NH3', from: UG_DL, f: 0.587, dp: 0, to: 'µmol/L' },
  { re: '(?:serum |random |AM |morning )?cortisol', from: UG_DL, f: 27.59, dp: 0, to: 'nmol/L' },
  { re: 'iron|Fe', from: UG_DL, f: 0.179, dp: 1, to: 'µmol/L' },
  { re: '(?:hs-?|high[- ]sensitivity )?troponin(?: [IT])?|hs-?Tn[IT]|Tn[IT]', from: NG_ML, f: 1000, dp: 0, to: 'ng/L' },
  { re: 'ferritin', from: NG_ML, f: 1, dp: 0, to: 'µg/L' },
  { re: 'procalcitonin|PCT', from: NG_ML, f: 1, dp: 2, to: 'µg/L' },
  { re: 'NT-?proBNP|BNP', from: PG_ML, f: 1, dp: 0, to: 'ng/L' },
  { re: '(?:vitamin )?B12|cobalamin', from: PG_ML, f: 0.738, dp: 0, to: 'pmol/L' },
  { re: 'free T4|FT4|fT4|T4', from: NG_DL, f: 12.87, dp: 1, to: 'pmol/L' },
  { re: 'acetaminophen|paracetamol|APAP', from: UG_ML, f: 6.62, dp: 0, to: 'µmol/L' },
  { re: 'digoxin', from: NG_ML, f: 1.281, dp: 1, to: 'nmol/L' },
  { re: 'lithium|Li', from: MEQ, f: 1, dp: 1, to: 'mmol/L' },
  { re: 'magnesium|Mg(?:2\\+)?', from: MEQ, f: 0.5, dp: 2, to: 'mmol/L' },
  { re: '(?:total |ionized )?calcium|Ca(?:2\\+)?', from: MEQ, f: 0.5, dp: 2, to: 'mmol/L' },
  { re: 'TSH', from: '(?:µ|u|m)IU\\s*/\\s*m[lL]', f: 1, dp: 2, to: 'mIU/L' }
];

// Gap between analyte and value: ":", " =", " of", " was", " is", " level", etc.
const GAP = '(\\s*(?:level|concentration)?\\s*(?:[:=]|\\bof\\b|\\bwas\\b|\\bis\\b|\\bnow\\b|\\bat\\b|\\bup to\\b|\\bdown to\\b|\\bfrom\\b)?\\s*)';
const NUM = '(\\d+(?:\\.\\d+)?)';
const RANGE = `${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?`;

const COMPILED = CONVERSIONS.map(c => ({
  ...c,
  rx: new RegExp(`(?<![A-Za-z])(${c.re})${GAP}${RANGE}\\s*(?:${c.from})(?![A-Za-z])`, 'gi'),
  nameRx: new RegExp(`^(?:${c.re})$`, 'i'),
  fromRx: new RegExp(`^(?:${c.from})$`, 'i')
}));

function convertAnalytes(s) {
  for (const c of COMPILED) {
    s = s.replace(c.rx, (_m, name, gap, a, b) => {
      const label = c.rename && /^(BUN|blood urea nitrogen|urea nitrogen)$/i.test(name) ? c.rename : name;
      const v1 = fmt(+a * c.f, c.dp);
      const v2 = b != null ? `–${fmt(+b * c.f, c.dp)}` : '';
      return `${label}${gap}${v1}${v2} ${c.to}`;
    });
  }
  return s;
}

function convertGeneric(s) {
  // Electrolytes in mEq/L are numerically equal to mmol/L for monovalent ions.
  // (Ca/Mg/Li in mEq/L were handled above with their own factors.)
  s = s.replace(new RegExp(`${NUM}\\s*${MEQ}`, 'gi'), (_m, a) => `${a} mmol/L`);

  // Cell counts.
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:k|K|x\s*10\^?3|×\s*10\^?3|x10\^?3|×10\^?3|thou)\s*\/\s*(?:µ|u|mc)?L\b/g, (_m, a) => `${a} ×10^9/L`);
  s = s.replace(/(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:cells\s*)?\/\s*(?:mm3|mm\^3|mm³|(?:µ|u|mc)L)\b/g, (_m, a) => { const v = +a.replace(/,/g, '') / 1000; return `${fmt(v, v >= 10 ? 0 : 1)} ×10^9/L`; });

  // Temperature: only explicit Fahrenheit markers.
  s = s.replace(/(\d{2,3}(?:\.\d+)?)\s*(?:°\s*F|º\s*F|degrees?\s*F(?:ahrenheit)?|F(?:ahrenheit)\b)(?![A-Za-z])/g, (_m, a) => `${fmt((+a - 32) * 5 / 9, 1)}°C`);

  // Height: 5'10", 5 ft 10 in, 5 feet 10 inches.
  s = s.replace(/(\d)\s*(?:'|’|ft\b|feet\b|foot\b)\s*(\d{1,2})\s*(?:"|”|''|in\b|inches\b|inch\b)?/g, (_m, ft, inch) => `${Math.round((+ft * 12 + +inch) * 2.54)} cm`);
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:feet|foot|ft)\b(?!\s*\d)/g, (_m, a) => `${Math.round(+a * 30.48)} cm`);
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:inches|inch|in\.)(?![A-Za-z])/g, (_m, a) => `${fmt(+a * 2.54, 1)} cm`);

  // Weight.
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/gi, (_m, a) => `${fmt(+a * 0.4536, 1)} kg`);

  return s;
}

export function toCanadianText(s) {
  if (typeof s !== 'string' || !/\d/.test(s)) return s;
  return convertGeneric(convertAnalytes(s));
}

// Walk any parsed AI output and convert every string in place (returns a copy).
export function toCanadianDeep(x, depth = 0) {
  if (depth > 12) return x;
  if (typeof x === 'string') return toCanadianText(x);
  if (Array.isArray(x)) return x.map(v => toCanadianDeep(v, depth + 1));
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = toCanadianDeep(v, depth + 1);
    return out;
  }
  return x;
}

// Normalize a structured lab definition {name, unit, lo, hi, value?} that the
// model invented (case engine customTests). Converts unit, range and value.
export function normalizeTestDef(t) {
  if (!t || typeof t !== 'object') return t;
  const unit = String(t.unit || '').trim();
  const name = String(t.name || t.key || '').replace(/_/g, ' ').trim();
  if (!unit) return t;
  const scale = (f, dp, to, extra = {}) => {
    const conv = v => (v == null || v === '' || !Number.isFinite(+v) ? v : round(+v * f, dp));
    return { ...t, ...extra, unit: to, lo: conv(t.lo), hi: conv(t.hi), ...(t.value !== undefined ? { value: conv(t.value) } : {}), dp };
  };
  for (const c of COMPILED) {
    if (c.fromRx.test(unit) && c.nameRx.test(name)) {
      return scale(c.f, c.dp, c.to, c.rename && /^(BUN|blood urea nitrogen|urea nitrogen)$/i.test(name) ? { name: 'Urea' } : {});
    }
  }
  if (/^mEq\s*\/\s*L$/i.test(unit)) return { ...t, unit: 'mmol/L' };
  if (/^(?:k|x\s*10\^?3|×\s*10\^?3)\s*\/\s*(?:µ|u|mc)?L$/i.test(unit)) return { ...t, unit: '×10^9/L' };
  if (/^(?:°\s*F|F|fahrenheit)$/i.test(unit)) {
    const c = v => (v == null || !Number.isFinite(+v) ? v : round((+v - 32) * 5 / 9, 1));
    return { ...t, unit: '°C', lo: c(t.lo), hi: c(t.hi), ...(t.value !== undefined ? { value: c(t.value) } : {}) };
  }
  if (/^(?:lbs?|pounds?)$/i.test(unit)) {
    const c = v => (v == null || !Number.isFinite(+v) ? v : round(+v * 0.4536, 1));
    return { ...t, unit: 'kg', lo: c(t.lo), hi: c(t.hi), ...(t.value !== undefined ? { value: c(t.value) } : {}) };
  }
  return t;
}

// True if a string still carries a conventional unit we could not convert
// (e.g. "mg/dL" with no recognisable analyte). Used for usage logging only.
export function hasNonCanadianUnits(s) {
  return typeof s === 'string' && /\b(?:mg|g|µg|ug|mcg|ng)\s*\/\s*dL\b|mEq\s*\/\s*L|°\s*F\b|\blbs?\b/i.test(s);
}
