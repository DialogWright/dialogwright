/**
 * The decision model's question of which topic a caller asks about, in its default words: the scripted `topic`
 * slot's (slots/topic/options.ts, where an app may word its own) and agent mode's lookup (converse/knowledge.ts),
 * which asks it of the topics retrieval nominated for the caller's question. One question, so the two read a
 * question the same way.
 */

/** The question's instructions, where it tells a question none of the topics answers (`unanswered`) from a turn that asks nothing (`none`). */
export const TOPIC_UNANSWERED_INSTRUCTIONS = 'Read asr.text. Which of these topics does the caller ask about? Choose unanswered when they ask about something none of them answers, and none when they say nothing about what they want to know (saying only that they have a question is none).';

/** What the question's `none` label means beside `unanswered`: the caller said nothing of what they want to know. */
export const TOPIC_UNANSWERED_NONE = 'Says nothing about what they want to know';

/** What the question's `unanswered` label means: the caller asks a question none of the topics offered answers. */
export const TOPIC_UNANSWERED = 'Asks about something none of these answers';

/** What each nominated topic's criterion says, by default ({title|lower}: its title in lower case; kb/criterion.ts). */
export const DEFAULT_TOPIC_CRITERION = 'Asks about {title|lower}';
