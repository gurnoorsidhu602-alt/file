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

////////////////////////////////////////////////////////////////////////////////
// CONFIG & INIT
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

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
app.post('/med/high-yield-im', async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "").trim();
    const want = Math.max(1, Math.min(10, Number(req.body?.n || 1)));

    // Exclude user's completed topics
    let exclude = new Set();
    if (user_id) {
      const rows = medDb.prepare(
        `SELECT topic FROM completed_topics WHERE user_id = ?`
      ).all(user_id);
      exclude = new Set(rows.map(r => r.topic));
    }

    // Collect IM candidates
    const candidates = collectIMCandidates(exclude);
    if (!candidates.length) {
      return res.status(404).json({ error: "no eligible internal medicine topics" });
    }

    // Keep token usage sane
    const limited = candidates.slice(0, 200);

    const system = `You are a seasoned Internal Medicine attending.
Rank topics by "high-yield" value for med learners (exam relevance, admissions frequency, emergency impact, bread-and-butter).
Return STRICT JSON:
{"ranked":[{"topic":"","discipline":"","sub":"","reason":"","score":0}]}
- Use only the provided candidates.
- "score" is 1–10 (10 = most high-yield).
- Provide a short "reason".
- Do not invent topics.`;

    const userPayload = { candidates: limited, want };

    let ranked = null;
    try {
      const resp = await openai.responses.create({
        model: "gpt-4.1-mini",
        temperature: 0,
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(userPayload) }
        ]
      });
      const parsed = parseResponsesJSON(resp);
      if (parsed && Array.isArray(parsed.ranked)) {
        // Validate against our candidate pool
        const byTopic = new Map(limited.map(x => [x.topic, x]));
        ranked = parsed.ranked
          .map(r => {
            const match = byTopic.get(String(r.topic || ""));
            if (!match) return null;
            return {
              topic: match.topic,
              discipline: match.discipline,
              sub: match.sub,
              reason: String(r.reason || ""),
              score: Number.isFinite(Number(r.score)) ? Number(r.score) : 0
            };
          })
          .filter(Boolean)
          .slice(0, want);
      }
    } catch (e) {
      // fall through to fallback
    }

    if (!ranked || ranked.length === 0) {
      // Fallback: random (rare; only if AI fails)
      const shuffled = limited.sort(() => Math.random() - 0.5).slice(0, want);
      ranked = shuffled.map(x => ({ ...x, reason: "fallback: random", score: 5 }));
    }

    res.json({ ok: true, pick: ranked[0], ranked });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Learn-plan helpers (place under HARDCODED_TOC) ---

// If you already added this earlier for high-yield, keep one copy only.
const INTERNAL_MED_DISC_SET = new Set([
  "Cardiology","Endocrinology","Gastroenterology","Hematology",
  "Infectious Disease","Nephrology","Neurology","Respirology","Rheumatology"
]);

// Simple FTS search into your indexed notes (if any) to provide context to the AI.
// It’s OK if you haven’t indexed anything yet; the endpoint will still work.
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

// One function to ask OpenAI for the entire learn plan.
// Returns {guidelines:[], trials:[], objectives:[]}
async function buildLearnPlanAI(topic, noteSnippets = []) {
  const system = `
You are an evidence-based Internal Medicine educator.
Build a LEARNING PLAN for the requested topic. Be comprehensive but concise.

You MUST return STRICT JSON with this schema (no prose outside JSON):
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
      ]
    }
  ]
}

RULES
- Prefer CANADIAN society guidance first (e.g., CCS/CTS/CMAJ/etc.); if none, provide USA (ACC/AHA/ACP/IDSA/etc.), then International.
- "link" may be empty if unsure (front end will add search links).
- Trials must be landmark/seminal (include negative trials if influential).
- Objectives should be extensive and cover pathophys, dx, risk stratification, mgmt, complications, follow-up.
- Under each objective, list relevant resources: reference trials/guidelines by exact title or name in your own output arrays.
- If you see ambiguous subtopics, include them in objectives anyway.
- Keep JSON valid. Do not include markdown or commentary.`;

  const userPayload = {
    topic,
    note_snippets: noteSnippets, // optional context from user notes
    prefer_regions: ["Canada","USA","International"],
    want_objectives: "extensive",
    max_guidelines: 10,
    max_trials: 12
  };

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    temperature: 0,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const parsed = parseResponsesJSON(resp);
  if (!parsed || !Array.isArray(parsed.guidelines) || !Array.isArray(parsed.trials) || !Array.isArray(parsed.objectives)) {
    // Fail gracefully with empty arrays
    return { guidelines: [], trials: [], objectives: [] };
  }
  return parsed;
}


