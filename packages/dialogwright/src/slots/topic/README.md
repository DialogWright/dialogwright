# `topic`

Which of the knowledge base's topics the caller asks about: the opening hours, the returns policy, the late fees. The value is the topic's id, so the app can find the approved passage that answers it; the slot never writes or chooses the answer.

The model does not see every topic. Before the turn is planned, the app's retriever nominates a few topics for the caller's words (`SlotContext.nominated`, best first), and the slot asks one question over those alone: which of these does the caller ask about, a question none of them answers, or nothing? A turn that nominates nothing asks nothing, so a call that never asks a general question pays nothing for the knowledge base. The slot opts in to retrieval (`nominates`): while it listens, a turn with words runs the retriever once.

Reach for it when the app answers general questions from approved passages. It needs the app's knowledge: a `kb/` folder, whose topics the engine's retriever nominates (by keywords, or hybrid with `retrieval.embedder` in `kb/kb.yaml`) unless the code gives its own (`code.knowledge.retriever`), or, for an app that is not a folder, `App.knowledge` with the topics its retriever nominates. For a fixed list the caller chooses from as part of a task, use `choice`.

## Options

<!-- slot-docs:options -->

The slot is read back in the final summary and not on its own unless `confirm: always` says so, has no keypad rung, and reads only the thresholds named here.

## The topics

A topic slot is built with the app's topics (`topicCatalog`): defineApp gives it the folder's `kb/topics.yaml` (each topic's id and title, the titles in `kb/locale/<tag>/topics.yaml`, and `kb.yaml`'s `retrieval.cap`), and an app that is not a folder passes its knowledge to `defineSlots(file, codeSlots, types, { knowledge })`. The slot says a topic by its title in lower case ("opening hours"), in the session's locale when the knowledge gives one ("horario de apertura"), and a value it has no title for as the value itself. The question's criteria read the title the retriever gave with each nomination, in the default language, since the questions are never translated.

## The outcome

| What the caller said | The outcome |
|---|---|
| A topic it may fill with, and the model's probability for it reaches `fillAt` | `filled`: the value is the topic's id, the display its title, and no read-back is asked for |
| Two topics it may fill with, the top at `SLOT_CHOICE_CONFIRM` or above and the second within `KB_TOPIC_MARGIN` of it (with `disambiguate`) | `disambiguate`, between the two |
| `unanswered` (with `unanswered: retry`, the default) at `fillAt` or above: a question none of the topics offered answers | `invalid` with `missReason` (raw empty); when the slot was not asked for, `held` too (below) |
| `none` on top at its own question (with `unanswered: retry`): the caller said nothing about what they want to know | `invalid` with `missReason` (raw empty) and `reask`: counted, the question asked again (below) |
| `none`, a label no topic has, a topic it may not fill with, or a probability below the threshold | `invalid` with `missReason` (raw empty) when the slot was asked for, else `absent` |
| No answer at all (nothing was nominated, so the question was not asked) | the same |

A topic it may fill with is one the question offered on that turn (`accept: nominated`, the default), or any topic of the app's knowledge (`accept: catalog`), which keeps a recorded answer given against another turn's nominations. With `disambiguate` (the default) the slot reads the probabilities of every label, best first; without it, the model's pick alone, at its own probability or, when the pick has none, the answer's confidence.

## A question no topic answers

