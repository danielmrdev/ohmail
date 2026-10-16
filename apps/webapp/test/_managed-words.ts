/**
 * The words that belong to the MANAGED service and to no self-hosted server: its billing, credits, subscription,
 * payment processor, trial and renewal, and its operator's address. A self-hosted server has none of them, so a
 * sentence carrying one on a self-host render is a claim about somebody else's deployment. One list, read by the
 * catalogue census and by the rendered checks, in both languages.
 */
const EN =
  /\b(?:bill(?:s|ed|ing)?|credits?|subscri(?:be|bed|bes|bing|ption|ptions)|stripe|payments?|processor|trials?|renew(?:s|ed|al|als)?|invoices?|refund(?:s|ed)?|checkout|paid|plans?|ai budget|trafficflow)\b|ohmail\.app|support@/gi;
const DE =
  /\b(?:abrechnung\w*|guthaben\w*|abo|abos|abonn\w*|stripe|zahlung\w*|testphase\w*|tarif\w*|verlänger\w*|rechnung(?:en)?|erstatt\w*|bezahlt\w*|ki-budget\w*|trafficflow)\b|ohmail\.app|support@/gi;

/** Every managed-only word in `text`, lower-cased, in order; empty when the sentence names none. */
export function managedWordsIn(text: string): string[] {
  const found = [...text.matchAll(EN), ...text.matchAll(DE)].map((m) => m[0].toLowerCase());
  return [...new Set(found)];
}
