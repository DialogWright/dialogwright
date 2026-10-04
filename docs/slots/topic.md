# `topic`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/topic/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

Which of the knowledge base's topics the caller asks about: the opening hours, the returns policy, the late fees. The value is the topic's id, so the app can find the approved passage that answers it; the slot never writes or chooses the answer.

The model does not see every topic. Before the turn is planned, the app's retriever nominates a few topics for the caller's words (`SlotContext.nominated`, best first), and the slot asks one question over those alone: which of these does the caller ask about, or none? A turn that nominates nothing asks nothing, so a call that never asks a general question pays nothing for the knowledge base. The slot opts in to retrieval (`nominates`): while it listens, a turn with words runs the retriever once.

Reach for it when the app answers general questions from approved passages. It needs the app's knowledge: a `kb/` folder with a retriever in the code (`code.knowledge.retriever`), or, for an app that is not a folder, `App.knowledge` with the topics its retriever nominates. For a fixed list the caller chooses from as part of a task, use `choice`.

## Options

A slot of this type is written under its id in slots.yaml, with `type: topic` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `criterion` | string | `Asks about {title\|lower}` | The criterion the model is given for each nominated topic. A template: {title} is the topic's title, {topic} its id, and {title\|lower} the title in lower case. Nothing else is evaluated. |
| `cap` | integer, 1 to 20 | unset | How many of the nominated topics the question offers, best first. Default: the knowledge base's retrieval cap (kb.yaml retrieval.cap), else 8. |
| `accept` | one of `nominated`, `catalog` | `nominated` | What the slot fills with: `nominated`, only a topic the question offered on that turn; `catalog`, any topic the app's knowledge has (a recorded answer given against another turn's nominations can name one this turn did not offer). |
| `disambiguate` | boolean | `true` | Whether two topics the model cannot tell apart (the top two both topics the slot may fill, the top at SLOT_CHOICE_CONFIRM or above and the second within KB_TOPIC_MARGIN of it) make the slot ask which one (`disambiguate_<slot>`, with {a} and {b}). Off: the slot reads the model's pick alone. |
| `fillAt` | one of `SLOT_CHOICE_FILL`, `SLOT_CHOICE_CONFIRM` | `SLOT_CHOICE_FILL` | The threshold the model's probability for the topic must reach for the slot to fill. |
| `missReason` | string | `no_topic` | The reason of the invalid outcome when the slot was asked for and the caller chose no topic (or the model was not sure enough). Not asked for, that is absent. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions, none. |
| `ids` | map | unset | Question ids in place of the default: `ids.choice` is the question's id (default: the slot's id followed by "Topic"), to keep the id an existing slot used. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.instructions` | The question that asks which topic the caller asks about, sent to the model in place of the default. | `Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing.` |
| `text.none` | What the question's "none" label means: the caller asks about none of the topics offered. | `Asks about none of these` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.choice` | The id of the question that asks which topic the caller asks about. |

The slot is read back in the final summary and never on its own (`spokenConfirm: summary`), has no keypad rung, and reads only the thresholds named here.

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

`ask_<slot>` and `ask_<slot>_retry` as for any slot; with `disambiguate`, `disambiguate_<slot>` with `{a}` and `{b}`, the two topics' titles ("Do you mean {a} or {b}?").

## Examples

The starter examples, listed below, are two configurations with starter utterances: the defaults on a help desk's four topics, and a slot that takes any topic of the knowledge, offers two, reads the model's pick alone and keeps its own words. In an app's `slots.yaml`:

```yaml
subject:
  type: topic
  cap: 4
```

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### help desk

The defaults, on a help desk's four topics. Only a topic the question offered fills, and two the model cannot tell apart are asked about.

```yaml
subject:
  type: topic
```

Built with the knowledge topics:

| Topic | Title | Titles by locale |
|---|---|---|
| `opening_hours` | Opening hours | es: Horario de apertura |
| `returns` | Returns and refunds | es: Devoluciones y reembolsos |
| `parking` | Parking | es: Aparcamiento |
| `late_fees` | Late fees | es: Recargos por retraso |

<details><summary>Starter utterances (7)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| when do you open on saturday<br>_nominated opening_hours, parking_ | `subjectTopic`: `opening_hours` 0.9, `parking` 0.04, `none` 0.06 | filled: value `opening_hours`, display `opening hours`, confirm `none`, display in es `horario de apertura` |
| is there a fee if i bring it back late<br>_prompted; nominated returns, late_fees_ | `subjectTopic`: `late_fees` 0.85, `returns` 0.1, `none` 0.05 | filled: value `late_fees`, display `late fees` |
| can i bring a book back<br>_nominated returns, late_fees_ | `subjectTopic`: `returns` 0.5, `late_fees` 0.42, `none` 0.08 | disambiguate |
| where can i leave the car<br>_nominated parking_ | `subjectTopic`: `parking` 0.52, `none` 0.48 | absent |
| where can i park<br>_nominated parking_ | `subjectTopic`: `returns` 0.9, `none` 0.1 | absent |
| what about my dog<br>_prompted; nominated nothing_ | none | invalid: reason `no_topic`, raw `` |
| hello there | none | absent |

</details>

#### any topic of the knowledge

Any topic the app's knowledge has fills, not only one offered on that turn; at most two are offered; the model's pick is read alone; the slot keeps its own words, id and miss reason.

```yaml
subject:
  type: topic
  accept: catalog
  cap: 2
  disambiguate: false
  fillAt: SLOT_CHOICE_CONFIRM
  criterion: The caller wants to know about {title}
  missReason: no_subject
  text:
    instructions: Read asr.text. Which subject does the caller ask about?
    none: Names no subject
  ids:
    choice: subjectChoice
```

Built with the knowledge topics:

| Topic | Title | Titles by locale |
|---|---|---|
| `opening_hours` | Opening hours | es: Horario de apertura |
| `parking` | Parking | es: Aparcamiento |
| `late_fees` | Late fees | es: Recargos por retraso |

<details><summary>Starter utterances (4)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| do you have parking, and are you open late<br>_nominated parking, opening_hours, late_fees_ | `subjectChoice`: `parking` 0.48, `opening_hours` 0.47, `none` 0.05 | filled: value `parking`, display `parking`, display in es `aparcamiento` |
| and what do late books cost | `subjectChoice`: `late_fees` 0.8, `none` 0.2 | filled: value `late_fees`, display `late fees` |
| i just wanted to say thanks<br>_prompted; nominated opening_hours_ | `subjectChoice`: `none` 0.9, `opening_hours` 0.1 | invalid: reason `no_subject`, raw `` |
| is parking free<br>_nominated parking_ | `subjectChoice`: `not_a_topic` 0.9, `none` 0.1 | absent |

</details>

## Notes

- Retrieval floors, caps and the retriever change what the question offers, and so the model's request: sweep them offline on paraphrase sets, never by re-recording a cassette.
- The nominations ride on the turn: the questions and the fill see the same ones, and a caller of `plan()` or `resolve()` without `runTurn` passes them on the context (`TurnContext.knowledge`).
- `pnpm check` refuses a topic slot in an app with no `kb/`, or with no retriever, since it would never ask.
- Run its checks with `pnpm --filter dialogwright test slots/topic`.
