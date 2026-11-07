/* Site config and subspecialty list. Article files push into SEHAT.articles.
   Set draft:false once the articles have had clinician + native-speaker review. */
window.SEHAT = {
  draft: true,
  specialties: [
    { id: 'cardiology', pa: 'ਦਿਲ ਦੇ ਰੋਗ', en: 'Cardiology' },
    { id: 'endocrinology', pa: 'ਸ਼ੂਗਰ ਅਤੇ ਗਿਲਟੀਆਂ (ਹਾਰਮੋਨ)', en: 'Endocrinology' },
    { id: 'respirology', pa: 'ਫੇਫੜੇ ਅਤੇ ਸਾਹ', en: 'Respirology' },
    { id: 'nephrology', pa: 'ਗੁਰਦੇ', en: 'Nephrology' },
    { id: 'neurology', pa: 'ਦਿਮਾਗ਼ ਅਤੇ ਨਸਾਂ', en: 'Neurology' },
    { id: 'gastroenterology', pa: 'ਮਿਹਦਾ, ਆਂਦਰਾਂ ਅਤੇ ਜਿਗਰ', en: 'Gastroenterology & Hepatology' },
    { id: 'musculoskeletal', pa: 'ਜੋੜ ਅਤੇ ਹੱਡੀਆਂ', en: 'Rheumatology & Musculoskeletal' },
    { id: 'hematology', pa: 'ਲਹੂ', en: 'Hematology' },
  ],
  articles: [],
};
