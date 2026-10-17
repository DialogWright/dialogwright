import type { TopicCatalog } from '../../kb/types';
import { wordingFor } from '../parts/locale';
import { sectionKeysOf } from './questions';

/**
 * How a topic slot's value is said: the topic's title in lower case ("opening hours"), in the
 * session's locale when the app's knowledge gives that locale a title (else the default title), and
 * the value itself, in lower case, for a topic the knowledge does not have. The fill, the
 * disambiguation candidates and the spec's `display` all use this one function, built with the app's
 * topics (SlotBuildEnv.catalog).
 */
export function topicDisplay(catalog: TopicCatalog | undefined): (value: string, locale?: string) => string {
  const byId = new Map((catalog?.topics ?? []).map((t) => [t.id, t]));
  return (value, locale) => {
    // An answer from sections (kb.yaml documents) is said by its first section's heading.
    const keys = sectionKeysOf(value);
    if (keys !== null) return (keys[0]?.slice(keys[0].indexOf('#') + 1).replace(/^[\d.]+\s+/, '') ?? 'your question').toLowerCase();
    const topic = byId.get(value);
    const title = topic === undefined ? undefined : (wordingFor(topic.titles, locale) ?? topic.title);
    return (title ?? value).toLowerCase();
  };
}
