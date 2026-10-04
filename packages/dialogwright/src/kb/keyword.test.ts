import { describe, expect, it } from 'vitest';
import { en, GOLDEN, libraryKb, paraphraseLines, shown, TODAY } from './__fixtures__/library';
import { KeywordRetriever } from './keyword';
import { roundScore } from './score';
import { indexTexts, termsOf, topicWordsFor, wordingLocaleOf, wordsOf } from './words';

/**
 * Keyword retrieval over the library knowledge base (./__fixtures__/kb): how a topic's words are
 * read in a locale and compared, BM25 with phrase keywords, and the golden of its nominations for
 * every line of the paraphrase set (./__fixtures__/paraphrases.yaml, ./__fixtures__/nominations.golden.json).
 */

describe('a topic\'s words, as retrieval reads them', () => {
  it('reads a topic in the caller\'s locale when it has wording there (by tag, then language), else in the default', () => {
    const k = libraryKb();
    const hours = k.topics.opening_hours!;
    expect(['en-US', 'en-GB', 'es', 'es-MX', 'ES-us', 'fr'].map((l) => wordingLocaleOf(hours, 'en-US', l))).toEqual(['en-US', 'en-US', 'es', 'es', 'es', 'en-US']);
    expect(wordingLocaleOf(k.topics.card_renewal!, 'en-US', 'es')).toBe('en-US');
    expect(topicWordsFor(k.topics.late_fees!, 'en-US', 'es-MX')).toEqual({ topic: 'late_fees', locale: 'es', title: 'Multas por retraso', keywords: ['multa', 'retraso'], asks: [] });
  });

  it('compares words with accents and common suffixes folded, without the locale\'s stopwords', () => {
    expect(wordsOf('Opening hours, renewed CARDS!', 'en-US')).toEqual(['open', 'hour', 'renew', 'card']);
    expect(wordsOf('¿A qué hora abren? Multas', 'es')).toEqual(['a', 'que', 'hora', 'abren', 'multa']);
    expect(termsOf('Hi, when are you open on Sunday?', 'en-US')).toEqual(['open', 'sunday']);
    expect(termsOf('Hola, ¿cuándo abren los sábados?', 'es')).toEqual(['abren', 'sabado']);
  });

  it('lists every text the index embeds, in a fixed order: titles, keywords and example questions, per locale; not the answers', () => {
    const texts = indexTexts(libraryKb());
    expect(texts).toHaveLength(25);
    expect(texts.slice(0, 3).map((t) => `${t.topic} ${t.locale} ${t.field} ${t.text}`)).toEqual(['card_renewal en-US title Renewing a library card', expect.stringMatching(/^card_renewal en-US keyword /), expect.stringMatching(/^card_renewal en-US keyword /)]);
    expect(texts.filter((t) => t.locale === 'es').map((t) => `${t.topic} ${t.field} ${t.text}`).sort()).toEqual([
      'late_fees keyword multa', 'late_fees keyword retraso', 'late_fees title Multas por retraso',
      'opening_hours ask ¿A qué hora abren?', 'opening_hours keyword abierto', 'opening_hours keyword cerrado', 'opening_hours keyword horario', 'opening_hours title Horario',
    ]);
    const answers = Object.values(libraryKb().passages).map((p) => p.answer);
    expect(texts.some((t) => answers.includes(t.text))).toBe(false);
  });
});

describe('keyword retrieval (BM25 with exact-phrase keywords)', () => {
  const keyword = new KeywordRetriever(libraryKb());

  it('nominates the topics whose words the caller says, best first, with BM25 scores rounded to a millionth', () => {
    expect(shown(keyword.nominate(en('When are you open on Sunday?')))).toEqual(['opening_hours 3.742314 keyword']);
    expect(keyword.nominate(en('my card expired, and is there a late fee?')).map((n) => n.topic)).toEqual(['late_fees', 'card_renewal']);
    for (const n of keyword.nominate(en('my card expired, and is there a late fee?'))) expect(n.score).toBe(roundScore(n.score));
  });

  it('adds a boost for each keyword said whole, as a phrase', () => {
    const phrase = keyword.scores('the late fee', 'en-US')[0]!;
    const apart = keyword.scores('the fee was late', 'en-US')[0]!;
    expect(phrase.topic).toBe('late_fees');
    expect(apart.topic).toBe('late_fees');
    expect(roundScore(phrase.score - apart.score)).toBe(2);
  });

  it('nominates nothing for words that name no topic, or only stopwords', () => {
    expect(keyword.nominate(en('My name is Ann Lee.'))).toEqual([]);
    expect(keyword.nominate(en('yes please, thank you'))).toEqual([]);
    expect(keyword.nominate(en(''))).toEqual([]);
  });

  it('reads a topic in the caller\'s locale, and caps what it nominates', () => {
    expect(keyword.nominate({ text: '¿Tienen multas por retraso?', locale: 'es-US', todayIso: TODAY }).map((n) => [n.topic, n.title])).toEqual([['late_fees', 'Late fees']]);
    expect(keyword.nominate({ text: '¿Cuál es el horario?', locale: 'es', todayIso: TODAY }).map((n) => n.topic)).toEqual(['opening_hours']);
    expect(new KeywordRetriever(libraryKb(), { cap: 1 }).nominate(en('my card expired, and is there a late fee?'))).toHaveLength(1);
  });

  it('is a golden for the paraphrase set', () => {
    const got = Object.fromEntries(paraphraseLines().map((t) => [t, shown(keyword.nominate(en(t)))]));
    expect(got).toEqual(GOLDEN.keyword);
  });
});
