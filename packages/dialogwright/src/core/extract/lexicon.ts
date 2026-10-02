/**
 * The words of a language that the engine reads values out of: how a caller's words are split into
 * tokens and compared, the words numbers are said with, the words that are never part of a name,
 * and the month names a number said after one belongs to. One lexicon per language; a locale's is
 * its language's (`es-MX` reads as `es`), and every other locale, and no locale at all, reads as
 * English, whose lexicon is the tables the engine has always used, unchanged. So an app without
 * locales, and an en-US session, read every word exactly as before.
 *
 * A lexicon keeps a token as the caller said it (accents and all, so a span offered to the model
 * and a name said back keep them) and compares it folded (`fold`): Spanish compares without accents,
 * so "dieciséis" and "dieciseis" are one number word, and "sí" one filler.
 */
export interface Lexicon {
  /** The language subtag the lexicon is for: `en`, `es`. */
  readonly language: string;
  /** The caller's words as tokens, in lower case, punctuation dropped. */
  tokenize(text: string): string[];
  /** A token as the tables hold it: Spanish without accents, English as it is. */
  fold(token: string): string;
  /** Digits said one word each ("five", "cinco"). */
  readonly units: Readonly<Record<string, number>>;
  /** Numbers said as one word that never take a unit after them ("twelve", "dieciséis", "veinticinco"). */
  readonly teens: Readonly<Record<string, number>>;
  /** Tens, which a unit after them adds into ("forty four", "cuarenta y cuatro"). */
  readonly tens: Readonly<Record<string, number>>;
  /** Hundreds said as one word ("doscientos"), which open a group a smaller number adds into. English has none. */
  readonly hundreds: Readonly<Record<string, number>>;
  /** Words that repeat the next digit ("double four"). Spanish has none. */
  readonly repeats: Readonly<Record<string, number>>;
  /** Words that scale the group said before them ("three hundred", "dos mil"). */
  readonly multipliers: Readonly<Record<string, number>>;
  /** The word that joins parts of one number ("and", "y"). */
  readonly joiner: string;
  /** Whether the joiner joins a ten to the unit after it ("cincuenta y cinco" is 55); English "and" only follows a multiplier. */
  readonly joinsTens: boolean;
  /** Whether a multiplier said first stands for one of it and keeps its group open ("mil novecientos" is 1900); English "thousand" alone is a group of its own. */
  readonly bareMultiplierOpens: boolean;
  /** Every number word, folded. */
  readonly numberWords: ReadonlySet<string>;
  /** Number words that never make a span a number span on their own ("hundred", "un"), folded. */
  readonly weakWords: ReadonlySet<string>;
  /** Words that never begin or end a name span, folded. */
  readonly fillers: ReadonlySet<string>;
  /** Words a name may hold between two of its words ("de la" in "Muñoz de la Cruz"), folded. English has none. */
  readonly nameParticles: ReadonlySet<string>;
  /** The month names, folded, January first. */
  readonly months: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// English: the tables the engine has always read numbers and names with.
// ---------------------------------------------------------------------------------------------

const EN_UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const EN_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_REPEATS: Record<string, number> = { double: 2, triple: 3 };
const EN_MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000 };

/**
 * tokenize() strips apostrophes, so a contraction arrives split into fragments: "it's" as "it s",
 * "I'm" as "i m", "I'd" as "i d", "don't" as "don t", "we're" as "we re", "I'll" as "i ll", "I've"
 * as "i ve". The fragments themselves (not the un-tokenizable "it's"/"i'm" spellings) are what
 * need listing here.
 */
const EN_FILLERS = [
  'my', 'name', 'is', 'its', 'this', 'the', 'a', 'an', 'and', 'um', 'uh', 'i', 'im',
  'for', 'with', 'to', 'of', 'please', 'hi', 'hello', 'hey', 'yes', 'no', 'calling', 'speaking', 'here',
  's', 'm', 'it', 'd', 't', 're', 'll', 've',
];

const EN_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const keysOf = (...tables: Readonly<Record<string, number>>[]): string[] => tables.flatMap((t) => Object.keys(t));

