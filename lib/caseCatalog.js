// lib/caseCatalog.js
// Deterministic catalogue used by the case engine: laboratory tests (SI units),
// panels, investigations with turnaround times, medications, nursing orders,
// and a free-text order parser. Anything the parser cannot recognise is sent
// to a small AI classification call by the engine.

// ---------------------------------------------------------------------------
// Laboratory tests. lo/hi = reference interval (sex-specific where given).
// routine=true: if the hidden case does not specify a value, a normal value is
// generated without asking the AI. Non-routine tests that the case did not
// specify are resolved by the AI once, then stored.
// ---------------------------------------------------------------------------
export const LAB_TESTS = {
  // Hematology
  wbc:   { name: 'WBC', unit: '10^9/L', lo: 4.0, hi: 11.0, dp: 1, cat: 'Hematology', routine: true, critLo: 1.0, critHi: 50 },
  hgb:   { name: 'Hemoglobin', unit: 'g/L', lo: { F: 120, M: 135 }, hi: { F: 160, M: 175 }, dp: 0, cat: 'Hematology', routine: true, critLo: 70 },
  plt:   { name: 'Platelets', unit: '10^9/L', lo: 150, hi: 400, dp: 0, cat: 'Hematology', routine: true, critLo: 20, critHi: 1000 },
  mcv:   { name: 'MCV', unit: 'fL', lo: 80, hi: 100, dp: 0, cat: 'Hematology', routine: true },
  neut:  { name: 'Neutrophils', unit: '10^9/L', lo: 2.0, hi: 7.5, dp: 1, cat: 'Hematology', routine: true, critLo: 0.5 },
  lymph: { name: 'Lymphocytes', unit: '10^9/L', lo: 1.0, hi: 4.0, dp: 1, cat: 'Hematology', routine: true },
  eos:   { name: 'Eosinophils', unit: '10^9/L', lo: 0.0, hi: 0.5, dp: 1, cat: 'Hematology', routine: true },
  retic: { name: 'Reticulocytes', unit: '10^9/L', lo: 20, hi: 100, dp: 0, cat: 'Hematology' },
  inr:   { name: 'INR', unit: '', lo: 0.9, hi: 1.2, dp: 1, cat: 'Hematology', routine: true, critHi: 5 },
  ptt:   { name: 'PTT', unit: 's', lo: 25, hi: 38, dp: 0, cat: 'Hematology', routine: true, critHi: 100 },
  fibrinogen: { name: 'Fibrinogen', unit: 'g/L', lo: 2.0, hi: 4.0, dp: 1, cat: 'Hematology', critLo: 1.0 },
  ddimer: { name: 'D-dimer', unit: 'mg/L FEU', lo: 0, hi: 0.5, dp: 2, cat: 'Hematology' },
  haptoglobin: { name: 'Haptoglobin', unit: 'g/L', lo: 0.3, hi: 2.0, dp: 2, cat: 'Hematology' },
  ferritin: { name: 'Ferritin', unit: 'µg/L', lo: 30, hi: 300, dp: 0, cat: 'Chemistry' },
  b12:   { name: 'Vitamin B12', unit: 'pmol/L', lo: 150, hi: 650, dp: 0, cat: 'Chemistry' },
  // Electrolytes / renal
  na:    { name: 'Sodium', unit: 'mmol/L', lo: 135, hi: 145, dp: 0, cat: 'Chemistry', routine: true, critLo: 120, critHi: 160 },
  k:     { name: 'Potassium', unit: 'mmol/L', lo: 3.5, hi: 5.0, dp: 1, cat: 'Chemistry', routine: true, critLo: 2.5, critHi: 6.5 },
  cl:    { name: 'Chloride', unit: 'mmol/L', lo: 98, hi: 107, dp: 0, cat: 'Chemistry', routine: true },
  hco3:  { name: 'Bicarbonate', unit: 'mmol/L', lo: 22, hi: 29, dp: 0, cat: 'Chemistry', routine: true, critLo: 10 },
  ag:    { name: 'Anion gap', unit: 'mmol/L', lo: 8, hi: 16, dp: 0, cat: 'Chemistry', derived: true },
  urea:  { name: 'Urea', unit: 'mmol/L', lo: 2.5, hi: 8.0, dp: 1, cat: 'Chemistry', routine: true },
  cr:    { name: 'Creatinine', unit: 'µmol/L', lo: { F: 45, M: 60 }, hi: { F: 90, M: 110 }, dp: 0, cat: 'Chemistry', routine: true },
  glucose: { name: 'Glucose (random)', unit: 'mmol/L', lo: 3.9, hi: 7.8, dp: 1, cat: 'Chemistry', routine: true, critLo: 2.5, critHi: 25 },
  ca:    { name: 'Calcium (total)', unit: 'mmol/L', lo: 2.10, hi: 2.60, dp: 2, cat: 'Chemistry', routine: true, critLo: 1.6, critHi: 3.4 },
  ica:   { name: 'Ionized calcium', unit: 'mmol/L', lo: 1.12, hi: 1.32, dp: 2, cat: 'Chemistry', routine: true },
  mg:    { name: 'Magnesium', unit: 'mmol/L', lo: 0.70, hi: 1.00, dp: 2, cat: 'Chemistry', routine: true, critLo: 0.4 },
  po4:   { name: 'Phosphate', unit: 'mmol/L', lo: 0.80, hi: 1.45, dp: 2, cat: 'Chemistry', routine: true, critLo: 0.3 },
  osm:   { name: 'Osmolality (serum)', unit: 'mmol/kg', lo: 275, hi: 295, dp: 0, cat: 'Chemistry' },
  // Liver / pancreas
  alb:   { name: 'Albumin', unit: 'g/L', lo: 35, hi: 50, dp: 0, cat: 'Chemistry', routine: true },
  alt:   { name: 'ALT', unit: 'U/L', lo: 7, hi: 40, dp: 0, cat: 'Chemistry', routine: true },
  ast:   { name: 'AST', unit: 'U/L', lo: 8, hi: 40, dp: 0, cat: 'Chemistry', routine: true },
  alp:   { name: 'ALP', unit: 'U/L', lo: 40, hi: 120, dp: 0, cat: 'Chemistry', routine: true },
  ggt:   { name: 'GGT', unit: 'U/L', lo: 5, hi: 60, dp: 0, cat: 'Chemistry', routine: true },
  tbili: { name: 'Bilirubin (total)', unit: 'µmol/L', lo: 3, hi: 20, dp: 0, cat: 'Chemistry', routine: true },
  dbili: { name: 'Bilirubin (direct)', unit: 'µmol/L', lo: 0, hi: 5, dp: 0, cat: 'Chemistry', routine: true },
  lipase: { name: 'Lipase', unit: 'U/L', lo: 10, hi: 60, dp: 0, cat: 'Chemistry' },
  ammonia: { name: 'Ammonia', unit: 'µmol/L', lo: 11, hi: 35, dp: 0, cat: 'Chemistry' },
  // Cardiac / muscle / inflammatory
  trop:  { name: 'hs-Troponin I', unit: 'ng/L', lo: 0, hi: 26, dp: 0, cat: 'Chemistry' },
  bnp:   { name: 'NT-proBNP', unit: 'ng/L', lo: 0, hi: 300, dp: 0, cat: 'Chemistry' },
  ck:    { name: 'CK', unit: 'U/L', lo: 30, hi: 200, dp: 0, cat: 'Chemistry' },
  ldh:   { name: 'LDH', unit: 'U/L', lo: 100, hi: 225, dp: 0, cat: 'Chemistry' },
  urate: { name: 'Urate', unit: 'µmol/L', lo: 200, hi: 420, dp: 0, cat: 'Chemistry' },
  crp:   { name: 'CRP', unit: 'mg/L', lo: 0, hi: 5, dp: 0, cat: 'Chemistry' },
  esr:   { name: 'ESR', unit: 'mm/h', lo: 0, hi: 20, dp: 0, cat: 'Hematology' },
  pct:   { name: 'Procalcitonin', unit: 'µg/L', lo: 0, hi: 0.10, dp: 2, cat: 'Chemistry' },
  lactate: { name: 'Lactate', unit: 'mmol/L', lo: 0.5, hi: 2.0, dp: 1, cat: 'Chemistry', critHi: 4 },
  // Endocrine
  tsh:   { name: 'TSH', unit: 'mIU/L', lo: 0.4, hi: 4.0, dp: 2, cat: 'Misc' },
  ft4:   { name: 'Free T4', unit: 'pmol/L', lo: 10, hi: 23, dp: 0, cat: 'Misc' },
  cortisol: { name: 'Cortisol (random)', unit: 'nmol/L', lo: 140, hi: 690, dp: 0, cat: 'Misc' },
  hba1c: { name: 'HbA1c', unit: '%', lo: 4.0, hi: 6.0, dp: 1, cat: 'Chemistry' },
  bhb:   { name: 'Beta-hydroxybutyrate', unit: 'mmol/L', lo: 0, hi: 0.5, dp: 1, cat: 'Chemistry' },
  // Blood gases
  vph:   { name: 'pH (venous)', unit: '', lo: 7.32, hi: 7.43, dp: 2, cat: 'Blood Gas', routine: true, critLo: 7.15, critHi: 7.6 },
  vpco2: { name: 'pCO2 (venous)', unit: 'mmHg', lo: 38, hi: 50, dp: 0, cat: 'Blood Gas', routine: true },
  aph:   { name: 'pH (arterial)', unit: '', lo: 7.35, hi: 7.45, dp: 2, cat: 'Blood Gas', routine: true, critLo: 7.15, critHi: 7.6 },
  apco2: { name: 'pCO2 (arterial)', unit: 'mmHg', lo: 35, hi: 45, dp: 0, cat: 'Blood Gas', routine: true },
  apo2:  { name: 'pO2 (arterial)', unit: 'mmHg', lo: 80, hi: 100, dp: 0, cat: 'Blood Gas', routine: true, critLo: 50 },
  // Urine chemistry
  una:   { name: 'Urine sodium', unit: 'mmol/L', lo: null, hi: null, dp: 0, cat: 'Urine' },
  uosm:  { name: 'Urine osmolality', unit: 'mmol/kg', lo: 50, hi: 1200, dp: 0, cat: 'Urine' },
  // Toxicology
  apap:  { name: 'Acetaminophen level', unit: 'µmol/L', lo: 0, hi: 66, dp: 0, cat: 'Misc' },
  asa:   { name: 'Salicylate level', unit: 'mmol/L', lo: 0, hi: 0.7, dp: 1, cat: 'Misc' },
  etoh:  { name: 'Ethanol', unit: 'mmol/L', lo: 0, hi: 2, dp: 0, cat: 'Misc' }
};