A caller who asks their question with the request ("can I bring my dog in?") has asked it; one who says only that they have one ("I have a question") has not. With `unanswered: retry` (the default, the maintainer's decision of 2026-10-17) the question tells the two apart: `none` is a turn that asks nothing, and `unanswered` a question none of the topics offered answers. Read as unanswered on a turn the slot was not asked for (the turn that opens the form, say), the miss is held (`SlotState.missed`): when the form comes to the slot, at once or after the identity its entry needs, the caller hears `ask_<slot>_retry` and an attempt is counted, as for a miss at the question itself, rather than `ask_<slot>` as if nothing had been asked. So `ask_<slot>_retry` is said to a question asked that nothing answers: write it to say so, and what the caller can ask ("I couldn't find anything that answers that. I can tell you about ..."). Held to `fillAt`, the bar a topic fills at; under it, the question is asked as before. At the slot's own question the two stay apart: `unanswered` is a miss that hears `ask_<slot>_retry`, and `none` ("I have a question about my plan") a miss with `reask` (the maintainer's decision of 2026-10-17): counted, but the question is asked again as it stands (`ask_<slot>`), at every rung short of the slot's end, since the retry line would say nothing answers a question the caller has not asked. Three misses of either kind in a row end as any slot's do (`onMaxAttempts`). A turn whose retrieval nominates nothing asks nothing, so it is never read as unanswered.

`unanswered: ask` keeps the question from before: no `unanswered` label, `none` meaning both, and the slot's question asked after a question nothing answered. An app that wrote its own `text.instructions` or `text.none` for the old labels should read them again beside `text.unanswered`, since the defaults of the two change with the option.

## Sections of approved documents

With answers from documents on (kb.yaml `documents: { summarize: on }`, the guide's section 12.14), retrieval nominates sections of the documents a person approved for summarizing beside the topics (`SlotContext.sections`, at most kb.yaml's `documents.cap`), and the slot asks of each, in the same request, one yes-or-no: `<slot>Section1`, `<slot>Section2` and on, by rank, each "Does this section of the {document} say what the caller asks about? {heading}: {text}" (`text.section`). An app's own wording of it (`text.section`) is a template over the same `{document}`, `{heading}` and `{text}`, filled for each section (the type's other text parts are said as written), and a name it does not have is refused when the slot is defined. A topic the topic question fills always wins. Where none fills and the caller asked something (`none` is not on top), the sections read yes at `KB_SECTION_ANSWERS` or above, best first, at most two, fill the slot: its value `sections:<document>#<section>|...`, said by the first section's heading. The form's knowledge completion resolves them through the gate as it does a topic. With `unanswered: ask` no section is asked. With `sections: { ask: score }` each section is asked a score in place of the yes-or-no (`text.sectionScore`): how much of what the caller asks it answers, `none`, `little` (about the same thing, not an answer), `partly`, `mostly` or `completely` (`text.sectionNone` to `text.sectionCompletely`), and it answers when the probability of `sections.from` (default `mostly`) or a level above it reaches `KB_SECTION_ANSWERS`. Measured on a 123-page booklet's 114 paraphrases and a handbook's 80, it found as many right sections as the yes-or-no from `partly`, and from `mostly` gave about five fewer wrong answers for about four fewer right ones: a cautious choice, not the default.

## The not-found reply

A question none of the topics (or sections) answers, read as `unanswered` at the slot's question or held from the request (above), is the slot's not-found reply (`notFound`): where the app has `kb_not_found`, that line in turn through its variants, then `kb_guide` (what can be asked) the first time on the call and again after `notFound.remind` replies in a row without it (default 2), then the slot's question; without `kb_not_found`, the slot's retry line, as before. It counts as a try on the slot's ladder only with `notFound.counts: true` (default false, the maintainer's decision of 2026-10-17): a caller may ask as often as they like.

When a caller's words name a task the engine confirms first ("can I park there with my pass?", then "yes"), the form fills from the earlier words, and the slot reads the topics nominated for those words on their own turn, kept with the confirmation, never the yes turn's.

## The question

On the slot `subject`, the question is `subjectTopic`, a choice whose labels are the nominated topics' ids, best first, at most `cap` of them, then `unanswered` and `none`. With these nominations for "is the car park open on sundays":

> - `parking`: Asks about parking
> - `opening_hours`: Asks about opening hours
> - `unanswered`: Asks about something none of these answers
> - `none`: Says nothing about what they want to know

and the instructions:

> Read asr.text. Which of these topics does the caller ask about? Choose unanswered when they ask about something none of them answers, and none when they say nothing about what they want to know (saying only that they have a question is none).

With `unanswered: ask`, there is no `unanswered` label, `none` is "Asks about none of these", and the instructions are "Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing."

`criterion` is a template with nothing evaluated but `{title}`, `{topic}` and the filter `lower` (`{title|lower}`); a name or a filter it does not have is a problem when the slot is defined.

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for any slot (the retry said also to a question no topic answers, with `unanswered: retry`); with `disambiguate`, `disambiguate_<slot>` with `{a}` and `{b}`, the two topics' titles ("Do you mean {a} or {b}?"). With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person.

## Examples

The starter examples, listed below, are two configurations with starter utterances: the defaults on a help desk's four topics, and a slot that takes any topic of the knowledge, offers two, reads the model's pick alone and keeps its own words. In an app's `slots.yaml`:

```yaml
subject:
  type: topic
  cap: 4
```

<!-- slot-docs:examples -->

## Notes

- Retrieval floors, caps and the retriever change what the question offers, and so the model's request: sweep them offline on paraphrase sets, never by re-recording a cassette.
- The nominations ride on the turn: the questions and the fill see the same ones, and a caller of `plan()` or `resolve()` without `runTurn` passes them on the context (`TurnContext.knowledge`).
- `pnpm check` refuses a topic slot in an app with no `kb/`, since it would never ask.
- Run its checks with `pnpm --filter dialogwright test slots/topic`.
