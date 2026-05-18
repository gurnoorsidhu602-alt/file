// server.js  (hardcoded TOC version)
// NOTE: This keeps your existing endpoints. Only the /med/toc route is replaced,
// and three small read endpoints are added for convenience.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { v4 as uuid, v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

////////////////////////////////////////////////////////////////////////////////
// CONFIG & INIT
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(cors());
app.options('*', cors()); // handle CORS preflight

app.use(express.json());

// Serve the frontends from the same Render Web Service as the API.
// This avoids hard-coded backend URLs and CORS/fetch failures.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/learner', (_req, res) => res.sendFile(path.join(__dirname, 'learner.html')));
app.get('/learner.html', (_req, res) => res.sendFile(path.join(__dirname, 'learner.html')));
app.get('/medlearner', (_req, res) => res.sendFile(path.join(__dirname, 'learner.html')));
app.get('/casesim', (_req, res) => res.sendFile(path.join(__dirname, 'casesim.html')));
app.get('/casesim.html', (_req, res) => res.sendFile(path.join(__dirname, 'casesim.html')));

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Models ---
// Cheaper default for most tasks:
const BASE_MODEL = process.env.OPENAI_BASE_MODEL || "gpt-4.1";
// Use a smarter model ONLY for URL selection to reduce 404s; set env to "gpt-5.1" (or whatever you have)
// If not set, it will fallback to BASE_MODEL.
const STRICT_MODEL = process.env.OPENAI_STRICT_MODEL || "gpt-5";

// helper: some models (gpt-5.x, o-series) don't accept temperature on Responses API
function supportsTemperature(model = '') {
  const m = String(model || '').toLowerCase();

  // GPT-5 reasoning-style models do not accept temperature, including exact "gpt-5"
  // as well as variants like "gpt-5.1", "gpt-5-mini", etc.
  if (m.startsWith('gpt-5')) return false;

  // o-series reasoning models also generally do not accept temperature.
  if (/^o\d/.test(m)) return false;

  return true;
}

// wrapper: build the request and include temperature only when supported
async function responsesCall({ model, messages, temperature }) {
  const req = { model, input: messages };
  if (temperature !== undefined && supportsTemperature(model)) {
    req.temperature = temperature;
  }
  return await openai.responses.create(req);
}
// Difficulty ladder
const DIFF = ["MSI1","MSI2","MSI3","MSI4","R1","R2","R3","R4","R5","Attending"];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bumpDifficulty = (label, delta) => {
  const i = DIFF.indexOf(label);
  const next = i < 0 ? 2 : clamp(i + delta, 0, DIFF.length - 1);
  return DIFF[next];
};