export const LAB_CATEGORY_ORDER = ['Hematology', 'Chemistry', 'Blood Gas', 'Serology', 'Urine', 'Misc'];

// Panels and the order text that requests them. Order matters: first match wins
// for overlapping phrases, but every matching rule is applied.
export const LAB_RULES = [
  [/\bcbc\b|complete blood count|\bhemogram\b|\bfbc\b/, ['wbc', 'hgb', 'plt', 'mcv', 'neut', 'lymph', 'eos']],
  [/\bdiff(erential)?\b/, ['neut', 'lymph', 'eos']],
  [/\b(hgb|hemoglobin|haemoglobin)\b/, ['hgb']],
  [/\bplatelets?\b/, ['plt']],
  [/\bextended (lytes|electrolytes)\b|\bca\s*,?\s*mg\s*,?\s*(po4|phos)/, ['ca', 'mg', 'po4']],
  [/\b(lytes|electrolytes|bmp|chem\s*7|chem7|basic metabolic)\b/, ['na', 'k', 'cl', 'hco3', 'ag']],
  [/\bsodium\b|\bna\b/, ['na']],
  [/\bpotassium\b|\bk\+?\b/, ['k']],
  [/\b(bicarb|bicarbonate|hco3)\b/, ['hco3']],
  [/\b(renal (panel|function)|kidney function|cr\b|creat(inine)?|urea|bun)\b/, ['urea', 'cr']],
  [/\b(glucose|blood sugar|bg)\b/, ['glucose']],
  [/\b(calcium|ca)\b(?!\s*(gluconate|chloride))/, ['ca']],
  [/\bionized calcium|\bica\b/, ['ica']],
  [/\b(magnesium|mg)\b(?!\s*(sulfate|sulphate))/, ['mg']],
  [/\b(phosphate|phos|po4)\b/, ['po4']],
  [/\b(serum )?osm(olality)?\b(?!.*urine)/, ['osm']],
  [/\b(lfts?|liver (function|enzymes|panel|tests?)|hepatic panel)\b/, ['alt', 'ast', 'alp', 'ggt', 'tbili', 'dbili', 'alb']],
  [/\b(alt|ast|alp|ggt)\b/, ['alt', 'ast', 'alp', 'ggt']],
  [/\bbili(rubin)?\b/, ['tbili', 'dbili']],
  [/\balbumin\b/, ['alb']],
  [/\blipase\b/, ['lipase']],
  [/\bammonia\b/, ['ammonia']],
  [/\b(trop|troponin)s?\b/, ['trop']],
  [/\b(bnp|nt-?probnp)\b/, ['bnp']],
  [/\b(ck|cpk|creatine kinase)\b/, ['ck']],
  [/\bldh\b/, ['ldh']],
  [/\b(urate|uric acid)\b/, ['urate']],
  [/\bcrp\b|c-reactive/, ['crp']],
  [/\besr\b|sed rate/, ['esr']],
  [/\b(procalcitonin|pct)\b/, ['pct']],
  [/\blactate\b|\blactic acid\b/, ['lactate']],
  [/\b(inr|pt\/?inr|coags?|coagulation)\b/, ['inr', 'ptt']],
  [/\b(ptt|aptt)\b/, ['ptt']],
  [/\bfibrinogen\b/, ['fibrinogen']],
  [/\bd-?dimer\b/, ['ddimer']],
  [/\b(hemolysis (work-?up|panel|labs))\b/, ['ldh', 'haptoglobin', 'retic', 'tbili', 'dbili']],
  [/\bhaptoglobin\b/, ['haptoglobin']],
  [/\bretic(ulocyte)?s?\b/, ['retic']],
  [/\bferritin|iron studies\b/, ['ferritin']],
  [/\b(b12|cobalamin)\b/, ['b12']],
  [/\btsh\b|thyroid (function|panel)/, ['tsh']],
  [/\b(free t4|ft4|thyroid (function|panel))\b/, ['ft4']],
  [/\bcortisol\b/, ['cortisol']],
  [/\b(a1c|hba1c|hemoglobin a1c)\b/, ['hba1c']],
  [/\b(beta-?hydroxybutyrate|bhb|serum ketones|ketones \(serum\))\b/, ['bhb']],
  [/\b(vbg|venous (blood )?gas)\b/, ['vph', 'vpco2', 'hco3']],
  [/\b(abg|arterial (blood )?gas)\b/, ['aph', 'apco2', 'apo2', 'hco3']],
  [/\burine (sodium|na|lytes|electrolytes)\b/, ['una']],
  [/\burine osm(olality)?\b/, ['uosm']],
  [/\b(acetaminophen|tylenol|apap|paracetamol) (level|concentration)\b/, ['apap']],
  [/\b(salicylate|asa|aspirin) level\b/, ['asa']],
  [/\b(ethanol|etoh|alcohol) level\b|\bserum (ethanol|alcohol)\b/, ['etoh']],
  [/\b(tox(icology)? screen|serum tox)\b/, ['apap', 'asa', 'etoh']]
];

