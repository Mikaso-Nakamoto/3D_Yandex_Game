// Small Russian-language helpers shared by the simulation log and the UI.
// They exist because nation names are not all singular: «Пруссия предлагает»,
// but «Османы предлагают». Getting that wrong in half the offers made the game
// look machine-translated.

/** Names that take a plural verb. Detected by ending, with explicit exceptions. */
const ALWAYS_PLURAL = new Set(['США', 'СССР']);

export function isPluralName(name = '') {
  const short = String(name).trim();
  if (!short) return false;
  if (ALWAYS_PLURAL.has(short)) return true;
  // «Османы», «Нидерланды» — plural nouns end in -ы/-и in the nominative.
  // «Османы», «Нидерланды». Note that «Гаити» ends in -и but is singular
  // (a state, not a plural), so only -ы is treated as a plural ending.
  if (/ы$/u.test(short)) return true;
  // «Соединённые Штаты», «Испанские колонии» — adjective + plural noun.
  return /(ые|ие)\s+\S+(ы|и)$/u.test(short);
}

/** Picks the verb form that agrees with the nation name. */
export function verbFor(name, singular, plural) {
  return isPluralName(name) ? plural : singular;
}

/** «Пруссия предлагает» / «Османы предлагают». */
export function offersVerb(name) {
  return verbFor(name, 'предлагает', 'предлагают');
}

/** «Пруссия ведёт войска» / «Османы ведут войска». */
export function marchesVerb(name) {
  return verbFor(name, 'ведёт', 'ведут');
}

/** What exactly is being offered: «пакт о ненападении», «мир», «право прохода». */
export function offerWhat(kind = 'peace') {
  if (kind === 'pact') return 'пакт о ненападении';
  if (kind === 'passage') return 'право прохода';
  return 'мир';
}

/** «Пруссия просит право прохода» / «Османы просят право прохода». */
export function asksVerb(name) {
  return verbFor(name, 'просит', 'просят');
}

/** Full sentence for the event log. */
export function offerSentence(name, kind = 'peace') {
  if (kind === 'passage') return `${name} ${asksVerb(name)} право прохода`;
  return `${name} ${offersVerb(name)} ${offerWhat(kind)}`;
}

/** Title of the offer card: no verb agreement problems, same wording. */
export function offerTitle(name, kind = 'peace') {
  if (kind === 'passage') return `${name} ${asksVerb(name)} право прохода`;
  return `${name} ${offersVerb(name)} ${offerWhat(kind)}`;
}

/**
 * Russian plural forms: 1 провинция, 2 провинции, 5 провинций.
 * `one`/`few`/`many` are complete words, e.g. plural(n, 'провинция', 'провинции', 'провинций').
 */
export function plural(n, one, few, many) {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} ${many}`;
  if (last === 1) return `${n} ${one}`;
  if (last >= 2 && last <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Shorthand used in cards: «3 провинции», «5 держав». */
export const provincesCount = (n) => plural(n, 'провинция', 'провинции', 'провинций');
export const nationsCount = (n) => plural(n, 'держава', 'державы', 'держав');