// ------------------------------ SQLITE INIT ---------------------------------
const medDb = new Database('medlearner.db');
medDb.pragma('journal_mode = WAL');
medDb.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS completed_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    topic   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, topic)
  );

  CREATE TABLE IF NOT EXISTS pdf_docs (
    id TEXT PRIMARY KEY,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pdf_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES pdf_docs(id) ON DELETE CASCADE
  );

  -- Full-text search over PDF chunks
  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts
  USING fts5(text, content='pdf_chunks', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_ai AFTER INSERT ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_ad AFTER DELETE ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_au AFTER UPDATE ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO pdf_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  -- TOC cache (left for future use)
  CREATE TABLE IF NOT EXISTS toc_cache (
    label TEXT PRIMARY KEY,
    json  TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- one-time safety: ensure labels are unique if set
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_label_unique
  ON pdf_docs(label) WHERE label IS NOT NULL;
`);

// ------------------------------ PDF HELPERS ---------------------------------
const upload = multer({ storage: multer.memoryStorage() });

const CHUNK_SIZE = 1200;     // characters
const CHUNK_OVERLAP = 150;   // characters

function chunkText(raw) {
  const text = (raw || '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_SIZE, text.length);
    let slice = text.slice(i, end);

    const lastPara = slice.lastIndexOf('\n\n');
    const lastSent = slice.lastIndexOf('. ');
    const lastStop = Math.max(lastPara, lastSent);
    if (lastStop > 400 && end < text.length) slice = slice.slice(0, lastStop + 1);

    chunks.push(slice.trim());
    i += Math.max(slice.length - CHUNK_OVERLAP, 1);
  }
  return chunks.filter(Boolean);
}

async function indexPdfBuffer(buffer, label) {
  const data = await pdfParse(buffer);
  const docId = uuidv4();

  medDb.prepare(`INSERT INTO pdf_docs (id, label) VALUES (?, ?)`).run(docId, label || null);

  const chunks = chunkText(data.text || '');
  const insert = medDb.prepare(`INSERT INTO pdf_chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)`);

  const tx = medDb.transaction(() => {
    chunks.forEach((c, idx) => insert.run(uuidv4(), docId, idx, c));
  });
  tx();

  return { docId, nChunks: chunks.length };
}

// ----------------------- STANDARD PDF AUTO-INDEXER (left as-is) -------------
const STANDARD_PDF_URL =
  process.env.STANDARD_PDF_URL || 'https://raw.githubusercontent.com/gurnoorsidhu602-alt/file/7c1f0d025f19f12e2494694197bd38da92f09f49/toc.pdf';
const STANDARD_PDF_LABEL =
  process.env.STANDARD_PDF_LABEL || 'STANDARD_TOC_V1';

function pdfExistsByLabel(label) {
  const row = medDb.prepare('SELECT id FROM pdf_docs WHERE label = ?').get(label);
  return !!row;
}

async function ensureStandardPdfIndexed() {
  try {
    if (!STANDARD_PDF_URL) return;
    if (pdfExistsByLabel(STANDARD_PDF_LABEL)) return;
    const resp = await fetch(STANDARD_PDF_URL);
    if (!resp.ok) return;
    const buf = Buffer.from(await resp.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, STANDARD_PDF_LABEL);
    console.log(`[MedLearner] Indexed standard PDF "${STANDARD_PDF_LABEL}" as ${docId} (${nChunks} chunks).`);
  } catch (err) {
    console.error('[MedLearner] Error ensuring standard PDF:', err);
  }
}
ensureStandardPdfIndexed();

// ----------------------------- HARDCODED TOC -------------------------------
// Derived from your TOC PDF. Expand freely — the API below reads from this tree.
// Structure: { [discipline]: { [sub]: [topics...] } }

const HARDCODED_TOC = {
  "Cardiology": {
    "Ischemia": [
      "Approach To Acute Coronary Syndrome",
      "Approach to ECG for suspected MI/ACS",
      "Approach to Dyslipidemia Therapy",
      "Non-acute Coronary Artery Disease",
      "Acute Coronary Syndrome",
      "Variant/Prinzmetal/Vasospastic Angina"
    ],
    "Arrhythmias": [
      "ECG interpretation",
      "Approach to Abnormal QT",
      "Approach to Bundle Branch Blocks",
      "Approach to AV Block",
      "Approach to Tachycardia",
      "Approach to Bradyarrhythmia",
      "Supraventricular Premature Beats",
      "Supraventricular Tachycardia",
      "Atrial Fibrillation and Flutter",
      "PVCs",
      "Ventricular Tachycardia",
      "Ventricular Fibrillation",
      "Causes of Wide Complex Tachycardia in Children",
      "Overview of Antiarrhythmic Drugs"
    ],
    "Valvular Heart Disease": [
      "Approach to Murmur/Valvular Disease",
      "Aortic Regurgitation",
      "Aortic Stenosis",
      "Mitral Regurgitation",
      "Mitral Valve Prolapse",
      "Mitral Stenosis"
    ],
    "Heart Failure": [
      "Background Pathophysiology",
      "Diagnostic approach to Acute Heart Failure",
      "Chronic Heart Failure",
      "Acute Heart Failure",
      "Approach to Shock"
    ],
    "Misc": [
      "Basic Cardiac Physiology and Anatomy",
      "Infective Endocarditis",
      "Hypertension",
      "Aortic Dissection",
      "Approach to Cardiac Tumours",
      "Approach to Pericardial Disease",
      "Sympathomimetics"
    ],
    "Myocardial": [
      "Acute Rheumatic Fever",
      "Takotsubo Cardiomyopathy",
      "Dilated Cardiomyopathy",
      "Hypertrophic Cardiomyopathy",
      "Restrictive Cardiomyopathy"
    ],
    "Vascular": [
      "Peripheral Arterial Disease",
      "Nonthrombotic Embolism",
      "Chronic Venous Disease",
      "Carotid Artery Stenosis",
      "Renal Artery Stenosis",
      "Carotid/Vertebral Artery Dissection",
      "Acute Limb Ischemia",
      "Cholesterol Embolization Syndrome",
      "Abdominal Aortic Aneurysm",
      "Thoracic Outlet Syndrome"
    ]
  },

  "Emergency Medicine": {
    "Approaches": [
      "Approach to Syncope"
    ],
    "Trauma": [
      "Initial Management of Trauma",
      "Blunt Abdominal Trauma",
      "Blunt Pelvic Trauma",
      "FAST and eFAST"
    ]
  },

  "Endocrinology": {
    "Glucose": [
      "Physiology Relevant to Endocrine Pancreas",
      "General Approach to Diabetes Mellitus",
      "Diabetic Neuropathy",
      "Diabetic Retinopathy",
      "Hyperglycemic Crises",
      "Insulin Therapy",
      "Non-Insulin Oral Antidiabetics"
    ],
    "Adrenal": [
      "Adrenal Physiology",
      "Adrenal/Testicular Gland Biochemistry",
      "Congenital Adrenal Hyperplasia",
      "Adrenal Insufficiency",
      "Hypercortisolism",
      "Hyperaldosteronism",
      "Adrenal Incidentaloma"
    ],
    "Gonadal": [
      "Disorders of Sexual Development",
      "Testosterone Replacement Therapy"
    ],
    "Thyroid": [
      "Physiology relevant to Thyroid disease",
      "Hypothyroidism",
      "Hyperthyroidism",
      "Thyroid Crises"
    ],
    "Parathyroid": [
      "Parathyroid Physiology",
      "Hyperparathyroidism",
      "Hypoparathyroidism"
    ],
    "Pituitary": [
      "Pituitary Physiology",
      "Pituitary Adenoma",
      "Hypopituitarism",
      "Hyperprolactinemia",
      "Acromegaly",
      "Diabetes Insipidus",
      "Syndrome of Inappropriate ADH"
    ]
  },

  "Gastroenterology": {
    "Intestinal and Stomach": [
      "Bowel Obstruction (Adult)",
      "Acute Mesenteric Ischemia",
      "Perforated Peptic Ulcer",
      "Management of Peptic Ulcers",
      "Diverticular Disease",
      "Abdominal Hernias",
      "Volvulus / Malrotation",
      "Paralytic Ileus",
      "Irritable Bowel Syndrome",
      "Inflammatory Bowel Disease",
      "Osmotic Diarrhea",
      "Secretory Diarrhea",
      "Malabsorptive Diarrhea",
      "Inflammatory Diarrhea",
      "Gastritis and Dyspepsia",
      "Appendicitis",
      "Ischemic Colitis (non-acute)",
      "Angiodysplasia",
      "Constipation in Adults",
      "Celiac Disease",
      "Small Intestinal Bacterial Overgrowth"
    ],
    "General": [
      "Diagnostic Approach to Non-traumatic Abdominal Pain",
      "Approach to Upper GI Bleed",
      "Approach to Lower GI Bleed"
    ],
    "Biliary and Hepatic": [
      "Acute Pancreatitis",
      "Chronic Pancreatitis",
      "Acute (Fulminant) Liver Failure",
      "Diagnostic Approach to Chronic Liver Disease",
      "Spontaneous Bacterial Peritonitis",
      "Gallstone Disease",
      "Diagnostic Approach to Jaundice",
      "PSC and PBC",
      "Autoimmune Hepatitis",
      "Wilson Disease",
      "Hemochromatosis",
      "Cirrhosis",
      "Ascites",
      "Alcoholic Liver Disease",
      "Budd–Chiari Syndrome",
      "Portal Hypertension",
      "Hepatic Encephalopathy",
      "MASLD (NAFLD)",
      "Complications of Gallstones"
    ],
    "Esophageal": [
      "Diagnostic Approach to Dysphagia",
      "Esophageal Varices",
      "GERD",
      "Approach to Esophagitis",
      "Hiatal Hernia",
      "Esophageal Diverticula",
      "Achalasia",
      "Hypermotility Disorders",
      "Esophageal Tears and Rupture"
    ],
    "Misc": [
      "Acute Splenic Diseases and Injuries",
      "Abdominal Compartment Syndrome",
      "Hemorrhoids",
      "Anal Fissures",
      "Perirectal/Anorectal Abscess and Fistula",
      "GI Perforation (Perforated Viscus)",
      "Pilonidal Disease",
      "Refeeding Syndrome"
    ]
  },

  "Gynecology": {
    "Menstrual and Structural": [
      "Physiology of the Menstrual Cycle",
      "Approach to Dysmenorrhea",
      "Approach to Amenorrhea",
      "Abnormal Uterine Bleeding",
      "Menopause",
      "Adenomyosis",
      "Endometriosis",
      "Ovarian Torsion",
      "Tubo-Ovarian Abscess"
    ],
    "Sexual Health": [
      "Approach to Dyspareunia in Women"
    ],
    "Fertility and Contraception": [
      "Polycystic Ovarian Syndrome",
      "Contraception",
      "Approach to Infertility"
    ]
  },

  "Hematology": {
    "Heme": ["Porphyrias","Thalassemia","Sickle Cell Disease","Hemoglobin C Disease","Hemoglobin Zurich"],
    "Anemia": [
      "Bone Marrow Physiology","Approach to Hemolysis","Approach to Anemia","Macrocytic Anemia","Iron Deficiency",
      "AIHA","PNH","G6PD Deficiency","Hereditary Spherocytosis","Hereditary Elliptocytosis",
      "Southeast Asian Ovalocytosis","Aplastic Anemia","Pancytopenia","Transfusion Reactions",
      "Pyruvate Kinase Deficiency","Anemia of Chronic Disease","Lead Poisoning","Sideroblastic Anemia"
    ],
    "Hemostasis": [
      "Physiology of Hemostasis","Approach to Thrombocytopenia","VTE/DVT/PE","Thrombophilia/Hypercoagulability Workup",
      "Approach to Bleeding Disorders","von Willebrand Disease","ITP","TTP","HUS","HIT Type II","Hemophilia","APS","DIC",
      "Anticoagulation and Antiplatelet Pharmacology","Protamine Reactions"
    ],
    "WBC Disorders": [
      "Systemic Amyloidosis","Eosinophilia","Approach to Lymphadenopathy","Erythrocytosis","Neutropenia"
    ]
  },

  "Infectious Disease": {
    "Sepsis and FUO": ["Sepsis","Fever of Unknown Origin","Neutropenic Fever"],
    "Viral": [
      "Overview of Virology","Viral Tree","Viral Hepatitis","Influenza","COVID-19","RSV","Herpes Viruses","Rabies",
      "Polio","Japanese Encephalitis","Coxsackie Virus","Rotavirus","Norovirus","HPV","HIV","Australian Bat Lyssavirus",
      "Monkeypox","Smallpox","Viral Hemorrhagic Fevers","Zika","Dengue"
    ],
    "Fungal": ["Overview of Fungi","Candidiasis","Aspergillosis"],
    "Helminth": ["Helminth Infections"],
    "Protozoa": [
      "Overview of Protozoa","Malaria","Giardiasis","Toxoplasmosis","Leishmaniasis","Chagas Disease",
      "African Trypanosomiasis","Amebiasis","Babesiosis"
    ],
    "Bacteria": [
      "Gram Positive Tree","Gram Negative Tree","Antibiotics","Tuberculosis","Non-TB Mycobacteria","Staph aureus",
      "CoNS","Streptococci","Clostridium","Corynebacterium diphtheriae","Listeria","Bacillus","Actinomyces","Nocardia",
      "Klebsiella","E. coli","Enterobacter","Citrobacter/Serratia","Salmonella","Shigella","Proteus","Pseudomonas",
      "Burkholderia cepacia","H. pylori","Legionella","Bacteroides","Moraxella catarrhalis","Neisseria","Chlamydia",
      "Campylobacter","Vibrio spp","Haemophilus","Bordetella pertussis","Yersinia enterocolitica","Acinetobacter",
      "Leptospirosis","Borrelia burgdorferi","Non-Lyme Borrelia","Treponema pallidum","Bartonella henselae","Brucella",
      "Chlamydophila psittaci","Coxiella burnetii","Francisella tularensis","Pasteurella","Ehrlichia","Anaplasma",
      "Rickettsia rickettsii","Other Rickettsia","Yersinia pestis"
    ],
    "Other": ["Lice","Scabies","Bedbugs"],
    "Clinical – Pulmonary/URT": [
      "URI","Pneumonia","Pulmonary Fungal Diseases","Common Cold","Sinusitis","Acute Bronchitis",
      "Acute Tonsillitis/Pharyngitis","Bronchiolitis","Deep Neck Infections","Lung Abscess"
    ],
    "Clinical – Neuro": ["Meningitis","Encephalitis","Brain Abscess"],
    "Clinical – Cardiovascular": ["Myocarditis","Infective Endocarditis"],
    "STI – Female": ["Pelvic Inflammatory Disease"],
    "STI – Male": ["Epididymitis","Prostatitis","Urethritis"],
    "Wound/Soft tissue/Bone/Joint": [
      "Skin and Soft Tissue Infections","Animal Bites","Toxic Shock Syndrome",
      "Psoas Abscess","Septic Arthritis","Spinal Infections","Osteomyelitis","Diabetic Foot Infections",
      "Otitis Externa","Otitis Media"
    ],
    "Misc, Rare, Nosocomial": [
      "Device-related infections","Intravascular Catheter-related infections","Neglected Tropical Diseases"
    ],
    "GU": ["UTIs","Pyelonephritis","Perinephric Abscess"],
    "GI": ["Infectious Gastroenteritis","Seafood Poisoning","Pyogenic Liver Abscess"]
  },

  "Nephrology": {
    "Diseases of Nephron": [
      "Approach to AKI","Approach to Nephrotic Syndrome","Approach to Nephritic Syndrome","Dialysis",
      "Thin Basement Membrane Nephropathy","Post-streptococcal GN","IgA Nephropathy","Alport Syndrome",
      "Acute TIN","Chronic TIN","Renal Papillary Necrosis","Renal Tubular Disorders","CKD"
    ],
    "Electrolytes": [
      "Approach to Hyponatremia","Approach to Hypernatremia","Approach to Hypokalemia","Approach to Hyperkalemia",
      "Approach to Hypocalcemia","Approach to Hypercalcemia","Approach to Hypermagnesemia","Approach to Hypomagnesemia",
      "Approach to Acidosis","Approach to Metabolic Alkalosis","SIADH","Diabetes Insipidus"
    ],
    "Misc": [
      "Nephrolithiasis","Cardio-Renal Syndrome","Hepatorenal Syndrome","Rhabdomyolysis/Crush Syndrome",
      "Polycystic Kidney Disease","Renal Cysts","Fibromuscular Dysplasia"
    ]
  },

  "Neurology": {
    "Localization": [
      "Cerebral Localization","Brainstem Localization","Cerebellar Localization","Cranial Nerve (Peripheral) Localization",
      "Spinal Cord Localization","Basal Ganglia Localization","Peripheral Nerve Localization"
    ],
    "Headache": ["Headache","Trigeminal Neuralgia"],
    "Seizure": ["Approach to Seizure in Adults","Approach to Seizure in Children","Seizure Pharmacology"],
    "Vertigo": [
      "Diagnostic Approach to Vertigo","BPPV","Menière Disease","Vestibular Neuritis and Labyrinthitis"
    ],
    "Consciousness": [
      "Approach to Altered Mental Status and Coma","Delirium","Transient Global Amnesia",
      "Persistent Vegetative State","Heat-related Illness"
    ],
    "Sleep": [
      "Normal Sleep Cycle & Classification","Circadian Rhythm Disorders","Insomnia Disorder",
      "Hypersomnolence Disorder","Parasomnias","Sleep Movement Disorders","Narcolepsy"
    ],
    "Neurocognitive": [
      "Approach to Dementia","Alzheimer Disease","Vascular Dementia","Frontotemporal Dementia","CJD"
    ],
    "Vascular": [
      "Ischemic Stroke","TIA","Intracerebral Hemorrhage","Subarachnoid Hemorrhage","Subdural Hematoma",
      "Epidural Hematoma","Intraventricular Hemorrhage","Cerebral Venous Thrombosis","Subclavian Steal Syndrome"
    ],
    "Spinal Cord": ["Cervical Myelopathy","Syringomyelia","Degenerative Disk Disease","Spinal Stenosis"],
    "Movement": ["Approach to Tremor","Parkinson Disease","Parkinson-Plus Syndromes","Huntington Disease","Dystonia"],
    "Neuromuscular": [
      "Multiple Sclerosis","NMOSD/ADEM/MOGAD/CLIPPERS","ALS","Spinal Muscular Atrophy","Myasthenia Gravis",
      "Stiff Person Syndrome","Myotonic Syndromes"
    ],
    "Neuropathy": ["Approach to Polyneuropathy","Peripheral Nerve Injury","GBS/CIDP","Morton Neuroma"],
    "Inherited & Rare": [
      "Neurocutaneous Syndromes","Rare Neurological Syndromes","Friedreich Ataxia",
      "Hereditary Motor Sensory Neuropathy","Refsum Disease","Spinocerebellar Ataxias"
    ]
  },

  "Obstetrics": {
    "Emergencies": ["Ectopic Pregnancy","Uterine Rupture","Postpartum Hemorrhage","Amniotic Fluid Embolism","Antepartum Hemorrhage"],
    "Pregnancy & Prenatal Care": [
      "Prenatal Care","Multiple Gestation","HDFN","Induced Abortion","Late-term & Post-term Pregnancy"
    ],
    "Pregnancy-associated Disorders": [
      "Hypertensive Pregnancy Disorders","Gestational Diabetes","Pregnancy Loss","Hydatidiform Mole",
      "Gestational Trophoblastic Neoplasia","Chorioamnionitis","Hyperemesis Gravidarum","Cervical Insufficiency",
      "Other Pregnancy Complications","Pregnancy-associated Liver Disorders","TORCH & Congenital Infections",
      "Polyhydramnios","Oligohydramnios","Peripartum Cardiomyopathy"
    ],
    "Labour & Delivery": [
      "Labour and Delivery","Induced Delivery","Cesarean Delivery","Preterm Labour","Postpartum Period & Complications",
      "Antepartum Fetal Surveillance"
    ]
  },

  "Oncology": {
    "Lung": ["Lung Cancer","Solitary Pulmonary Nodule","Mesothelioma"],
    "GI": [
      "Esophageal Cancer","Hepatocellular Carcinoma","Rarer Hepatic Malignancies","Benign Liver Tumours/Cysts",
      "Gastric Cancer","Cholangiocarcinoma","Gallbladder Cancer","Rarer Biliary Malignancies",
      "Pancreatic Cancer","Small Bowel Neoplasms","Colorectal Cancer","Anal Cancer"
    ],
    "Endocrine": ["Approach to Neuroendocrine Tumours","Approach to Thyroid Nodules","Thyroid Cancer"],
    "Gynecological": [
      "Cervical Cancer Screening","Cervical Cancer","Uterine Leiomyoma","Ovarian Tumours",
      "Benign Tumours of Endometrium","Endometrial Cancer","Vulvar/Vaginal Cancer","Approach to Adnexal Mass"
    ],
    "Breast": [
      "Approach to Palpable Breast Mass/Abnormal Mammogram","Nipple Discharge","Breast Hypertrophy",
      "Breast Cancer","Benign Breast Conditions","Fibroadenoma","Phyllodes Tumour","Galactocele",
      "Fibrocystic Changes","Mammary Duct Ectasia","Intraductal Papilloma","LCIS"
    ],
    "CNS": ["Approach to Brain Tumor in Adults","Approach to Neurocutaneous Syndromes"],
    "Heme": [
      "Summary of Hematologic Malignancies","AML","ALL","CLL","CML","Hairy Cell Leukemia",
      "Hodgkin Lymphomas","Non-Hodgkin Lymphomas","Mastocytosis","Multiple Myeloma/MGUS/SMM",
      "Waldenström Macroglobulinemia","Polycythemia Vera","Essential Thrombocytosis","Mycosis Fungoides / CTCL",
      "Chronic Eosinophilic Leukemia","Chronic Neutrophilic Leukemia","MPN-Unclassifiable","Primary Myelofibrosis",
      "Myelodysplastic Syndromes","CMML","JMML","Langerhans Cell Histiocytosis",
      "Erdheim–Chester Disease","Rosai–Dorfman Disease","POEMS Syndrome","Heavy Chain Diseases"
    ],
    "Oncologic Emergencies": ["Tumor lysis, SVC syndrome, cord compression, hypercalcemia, neutropenic sepsis"],
    "Misc": ["Chemotherapy & Oncologic Pharmacology","Paraneoplastic Syndromes"]
  },

  "Pediatrics": {
    "Infectious Diseases": ["Approach to Pediatric Sepsis","Approach to Influenza in Pediatrics"],
    "Neonatology": ["Approach to Neonatal Jaundice","Perinatal Asphyxia and HIE"],
    "Development": ["Developmental Approach (placeholder)"]
  },

  "Respirology": {
    "Obstructive": [
      "COPD","Acute Exacerbation of COPD","Asthma","Acute Exacerbation of Asthma",
      "Bronchiectasis","Cystic Fibrosis","Acute Exacerbation of Cystic Fibrosis"
    ],
    "Restrictive": [
      "PIGE (Pulmonary Infiltrates with Eosinophilia) – Diagnostic Approach",
      "Hypersensitivity Pneumonitis","Eosinophilic Pneumonias","Restrictive Lung Diseases",
      "Idiopathic Interstitial Pneumonias"
    ],
    "Critical Resp": [
      "Hemoptysis","ARDS","Approach to Hypoxemia","Mechanical Ventilation","ECMO","Approach to Respiratory Failure"
    ],
    "Misc": [
      "Occupational & Environmental Lung Disease","Pulmonary Alveolar Proteinosis",
      "Pulmonary Hypertension","Tobacco Addiction & Cessation"
    ],
    "Pleural Disease": ["Pleural Effusion","Pleuritis","Pneumothorax"]
  },

  "Rheumatology": {
    "Misc": ["Antirheumatic/Immunosuppressants","IgG4-Related Disease"],
    "Connective Tissue Diseases": [
      "Approach to Arthralgia/CTDs","Raynaud Phenomenon","Relapsing Polychondritis",
      "Sjögren Syndrome","SLE","Systemic Sclerosis","MCTD"
    ],
    "Joint Diseases": [
      "Rheumatoid Arthritis","Gout/Hyperuricemia","CPPD","Basic Calcium Phosphate Deposition",
      "Reactive Arthritis","Seronegative Spondyloarthropathies","Psoriatic Arthritis",
      "Ankylosing Spondylitis","Sarcoidosis"
    ],
    "Myopathies & Pain": ["Idiopathic Inflammatory Myopathies","Adult-Onset Still Disease","Polymyalgia Rheumatica"],
    "Vasculitis": [
      "Approach to Vasculitides","Giant Cell Arteritis","GPA","EGPA","MPA","Polyarteritis Nodosa","IgA Vasculitis",
      "Takayasu Arteritis","Cryoglobulinemic Vasculitis","Behçet Disease","Cutaneous Small-Vessel Vasculitis",
      "Thromboangiitis Obliterans (Buerger Disease)"
    ]
  },

  "Urology": {
    "Emergencies": ["Approach to Testicular Torsion"],
    "Infections": ["Approach to Urinary Tract Infections","Approach to Cystitis"]
  }
};

// Utility: flatten tree to items[]
function tocItemsFromTree(tree) {
  const out = [];
  for (const [disc, subs] of Object.entries(tree)) {
    for (const [sub, topics] of Object.entries(subs)) {
      for (const t of topics) {
        out.push({ discipline: disc, sub, topic: t });
      }
    }
  }
  return out;
}

// Normalize topic names so "Approach To X" matches "X"
function normalizeTopicName(s = "") {
  return String(s)
    .toLowerCase()
    // strip common prefixes
    .replace(/^(approach\s*to|evaluation\s*of|diagnosis\s*of|management\s*of|treatment\s*of|overview\s*of)\s+/i, "")
    // collapse punctuation/whitespace
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}


// === Add under HARDCODED_TOC ===

// Internal Medicine disciplines (for "High-Yield (IM)")
const INTERNAL_MED_DISC_SET = new Set([
  "Cardiology","Endocrinology","Gastroenterology","Hematology",
  "Infectious Disease","Nephrology","Neurology","Respirology","Rheumatology"
]);

function collectIMCandidates(excludeSet = new Set()) {
  const out = [];
  for (const [disc, subs] of Object.entries(HARDCODED_TOC)) {
    if (!INTERNAL_MED_DISC_SET.has(disc)) continue;
    for (const [sub, topics] of Object.entries(subs)) {
      for (const topic of topics) {
        if (excludeSet.has(topic)) continue;
        out.push({ discipline: disc, sub, topic });
      }
    }
  }
  return out;
}

// High-Yield (IM) via AI
// POST /med/high-yield-im { user_id, n? }
app.post('/med/high-yield-im', async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "Gurnoor");
    const n = Math.max(1, Math.min(10, Number(req.body?.n || 1)));

    // Build eligible pool from the hard-coded TOC
    const allTopics = Array.from(
      new Set(tocItemsFromTree(HARDCODED_TOC).map(it => it.topic))
    ).sort();

    // --- INLINE fetch of completed topics for this user (replaces missing helper) ---
    const completedRows = medDb
      .prepare(`SELECT topic FROM completed_topics WHERE user_id = ?`)
      .all(user_id);
    const completed = completedRows.map(r => r.topic);
    const completedNorm = new Set(completed.map(normalizeTopicName));

    const eligible = allTopics.filter(
      t => !completedNorm.has(normalizeTopicName(t))
    );

    if (!eligible.length) {
      return res.json({
        ok: true,
        ranked: [],
        pick: null,
        reason: "No eligible topics (all completed)."
      });
    }

    // Ask AI to rank **from the eligible list only**
    const system = `
You are a clerkship director selecting HIGH-YIELD Internal Medicine study topics.
From the provided list ONLY, rank topics (most to least high-yield for IM).
Return STRICT JSON:
{"ranked":[{"topic":"","reason":""}]}.
Do NOT invent topics not in the list.
Prefer common inpatient issues, critical emergencies, and algorithm-heavy entities.
`;
    const user = { topics: eligible, max: Math.min(20, eligible.length) };

    const resp = await responsesCall({
      model: BASE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: JSON.stringify(user) }
      ],
      temperature: 0
    });

    let out = parseResponsesJSON(resp) || {};
    let ranked = Array.isArray(out.ranked) ? out.ranked : [];

    // Safety: filter again after AI (and drop any out-of-list items)
    const eligibleSet = new Set(eligible);
    ranked = ranked
      .filter(x => x && x.topic && eligibleSet.has(x.topic))
      .filter(x => !completedNorm.has(normalizeTopicName(x.topic)));

    // Fallback if AI returns nothing usable
    if (!ranked.length) {
      const fallback = eligible[Math.floor(Math.random() * eligible.length)];
      return res.json({
        ok: true,
        ranked: [{ topic: fallback, reason: "Random fallback from eligible (AI gave no usable output)." }],
        pick: { topic: fallback, reason: "Random fallback." }
      });
    }

    const pick = ranked[0];
    res.json({ ok: true, ranked: ranked.slice(0, n), pick });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// ====== AI Pimp Questions ======

async function buildPimpQuestionsAI(topic, noteSnippets = [], n = 12) {
  const system = `
You are a senior Internal Medicine attending running a fast ward round.
Create HARD, pimp-style questions. Tone: brisk, a bit mean, but professional.
Difficulty should PROGRESS from hard to brutal. Keep stems short and clinical.
Return STRICT JSON ONLY:
{"questions":[{"q":"","answer":"","explain":""}]}
- "q": the question stem
- "answer": the expected concise answer
- "explain": one-paragraph correction/explanation if the learner is wrong
- Create ${n} total. No extra prose.
`;

  const user = {
    topic,
    note_snippets: noteSnippets.slice(0, 12), // optional grounding
    constraints: {
      progressive_difficulty: true,
      number: n,
      brevity_in_stems: true,
      focus: "diagnosis, algorithms, must-not-miss complications, risk stratification, therapeutics, monitoring, contraindications"
    }
  };

  const resp = await responsesCall({
    model: process.env.OPENAI_FAST_MODEL || "gpt-4.1-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  });

  const parsed = parseResponsesJSON(resp);
  if (!parsed || !Array.isArray(parsed.questions)) return { questions: [] };
  // Normalize and trim
  const qs = parsed.questions.map(q => ({
    q: String(q.q || "").trim(),
    answer: String(q.answer || "").trim(),
    explain: String(q.explain || "").trim()
  })).filter(q => q.q && q.answer);
  return { questions: qs.slice(0, n) };
}

// POST /med/test-questions  { topic, n? }
app.post('/med/test-questions', async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    const n = Math.max(4, Math.min(20, Number(req.body?.n || 12)));
    if (!topic) return res.status(400).json({ error: "topic required" });

    const snippets = searchNoteSnippets(topic, 12);
    const out = await buildPimpQuestionsAI(topic, snippets, n);
    if (!out.questions.length) return res.status(500).json({ error: "failed to generate questions" });
    res.json({ ok: true, topic, count: out.questions.length, questions: out.questions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Handy GET wrapper for quick testing in a browser:
//   /med/test-questions?topic=Acute%20Coronary%20Syndrome&n=10
app.get('/med/test-questions', async (req, res) => {
  try {
    const topic = String(req.query?.topic || "").trim();
    const n = Math.max(4, Math.min(20, Number(req.query?.n || 12)));
    if (!topic) return res.status(400).json({ error: "topic required" });
    const snippets = searchNoteSnippets(topic, 12);
    const out = await buildPimpQuestionsAI(topic, snippets, n);
    if (!out.questions.length) return res.status(500).json({ error: "failed to generate questions" });
    res.json({ ok: true, topic, count: out.questions.length, questions: out.questions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// --- Learn-plan helpers (place under HARDCODED_TOC) ---

// If you already added this earlier for high-yield, keep one copy only.
/*
const INTERNAL_MED_DISC_SET = new Set([
  "Cardiology","Endocrinology","Gastroenterology","Hematology",
  "Infectious Disease","Nephrology","Neurology","Respirology","Rheumatology"
]);
*/

// Simple FTS search into your indexed notes (if any) to provide context to the AI.


// Optional grounding from your indexed PDFs (works even if empty)
function searchNoteSnippets(topic, k = 8) {
  try {
    const rows = medDb.prepare(`
      SELECT pc.text AS text
      FROM pdf_chunks_fts
      JOIN pdf_chunks pc ON pc.rowid = pdf_chunks_fts.rowid
      WHERE pdf_chunks_fts MATCH ?
      ORDER BY bm25(pdf_chunks_fts)
      LIMIT ?
    `).all(topic, k);
    return rows.map(r => r.text);
  } catch {
    return [];
  }
}

// Build the plan (cheaper model) – guidelines, trials, objectives
async function buildLearnPlanAI(topic, noteSnippets = []) {
  const system = `
You are an evidence-based Internal Medicine educator.
Create a LEARNING PLAN for the topic with three arrays: "guidelines", "trials", "objectives".
Return STRICT JSON only:

{
  "guidelines":[
    {"region":"Canada|USA|International","org":"","year":2020,"title":"","why":"","link":""}
  ],
  "trials":[
    {"name":"","year":1999,"question":"","design":"","n":"","result":"","impact":"","one_liner":"","link":""}
  ],
  "objectives":[
    {"objective":"","rationale":"",
     "resources":[
       {"type":"guideline","ref":""},
       {"type":"trial","ref":""},
       {"type":"other","title":"","link":""}
     ]}
  ]
}

RULES
- Prefer CANADIAN guidelines first (CCS/CTS/CMAJ/SOGC/IDSA Canada/etc), else USA (ACC/AHA/ACP/IDSA/etc), then International.
- Trials MUST be landmark/seminal (include influential negative trials when relevant).
- Objectives should be extensive: pathophysiology, dx, risk stratification, mgmt (ED/inpatient/outpatient), complications, follow-up.
- Under each objective, list resources that match items in the "guidelines" or "trials" arrays (use their exact titles/names in "ref").
- If you provide "link", it MUST be a stable landing page, DOI or PMID; if unsure, leave "link" empty. NO dead paths.
`;

  const userPayload = {
    topic,
    note_snippets: noteSnippets,
    prefer_regions: ["Canada","USA","International"],
    max_guidelines: 10,
    max_trials: 12
  };

  const resp = await responsesCall({
    model: BASE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const parsed = parseResponsesJSON(resp);
  if (!parsed || !Array.isArray(parsed.guidelines) || !Array.isArray(parsed.trials) || !Array.isArray(parsed.objectives)) {
    return { guidelines: [], trials: [], objectives: [] };
  }
  return parsed;
}
// Validate a URL (HEAD first, fallback GET), short timeout
async function urlOk(url, timeoutMs = 7000) {
  if (!url || typeof url !== "string") return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // HEAD can be blocked; try GET if HEAD not ok
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    if (!r.ok) {
      r = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    }
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// Ask a smarter model for canonical links (only for items missing/invalid URLs)
async function aiSuggestCanonicalLinks(kind, items) {
  // items: [{i, title/org/year} or {i, name/year}]
  if (!items.length) return [];
  const system = `
You are a meticulous research assistant whose ONLY job is to provide canonical, non-404 links.
For ${kind}, return stable landing pages (home guideline pages) or DOI/PMID links.
Return STRICT JSON only: {"links":[{"i":0,"url":""}, ...]}  
Rules:
- Prefer society's canonical landing page for guidelines (not PDF deep-links if unstable).
- Prefer DOI or PubMed for trials; Google-hosted PDFs are OK if official.
- NEVER return obvious 404s or search result pages. If uncertain, leave the url empty.
`;
  const resp = await responsesCall({
    model: STRICT_MODEL,              // set OPENAI_STRICT_MODEL=gpt-5.1 on Render
    messages: [
      { role: "system", content: system },
      { role: "user",   content: JSON.stringify({ items }) }
    ]
    // no temperature for 5.x (wrapper omits it automatically)
  });

  const parsed = parseResponsesJSON(resp);
  return Array.isArray(parsed?.links) ? parsed.links : [];
}

// Fix/verify links: if invalid -> ask AI for a canonical URL -> verify -> else fall back to search links
async function improvePlanLinks(plan, topic) {
  const order = { Canada: 0, USA: 1, International: 2 };
  plan.guidelines.sort((a,b) => (order[a.region] ?? 99) - (order[b.region] ?? 99) || (b.year||0) - (a.year||0));

  // Verify given links
  const invalidGuides = [];
  for (let i=0;i<plan.guidelines.length;i++){
    const g = plan.guidelines[i];
    if (g.link && await urlOk(g.link)) continue;
    invalidGuides.push({ i, title: g.title || "", org: g.org || "", year: g.year || "", region: g.region || "" });
    g.link = ""; // clear for now
  }
  const invalidTrials = [];
  for (let i=0;i<plan.trials.length;i++){
    const t = plan.trials[i];
    if (t.link && await urlOk(t.link)) continue;
    invalidTrials.push({ i, name: t.name || "", year: t.year || "" });
    t.link = "";
  }

  // Ask smarter model only for the missing ones
  if (invalidGuides.length){
    const links = await aiSuggestCanonicalLinks("guidelines", invalidGuides);
    for (const l of links) {
      const g = plan.guidelines[l.i];
      if (!g) continue;
      if (l.url && await urlOk(l.url)) g.link = l.url;
    }
  }
  if (invalidTrials.length){
    const links = await aiSuggestCanonicalLinks("trials", invalidTrials);
    for (const l of links) {
      const t = plan.trials[l.i];
      if (!t) continue;
      if (l.url && await urlOk(l.url)) t.link = l.url;
    }
  }

  // Final fallbacks: search links that won't 404 (search pages are intentional here)
  const gSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const pmid = (q) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}`;
  const scholar = (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`;

  for (const g of plan.guidelines) {
    if (!g.link) g.link = gSearch(`${g.title || topic} ${g.org || ""} guideline`);
  }
  for (const t of plan.trials) {
    if (!t.link) t.link = pmid(`${t.name || topic}`);
  }

  return plan;
}



// ------------------------------ ADMIN NUKE (kept) ---------------------------
app.delete('/admin/wipe', async (req, res) => {
  try {
    const secret = String(req.query.secret || "");
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }
    const dry = String(req.query.dry || "0") === "1";

    const patterns = ["user:*","sess:*","sess:*:items","excl:*","history:*","leaderboard:*"];
    let deleted = 0;

    async function delChunked(keys) {
      const CHUNK = 100;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        if (!dry && slice.length) await redis.del(...slice);
        deleted += slice.length;
      }
    }

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys?.length) await delChunked(keys);
    }

    if (!dry) await redis.del("leaderboard:global");
    res.json({ ok: true, dry, deleted_keys_estimate: deleted });
  } catch (e) {
    res.status(500).json({ error: "wipe failed", detail: String(e) });
  }
});

// --- AI username moderation (kept) ---
const OPENAI_MOD_URL = "https://api.openai.com/v1/moderations";
const ALLOW_ON_MOD_FAIL = true;

async function isUsernameAllowedAI(username) {
  try {
    const resp = await fetch(OPENAI_MOD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: username }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || resp.statusText);

    const r = Array.isArray(data.results) ? data.results[0] : data;
    const c = r.categories || {};
    const s = r.category_scores || r.scores || {};
    const flagged = r.flagged === true;

    const blockHardFlags =
      c.hate === true || c.hate_threatening === true ||
      c.harassment_threats === true ||
      c.sexual_minors === true ||
      c.violence_graphic === true;

    const blockByScore =
      (s.hate || 0) > 0.50 ||
      (s.hate_threatening || 0) > 0.40 ||
      (s.harassment_threats || 0) > 0.50 ||
      (s.sexual_minors || 0) > 0.20 ||
      (s.violence_graphic || 0) > 0.40;

    return !(flagged || blockHardFlags || blockByScore);
  } catch (e) {
    console.error("Moderation check failed:", e);
    return ALLOW_ON_MOD_FAIL;
  }
}

// Redis keys (kept)
const kUser = (u) => `user:${u}`;
const kExcl = (u) => `excl:${u}`;
const kSess = (s) => `sess:${s}`;
const kSessItems = (s) => `sess:${s}:items`;
const kHistory = (u) => `history:${u}`;

// DEBUGGERS (kept)
app.get("/admin/raw-items", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const key = kSessItems(String(sessionId));
    const raw = await redis.lrange(key, 0, -1);
    res.json({
      key,
      length: raw.length,
      items: raw.map((x, i) => ({ idx: i, typeof: typeof x, preview: String(x).slice(0, 120) }))
    });
  } catch (e) {
    res.status(500).json({ error: "raw-items failed", detail: String(e) });
  }
});

app.post("/admin/append-dummy", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const key = kSessItems(String(sessionId));
    const dummy = { question: "DUMMY?", final_difficulty: "MSI3", asked_at: Date.now() };
    const newLen = await redis.rpush(key, JSON.stringify(dummy));
    res.json({ ok: true, key, newLen });
  } catch (e) {
    res.status(500).json({ error: "append failed", detail: String(e) });
  }
});

// Points helpers (kept)
const kLB = () => `leaderboard:global`;
function tierIndex(label) { const i = DIFF.indexOf(label); return (i >= 0 ? i : 0) + 1; }
function pointsFor(label) { const t = tierIndex(label); return { correct: 10 * t, wrong: 5 * t }; }

async function getUserScore(username) {
  const h = await redis.hgetall(kUser(username));
  const score = Number(h?.score || 0);
  const answered = Number(h?.answered || 0);
  const correct = Number(h?.correct || 0);
  return { score, answered, correct, accuracy: answered ? correct / answered : 0 };
}

async function applyScoreDelta(username, delta, wasCorrect) {
  await redis.hincrby(kUser(username), "answered", 1);
  if (wasCorrect) await redis.hincrby(kUser(username), "correct", 1);

  let newScore = await redis.hincrby(kUser(username), "score", delta);
  await redis.zincrby(kLB(), delta, username);

  if (newScore < 0) {
    await redis.hincrby(kUser(username), "score", -newScore);
    await redis.zincrby(kLB(), -newScore, username);
    newScore = 0;
  }
  return newScore;
}

// ------------------------------ HARD-CODED TOC ROUTES -----------------------

// Full TOC (flattened)
app.get('/med/toc', (req, res) => {
  const items = tocItemsFromTree(HARDCODED_TOC);
  const counts = {
    disciplines: Object.keys(HARDCODED_TOC).length,
    subs: Object.values(HARDCODED_TOC).reduce((a, s) => a + Object.keys(s).length, 0),
    topics: items.length
  };
  res.json({ ok: true, label: 'HARDCODED_TOC_V1', items, counts });
});

// Lists for UI pickers
app.get('/med/disciplines', (req, res) => {
  res.json({ disciplines: Object.keys(HARDCODED_TOC) });
});

app.get('/med/subdisciplines', (req, res) => {
  const d = String(req.query.discipline || '');
  const subs = HARDCODED_TOC[d] ? Object.keys(HARDCODED_TOC[d]) : [];
  res.json({ discipline: d, subs });
});

app.get('/med/topics-for-sub', (req, res) => {
  const d = String(req.query.discipline || '');
  const s = String(req.query.sub || '');
  const topics = HARDCODED_TOC[d]?.[s] || [];
  res.json({ discipline: d, sub: s, topics });
});

// ---------- Response parsing helpers (kept) ----------
function parseResponsesJSON(resp) {
  try {
    const t1 = typeof resp?.output_text === "string" ? resp.output_text.trim() : "";
    if (t1 && (t1.startsWith("{") || t1.startsWith("["))) return JSON.parse(t1);

    const part = resp?.output?.[0]?.content?.[0];
    if (!part) return null;

    const t2 = typeof part?.text === "string" ? part.text.trim() : "";
    if (t2 && (t2.startsWith("{") || t2.startsWith("["))) return JSON.parse(t2);

    if (part && typeof part.json === "object" && part.json !== null) return part.json;
    if (part && typeof part === "object" && !Array.isArray(part)) return part;

    return null;
  } catch { return null; }
}

function debugResp(tag, resp) {
  try {
    console.log(`[${tag}] typeof output_text=`, typeof resp?.output_text);
    if (typeof resp?.output_text === "string") {
      console.log(`[${tag}] output_text (first 200):`, resp.output_text.slice(0, 200));
    }
    const part = resp?.output?.[0]?.content?.[0];
    console.log(`[${tag}] part keys:`, part ? Object.keys(part) : null);
    if (typeof part?.text === "string") {
      console.log(`[${tag}] part.text (first 200):`, part.text.slice(0, 200));
    }
  } catch {}
}

// Peek at a session's stored items (kept)
app.get("/admin/peek-session", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(String(sessionId));
    const items = await getSessionItems(String(sessionId));
    res.json({ meta, items_count: items.length, last_item: items[items.length - 1] || null });
  } catch (e) {
    res.status(500).json({ error: "peek failed", detail: String(e) });
  }
});

// Helpers (kept)
async function userExists(username) { return Boolean(await redis.exists(kUser(username))); }

async function createUser(username) {
  await redis.hset(kUser(username), { created_at: Date.now() });
  await redis.hset(kUser(username), { score: 0, answered: 0, correct: 0 });
  await redis.zadd(kLB(), { score: 0, member: username });
  await redis.zadd('leaderboard:global', { score: 0, member: username });
}

async function exclusionsCount(username) { return await redis.llen(kExcl(username)); }
async function getExclusions(username) { return await redis.lrange(kExcl(username), 0, -1); }
async function pushExclusions(username, questions) { if (!questions?.length) return 0; return await redis.rpush(kExcl(username), ...questions); }

async function createSession({ username, topic, startingDifficulty }) {
  const id = uuid();
  await redis.hset(kSess(id), {
    username,
    topic: topic || 'random',
    start_diff: startingDifficulty || 'MSI3',
    created_at: Date.now()
  });
  return id;
}

async function getSessionMeta(sessionId) {
  const data = await redis.hgetall(kSess(sessionId));
  if (!data || Object.keys(data).length === 0) return null;
  return data;
}

async function getSessionItems(sessionId) {
  const raw = await redis.lrange(kSessItems(sessionId), 0, -1);
  const items = [];
  for (const r of raw) {
    if (typeof r === "string") {
      const t = r.trim();
      if (t.startsWith("{") || t.startsWith("[")) { try { items.push(JSON.parse(t)); } catch {} }
    } else if (r && typeof r === "object" && !Array.isArray(r)) {
      items.push(r);
    }
  }
  return items;
}

function parseMaybeJSON(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { return null; }
  }
  return null;
}

async function pushSessionItem(sessionId, item) {
  await redis.rpush(kSessItems(sessionId), JSON.stringify(item));
}

async function updateLastSessionItem(sessionId, patch) {
  const len = await redis.llen(kSessItems(sessionId));
  if (len === 0) return;

  const raw = await redis.lindex(kSessItems(sessionId), len - 1);
  const last = parseMaybeJSON(raw);
  if (!last) return;

  const updated = { ...last, ...patch };
  await redis.lset(kSessItems(sessionId), len - 1, JSON.stringify(updated));
}

async function pushHistory(username, item) {
  await redis.lpush(kHistory(username), JSON.stringify(item));
  await redis.ltrim(kHistory(username), 0, 999);
}

// Delete a PDF by label (kept from your version)
app.delete('/med/pdfs/by-label', (req, res) => {
  try {
    const label = String(req.query.label || '');
    if (!label) return res.status(400).json({ error: 'label required' });

    const row = medDb.prepare('SELECT id FROM pdf_docs WHERE label = ?').get(label);
    if (!row) return res.json({ ok: true, deleted: false, reason: 'not found' });

    medDb.prepare('DELETE FROM pdf_docs WHERE id = ?').run(row.id);
    medDb.prepare('DELETE FROM toc_cache WHERE label = ?').run(label);

    res.json({ ok: true, deleted: true, label });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

////////////////////////////////////////////////////////////////////////////////
// OPENAI HELPERS (question/grade/summarize) — kept as in your file
////////////////////////////////////////////////////////////////////////////////

async function aiGenerateQuestion({ topic, difficulty, avoidList }) {
  if (process.env.MOCK_AI === '1') {
    const pool = (Array.isArray(avoidList) ? avoidList : []);
    const bank = [
      "First-line treatment for status asthmaticus?",
      "Antidote for organophosphate poisoning?",
      "Next step for suspected PE in a hemodynamically stable patient?",
      "Diagnostic test of choice for C. difficile infection?",
      "Target INR for mechanical mitral valve?"
    ];
    const q = bank.find(b => !pool.includes(b)) || "Dose of epinephrine IM for anaphylaxis in adults?";
    return q;
  }

  const avoid = Array.isArray(avoidList) ? avoidList.slice(-200) : [];

  const system = `You are the question engine for "One Line Pimp Simulator".
Return ONLY JSON like: {"question":"..."}.
Question must be answerable in ONE word or ONE short sentence.
The questions should be difficult questions designed to mimic questions an attending physician would ask (or "pimp") a medical student or resident.
Ensure the difficulty scales with MSI1→Attending. Avoid duplicates of provided examples.
Quality control is mandatory: do not generate physiologically contradictory or internally inconsistent stems.
If the topic involves acid-base, electrolytes, endocrine physiology, pharmacology, or hemodynamics, verify the expected answer before returning the question.
Do not ask a question whose correct answer depends on a false premise unless the question explicitly asks the learner to identify the inconsistency.`;

  const userPayload = { topic: topic || "random", difficulty: difficulty || "MSI3", avoid_examples: avoid };

  const resp = await responsesCall({
    model: process.env.OPENAI_FAST_MODEL || "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const parsed = parseResponsesJSON(resp) || {};
  if (!parsed.question || typeof parsed.question !== "string") throw new Error("Bad question JSON");
  return parsed.question.trim();
}

async function aiGradeAnswer({ question, userAnswer, difficulty }) {
  if (process.env.MOCK_AI === "1") {
    const golds = {
      "First-line treatment for status asthmaticus?": "nebulized SABA plus ipratropium, systemic steroids, oxygen and magnesium if severe",
      "Antidote for organophosphate poisoning?": "atropine and pralidoxime",
      "Next step for suspected PE in a hemodynamically stable patient?": "CTPA if not low-risk/PERC negative",
      "Diagnostic test of choice for C. difficile infection?": "stool NAAT or toxin testing depending on local algorithm",
      "Target INR for mechanical mitral valve?": "3.0"
    };
    const gold = (golds[question] || "").toLowerCase().trim();
    const ans  = String(userAnswer || "").toLowerCase().trim();
    let credit = 0;
    if (gold && (ans === gold || gold.includes(ans) || ans.includes(gold))) credit = 1;
    else if (gold && ans && gold.split(/\W+/).some(w => w.length > 4 && ans.includes(w))) credit = 0.5;
    const verdict = credit >= 0.85 ? "correct" : (credit > 0 ? "partial" : "incorrect");
    return {
      verdict,
      credit,
      is_correct: credit >= 0.85,
      explanation: credit >= 0.85 ? "" : (gold ? `Expected: ${gold}.` : "Reviewed."),
      difficulty_delta: credit >= 0.85 ? 1 : (credit >= 0.35 ? 0 : -1),
      invalid_question: false
    };
  }

  const system = `You are a strict but fair medical answer grader for a one-line clinical pimp simulator.
Return ONLY valid JSON with this exact shape:
{
  "verdict": "correct" | "partial" | "incorrect" | "invalid",
  "credit": 0.0,
  "explanation": "1-3 concise sentences",
  "difficulty_delta": -1 | 0 | 1,
  "invalid_question": false
}

Core grading rules:
- Award continuous partial credit from 0 to 1.
- credit=1 means the core answer is correct, even if wording is imperfect.
- credit 0.60-0.85 means the answer is very close or captures the key mechanism but misses an important qualifier.
- credit 0.30-0.59 means partially correct but materially incomplete.
- credit 0.05-0.29 means a small relevant fragment only.
- credit=0 means wrong, unrelated, or unsafe.
- Use verdict="partial" for any defensible partial answer where 0 < credit < 0.85.
- Use verdict="correct" when credit >= 0.85.
- Use verdict="incorrect" when credit = 0.
- If the learner challenges a false premise and the challenge is valid, mark correct or partial depending on quality.
- If the stem itself is ambiguous, impossible, internally inconsistent, or based on a false physiologic premise, set verdict="invalid", invalid_question=true, credit=0, difficulty_delta=0, and explain the corrected concept.
- Do not punish the learner for a defensible answer to an invalid or ambiguous stem.
- Be especially careful with acid-base, electrolytes, endocrine physiology, pharmacology, and hemodynamics.
- Keep explanations precise and high-yield. If the learner is close, say exactly what was missing.`;

  const userPayload = { question, userAnswer, difficulty };

  let parsed = null;
  try {
    const resp = await responsesCall({
      model: process.env.OPENAI_FAST_MODEL || "gpt-4.1-mini",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    });
    parsed = parseResponsesJSON(resp);
  } catch (e) {
    return { verdict: "incorrect", credit: 0, is_correct: false, explanation: "Grader unavailable; keeping same difficulty.", difficulty_delta: 0, invalid_question: false };
  }

  if (!parsed || typeof parsed !== "object") {
    return { verdict: "incorrect", credit: 0, is_correct: false, explanation: "Grader returned unexpected format.", difficulty_delta: 0, invalid_question: false };
  }

  const invalid_question = !!parsed.invalid_question || parsed.verdict === "invalid";
  let credit = Number(parsed.credit);

  // Backward compatibility if a model accidentally returns the older boolean format.
  if (!Number.isFinite(credit)) {
    if (invalid_question) credit = 0;
    else if (parsed.is_correct === true) credit = 1;
    else credit = 0;
  }
  credit = Math.max(0, Math.min(1, credit));

  let verdict = String(parsed.verdict || "").toLowerCase();
  if (invalid_question) verdict = "invalid";
  else if (!["correct", "partial", "incorrect"].includes(verdict)) {
    verdict = credit >= 0.85 ? "correct" : (credit > 0 ? "partial" : "incorrect");
  }
  if (!invalid_question) {
    if (credit >= 0.85) verdict = "correct";
    else if (credit > 0) verdict = "partial";
    else verdict = "incorrect";
  }

  const is_correct = verdict === "correct";
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";

  let delta = Number(parsed.difficulty_delta);
  if (![ -1, 0, 1 ].includes(delta)) {
    delta = invalid_question ? 0 : (credit >= 0.85 ? 1 : (credit >= 0.35 ? 0 : -1));
  }

  return { verdict, credit, is_correct, explanation, difficulty_delta: delta, invalid_question };
}


async function aiDiscussAnswer({ question, userAnswer, grading, dialogue, message }) {
  if (process.env.MOCK_AI === "1") {
    return "That is a fair challenge. If the stem is internally inconsistent, treat it as a flawed question rather than a true miss.";
  }

  const system = `You are a rigorous but helpful clinical educator inside a pimp-question simulator.
The learner may challenge the explanation, ask why partial credit was assigned, or request a mechanism.
Respond directly and honestly.
If the original grading, credit fraction, or explanation appears wrong, admit it plainly and explain the corrected physiology.
Do not protect the previous answer if it is incorrect.
When discussing partial credit, explain what the learner got right, what was missing, and what would make it full credit.
Keep the reply concise, high-yield, and mechanistic when useful.`;

  const payload = {
    question,
    userAnswer,
    grading,
    priorDialogue: Array.isArray(dialogue) ? dialogue.slice(-8) : [],
    learnerMessage: message
  };

  const resp = await responsesCall({
    model: process.env.OPENAI_BASE_MODEL || "gpt-4.1",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) }
    ]
  });

  return (resp.output_text || resp.output?.[0]?.content?.[0]?.text || "").trim() || "I could not generate a clarification.";
}

async function aiSummarizeSession({ transcript, startDifficulty }) {
  const system = `You will summarize the session in detail, explain strengths and weaknesses with examples, and give a final rating.
Return JSON ONLY:
{"feedback": "short feedback", "rating": "MSI1|MSI2|MSI3|MSI4|R1|R2|R3|R4|R5|Attending"}`;

  const userPayload = {
    startDifficulty: startDifficulty || "MSI3",
    items: transcript.map(t => ({
      question: t.question,
      userAnswer: t.user_answer ?? "",
      correct: !!t.is_correct,
      verdict: t.verdict || (t.is_correct ? "correct" : "incorrect"),
      credit: Number(t.credit || 0),
      explanation: t.explanation ?? ""
    }))
  };

  const resp = await responsesCall({
    model: BASE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const txt = resp.output_text?.trim() || resp.output?.[0]?.content?.[0]?.text || "{}";
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = {}; }

  const feedback = typeof parsed.feedback === "string" ? parsed.feedback : "Good effort.";
  const rating = DIFF.includes(parsed.rating) ? parsed.rating : "MSI3";
  return { feedback, rating };
}

////////////////////////////////////////////////////////////////////////////////
// ROUTES (your existing routes below are kept unchanged)
////////////////////////////////////////////////////////////////////////////////

// Health check
app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Create user
app.post('/api/users', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: "username required" });
    }
    const ok = await isUsernameAllowedAI(username);
    if (!ok) {
      return res.status(400).json({ error: 'That username isn’t allowed. Please choose something else.' });
    }
    if (await userExists(username)) {
      return res.status(409).json({ error: "Username taken" });
    }
    await createUser(username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to create user", detail: String(e) });
  }
});

// Exclusions count
app.get('/api/exclusions/count', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    if (!(await userExists(String(username)))) return res.status(404).json({ error: "User not found" });
    const count = await exclusionsCount(String(username));
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: "Failed to get count", detail: String(e) });
  }
});

// Full exclusions list
app.get('/api/exclusions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    const list = await getExclusions(String(username));
    res.json({ questions: list });
  } catch (e) {
    res.status(500).json({ error: "Failed to get exclusions", detail: String(e) });
  }
});

// Start session
app.post('/api/sessions', async (req, res) => {
  try {
    const { username, topic, startingDifficulty } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });
    if (!(await userExists(username))) {
      return res.status(404).json({ error: "User not found" });
    }
    const id = await createSession({ username, topic, startingDifficulty });
    res.json({ sessionId: id, topic: topic || 'random', difficulty: startingDifficulty || 'MSI3' });
  } catch (e) {
    res.status(500).json({ error: "Failed to create session", detail: String(e) });
  }
});

// Next question
app.post('/api/next', async (req, res) => {
  try {
    const { sessionId, topic: overrideTopic, difficulty: overrideDiff } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found" });

    const username = meta.username;
    const topic = overrideTopic || meta.topic || 'random';

    const items = await getSessionItems(sessionId);
    const lastDiff = items.length
      ? items[items.length - 1].final_difficulty
      : (overrideDiff || meta.start_diff || "MSI3");
    const difficulty = lastDiff;

    const exclList = await getExclusions(username);

    const already = await getSessionItems(sessionId);
    const sessionQs = already.map(it => it.question).filter(Boolean);

    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const avoidSet = new Set([...exclList, ...sessionQs].map(norm));

    let question;
    let tries = 0;
    do {
      question = await aiGenerateQuestion({ topic, difficulty, avoidList: [...avoidSet] });
      tries++;
    } while (avoidSet.has(norm(question)) && tries < 3);

    if (avoidSet.has(norm(question))) {
      question = `${topic !== 'random' ? topic + ': ' : ''}${question}`;
    }

    const asked_index_in_session = items.length + 1;
    const baseCount = await exclusionsCount(username);
    const q_number = baseCount + asked_index_in_session;

    await pushSessionItem(sessionId, {
      question,
      topic,
      starting_difficulty: difficulty,
      final_difficulty: difficulty,
      asked_index_in_session,
      asked_at: Date.now()
    });

    res.json({ q_number, question, difficulty });
  } catch (e) {
    res.status(500).json({ error: "Failed to get next question", detail: String(e) });
  }
});

// Grade answer
app.post('/api/answer', async (req, res) => {
  try {
    const { sessionId, answer } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    if (typeof answer !== "string") return res.status(400).json({ error: "answer required" });

    const meta = await getSessionMeta(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found" });
    const username = meta.username;

    const items = await getSessionItems(sessionId);
    if (items.length === 0) return res.status(400).json({ error: "No question to grade" });
    const last = items[items.length - 1];

    const graded = await aiGradeAnswer({
      question: last.question,
      userAnswer: answer,
      difficulty: last.final_difficulty
    });

    const {
      verdict,
      credit,
      is_correct,
      explanation,
      difficulty_delta,
      invalid_question
    } = graded;

    const nextDiff = bumpDifficulty(last.final_difficulty, difficulty_delta);

    const { correct, wrong } = pointsFor(last.final_difficulty);
    const max_points = correct;
    const penalty_points = wrong;

    // Scoring policy:
    // - correct: full positive points
    // - partial: continuous positive points from 0 to full points
    // - incorrect: original negative penalty
    // - invalid/ambiguous question: neutral, no penalty
    let points_delta = 0;
    if (invalid_question || verdict === "invalid") {
      points_delta = 0;
    } else if (verdict === "correct") {
      points_delta = max_points;
    } else if (verdict === "partial" || (credit > 0 && credit < 0.85)) {
      points_delta = Math.round(max_points * Math.max(0, Math.min(1, credit)));
    } else {
      points_delta = -penalty_points;
    }

    const score_after = await applyScoreDelta(username, points_delta, is_correct);

    const askedAt = Date.now();

    await pushHistory(username, {
      question: last.question,
      difficulty: last.final_difficulty,
      user_answer: answer,
      is_correct,
      verdict,
      credit,
      explanation,
      invalid_question,
      points_delta,
      max_points,
      penalty_points,
      score_after,
      asked_at: askedAt,
    });

    await updateLastSessionItem(sessionId, {
      user_answer: answer,
      is_correct,
      verdict,
      credit,
      explanation,
      invalid_question,
      final_difficulty: nextDiff,
      points_delta,
      max_points,
      penalty_points,
      score_after,
      dialogue: []
    });

    res.json({
      correct: is_correct,
      verdict,
      credit,
      explanation,
      invalid_question,
      nextDifficulty: nextDiff,
      points_delta,
      max_points,
      penalty_points,
      score: score_after
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to grade answer", detail: String(e) });
  }
});


// Optional follow-up dialogue after an answer has been graded.
app.post('/api/discuss', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });

    const meta = await getSessionMeta(String(sessionId));
    if (!meta) return res.status(404).json({ error: "Session not found" });

    const items = await getSessionItems(String(sessionId));
    if (!items.length) return res.status(400).json({ error: "No active question" });
    const last = items[items.length - 1];
    if (!Object.prototype.hasOwnProperty.call(last, 'user_answer')) {
      return res.status(400).json({ error: "Answer the question before starting discussion" });
    }

    const dialogue = Array.isArray(last.dialogue) ? last.dialogue : [];
    const grading = {
      is_correct: !!last.is_correct,
      verdict: last.verdict || (last.is_correct ? "correct" : "incorrect"),
      credit: Number(last.credit || 0),
      explanation: last.explanation || "",
      invalid_question: !!last.invalid_question,
      points_delta: Number(last.points_delta || 0),
      max_points: Number(last.max_points || 0),
      penalty_points: Number(last.penalty_points || 0)
    };

    const reply = await aiDiscussAnswer({
      question: last.question,
      userAnswer: last.user_answer || "",
      grading,
      dialogue,
      message: String(message)
    });

    const updatedDialogue = [...dialogue, { role: "user", content: String(message), at: Date.now() }, { role: "assistant", content: reply, at: Date.now() }];
    await updateLastSessionItem(String(sessionId), { dialogue: updatedDialogue });

    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: "Discussion failed", detail: String(e) });
  }
});


// Save the session questions into the user's exclusion list and generate feedback
app.post('/api/conclude', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(String(sessionId));
    if (!meta) return res.status(404).json({ error: "Session not found" });

    const username = meta.username;
    const items = await getSessionItems(String(sessionId));
    const asked = items.filter(it => it && it.question).map(it => String(it.question));
    const answered = items.filter(it => it && it.question && Object.prototype.hasOwnProperty.call(it, 'user_answer'));

    // Add only genuinely new questions to exclusions so repeated clicks do not inflate numbering.
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = await getExclusions(username);
    const existingNorm = new Set((existing || []).map(norm));
    const toAdd = [];
    for (const q of asked) {
      const nq = norm(q);
      if (nq && !existingNorm.has(nq)) {
        existingNorm.add(nq);
        toAdd.push(q);
      }
    }
    if (toAdd.length) await pushExclusions(username, toAdd);

    const session_points = answered.reduce((sum, it) => sum + Number(it.points_delta || 0), 0);
    let feedback = "No answered questions yet.";
    let rating = meta.start_diff || "MSI3";
    if (answered.length) {
      const summary = await aiSummarizeSession({ transcript: answered, startDifficulty: meta.start_diff });
      feedback = summary.feedback;
      rating = summary.rating;
    }

    await redis.hset(kSess(String(sessionId)), { concluded_at: Date.now(), rating });
    const new_count = await exclusionsCount(username);
    res.json({
      ok: true,
      added: toAdd.length,
      new_count,
      next_number: new_count + 1,
      session_points,
      feedback,
      rating
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to conclude session", detail: String(e) });
  }
});

// Get a user's score + stats
app.get('/api/score', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    if (!(await userExists(String(username)))) return res.status(404).json({ error: "User not found" });

    const stats = await getUserScore(String(username));
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: "Failed to get score", detail: String(e) });
  }
});

// Leaderboard (global)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
    const key = 'leaderboard:global';

    const raw = await redis.zrange(key, 0, limit - 1, { rev: true, withScores: true });

    let pairs = [];
    if (Array.isArray(raw) && raw.length > 0) {
      if (typeof raw[0] === 'object' && raw[0] !== null && ('member' in raw[0] || 'score' in raw[0])) {
        pairs = raw.map(r => [String(r.member ?? ''), Number(r.score ?? 0)]);
      } else if (typeof raw[0] === 'string' || typeof raw[0] === 'number') {
        for (let i = 0; i < raw.length; i += 2) {
          const m = String(raw[i] ?? '');
          const s = Number(raw[i + 1] ?? 0);
          pairs.push([m, s]);
        }
      }
    }

    const board = pairs
      .filter(([m]) => m && m.trim().length > 0)
      .map(([m, s], i) => ({ rank: i + 1, username: m, score: Number.isFinite(s) ? s : 0 }));

    res.json({ leaderboard: board });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get leaderboard', detail: String(e) });
  }
});

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const username = String(req.query.username || "");
    if (!username) return res.status(400).json({ error: "username required" });

    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const rows = await redis.lrange(kHistory(username), 0, limit - 1);

    const items = (rows || []).map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: "history failed", detail: String(e) });
  }
});

// ==================== MED LEARNER ROUTES (existing) ====================

// --- Learn Plan API ---
// POST /med/learn-plan { topic, user_id? } -> guidelines, trials, objectives

// POST /med/learn-plan { topic, user_id? }
app.post('/med/learn-plan', async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "topic required" });

    const snippets = searchNoteSnippets(topic, 8);
    let plan = await buildLearnPlanAI(topic, snippets);
    plan = await improvePlanLinks(plan, topic);

    res.json({ ok: true, topic, ...plan, snippets_count: snippets.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /med/learn-plan?topic=...
app.get('/med/learn-plan', async (req, res) => {
  try {
    const topic = String(req.query?.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "topic required" });

    const snippets = searchNoteSnippets(topic, 8);
    let plan = await buildLearnPlanAI(topic, snippets);
    plan = await improvePlanLinks(plan, topic);

    res.json({ ok: true, topic, ...plan, snippets_count: snippets.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// Get completed topics for a user
app.get('/med/topics', (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const rows = medDb
    .prepare(`SELECT topic FROM completed_topics WHERE user_id = ? ORDER BY created_at DESC`)
    .all(user_id);
  res.json({ topics: rows.map(r => r.topic) });
});

// Add a completed topic
app.post('/med/topics', (req, res) => {
  const { user_id, topic } = req.body || {};
  if (!user_id || !topic) return res.status(400).json({ error: 'user_id and topic required' });
  try {
    medDb.prepare(`INSERT OR IGNORE INTO completed_topics (user_id, topic) VALUES (?, ?)`).run(user_id, topic);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload & index a PDF (multipart/form-data) — left intact
app.post('/med/pdfs', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const label = req.body?.label || req.file.originalname;
    const { docId, nChunks } = await indexPdfBuffer(req.file.buffer, label);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch & index a PDF by URL — left intact
app.post('/med/pdfs/by-url', async (req, res) => {
  try {
    const { url, label } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });

    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ error: `fetch failed: ${r.status}` });

    const buf = Buffer.from(await r.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, label || url);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label: label || url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search indexed PDFs (FTS5; BM25 ranking) — left intact
app.get('/med/pdfs/search', (req, res) => {
  const q = req.query.q;
  const k = Number(req.query.k || 8);
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const rows = medDb.prepare(`
      SELECT pc.rowid as rowid,
             pc.id     as chunk_id,
             pc.doc_id as doc_id,
             pd.label  as label,
             pc.text   as text,
             bm25(pdf_chunks_fts) as score
      FROM pdf_chunks_fts
      JOIN pdf_chunks pc ON pc.rowid = pdf_chunks_fts.rowid
      JOIN pdf_docs   pd ON pd.id = pc.doc_id
      WHERE pdf_chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(q, k);

    res.json({
      hits: rows.map(r => ({
        doc_id: r.doc_id,
        label : r.label,
        chunk_id: r.chunk_id,
        text  : r.text,
        score : r.score
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ==================== MEDICAL CASE SIMULATOR ROUTES ====================
// EMR-style diagnostic and management simulator. Stores the locked diagnosis server-side.

const CASE_MODEL = process.env.OPENAI_CASE_MODEL || STRICT_MODEL || BASE_MODEL;
const CASE_FAST_MODEL = process.env.OPENAI_CASE_FAST_MODEL || process.env.OPENAI_FAST_MODEL || "gpt-4.1-mini";
const CASE_SESSION_TTL_SECONDS = Number(process.env.CASE_SESSION_TTL_SECONDS || 60 * 60 * 24 * 30);

const kCase = (id) => `casesim:session:${id}`;

function extractOutputText(resp) {
  return (typeof resp?.output_text === "string" && resp.output_text.trim())
    || resp?.output?.[0]?.content?.[0]?.text
    || "";
}

function parseLooseJSON(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  if (typeof text !== "string") return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  const firstObj = t.indexOf('{');
  const lastObj = t.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try { return JSON.parse(t.slice(firstObj, lastObj + 1)); } catch {}
  }
  const firstArr = t.indexOf('[');
  const lastArr = t.lastIndexOf(']');
  if (firstArr >= 0 && lastArr > firstArr) {
    try { return JSON.parse(t.slice(firstArr, lastArr + 1)); } catch {}
  }
  return null;
}

async function caseAiJSON({ system, payload, model = CASE_MODEL, temperature = 0 }) {
  const resp = await responsesCall({
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) }
    ]
  });
  const parsed = parseResponsesJSON(resp) || parseLooseJSON(extractOutputText(resp));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI returned non-JSON output for case simulator");
  }
  return parsed;
}

function nowIso() { return new Date().toISOString(); }
function normalizeSimple(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function ensureArray(x) { return Array.isArray(x) ? x : []; }

function parseSimDateTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatSimDateTime(date) {
  const d = date instanceof Date ? date : parseSimDateTime(date);
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addSimMinutes(value, minutes) {
  const d = parseSimDateTime(value) || new Date();
  return formatSimDateTime(new Date(d.getTime() + Number(minutes || 0) * 60000));
}

function simDayLabel(value) {
  const d = parseSimDateTime(value);
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function collectPatientDateTimes(patient) {
  const out = [];
  const push = (x) => { const d = parseSimDateTime(x); if (d) out.push(d); };
  const p = patient || {};
  ensureArray(p.vitals).forEach(x => push(x.datetime));
  ensureArray(p.labCategories).forEach(c => ensureArray(c.rows).forEach(r => ensureArray(r.values).forEach(v => push(v.datetime))));
  ensureArray(p.investigations).forEach(x => push(x.datetime));
  ensureArray(p.nursingNotes).forEach(x => push(x.datetime));
  ensureArray(p.medications).forEach(x => { push(x.start); push(x.stop); });
  ensureArray(p.notes).forEach(x => push(x.datetime));
  ensureArray(p.orders).forEach(x => push(x.datetime || x.at));
  return out;
}

function latestPatientDateTime(patient) {
  const times = collectPatientDateTimes(patient);
  if (!times.length) return "";
  return formatSimDateTime(new Date(Math.max(...times.map(d => d.getTime()))));
}

function isPendingConsultSetting(specialty = "") {
  const s = normalizeSimple(specialty);
  return /\b(ctu|clinical teaching unit|internal medicine|medicine|gim|general internal medicine)\b/.test(s) && /\b(consult|referral|ed|emergency)\b/.test(s);
}

function inferNoteService(...parts) {
  const s = normalizeSimple(parts.filter(Boolean).join(' '));
  if (/\b(ed|emergency|emerg)\b/.test(s)) return "Emergency Medicine";
  if (/\b(internal medicine|medicine|gim|ctu|clinical teaching unit)\b/.test(s)) return "Internal Medicine";
  if (/\bnurs|rn\b/.test(s)) return "Nursing";
  if (/\bsurg/.test(s)) return "General Surgery";
  if (/\bcardio/.test(s)) return "Cardiology";
  if (/\bnephro/.test(s)) return "Nephrology";
  if (/\brespi|pulm/.test(s)) return "Respirology";
  return "";
}

function normalizeNoteObject(note = {}) {
  const n = note && typeof note === "object" ? note : {};
  const noteType = String(n.noteType || n.type || "Note");
  const providerName = String(n.providerName || n.provider || n.author || "");
  const service = String(n.service || n.department || n.specialty || inferNoteService(noteType, providerName, n.title, n.text));
  return {
    ...n,
    id: String(n.id || uuid()),
    datetime: String(n.datetime || ""),
    service,
    providerName,
    noteType,
    type: noteType,
    author: providerName || String(n.author || ""),
    title: String(n.title || noteType),
    text: String(n.text || "")
  };
}

function removeCompletedConsultNotesIfPending(patient, specialty) {
  if (!isPendingConsultSetting(specialty)) return patient;
  const p = patient || {};
  p.notes = ensureArray(p.notes).filter(note => {
    const service = normalizeSimple(note.service || note.department || note.specialty || note.author || note.providerName || "");
    const type = normalizeSimple(note.noteType || note.type || note.title || "");
    const text = normalizeSimple(note.text || "");
    const combined = `${service} ${type} ${text}`;
    const isIM = /\b(internal medicine|medicine|gim|ctu|clinical teaching unit)\b/.test(combined);
    const isCompletedConsultOrAdmission = /\b(consult note|admission note|admission|progress note|assessment and plan|recommendations)\b/.test(combined);
    const isRequest = /\b(consult request|request|referral|ed note|triage)\b/.test(combined) || /\b(emergency medicine|ed|emerg)\b/.test(service);
    if (isRequest) return true;
    if (isIM && isCompletedConsultOrAdmission) return false;
    return true;
  });
  return p;
}

function postProcessCasePatient(patient, specialty = "") {
  const p = sanitizePatient(patient);
  p.notes = ensureArray(p.notes).map(normalizeNoteObject);
  removeCompletedConsultNotesIfPending(p, specialty);
  return p;
}

function administrativeOrderResult(order) {
  const o = String(order || '').trim();
  const low = o.toLowerCase();
  let status = "entered";
  let comment = "Order entered.";
  if (/\b(cbc|lytes|electrolytes|creatinine|urea|lft|inr|ptt|troponin|crp|esr|blood gas|vbg|abg|culture|urine|urinalysis|xray|x-ray|ct|mri|ultrasound|ecg|ekg)\b/.test(low)) {
    status = "pending";
    comment = "Order entered; result pending.";
  }
  if (/\b(d\/c|dc|discontinue|stop|hold)\b/.test(low)) {
    status = "entered";
    comment = "Medication/order change entered.";
  }
  return { order: o, status, comment };
}

function maybeAddMedicationFromOrder(patient, order, simTime) {
  const o = String(order || '').trim();
  if (!/\b(start|give|administer|continue|ceftriaxone|azithromycin|vancomycin|piperacillin|tazobactam|heparin|enoxaparin|insulin|salbutamol|furosemide|lasix|normal saline|ringer|d5w|morphine|hydromorphone|acetaminophen|ondansetron)\b/i.test(o)) return;
  if (/\b(cbc|ct|xray|x-ray|mri|ultrasound|ecg|ekg|culture|bloodwork|lab)\b/i.test(o)) return;
  patient.medications = ensureArray(patient.medications);
  patient.medications.push({ id: uuid(), name: o, dose: "", route: "", frequency: "", status: "active", start: simTime, stop: "", comments: "Entered order" });
}

function sanitizePatient(p) {
  p = p && typeof p === "object" ? p : {};
  delete p.lock;
  delete p.diagnosis;
  delete p.primary_diagnosis;
  delete p.answer;
  return {
    id: String(p.id || uuid()).slice(0, 64),
    displayName: String(p.displayName || p.name || "Doe, Alex"),
    age: Number.isFinite(Number(p.age)) ? Number(p.age) : 50,
    sex: String(p.sex || "U"),
    location: String(p.location || "Emergency Department"),
    allergies: ensureArray(p.allergies).map(String),
    codeStatus: String(p.codeStatus || "Full Code"),
    presentingComplaint: String(p.presentingComplaint || "Undifferentiated presentation"),
    banner: String(p.banner || "Select tabs to review the available chart."),
    vitals: ensureArray(p.vitals),
    labCategories: ensureArray(p.labCategories),
    investigations: ensureArray(p.investigations),
    nursingNotes: ensureArray(p.nursingNotes),
    medications: ensureArray(p.medications),
    notes: ensureArray(p.notes),
    orders: ensureArray(p.orders)
  };
}

function publicCasePayload(session) {
  const patient = postProcessCasePatient(session.patient, session.specialty);
  const currentTime = session.currentTime || latestPatientDateTime(patient) || "";
  return {
    ok: true,
    sessionId: session.id,
    mode: session.mode,
    specialty: session.specialty,
    difficulty: session.difficulty,
    createdAt: session.createdAt,
    currentTime,
    currentDayLabel: simDayLabel(currentTime),
    patient,
    activity: ensureArray(session.activity).slice(-40),
    orderHistory: ensureArray(session.orderHistory),
    concluded: !!session.concluded
  };
}

async function saveCaseSession(session) {
  await redis.set(kCase(session.id), JSON.stringify(session), { ex: CASE_SESSION_TTL_SECONDS });
}

async function loadCaseSession(id) {
  const raw = await redis.get(kCase(id));
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const parsed = parseLooseJSON(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}

const CASE_SCHEMA_TEXT = `
Return strict JSON only with this shape:
{
  "caseTitle": "short non-diagnostic title",
  "lock": {
    "primaryDiagnosis": "hidden locked diagnosis",
    "secondaryDiagnoses": ["hidden relevant comorbid/complication diagnoses"],
    "caseFingerprint": "brief hidden fingerprint for duplicate avoidance",
    "expectedKeyActions": ["diagnostic/management actions expected"],
    "dangerousActions": ["actions that could worsen the case"],
    "exclusionEntry": "one-line case exclusion text"
  },
  "patient": {
    "id": "stable patient id",
    "displayName": "Last, First",
    "age": 55,
    "sex": "F",
    "location": "ED | ward | clinic referral",
    "allergies": ["..."],
    "codeStatus": "Full Code",
    "presentingComplaint": "non-diagnostic presenting complaint",
    "banner": "one-line chart banner without revealing diagnosis",
    "vitals": [{"datetime":"YYYY-MM-DD HH:mm","temperature_C":"37.1","hr":"92","bp":"128/76","rr":"18","spo2":"96%","oxygen":"room air","pain":"0/10","notes":""}],
    "labCategories": [{"name":"Hematology","rows":[{"test":"Hemoglobin","unit":"g/L","referenceRange":"120-160 F, 135-175 M","values":[{"datetime":"YYYY-MM-DD HH:mm","value":"132","flag":"normal"}]}]}],
    "investigations": [{"id":"unique-id","datetime":"YYYY-MM-DD HH:mm","group":"Imaging | ECG | Microbiology | Pathology | Other","title":"CXR","status":"Final","report":"objective report text"}],
    "nursingNotes": [{"datetime":"YYYY-MM-DD HH:mm","author":"RN","text":"objective note"}],
    "medications": [{"id":"unique-id","name":"Medication","dose":"","route":"","frequency":"","status":"active | discontinued","start":"YYYY-MM-DD HH:mm","stop":"","comments":""}],
    "notes": [{"id":"unique-id","datetime":"YYYY-MM-DD HH:mm","service":"Emergency Medicine | Internal Medicine | Surgery | etc","providerName":"Dr. Lastname or role","noteType":"Triage | ED note | Consult request | Progress note | Discharge summary | Procedure note","type":"same as noteType","author":"same as providerName","title":"","text":"objective chart text with realistic headings"}],
    "orders": []
  }
}
Rules for lab values: use Canadian/SI units only. Every lab value must include flag normal, high, low, or critical. Public text must not reveal the hidden diagnosis unless it would genuinely be written in the chart as a pre-existing known diagnosis.
`;

async function aiGenerateCaseSession({ mode, specialty, difficulty, exclusionText, userId }) {
  if (process.env.MOCK_AI === "1") {
    const id = uuid();
    return {
      id,
      userId,
      mode,
      specialty,
      difficulty,
      createdAt: nowIso(),
      currentTime: "2026-05-17 19:10",
      simStartTime: "2026-05-17 19:10",
      lock: {
        primaryDiagnosis: "Acute intermittent porphyria",
        secondaryDiagnoses: ["Hyponatremia"],
        caseFingerprint: "young woman abdominal pain neuropsychiatric symptoms hyponatremia porphyria",
        expectedKeyActions: ["urine porphobilinogen", "stop triggers", "hemin if severe"],
        dangerousActions: ["porphyrogenic medications"],
        exclusionEntry: "Acute intermittent porphyria presenting with abdominal pain, neuropathic symptoms, and hyponatremia."
      },
      patient: sanitizePatient({
        id: uuid(), displayName: "Dhaliwal, Harleen", age: 29, sex: "F", location: "Emergency Department", allergies: ["NKDA"], codeStatus: "Full Code", presentingComplaint: "Abdominal pain and vomiting", banner: "ED consult requested for persistent abdominal pain with electrolyte abnormality.",
        vitals: [{ datetime: "2026-05-17 18:20", temperature_C: "36.9", hr: "112", bp: "148/92", rr: "18", spo2: "99%", oxygen: "room air", pain: "8/10", notes: "Appears uncomfortable" }],
        labCategories: [
          { name: "Hematology", rows: [{ test:"WBC", unit:"10^9/L", referenceRange:"4.0-11.0", values:[{datetime:"2026-05-17 18:35", value:"9.8", flag:"normal"}] }, { test:"Hemoglobin", unit:"g/L", referenceRange:"120-160 F", values:[{datetime:"2026-05-17 18:35", value:"129", flag:"normal"}] }, { test:"Platelets", unit:"10^9/L", referenceRange:"150-400", values:[{datetime:"2026-05-17 18:35", value:"286", flag:"normal"}] }]},
          { name: "Chemistry", rows: [{ test:"Sodium", unit:"mmol/L", referenceRange:"135-145", values:[{datetime:"2026-05-17 18:35", value:"126", flag:"low"}] }, { test:"Potassium", unit:"mmol/L", referenceRange:"3.5-5.0", values:[{datetime:"2026-05-17 18:35", value:"3.8", flag:"normal"}] }, { test:"Creatinine", unit:"µmol/L", referenceRange:"45-90 F", values:[{datetime:"2026-05-17 18:35", value:"64", flag:"normal"}] }, { test:"Glucose", unit:"mmol/L", referenceRange:"3.9-7.8 random", values:[{datetime:"2026-05-17 18:35", value:"5.6", flag:"normal"}] }]}],
        investigations: [{ id: uuid(), datetime:"2026-05-17 19:10", group:"Imaging", title:"CT abdomen/pelvis with contrast", status:"Final", report:"No bowel obstruction. No appendicitis. No free air. Small physiologic pelvic free fluid. Solid organs unremarkable." }],
        nursingNotes: [{ datetime:"2026-05-17 18:25", author:"RN", text:"Patient reports diffuse abdominal pain with nausea. Vomited twice in ED. Ambulating independently." }],
        medications: [{ id: uuid(), name:"Ondansetron", dose:"4 mg", route:"IV", frequency:"once", status:"active", start:"2026-05-17 18:30", stop:"", comments:"administered" }],
        notes: [{ id: uuid(), datetime:"2026-05-17 18:15", type:"Consult request", author:"Emergency physician", title:"Internal Medicine consult request", text:"29F with severe diffuse abdominal pain and vomiting. CT abdomen negative. Sodium 126. Please assess for admission and ongoing workup." }],
        orders: []
      }),
      activity: [{ at: nowIso(), type: "system", text: "Case generated. Locked diagnosis stored server-side." }],
      orderHistory: [],
      concluded: false
    };
  }

  const system = `You are the hidden backend engine for an advanced browser-based Medical Case Simulator for Canadian medical trainees.
You must generate a single realistic patient chart for an EMR-style simulator.
Hard rules:
- Choose and lock one primary diagnosis at generation time. It goes ONLY in lock.primaryDiagnosis.
- The public patient chart must contain no hints, teaching, interpretation, suggested next steps, or diagnosis disclosure beyond realistic chart facts.
- Use Canadian/SI units only. Never use mg/dL for chemistry. Use mmol/L, µmol/L, g/L, 10^9/L, pmol/L, IU/L, kPa/mmHg only where locally realistic.
- Regular mode should reflect real-world clinical probabilities and common presentations.
- Zebra mode should be rare, atypical, confusing, and extremely challenging while still medically coherent.
- Cross-reference the exclusion list. Do not repeat or closely mimic prior cases, disease categories, fingerprints, or obvious variants.
- EMR content should feel like Meditech/Cerner: terse, objective, chronological, and incomplete in realistic ways.
- Include enough initial data to start a case, but not enough to make it obvious.
- If the requested setting says CTU consult, GIM consult, Internal Medicine consult, Medicine consult, or ED consult to Medicine, the medicine consult is still pending. Do NOT include an Internal Medicine/CTU consult note, admission note, progress note, assessment/plan, or recommendations in the initial chart. You may include ED triage, ED physician notes, referral/consult request, nursing notes, vitals, labs, and investigations.
- Do not include educational rationale in public chart fields.
${CASE_SCHEMA_TEXT}`;

  const payload = {
    requestedMode: mode,
    requestedSpecialtyOrSetting: specialty || "undifferentiated adult inpatient/ED medicine",
    requestedDifficulty: difficulty || "MSI3-R1",
    userId,
    exclusionListText: String(exclusionText || '').slice(0, 60000),
    generationTime: new Date().toISOString()
  };

  let generated = await caseAiJSON({ system, payload, model: CASE_MODEL, temperature: mode === "zebra" ? 0.8 : 0.35 });
  if (!generated.lock?.primaryDiagnosis || !generated.patient) {
    throw new Error("Case generator returned incomplete case JSON");
  }
  const id = uuid();
  const publicPatient = postProcessCasePatient(generated.patient, specialty);
  const initialTime = latestPatientDateTime(publicPatient) || formatSimDateTime(new Date());
  return {
    id,
    userId,
    mode,
    specialty,
    difficulty,
    createdAt: nowIso(),
    currentTime: initialTime,
    simStartTime: initialTime,
    lock: generated.lock,
    caseTitle: generated.caseTitle || "Medical case",
    patient: publicPatient,
    activity: [{ at: initialTime, type: "system", text: "Case generated. Locked diagnosis stored server-side." }],
    orderHistory: [],
    concluded: false
  };
}

async function aiInteractWithCase({ session, request }) {
  const system = `You are the backend engine for an EMR medical case simulator.
The hidden locked diagnosis is provided, but you must NEVER reveal it before conclusion.
Respond to the learner's request as the simulated chart/patient/exam environment.
Rules:
- No hints, no interpretation, no teaching, no suggested next steps.
- Provide only the specific information requested.
- For physical exam, return objective findings only. If the request is too broad, provide a terse focused exam only or state what cannot be assessed.
- For history questions, simulate realistic patient answers, including uncertainty if appropriate.
- For chart review, provide realistic chart text/labs only if likely available.
- Canadian/SI units only.
Return strict JSON: {"response":"text shown to user", "patient": <optional updated full public patient object or null>, "activityText":"short log text"}`;
  const payload = {
    lockedDiagnosis: session.lock,
    patient: session.patient,
    activity: ensureArray(session.activity).slice(-30),
    orderHistory: ensureArray(session.orderHistory).slice(-50),
    learnerRequest: request
  };
  return await caseAiJSON({ system, payload, model: CASE_FAST_MODEL, temperature: 0 });
}

async function aiApplyOrders({ session, newOrders }) {
  const system = `You are the hidden backend engine for a Canadian EMR medical case simulator.
Apply the learner's orders to the locked patient case and update the public EMR state.
Rules:
- The locked diagnosis must remain stable. Do not let user orders change the diagnosis, but let them alter physiology/outcomes if medically plausible.
- Do not reveal the locked diagnosis.
- No hints, no interpretation, no suggested next steps, no teaching.
- For labs ordered, add realistic values using Canadian/SI units and reference ranges.
- For imaging/ECG/micro/pathology ordered, add a realistic report only if the test could plausibly result at this time. Otherwise add/order as pending or mention pending.
- For meds/fluids/procedures, update MAR/vitals/nursing notes as appropriate. Harmful orders may worsen the case realistically.
- Order results shown to user must be administrative only: Entered, pending, completed, discontinued, unclear, not available.
Return strict JSON only: {"patient": <full updated public patient object>, "orderResults":[{"order":"","status":"entered|pending|completed|discontinued|unclear|not available","comment":"terse non-interpretive administrative comment"}], "visibleEvent":"optional nurse/lab/radiology event text"}`;
  const payload = {
    lockedDiagnosis: session.lock,
    patient: session.patient,
    priorActivity: ensureArray(session.activity).slice(-30),
    priorOrders: ensureArray(session.orderHistory).slice(-80),
    newOrders: newOrders
  };
  return await caseAiJSON({ system, payload, model: CASE_FAST_MODEL, temperature: 0 });
}

async function aiAdvanceCase({ session }) {
  const system = `You are the hidden backend engine for a Canadian EMR medical case simulator.
Advance the case to the next clinically plausible event. This may be a nurse page, new vitals, lab result, imaging result, medication effect, deterioration, stabilization, or no major change.
Rules:
- Never reveal the locked diagnosis.
- No hints, no interpretation, no suggested next steps, no teaching.
- Reflect the user's prior orders and actions.
- If the user made harmful or delayed decisions, deterioration can occur.
- If the user made effective decisions, improvement can occur.
- Canadian/SI units only.
Return strict JSON only: {"patient": <full updated public patient object>, "event":"short objective event/page text", "urgency":"routine|urgent|critical|none", "currentTime":"YYYY-MM-DD HH:mm"}`;
  const payload = {
    lockedDiagnosis: session.lock,
    currentTime: session.currentTime || latestPatientDateTime(session.patient),
    patient: session.patient,
    activity: ensureArray(session.activity).slice(-50),
    orderHistory: ensureArray(session.orderHistory).slice(-80)
  };
  return await caseAiJSON({ system, payload, model: CASE_MODEL, temperature: 0.25 });
}

async function aiConcludeCase({ session, finalNoteText, finalOrdersText }) {
  const system = `You are a strict attending physician debriefing a Canadian medical trainee after a medical case simulator.
At this point you MAY reveal the locked diagnosis.
Provide detailed, critical, educational feedback. Do not be overly permissive.
Assess diagnostic reasoning, investigations, management, safety, documentation, and missed opportunities.
Return strict JSON only:
{
  "diagnosis":"locked primary diagnosis",
  "secondaryDiagnoses":["..."],
  "caseSummary":"short case summary",
  "diagnosticFeedback":["..."],
  "managementFeedback":["..."],
  "documentationFeedback":["..."],
  "safetyIssues":["..."],
  "whatGoodLookedLike":["..."],
  "overallRating":"MSI1|MSI2|MSI3|MSI4|R1|R2|R3|R4|R5|Attending",
  "exclusionEntry":"copy-pasteable one-line exclusion list entry with diagnosis and distinctive features"
}`;
  const payload = {
    lockedDiagnosis: session.lock,
    patient: session.patient,
    activity: ensureArray(session.activity),
    orderHistory: ensureArray(session.orderHistory),
    finalNoteText: finalNoteText || "",
    finalOrdersText: finalOrdersText || ""
  };
  return await caseAiJSON({ system, payload, model: CASE_MODEL, temperature: 0 });
}

app.post('/case/sessions', async (req, res) => {
  try {
    const body = req.body || {};
    const userId = String(body.user_id || body.username || "Gurnoor").trim() || "Gurnoor";
    const modeRaw = String(body.mode || "regular").toLowerCase();
    const mode = modeRaw === "zebra" ? "zebra" : "regular";
    const specialty = String(body.specialty || "").trim();
    const difficulty = String(body.difficulty || "MSI3-R1").trim();
    const exclusionText = String(body.exclusionText || "");
    if (!Object.prototype.hasOwnProperty.call(body, 'exclusionText')) {
      return res.status(400).json({ error: "exclusionText required. Upload an exclusion list or explicitly start with an empty list." });
    }
    const session = await aiGenerateCaseSession({ mode, specialty, difficulty, exclusionText, userId });
    await saveCaseSession(session);
    res.json(publicCasePayload(session));
  } catch (e) {
    res.status(500).json({ error: "Failed to start case session", detail: String(e) });
  }
});

app.get('/case/sessions/:id', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    res.json(publicCasePayload(session));
  } catch (e) {
    res.status(500).json({ error: "Failed to load case session", detail: String(e) });
  }
});

app.get('/case/sessions/:id/lockfile', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).type('text/plain').send("Case session not found");
    const lock = session.lock || {};
    const txt = [
      `Medical Case Simulator locked diagnosis file`,
      `Session ID: ${session.id}`,
      `Created: ${session.createdAt}`,
      `Mode: ${session.mode}`,
      `Specialty/setting: ${session.specialty || 'unspecified'}`,
      ``,
      `PRIMARY DIAGNOSIS: ${lock.primaryDiagnosis || ''}`,
      `Secondary diagnoses: ${ensureArray(lock.secondaryDiagnoses).join('; ')}`,
      `Fingerprint: ${lock.caseFingerprint || ''}`,
      `Expected key actions: ${ensureArray(lock.expectedKeyActions).join('; ')}`,
      `Dangerous actions: ${ensureArray(lock.dangerousActions).join('; ')}`,
      ``,
      `Exclusion entry:`,
      lock.exclusionEntry || `${lock.primaryDiagnosis || 'Unknown diagnosis'} - ${lock.caseFingerprint || ''}`
    ].join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="case-lock-${session.id}.txt"`);
    res.send(txt);
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

app.post('/case/sessions/:id/interact', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    if (session.concluded) return res.status(400).json({ error: "Case already concluded" });
    const request = String(req.body?.request || "").trim();
    if (!request) return res.status(400).json({ error: "request required" });
    const out = await aiInteractWithCase({ session, request });
    if (out.patient) session.patient = postProcessCasePatient(out.patient, session.specialty);
    const response = String(out.response || "No information returned.");
    session.activity = ensureArray(session.activity);
    session.activity.push({ at: nowIso(), type: "learner_request", text: request });
    session.activity.push({ at: nowIso(), type: "case_response", text: response });
    await saveCaseSession(session);
    res.json({ ...publicCasePayload(session), response });
  } catch (e) {
    res.status(500).json({ error: "Interaction failed", detail: String(e) });
  }
});

app.post('/case/sessions/:id/orders', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    if (session.concluded) return res.status(400).json({ error: "Case already concluded" });
    const orders = ensureArray(req.body?.orders).map(x => String(x || '').trim()).filter(Boolean);
    if (!orders.length) return res.status(400).json({ error: "orders required" });
    session.patient = postProcessCasePatient(session.patient, session.specialty);
    const simTime = session.currentTime || latestPatientDateTime(session.patient) || formatSimDateTime(new Date());
    session.patient.orders = ensureArray(session.patient.orders);
    session.orderHistory = ensureArray(session.orderHistory);
    const results = orders.map(administrativeOrderResult);
    orders.forEach((order, i) => {
      const r = results[i];
      const orderEntry = { id: uuid(), datetime: simTime, order, status: r.status, comment: r.comment };
      session.patient.orders.push(orderEntry);
      session.orderHistory.push({ at: simTime, order, status: r.status, comment: r.comment });
      maybeAddMedicationFromOrder(session.patient, order, simTime);
    });
    session.patient.nursingNotes = ensureArray(session.patient.nursingNotes);
    session.patient.nursingNotes.push({ datetime: simTime, author: "RN", text: `Orders received and acknowledged: ${orders.join('; ')}` });
    session.activity = ensureArray(session.activity);
    session.activity.push({ at: simTime, type: "orders", text: orders.join('\n') });
    const visibleEvent = "RN: Orders acknowledged.";
    await saveCaseSession(session);
    res.json({ ...publicCasePayload(session), orderResults: results, visibleEvent });
  } catch (e) {
    res.status(500).json({ error: "Order entry failed", detail: String(e) });
  }
});

app.post('/case/sessions/:id/advance', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    if (session.concluded) return res.status(400).json({ error: "Case already concluded" });
    const priorTime = session.currentTime || latestPatientDateTime(session.patient) || formatSimDateTime(new Date());
    const out = await aiAdvanceCase({ session });
    if (out.patient) session.patient = postProcessCasePatient(out.patient, session.specialty);
    const latestTime = latestPatientDateTime(session.patient);
    const aiTime = String(out.currentTime || "").trim();
    session.currentTime = aiTime || (latestTime && latestTime > priorTime ? latestTime : addSimMinutes(priorTime, 60));
    const event = String(out.event || "No new events.");
    session.activity = ensureArray(session.activity);
    session.activity.push({ at: session.currentTime, type: "advance", text: event, urgency: String(out.urgency || "routine") });
    await saveCaseSession(session);
    res.json({ ...publicCasePayload(session), event, urgency: out.urgency || "routine" });
  } catch (e) {
    res.status(500).json({ error: "Failed to advance case", detail: String(e) });
  }
});

app.post('/case/sessions/:id/note', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    if (session.concluded) return res.status(400).json({ error: "Case already concluded" });
    const title = String(req.body?.title || "User note").trim();
    const type = String(req.body?.noteType || req.body?.type || "User note").trim();
    const service = String(req.body?.service || "Internal Medicine").trim();
    const providerName = String(req.body?.providerName || req.body?.author || "Learner").trim();
    const datetime = String(req.body?.datetime || session.currentTime || latestPatientDateTime(session.patient) || formatSimDateTime(new Date())).trim();
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "note text required" });
    session.patient = postProcessCasePatient(session.patient, session.specialty);
    session.patient.notes.push(normalizeNoteObject({ id: uuid(), datetime, service, providerName, noteType: type, type, author: providerName, title, text }));
    session.activity = ensureArray(session.activity);
    session.activity.push({ at: datetime, type: "user_note", text: `${title}
${text}` });
    await saveCaseSession(session);
    res.json(publicCasePayload(session));
  } catch (e) {
    res.status(500).json({ error: "Failed to save note", detail: String(e) });
  }
});

app.post('/case/sessions/:id/conclude', async (req, res) => {
  try {
    const session = await loadCaseSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Case session not found" });
    const finalNoteText = String(req.body?.finalNoteText || "");
    const finalOrdersText = String(req.body?.finalOrdersText || "");
    const out = await aiConcludeCase({ session, finalNoteText, finalOrdersText });
    session.concluded = true;
    session.concludedAt = nowIso();
    session.conclusion = out;
    await saveCaseSession(session);
    res.json({ ...publicCasePayload(session), conclusion: out });
  } catch (e) {
    res.status(500).json({ error: "Failed to conclude case", detail: String(e) });
  }
});

////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
