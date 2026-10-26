const PAN_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;
const TOKENIZED_CARD_REGEX = /\*[^*\n]{10,60}\*/g;

const FOREIGN_COUNTRY_CODES = new Set([
  'AE',
  'AU',
  'BE',
  'CA',
  'CH',
  'CN',
  'DE',
  'ES',
  'EU',
  'FR',
  'GB',
  'HK',
  'ID',
  'IE',
  'IN',
  'IT',
  'JP',
  'KR',
  'MT',
  'MY',
  'NL',
  'NZ',
  'QA',
  'SA',
  'SG',
  'TH',
  'TW',
  'US',
  'VN',
]);

const CITY_TOKENS = new Set([
  'ALABANG',
  'ANTIPOLO',
  'BACOLOD',
  'BAGUIO',
  'CALOOCAN',
  'CAVITE',
  'CEBU',
  'CIT',
  'CITY',
  'DAVAO',
  'ILOILO',
  'LONDON',
  'MAKATI',
  'MALABON',
  'MANDALUYONG',
  'MANILA',
  'MARIKINA',
  'MUNTINLUPA',
  'NAXXAR',
  'NAVOTAS',
  'PARANAQUE',
  'PASAY',
  'PASIG',
  'PATEROS',
  'QUEZON',
  'SINGAPORE',
  'TAGUIG',
  'VALENZUELA',
]);

const FLAG_TOKENS = new Set(['IP', 'PI', 'TM', 'POS']);

const PAYEE_PREFIX_REGEX = /^[A-Z]{2,4}\*\s*/;
const URL_REGEX = /https?:\/\/\S+/gi;
const STORE_NUMBER_REGEX = /\s#\w+\b/g;
const THANK_YOU_REGEX = /\s*-\s*THANK YOU\s*$/i;
const FLAG_SUFFIX_REGEX = /^-[A-Z]{1,4}$/;

export function maskCardNumbers(text: string): string {
  return text.replace(PAN_REGEX, match => {
    const digits = match.replace(/[\s-]/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return match;
    }
    return `****-****-****-${digits.slice(-4)}`;
  });
}

export function redactTokenizedCards(text: string): string {
  return text.replace(TOKENIZED_CARD_REGEX, '[CARD TOKEN]');
}

export function redactText(text: string): string {
  return maskCardNumbers(redactTokenizedCards(text));
}

export function cleanPayee(rawDescription: string): string {
  let payee = rawDescription.toUpperCase();

  payee = payee.replace(URL_REGEX, ' ');
  payee = payee.replace(THANK_YOU_REGEX, '');
  payee = payee.replace(PAYEE_PREFIX_REGEX, '');
  payee = payee.replace(STORE_NUMBER_REGEX, '');

  const tokens = payee.split(/\s+/).filter(Boolean);

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];

    if (FLAG_TOKENS.has(last) || FLAG_SUFFIX_REGEX.test(last)) {
      tokens.pop();
      continue;
    }

    if (FOREIGN_COUNTRY_CODES.has(last)) {
      tokens.pop();
      continue;
    }

    if (last === 'PH') {
      const prevIsFlag =
        prev != null && (FLAG_TOKENS.has(prev) || FLAG_SUFFIX_REGEX.test(prev));
      const prevIsCity = prev != null && CITY_TOKENS.has(prev);
      const isDoubled = prev === 'PH';
      if (prevIsFlag || prevIsCity || isDoubled) {
        tokens.pop();
        tokens.pop();
        continue;
      }
      break;
    }

    if (CITY_TOKENS.has(last)) {
      tokens.pop();
      continue;
    }

    break;
  }

  return tokens.join(' ').trim();
}