// ---------------------------------------------------------------------------
// Investigations: imaging, ECG, microbiology, qualitative laboratory tests.
// tat = minutes from order to report.
// ---------------------------------------------------------------------------
export const STUDIES = {
  ecg:        { title: 'ECG 12-lead', group: 'ECG', tat: 15, re: /\b(ecg|ekg|12[- ]?lead)\b/ },
  cxr:        { title: 'Chest X-ray', group: 'Imaging', tat: 60, re: /\b(cxr|chest x-?ray|chest radiograph|chest film)\b/ },
  axr:        { title: 'Abdominal X-ray', group: 'Imaging', tat: 60, re: /\b(axr|abdo(minal)? x-?ray|kub)\b/ },
  ct_head:    { title: 'CT head (non-contrast)', group: 'Imaging', tat: 60, re: /\bct (of the )?head\b|\bct brain\b|\bnon-?con(trast)? ct head\b/ },
  cta_head:   { title: 'CT angiogram head and neck', group: 'Imaging', tat: 90, re: /\bcta (of the )?(head|neck|brain)|ct angio(gram)? (of the )?(head|neck)/ },
  ctpa:       { title: 'CT pulmonary angiogram', group: 'Imaging', tat: 120, re: /\b(ctpa|ct pulmonary angio(gram)?|ct pe (study|protocol)|cta chest)\b/ },
  ct_chest:   { title: 'CT chest', group: 'Imaging', tat: 120, re: /\bct (of the )?chest\b|\bct thorax\b/ },
  ct_abdo:    { title: 'CT abdomen and pelvis', group: 'Imaging', tat: 120, re: /\bct (of the )?(abdo(men)?|a\/?p|abdomen\/pelvis|abd(omen)? and pelvis|abdopelvis)\b|\bct ap\b/ },
  ct_spine:   { title: 'CT spine', group: 'Imaging', tat: 120, re: /\bct (c|t|l)-?spine\b|\bct spine\b/ },
  us_abdo:    { title: 'Ultrasound abdomen', group: 'Imaging', tat: 240, re: /\b(us|u\/s|ultrasound) (of the )?abdo(men)?\b|\babdominal (us|ultrasound)\b/ },
  us_ruq:     { title: 'Ultrasound RUQ', group: 'Imaging', tat: 240, re: /\bruq (us|u\/s|ultrasound)\b|\b(us|ultrasound) ruq\b/ },
  us_renal:   { title: 'Ultrasound kidneys and bladder', group: 'Imaging', tat: 240, re: /\b(renal|kidney|kub) (us|u\/s|ultrasound)\b|\b(us|ultrasound) (of the )?kidneys?\b/ },
  us_dvt:     { title: 'Venous Doppler lower extremities', group: 'Imaging', tat: 240, re: /\b(dvt (us|ultrasound|study|scan)|venous doppler|leg dopplers?|compression (us|ultrasound))\b/ },
  pocus:      { title: 'Point-of-care ultrasound', group: 'Imaging', tat: 10, re: /\bpocus\b|bedside (us|ultrasound)/ },
  echo:       { title: 'Transthoracic echocardiogram', group: 'Imaging', tat: 1440, re: /\b(echo|tte|echocardiogram|transthoracic)\b/ },
  mri_brain:  { title: 'MRI brain', group: 'Imaging', tat: 600, re: /\bmri (of the )?(brain|head)\b/ },
  mri_spine:  { title: 'MRI spine', group: 'Imaging', tat: 600, re: /\bmri (of the )?(c|t|l|whole)?-?\s*spine\b/ },
  blood_cx:   { title: 'Blood cultures x2', group: 'Microbiology', tat: 1440, re: /\bblood cultures?\b|\bbcx\b/ },
  urine_cx:   { title: 'Urine culture', group: 'Microbiology', tat: 1440, re: /\burine (culture|c&s|c\/s)\b|\bucx\b/ },
  sputum_cx:  { title: 'Sputum culture and Gram stain', group: 'Microbiology', tat: 1440, re: /\bsputum (culture|c&s|gram)/ },
  resp_pcr:   { title: 'Respiratory viral PCR (SARS-CoV-2/Influenza/RSV)', group: 'Microbiology', tat: 240, re: /\b(covid|sars-cov-2|influenza|flu|rsv|respiratory viral|viral) (swab|pcr|panel|test)\b|\bnp swab\b/ },
  cdiff:      { title: 'C. difficile toxin', group: 'Microbiology', tat: 720, re: /\bc\.? ?diff(icile)?\b/ },
  ua:         { title: 'Urinalysis with microscopy', group: 'Laboratory', tat: 60, re: /\b(ua|urinalysis|urine dip(stick)?|urine r&m|r ?& ?m)\b/ },
  smear:      { title: 'Peripheral blood film', group: 'Laboratory', tat: 360, re: /\b(blood (film|smear)|peripheral smear)\b/ },
  type_screen:{ title: 'Group and screen', group: 'Laboratory', tat: 60, re: /\b(group and screen|type and screen|g&s|t&s|crossmatch)\b/ },
  lp:         { title: 'Lumbar puncture: CSF analysis', group: 'Laboratory', tat: 180, re: /\b(lp|lumbar puncture|csf (analysis|studies))\b/ },
  paracentesis:{ title: 'Paracentesis: ascitic fluid analysis', group: 'Laboratory', tat: 180, re: /\bparacentesis|ascitic fluid\b/ },
  thoracentesis:{ title: 'Thoracentesis: pleural fluid analysis', group: 'Laboratory', tat: 180, re: /\bthoracentesis|pleural fluid\b/ },
  hiv:        { title: 'HIV serology', group: 'Serology', tat: 2880, re: /\bhiv\b/ },
  hepatitis:  { title: 'Hepatitis serology (HBV/HCV)', group: 'Serology', tat: 2880, re: /\bhep(atitis)? (b|c|serology|panel)\b/ },
  ana:        { title: 'ANA', group: 'Serology', tat: 4320, re: /\bana\b|antinuclear/ },
  anca:       { title: 'ANCA', group: 'Serology', tat: 4320, re: /\banca\b/ }
};

