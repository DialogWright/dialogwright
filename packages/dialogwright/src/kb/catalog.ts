import type { AppKnowledge, CatalogTopic, KnowledgeBase, TopicCatalog } from './types';

/**
 * The topics an app's knowledge has, as a topic slot is built with them (SlotBuildEnv.catalog): a
 * knowledge base's topics in kb/topics.yaml's order, each with its title in the default locale and in
 * every locale whose kb/locale/<tag>/topics.yaml gives one, and kb.yaml's retrieval cap; or, for an
 * app without a kb/ folder, the topics its code gives (AppKnowledge.topics), as they are.
 */
export function topicCatalog(knowledge: AppKnowledge): TopicCatalog {
  if (knowledge.kb !== undefined) return kbCatalog(knowledge.kb);
  return { topics: knowledge.topics };
}

/** A knowledge base's topics and cap (topicCatalog of a kb/ folder). */
export function kbCatalog(kb: KnowledgeBase): TopicCatalog {
  const topics = Object.values(kb.topics).map((t): CatalogTopic => {
    const titles = Object.fromEntries(Object.entries(t.locales).flatMap(([tag, w]) => (w.title !== undefined ? [[tag, w.title]] : [])));
    return { id: t.id, title: t.title, ...(Object.keys(titles).length > 0 ? { titles } : {}) };
  });
  return { topics, cap: kb.settings.retrieval.cap };
}