// ------------------------------ ADMIN NUKE (kept) ---------------------------
app.delete('/admin/wipe', async (req, res) => {
  try {
    const secret = String(req.query.secret || "");
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }
    const dry = String(req.query.dry || "0") === "1";

    const patterns = ["user:*","session:*","sessionitem:*","exclusions:*","history:*"];
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

async function pushSessionItem(sessionId, item) { await redis.rpush(kSessItems(sessionId), item); }

async function updateLastSessionItem(sessionId, patch) {
  const len = await redis.llen(kSessItems(sessionId));
  if (len === 0) return;

  const raw = await redis.lindex(kSessItems(sessionId), len - 1);
  let last = null;

  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { last = JSON.parse(t); } catch {} }
  } else if (raw && typeof raw === "object" && !Array.isArray(r)) { last = raw; }

  if (!last) return;

  const updated = { ...last, ...patch };
  await redis.lset(kSessItems(sessionId), len - 1, updated);
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
Ensure the difficulty scales with MSI1→Attending. Avoid duplicates of provided examples.`;

  const userPayload = { topic: topic || "random", difficulty: difficulty || "MSI3", avoid_examples: avoid };

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    input: [
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
      "First-line treatment for status asthmaticus?": "nebulized saba and ipratropium",
      "Antidote for organophosphate poisoning?": "atropine and pralidoxime",
      "Next step for suspected PE in a hemodynamically stable patient?": "ctpa",
      "Diagnostic test of choice for C. difficile infection?": "stool pcr",
      "Target INR for mechanical mitral valve?": "3.0"
    };
    const gold = (golds[question] || "").toLowerCase().trim();
    const ans  = String(userAnswer || "").toLowerCase().trim();
    const is_correct = gold && (ans === gold || gold.includes(ans) || ans.includes(gold));
    return { is_correct, explanation: is_correct ? "" : (gold ? `Correct: ${gold}.` : "Reviewed."), difficulty_delta: is_correct ? 1 : 0 };
  }

  const system = `Grade medical answers tersely.
Return ONLY JSON:
{"is_correct": true|false, "explanation": "1-3 sentences if incorrect else empty", "difficulty_delta": -1|0|1}`;

  const userPayload = { question, userAnswer, difficulty };

  let parsed = null;
  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    });
    parsed = parseResponsesJSON(resp);
  } catch (e) {
    return { is_correct: false, explanation: "Grader unavailable; keeping same difficulty.", difficulty_delta: 0 };
  }

  if (!parsed || (parsed.is_correct === undefined && parsed.explanation === undefined)) {
    return { is_correct: false, explanation: "Grader returned unexpected format.", difficulty_delta: 0 };
  }

  const is_correct = !!parsed.is_correct;
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
  let delta = Number(parsed.difficulty_delta);
  if (![ -1, 0, 1 ].includes(delta)) delta = is_correct ? 1 : 0;

  return { is_correct, explanation, difficulty_delta: delta };
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
      explanation: t.explanation ?? ""
    }))
  };

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    temperature: 0,
    input: [
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

    const { is_correct, explanation, difficulty_delta } = await aiGradeAnswer({
      question: last.question,
      userAnswer: answer,
      difficulty: last.final_difficulty
    });

    const nextDiff = bumpDifficulty(last.final_difficulty, difficulty_delta);

    const { correct, wrong } = pointsFor(last.final_difficulty);
    const points_delta = is_correct ? correct : -wrong;

    const score_after = await applyScoreDelta(username, points_delta, is_correct);

    const askedAt = Date.now();

    await pushHistory(username, {
      question: last.question,
      difficulty: last.final_difficulty,
      user_answer: answer,
      is_correct,
      explanation,
      points_delta,
      score_after,
      asked_at: askedAt,
    });

    await updateLastSessionItem(sessionId, {
      user_answer: answer,
      is_correct,
      explanation,
      final_difficulty: nextDiff,
      points_delta,
      score_after
    });

    res.json({ correct: is_correct, explanation, nextDifficulty: nextDiff, points_delta, score: score_after });
  } catch (e) {
    res.status(500).json({ error: "Failed to grade answer", detail: String(e) });
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
app.post('/med/learn-plan', async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "topic required" });

    // Optional: pull a few note snippets to ground the AI (works even if no PDFs indexed)
    const snippets = searchNoteSnippets(topic, 8);
    const plan = await buildLearnPlanAI(topic, snippets);

    // Sort guidelines Canada -> USA -> International
    const order = { Canada: 0, USA: 1, International: 2 };
    plan.guidelines.sort((a,b) => (order[a.region] ?? 99) - (order[b.region] ?? 99) || (b.year||0) - (a.year||0));

    res.json({ ok: true, topic, ...plan, snippets_count: snippets.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// (Handy) GET wrapper to test in browser: /med/learn-plan?topic=Acute%20Coronary%20Syndrome
app.get('/med/learn-plan', async (req, res) => {
  try {
    const topic = String(req.query?.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "topic required" });
    const snippets = searchNoteSnippets(topic, 8);
    const plan = await buildLearnPlanAI(topic, snippets);
    const order = { Canada: 0, USA: 1, International: 2 };
    plan.guidelines.sort((a,b) => (order[a.region] ?? 99) - (order[b.region] ?? 99) || (b.year||0) - (a.year||0));
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

////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
