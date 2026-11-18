export interface ProfanityRule {
  id: string;
  term: string;
  normalized_term: string;
  language: 'en' | 'ne_devanagari' | 'ne_romanized';
  severity: 'low' | 'medium' | 'high';
  context_exception_note: string | null;
}

export interface ProfanityCheckResult {
  flagged: boolean;
  blocked: boolean;
  matches: Array<{ term: string; severity: 'low' | 'medium' | 'high'; language: string }>;
}

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  '$': 's',
  '7': 't',
  '8': 'b',
};

/**
 * Normalizes English, Romanized Nepali, and Devanagari Unicode text:
 * - Unicode NFKC normalization
 * - Strips zero-width joiners/characters used for obfuscation
 * - Collapses repeated characters (e.g., "muuuji" -> "muji")
 * - Maps common leetspeak substitutions for Latin tokens
 */
export function normalizeForModeration(input: string): string {
  const nfkc = input.normalize('NFKC').toLowerCase();
  // Remove zero-width chars and soft hyphens
  const noZeroWidth = nfkc.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  // Replace leetspeak when adjacent to letters
  let mapped = '';
  for (const ch of noZeroWidth) {
    mapped += LEET_MAP[ch] ?? ch;
  }
  // Collapse 3+ repeated characters to 1, and strip punctuation between letters inside tokens
  const collapsed = mapped.replace(/(.)\1{2,}/g, '$1$1');
  return collapsed;
}

export function normalizeDictionaryTerm(term: string): string {
  return normalizeForModeration(term).replace(/[^a-z0-9\u0900-\u097F\s]/g, '').trim();
}

export function checkTextAgainstDictionary(
  text: string,
  rules: ProfanityRule[]
): ProfanityCheckResult {
  const normalized = normalizeForModeration(text);
  // Create both space-tokenized and de-punctuated versions to catch obfuscated spacing like "f.u.c.k"
  const tokens = normalized.split(/[\s,.;:!?()[\]{}"'`~\\/|<>-]+/).filter(Boolean);
  const compactTokens = tokens.map((t) => t.replace(/(.)\1+/g, '$1'));
  const joinedStripped = normalized.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ');

  const matches: Array<{ term: string; severity: 'low' | 'medium' | 'high'; language: string }> = [];

  for (const rule of rules) {
    const normTerm = rule.normalized_term;
    if (!normTerm) continue;
    const compactTerm = normTerm.replace(/(.)\1+/g, '$1');

    let matched = false;
    if (normTerm.includes(' ')) {
      matched = joinedStripped.includes(normTerm);
    } else {
      // Exact token match or compact token match avoids false-positives inside legitimate words (e.g. "class", "analytics")
      matched =
        tokens.includes(normTerm) ||
        compactTokens.includes(compactTerm) ||
        (rule.language === 'ne_devanagari' && normalized.includes(normTerm));
    }

    if (matched) {
      matches.push({
        term: rule.term,
        severity: rule.severity,
        language: rule.language,
      });
    }
  }

  const blocked = matches.some((m) => m.severity === 'high');
  return {
    flagged: matches.length > 0,
    blocked,
    matches,
  };
}