export const ENGLISH: Lexicon = Object.freeze({
  language: 'en',
  tokenize: (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  fold: (token: string): string => token,
  units: EN_UNITS,
  teens: EN_TEENS,
  tens: EN_TENS,
  hundreds: {},
  repeats: EN_REPEATS,
  multipliers: EN_MULTIPLIERS,
  joiner: 'and',
  joinsTens: false,
  bareMultiplierOpens: false,
  numberWords: new Set(keysOf(EN_UNITS, EN_TEENS, EN_TENS, EN_REPEATS, EN_MULTIPLIERS)),
  weakWords: new Set(Object.keys(EN_MULTIPLIERS)),
  fillers: new Set(EN_FILLERS),
  nameParticles: new Set<string>(),
  months: EN_MONTHS,
});

// ---------------------------------------------------------------------------------------------
// Spanish
// ---------------------------------------------------------------------------------------------

/** A Spanish token without its accents ("dieciséis" is "dieciseis", "sí" is "si"; "ñ" compares as "n"). */
export const foldAccents = (token: string): string => token.normalize('NFD').replace(/\p{M}/gu, '');

/** A table with no prototype, so a token such as "constructor" is never mistaken for one of its words. */
const table = (entries: Record<string, number>): Record<string, number> => Object.freeze(Object.assign(Object.create(null) as Record<string, number>, entries));

const ES_UNITS: Record<string, number> = table({
  cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
});
/** Ten to nineteen and twenty-one to twenty-nine: each one word, which no unit adds into. */
const ES_TEENS: Record<string, number> = table({
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
});
const ES_TENS: Record<string, number> = table({
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
});
const ES_HUNDREDS: Record<string, number> = table({
  cien: 100, ciento: 100,
  doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
});
const ES_MULTIPLIERS: Record<string, number> = table({ mil: 1000 });

/**
 * Words a Spanish caller says around a name: greetings, "me llamo", "soy", "mi nombre es", yes and
 * no, courtesies and hesitations, articles and prepositions. Folded.
 */
const ES_FILLERS = [
  'me', 'llamo', 'llama', 'soy', 'mi', 'nombre', 'es', 'hola', 'si', 'no', 'por', 'favor', 'gracias',
  'buenos', 'buenas', 'dias', 'tardes', 'noches', 'eh', 'em', 'este', 'pues', 'bueno', 'ah', 'um', 'uh', 'mm',
  'yo', 'se', 'habla', 'hablo', 'aqui', 'con', 'para', 'a', 'al', 'el', 'la', 'los', 'las', 'lo', 'le', 'de', 'del',
  'y', 'e', 'o', 'u', 'que', 'su', 'sus', 'tu', 'mire', 'oiga', 'senor', 'senora', 'senorita', 'apellido', 'llamaba',
];
/** Words a Spanish name holds between two of its words: "Muñoz de la Cruz", "Ortega y Gasset". Folded. */
const ES_NAME_PARTICLES = ['de', 'del', 'la', 'las', 'los', 'y', 'e'];

const ES_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export const SPANISH: Lexicon = Object.freeze({
  language: 'es',
  // Unicode letters kept with their accents (composed first, so a decomposed "í" is one letter);
  // anything that is not a letter or an ASCII digit separates words.
  tokenize: (text: string): string[] => text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}0-9\s]/gu, ' ').split(/\s+/).filter(Boolean),
  fold: foldAccents,
  units: ES_UNITS,
  teens: ES_TEENS,
  tens: ES_TENS,
  hundreds: ES_HUNDREDS,
  repeats: table({}),
  multipliers: ES_MULTIPLIERS,
  joiner: 'y',
  joinsTens: true,
  bareMultiplierOpens: true,
  numberWords: new Set(keysOf(ES_UNITS, ES_TEENS, ES_TENS, ES_HUNDREDS, ES_MULTIPLIERS)),
  // "cien por ciento seguro" and "un momento" are not numbers said.
  weakWords: new Set(['mil', 'cien', 'ciento', 'un', 'una']),
  fillers: new Set(ES_FILLERS),
  nameParticles: new Set(ES_NAME_PARTICLES),
  months: ES_MONTHS,
});

/** Whether a locale is Spanish: `es`, or any tag in the language (`es-US`, `es-MX`). */
export const isSpanish = (locale: string | undefined): boolean => locale !== undefined && /^es(?:[-_]|$)/i.test(locale.trim());

/** The lexicon a locale reads words with: Spanish for `es` and `es-*`, English for every other locale and for none. */
export function lexiconOf(locale?: string): Lexicon {
  return isSpanish(locale) ? SPANISH : ENGLISH;
}

/** Whether `token` is one of the lexicon's number words. */
export const isNumberWord = (lex: Lexicon, token: string): boolean => lex.numberWords.has(lex.fold(token));
