# `topic`

Which of the knowledge base's topics the caller asks about: the opening hours, the returns policy, the late fees. The value is the topic's id, so the app can find the approved passage that answers it; the slot never writes or chooses the answer.

The model does not see every topic. Before the turn is planned, the app's retriever nominates a few topics for the caller's words (`SlotContext.nominated`, best first), and the slot asks one question over those alone: which of these does the caller ask about, or none? A turn that nominates nothing asks nothing, so a call that never asks a general question pays nothing for the knowledge base. The slot opts in to retrieval (`nominates`): while it listens, a turn with words runs the retriever once.

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
| `none`, a label no topic has, a topic it may not fill with, or a probability below the threshold | `invalid` with `missReason` (raw empty) when the slot was asked for, else `absent` |
| No answer at all (nothing was nominated, so the question was not asked) | the same |

A topic it may fill with is one the question offered on that turn (`accept: nominated`, the default), or any topic of the app's knowledge (`accept: catalog`), which keeps a recorded answer given against another turn's nominations. With `disambiguate` (the default) the slot reads the probabilities of every label, best first; without it, the model's pick alone, at its own probability or, when the pick has none, the answer's confidence.

When a caller's words name a task the engine confirms first ("can I park there with my pass?", then "yes"), the form fills from the earlier words, and the slot reads the topics nominated for those words on their own turn, kept with the confirmation, never the yes turn's.

## The question

On the slot `subject`, the question is `subjectTopic`, a choice whose labels are the nominated topics' ids, best first, at most `cap` of them, then `none`. With these nominations for "is the car park open on sundays":

> - `parking`: Asks about parking
> - `opening_hours`: Asks about opening hours
> - `none`: Asks about none of these

and the instructions:

> Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing.

`criterion` is a template with nothing evaluated but `{title}`, `{topic}` and the filter `lower` (`{title|lower}`); a name or a filter it does not have is a problem when the slot is defined.

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for any slot; with `disambiguate`, `disambiguate_<slot>` with `{a}` and `{b}`, the two topics' titles ("Do you mean {a} or {b}?"). With `confirm: always`, `confirm_<slot>`, given `{<slot>}` set to the display: the read-back said as soon as a value is heard; a no empties the slot and asks it again (`ack_declined`, then `ask_<slot>`), a step on the slot's ladder; the right answer said with the no ("no, it's ...") is taken instead, and a second no to the read-back goes to a person.

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
