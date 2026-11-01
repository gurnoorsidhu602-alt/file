// lib/toc.js — Med Learner topic hierarchy: { [discipline]: { [subdiscipline]: [topics] } }

export const HARDCODED_TOC = {
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
