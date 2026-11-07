/* Chapters follow the IM textbook's numbering (/textbook). Article files push
   into SEHAT.articles; within a chapter, articles show in the order pushed.
   Set draft:false once the articles have had clinician + native-speaker review. */
window.SEHAT = {
  draft: true,
  specialties: [
    { id: 'cardiology', n: 1, pa: 'ਦਿਲ ਦੇ ਰੋਗ', en: 'Cardiology' },
    { id: 'respirology', n: 2, pa: 'ਫੇਫੜੇ ਅਤੇ ਸਾਹ', en: 'Respirology' },
    { id: 'nephrology', n: 3, pa: 'ਗੁਰਦੇ', en: 'Nephrology' },
    { id: 'infectious', n: 4, pa: 'ਲਾਗ ਦੇ ਰੋਗ', en: 'Infectious Diseases' },
    { id: 'endocrinology', n: 5, pa: 'ਸ਼ੂਗਰ ਅਤੇ ਗਿਲਟੀਆਂ (ਹਾਰਮੋਨ)', en: 'Endocrinology' },
    { id: 'gastroenterology', n: 6, pa: 'ਮਿਹਦਾ ਅਤੇ ਆਂਦਰਾਂ', en: 'Gastroenterology' },
    { id: 'hepatology', n: 7, pa: 'ਜਿਗਰ, ਪਿੱਤਾ ਅਤੇ ਪੈਨਕ੍ਰੀਆਜ਼', en: 'Hepatology and Pancreatobiliary' },
    { id: 'hematology', n: 8, pa: 'ਲਹੂ', en: 'Hematology' },
    { id: 'oncology', n: 9, pa: 'ਕੈਂਸਰ', en: 'Oncology' },
    { id: 'neurology', n: 10, pa: 'ਦਿਮਾਗ਼ ਅਤੇ ਨਸਾਂ', en: 'Neurology' },
    { id: 'rheumatology', n: 11, pa: 'ਜੋੜ, ਪੱਠੇ ਅਤੇ ਹੱਡੀਆਂ', en: 'Rheumatology' },
    { id: 'geriatrics', n: 12, pa: 'ਵੱਡੀ ਉਮਰ ਦੀ ਸਿਹਤ', en: 'Geriatric Medicine' },
    { id: 'addiction', n: 13, pa: 'ਨਸ਼ੇ ਅਤੇ ਜ਼ਹਿਰ', en: 'Addiction Medicine and Toxicology' },
    { id: 'allergy', n: 14, pa: 'ਐਲਰਜੀ ਅਤੇ ਦਵਾਈਆਂ ਦੇ ਗੰਭੀਰ ਅਸਰ', en: 'Allergy and Severe Drug Reactions' },
    { id: 'vascular', n: 15, pa: 'ਨਾੜਾਂ ਦੇ ਰੋਗ', en: 'Vascular Medicine' },
    { id: 'nutrition', n: 16, pa: 'ਖ਼ੁਰਾਕ ਅਤੇ ਭਾਰ', en: 'Nutrition and Metabolic Medicine' },
    { id: 'medications', n: 17, pa: 'ਦਵਾਈਆਂ ਦੀ ਸੁਰੱਖਿਆ', en: 'Medication-Related Problems' },
    { id: 'post-icu', n: 18, pa: 'ਆਈ.ਸੀ.ਯੂ. ਤੋਂ ਬਾਅਦ', en: 'After the ICU' },
  ],
  articles: [],
};