// ---------------------------------------------------------------------------
// Medications. tags drive the order parser; therapeutic orders bump the
// therapy version, which tells the engine to re-run the progression model.
// ---------------------------------------------------------------------------
export const MEDICATIONS = [
  ['Acetaminophen', /\b(acetaminophen|tylenol|paracetamol)\b(?!\s+(level|concentration))/],
  ['Ibuprofen', /\b(ibuprofen|advil)\b/], ['Ketorolac', /\bketorolac|toradol\b/], ['Naproxen', /\bnaproxen\b/],
  ['Morphine', /\bmorphine\b/], ['Hydromorphone', /\b(hydromorphone|dilaudid)\b/], ['Fentanyl', /\bfentanyl\b/], ['Oxycodone', /\boxycodone\b/],
  ['Ondansetron', /\b(ondansetron|zofran)\b/], ['Metoclopramide', /\b(metoclopramide|maxeran|reglan)\b/], ['Dimenhydrinate', /\b(dimenhydrinate|gravol)\b/],
  ['Pantoprazole', /\b(pantoprazole|pantoloc)\b/],
  ['Ceftriaxone', /\bceftriaxone\b/], ['Piperacillin-tazobactam', /\b(pip(eracillin)?[- ]?taz(obactam)?|tazocin|zosyn)\b/], ['Vancomycin', /\bvanc(omycin)?\b/],
  ['Meropenem', /\bmeropenem\b/], ['Cefazolin', /\bcefazolin\b/], ['Ceftazidime', /\bceftazidime\b/], ['Cefepime', /\bcefepime\b/], ['Azithromycin', /\bazithro(mycin)?\b/],
  ['Doxycycline', /\bdoxy(cycline)?\b/], ['Levofloxacin', /\blevofloxacin\b/], ['Ciprofloxacin', /\bcipro(floxacin)?\b/], ['Metronidazole', /\b(metronidazole|flagyl)\b/],
  ['Ampicillin', /\bampicillin\b/], ['Amoxicillin-clavulanate', /\b(amox(icillin)?[- ]clav(ulanate)?|clavulin|augmentin)\b/], ['Gentamicin', /\bgent(amicin)?\b/],
  ['Acyclovir', /\bacyclovir\b/], ['Fluconazole', /\bfluconazole\b/], ['TMP-SMX', /\b(tmp[- ]?smx|septra|bactrim|co-?trimoxazole)\b/], ['Nitrofurantoin', /\bnitrofurantoin|macrobid\b/],
  ['Oseltamivir', /\b(oseltamivir|tamiflu)\b/],
  ['Enoxaparin', /\b(enoxaparin|lovenox)\b/], ['Heparin', /\bheparin\b/], ['Dalteparin', /\b(dalteparin|fragmin)\b/], ['Apixaban', /\b(apixaban|eliquis)\b/],
  ['Rivaroxaban', /\b(rivaroxaban|xarelto)\b/], ['Warfarin', /\b(warfarin|coumadin)\b/],
  ['ASA', /\b(asa|aspirin)\b(?!\s+level)/], ['Clopidogrel', /\b(clopidogrel|plavix)\b/], ['Ticagrelor', /\b(ticagrelor|brilinta)\b/], ['Atorvastatin', /\batorvastatin\b/], ['Rosuvastatin', /\brosuvastatin\b/],
  ['Metoprolol', /\bmetoprolol\b/], ['Bisoprolol', /\bbisoprolol\b/], ['Diltiazem', /\bdiltiazem\b/], ['Amiodarone', /\bamiodarone\b/], ['Digoxin', /\bdigoxin\b/],
  ['Adenosine', /\badenosine\b/], ['Furosemide', /\b(furosemide|lasix)\b/], ['Spironolactone', /\bspironolactone\b/], ['Hydrochlorothiazide', /\b(hctz|hydrochlorothiazide)\b/],
  ['Amlodipine', /\bamlodipine\b/], ['Ramipril', /\bramipril\b/], ['Perindopril', /\bperindopril\b/], ['Labetalol', /\blabetalol\b/], ['Hydralazine', /\bhydralazine\b/],
  ['Nitroglycerin', /\b(nitroglycerin|ntg|nitro)\b/], ['Norepinephrine', /\b(norepinephrine|levophed|norepi)\b/], ['Epinephrine', /\b(epinephrine|adrenaline|epi)\b/],
  ['Vasopressin', /\bvasopressin\b/], ['Dobutamine', /\bdobutamine\b/], ['Phenylephrine', /\bphenylephrine\b/],
  ['Insulin regular', /\b(insulin (regular|r)|regular insulin|insulin infusion|insulin drip|iv insulin)\b/], ['Insulin glargine', /\b(glargine|lantus|basaglar)\b/],
  ['Insulin lispro/aspart', /\b(lispro|humalog|aspart|novorapid)\b/], ['Dextrose 50%', /\b(d50|d50w|dextrose 50)\b/], ['Dextrose 10%', /\b(d10|d10w|dextrose 10)\b/],
  ['Potassium chloride', /\b(kcl|potassium chloride|k-?dur|potassium replacement|replace k)\b|\bpotassium\b.*\b\d+\s*(mmol|meq)\b/], ['Magnesium sulfate', /\b(magnesium sulfate|mgso4|magnesium replacement|replace mg)\b|\bmagnesium\b.*\b\d+(\.\d+)?\s*g\b/],
  ['Calcium gluconate', /\bcalcium gluconate\b|\bcalcium\b.*\b\d+(\.\d+)?\s*g\b/], ['Calcium chloride', /\bcalcium chloride\b/], ['Sodium bicarbonate', /\b(sodium bicarbonate|nahco3|bicarb (push|infusion|amp))\b/],
  ['Normal saline', /\b(ns|normal saline|0\.9% (nacl|saline)|nacl 0\.9)\b/], ["Ringer's lactate", /\b(rl|lr|ringers?|ringer's|lactated ringer)\b/], ['D5W', /\bd5w\b/],
  ['Hypertonic saline 3%', /\b(3% (saline|nacl)|hypertonic saline)\b/], ['Albumin', /\b(albumin (5|25)%|25% albumin|5% albumin|iv albumin)\b/],
  ['Prednisone', /\bprednisone\b/], ['Methylprednisolone', /\b(methylprednisolone|solu-?medrol)\b/], ['Hydrocortisone', /\bhydrocortisone\b/], ['Dexamethasone', /\bdexamethasone\b/],
  ['Salbutamol', /\b(salbutamol|ventolin|albuterol)\b/], ['Ipratropium', /\b(ipratropium|atrovent)\b/],
  ['Levothyroxine', /\b(levothyroxine|synthroid)\b/], ['Methimazole', /\bmethimazole\b/], ['Propylthiouracil', /\b(ptu|propylthiouracil)\b/], ['Propranolol', /\bpropranolol\b/],
  ['Haloperidol', /\b(haloperidol|haldol)\b/], ['Lorazepam', /\b(lorazepam|ativan)\b/], ['Midazolam', /\bmidazolam\b/], ['Quetiapine', /\bquetiapine\b/],
  ['Thiamine', /\bthiamine\b/], ['Folic acid', /\bfolic acid|folate\b(?!\s+level)/], ['Lactulose', /\blactulose\b/], ['Rifaximin', /\brifaximin\b/], ['Octreotide', /\boctreotide\b/],
  ['Naloxone', /\b(naloxone|narcan)\b/], ['N-acetylcysteine', /\b(n-?acetylcysteine|nac)\b/], ['Tranexamic acid', /\b(tranexamic acid|txa)\b/], ['Vitamin K', /\b(vitamin k|phytonadione)\b/],
  ['Prothrombin complex concentrate', /\b(pcc|octaplex|beriplex)\b/], ['Alteplase', /\b(alteplase|tpa|tenecteplase|tnk)\b/], ['Allopurinol', /\ballopurinol\b/], ['Colchicine', /\bcolchicine\b/],
  ['Levetiracetam', /\b(levetiracetam|keppra)\b/], ['Phenytoin', /\b(phenytoin|fosphenytoin)\b/], ['Mannitol', /\bmannitol\b/], ['Hemin', /\b(hemin|panhematin)\b/],
  ['Packed red blood cells', /\b(prbc|packed red|rbc transfusion|transfuse.*(rbc|blood|unit))\b/], ['Platelet transfusion', /\bplatelet transfusion|transfuse platelets\b/],
  ['Frozen plasma', /\b(ffp|frozen plasma|plasma transfusion)\b/], ['IVIG', /\bivig\b/], ['Ceftriaxone + azithromycin', /\bcap (regimen|antibiotics)\b/]
];

export const ONE_TIME_RE = /\b(once|stat|x\s*1|one dose|single dose|bolus|now|push|load(ing)?( dose)?)\b/i;

// ---------------------------------------------------------------------------
// Nursing, supportive and disposition orders.
// ---------------------------------------------------------------------------
export const NURSING_RULES = [
  { key: 'vitals', re: /\b(vitals|vital signs|vs)\b/, therapeutic: false },
  { key: 'oxygen', re: /\b(o2|oxygen|nasal prongs|nasal cannula|\bnp\b|venturi|non-?rebreather|nrb|high[- ]flow|hfnc|optiflow|bipap|cpap|niv|intubat(e|ion)|mechanical ventilation)\b/, therapeutic: true },
  { key: 'telemetry', re: /\b(telemetry|tele|cardiac monitor(ing)?)\b/ },
  { key: 'npo', re: /\b(npo|nil by mouth|nothing by mouth)\b/ },
  { key: 'diet', re: /\b(diet|clear fluids|full fluids)\b/ },
  { key: 'foley', re: /\b(foley|urinary catheter|indwelling catheter)\b/ },
  { key: 'io', re: /\b(strict (i\/?o|ins and outs|intake)|i&o|ins and outs|urine output)\b/ },
  { key: 'fluid_restriction', re: /\bfluid restrict(ion)?\b/, therapeutic: true },
  { key: 'cbg', re: /\b(cbg|poc(t)? glucose|capillary (blood )?glucose|fingerstick|glucometer)\b/ },
  { key: 'neuro_vitals', re: /\bneuro (vitals|checks|obs)\b/ },
  { key: 'weights', re: /\bdaily weights?\b/ },
  { key: 'iv_access', re: /\b(iv access|iv start|large bore|peripheral iv|piv)\b/ },
  { key: 'isolation', re: /\b(isolation|droplet|contact precautions|airborne)\b/ },
  { key: 'mobility', re: /\b(bed ?rest|ambulat|mobil(ise|ize)|fall precautions|hob|head of bed)\b/ },
  { key: 'dialysis', re: /\b(dialysis|hemodialysis|crrt)\b/, therapeutic: true, procedure: true },
  { key: 'procedure', re: /\b(central line|arterial line|art line|chest tube|ng tube|ngt|intubat|cardioversion|pacing|pacer|endoscopy|egd|colonoscopy|ercp|pci|cath(eterization)? lab)\b/, therapeutic: true, procedure: true }
];

export const CONSULT_RE = /\b(consult|referral|refer to|page (the )?(icu|surgery|gi|cardiology|nephrology))\b/;
export const DISPOSITION_RE = /\b(admit|admission|discharge|transfer to (icu|ccu|step-?down|ward)|icu (admission|transfer)|move to (icu|ccu))\b/;
export const STOP_RE = /^\s*(d\/?c|dc|discontinue|stop|hold|cancel)\b[:\s]*(.*)$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function refRange(test, sex = 'U') {
  const pick = (x) => (x && typeof x === 'object') ? (x[sex] ?? x.F ?? x.M) : x;
  return { lo: pick(test.lo), hi: pick(test.hi) };
}

export function refRangeText(test, sex = 'U') {
  if (test.lo && typeof test.lo === 'object' && sex !== 'F' && sex !== 'M') {
    return `${test.lo.F}-${test.hi.F} (F); ${test.lo.M}-${test.hi.M} (M)`;
  }
  const { lo, hi } = refRange(test, sex);
  if (lo == null && hi == null) return '';
  if (lo == null) return `<${hi}`;
  if (hi == null) return `>${lo}`;
  return `${lo}-${hi}`;
}

export function flagFor(test, value, sex = 'U') {
  const v = Number(value);
  if (!Number.isFinite(v)) return 'normal';
  if (test.critLo != null && v < test.critLo) return 'critical';
  if (test.critHi != null && v > test.critHi) return 'critical';
  const { lo, hi } = refRange(test, sex);
  if (lo != null && v < lo) return 'low';
  if (hi != null && v > hi) return 'high';
  return 'normal';
}

export function formatValue(test, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return String(value ?? '');
  return v.toFixed(test.dp ?? 1);
}

function cleanText(s) {
  return ' ' + String(s || '').toLowerCase().replace(/[;,]+/g, ' , ').replace(/\s+/g, ' ').trim() + ' ';
}

// Parse dose, route and frequency out of a medication order.
export function parseMedDetails(text) {
  const t = String(text || '');
  const dose = (t.match(/(\d+(?:\.\d+)?\s*(?:-\s*\d+(?:\.\d+)?\s*)?(?:mg\/kg|mcg\/kg\/min|mcg\/min|units\/h(?:r|our)?|units\/kg|mg|mcg|µg|g|units?|u|mmol|meq|ml\/h(?:r)?|ml\/kg|ml|l)\b)/i) || [])[1] || '';
  const route = ((t.match(/\b(iv|po|sc|sq|subcut|im|sl|pr|inh|neb(?:ulized)?|ng|topical|patch|io)\b/i) || [])[1] || '').toUpperCase().replace('SQ', 'SC').replace('SUBCUT', 'SC');
  const freq = (t.match(/\b(q\d+(?:-\d+)?\s*h(?:ours?)?|q\d+\s*min|q(?:am|pm|hs)|qhs|daily|od|bid|tid|qid|prn|once|stat|x\s*1|continuous(?:ly)?|infusion|drip|bolus|weekly)\b/i) || [])[1] || '';
  return { dose: dose.trim(), route, frequency: freq.trim() };
}

export function matchMedication(text) {
  const t = cleanText(text);
  for (const [name, re] of MEDICATIONS) if (re.test(t)) return name;
  return null;
}

export function matchLabs(text) {
  const t = cleanText(text);
  const keys = new Set();
  for (const [re, tests] of LAB_RULES) if (re.test(t)) tests.forEach(k => keys.add(k));
  return [...keys];
}

export function matchStudies(text) {
  const t = cleanText(text);
  return Object.entries(STUDIES).filter(([, s]) => s.re.test(t)).map(([k]) => k);
}

// Parse one free-text order line into a structured order (or null if the
// catalogue does not recognise it).
export function parseOrder(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const stop = text.match(STOP_RE);
  if (stop) {
    const verb = stop[1].toLowerCase().replace('/', '');
    const action = verb === 'hold' ? 'hold' : verb === 'cancel' ? 'cancel' : 'discontinue';
    return { kind: 'stop', action, target: stop[2].trim(), text };
  }
  const t = cleanText(text);

  // Medications first: "ceftriaxone 2 g IV q24h" must not be read as a lab.
  const med = matchMedication(text);
  if (med) {
    const d = parseMedDetails(text);
    const fluid = /saline|ringer|d5w|albumin|dextrose 10/i.test(med) || /bolus|ml\/h/i.test(text);
    const recurring = /\bq\s*\d|\bq(am|pm|hs)\b|\b(daily|od|bid|tid|qid|qhs|continuous|infusion|drip|weekly)\b|ml\/h/i.test(text);
    const oneTime = !recurring && (ONE_TIME_RE.test(text) || /bolus/i.test(text));
    return { kind: fluid ? 'fluid' : 'med', name: med, ...d, oneTime, therapeutic: true, text };
  }

  const studies = matchStudies(text);
  const labs = matchLabs(text);
  const stat = /\bstat\b/i.test(text);
  if (studies.length || labs.length) {
    // A trailing "tomorrow AM"/"in the morning" defers collection.
    const deferAM = /\b(tomorrow|next) (am|morning)\b|\bin the (am|morning)\b|\bam (labs|bloodwork)\b/i.test(text);
    return { kind: 'diagnostic', labs, studies, stat, deferAM, text };
  }

  for (const rule of NURSING_RULES) {
    if (rule.re.test(t)) {
      const freqMin = (() => {
        const m = text.match(/q\s*(\d+)\s*(h|hr|hours?|min|minutes?)\b/i);
        if (!m) return null;
        return /^m/i.test(m[2]) ? Number(m[1]) : Number(m[1]) * 60;
      })();
      return { kind: rule.procedure ? 'procedure' : 'nursing', key: rule.key, freqMin, therapeutic: !!rule.therapeutic, text };
    }
  }
  if (CONSULT_RE.test(t)) return { kind: 'consult', text, service: (text.match(/(?:consult|refer(?:ral)? to|page)\s+(?:the\s+)?([a-z /&-]+)/i) || [])[1]?.trim() || 'Consult service' };
  if (DISPOSITION_RE.test(t)) return { kind: 'disposition', text, therapeutic: /icu|ccu|step-?down/i.test(text) };
  return null;
}

export function catalogKeysForPrompt() {
  return {
    labTests: Object.entries(LAB_TESTS).filter(([, t]) => !t.derived).map(([k, t]) => `${k}=${t.name} (${t.unit || 'ratio'})`),
    studies: Object.entries(STUDIES).map(([k, s]) => `${k}=${s.title}`)
  };
}
