# `topic`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/topic/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

Which of the knowledge base's topics the caller asks about: the opening hours, the returns policy, the late fees. The value is the topic's id, so the app can find the approved passage that answers it; the slot never writes or chooses the answer.

The model does not see every topic. Before the turn is planned, the app's retriever nominates a few topics for the caller's words (`SlotContext.nominated`, best first), and the slot asks one question over those alone: which of these does the caller ask about, a question none of them answers, or nothing? A turn that nominates nothing asks nothing, so a call that never asks a general question pays nothing for the knowledge base. The slot opts in to retrieval (`nominates`): while it listens, a turn with words runs the retriever once.

Reach for it when the app answers general questions from approved passages. It needs the app's knowledge: a `kb/` folder, whose topics the engine's retriever nominates (by keywords, or hybrid with `retrieval.embedder` in `kb/kb.yaml`) unless the code gives its own (`code.knowledge.retriever`), or, for an app that is not a folder, `App.knowledge` with the topics its retriever nominates. For a fixed list the caller chooses from as part of a task, use `choice`.

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
| `unanswered` | one of `retry`, `ask` | `retry` | What a question no topic answers leads to when the slot was not asked for (the turn that asks it opens the form, say). `retry` (the default, the maintainer's decision of 2026-10-17): the question has an `unanswered` label beside `none`, and a question read as unanswered is the slot's miss: when the form comes to the slot (at once, or after the identity it needs) the caller hears `ask_<slot>_retry` (which says nothing answers that, and what can be asked) and an attempt is counted, rather than the question as if nothing had been asked. `ask`: no such label, and the slot's question is asked, as before. |
| `sections` | map | `{"ask":"yes-no","from":"mostly"}` | With answers from documents (kb.yaml documents): how the slot asks whether each nominated section answers the caller. |
| `sections.ask` | one of `yes-no`, `score` | `yes-no` | How each nominated section of an approved document is asked of: `yes-no` (the default), whether it says what the caller asks about; `score`, how much of what the caller asks it answers (none, little, partly, mostly, completely), so a section that is only about the same thing is told from one that answers it. |
| `sections.from` | one of `partly`, `mostly`, `completely` | `mostly` | With `ask: score`, the level from which a section answers: the probability the model gives it of this level or above is held to KB_SECTION_ANSWERS. Default mostly. |
| `notFound` | map | `{"counts":false,"remind":2}` | With `unanswered: retry`, the reply to a question none of the topics (or the sections of approved documents) answers: where the app has kb_not_found, that line in turn through its variants, then kb_guide where it is due, then the slot's question; else the slot's retry line, as before. |
| `notFound.counts` | boolean | `false` | Whether a question nothing answers counts as a try on the slot's ladder (attempts, onMaxAttempts). false (the default, the maintainer's decision of 2026-10-17): the knowledge base lacked it, the caller did not fail, so they may ask as often as they like; true: three in a row (attempts) end as any slot's misses do. A turn that says nothing about what the caller wants (none) counts either way. |
| `notFound.remind` | integer, 1 to 10 | `2` | After how many not-found replies in a row without it the guide to what can be asked (kb_guide) is said again; it is said the first time a call hears one. Default 2. |
| `confirm` | one of `summary`, `always` | unset | "summary" (the default): a topic is neither acknowledged nor read back on its own; the form's final confirm covers it. "always": the topic is read back for a yes as soon as it is heard (`confirm_<slot>`, given its display as `{<slot>}`), before the form goes on; a no empties the slot and asks it again (ack_declined, then `ask_<slot>`), a step on its ladder, and a second no goes to a person. The right answer said with the no ("no, it's ...") is taken. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions, none, section, sectionScore, sectionNone, sectionLittle, sectionPartly, sectionMostly, sectionCompletely, unanswered. |
| `ids` | map | unset | Question ids in place of the default: `ids.choice` is the question's id (default: the slot's id followed by "Topic"), to keep the id an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front". |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form's entry call loaded after identity), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs code.facts.offers, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |
| `offerAt` | one of `slot`, `greeting` | `slot` | Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting's open question (greeting_offer, then `offer_<slot>`), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. Needs offer: facts, and greeting_offer and greet_after_offer in every locale. |
| `offerAnswers` | one of `yes-no-or-value`, `yes-no` | `yes-no-or-value` | What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller's own, which fills the slot as said. "yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot's question is then asked); on the keypad 1 is yes and 2 is no. Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts. |
| `askedOf` | list of string | unset | The callers the slot is asked of: principal kinds as identity.yaml names them (the subject kind, or a delegate kind such as broker), or a delegate kind and one of its roles (broker.office_admin). For any other caller the slot is not part of its forms: its question is not sent, it is not asked, and its form completes without it (a caller not yet verified is no kind listed but anonymous, which may not be listed). Use it for what only some callers need to say, such as which client a delegate is asking about. Never on an identity factor; pnpm check refuses a kind or a role identity.yaml does not have. Default: every caller. |
| `attempts` | integer, 1 to 10 | `3` | How many failed answers the slot takes before onMaxAttempts, 1 to 10. Each failure before the last but one re-asks: a missed answer with `ask_<slot>_retry`, or `ask_<slot>_retry2` at the second failure (and so on) where prompts.yaml has it; a silence with `ask_<slot>_noinput2` (and so on), else `ask_<slot>_noinput`, else no_input then the question (`ask_<slot>`) again (at the keypad rung of a slot that takes no keys, on a channel with a keypad, no_input then its retry line). The last but one is the keypad rung (`ask_<slot>_dtmf`) where the slot takes keys and the channel has a keypad, else another re-ask; the last runs onMaxAttempts. Default: the engine's MAX_ATTEMPTS (3). |
| `onMaxAttempts` | one of `handoff`, `skip` or map | `handoff` | What happens when the slot runs out of attempts (a missed answer, a silence, an unanswered read-back, or a second no to its read-back). "handoff" (the default): to a person, with handoff_max_attempts. "skip": the slot is left empty and declined, and the form goes on; never on an identity factor, nor on a slot its form's summary names. Or written out, { say, then, reason, form, goodbye }: then is handoff (reason names the handoff, default max-attempts), skip, end (say required; the call ends, the goodbye after the line unless goodbye: false), anything-else (say required; the form closes uncompleted and "anything else?" is asked) or form (the form closes uncompleted and `form` is entered, keeping the slots both list); say, a prompt said first. An offer of the caller's number with onNo: skip that runs out leaves the slot empty whatever this says; with no onNo: skip, the slot's ladder goes on to it. |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.instructions` | The question that asks which topic the caller asks about, sent to the model in place of the default. | `Read asr.text. Which of these topics does the caller ask about? Choose none when they ask about none of them, or ask nothing.` |
| `text.none` | What the question's "none" label means: the caller asks about none of the topics offered. | `Asks about none of these` |
| `text.section` | With answers from documents (kb.yaml documents), the yes-or-no asked of each nominated section beside the topic question: {document} is its document's title, {heading} its heading, {text} its text. Unlike the other parts, an app's own wording is a template over the same three, filled for each section, so it shows the model the section: write {heading}: {text} where the section goes. Variables: `{document}`, `{heading}`, `{text}`. | `Read asr.text. Would this section of the {document} answer the caller's question? {heading}: {text}` |
| `text.sectionScore` | With `sections: { ask: score }`, the score asked of each nominated section in place of the yes-or-no (`section`): how much of what the caller asks it answers, by the levels below. A template over {document}, {heading} and {text}, as `section` is. Variables: `{document}`, `{heading}`, `{text}`. | `Read asr.text. How much of what the caller asks does this section of the {document} answer? {heading}: {text}` |
| `text.sectionNone` | The score's lowest level, `none`. | `Says nothing about what the caller asks` |
| `text.sectionLittle` | The score's level `little`. | `Is about the same thing but does not answer what the caller asks` |
| `text.sectionPartly` | The score's level `partly`. | `Answers part of what the caller asks` |
| `text.sectionMostly` | The score's level `mostly`. | `Answers what the caller asks, but for a detail` |
| `text.sectionCompletely` | The score's highest level, `completely`. | `Answers everything the caller asks` |
| `text.unanswered` | What the question's "unanswered" label means, with `unanswered: retry`: the caller asks a question none of the topics offered answers. | `Asks about something none of these answers` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.choice` | The id of the question that asks which topic the caller asks about. |

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

With answers from documents on (kb.yaml `documents: { summarize: on }`, the guide's section 12.14), retrieval nominates sections of the documents a person approved for summarizing beside the topics (`SlotContext.sections`, at most kb.yaml's `documents.cap`), and the slot asks of each, in the same request, one yes-or-no: `<slot>Section1`, `<slot>Section2` and on, by rank, each "Would this section of the {document} answer the caller's question? {heading}: {text}" (`text.section`). An app's own wording of it (`text.section`) is a template over the same `{document}`, `{heading}` and `{text}`, filled for each section (the type's other text parts are said as written), and a name it does not have is refused when the slot is defined. A topic the topic question fills always wins. Where none fills and the caller asked something (`none` is not on top; with the request, rather than at the slot's own question, sure of it: all but `none` at `KB_UNANSWERED`, 0.65, as a not-found reply held from the request is, so a bare "coverage" is a request, not a question a section answers), the sections read yes at `KB_SECTION_ANSWERS` or above, best first, at most two, fill the slot: its value `sections:<document>#<section>|...`, said by the first section's heading. The form's knowledge completion resolves them through the gate as it does a topic. With `unanswered: ask` no section is asked. With `sections: { ask: score }` each section is asked a score in place of the yes-or-no (`text.sectionScore`): how much of what the caller asks it answers, `none`, `little` (about the same thing, not an answer), `partly`, `mostly` or `completely` (`text.sectionNone` to `text.sectionCompletely`), and it answers when the probability of `sections.from` (default `mostly`) or a level above it reaches `KB_SECTION_ANSWERS`. Measured on a 123-page booklet's 114 paraphrases and a handbook's 80, it found as many right sections as the yes-or-no from `partly`, and from `mostly` gave about five fewer wrong answers for about four fewer right ones: a cautious choice, not the default. Measured again with the line just played varied (below), the score falls apart after a long answer read out (from `partly`, 29 of 146 right where the yes-or-no finds 121): keep the yes-or-no where callers ask one question after another.

**The question's wording, and what the caller just heard.** The model reads each section's question with the rest of the turn, the line just played among it, so what the caller heard before can sway it: on a live call, "Is acupuncture covered?" read 0.38 for the acupuncture section after a physical therapy table was read out, and 0.91 after "Is there anything else I can help with?" alone. The wording decides how much. The default ("Would this section ... answer the caller's question?", the maintainer's decision of 2026-10-18) was measured against the earlier "Does this section ... say what the caller asks about?", the score, and a table's rows shown one a line, each section's question asked with three lines just played (a booklet's 152 questions: the greeting, "anything else?", and a long answer read out) and with four (a handbook's 88: the greeting, a coverage answer, a claim's date question, the coverage question). After a long answer it found the right section for 121 of 146 where the earlier read 73 (the handbook, after a coverage answer, 82 of 87 where it read 70), as many at a call's start or a little more, with no more wrong sections (8 to 16 of 146; 1 to 3 of 87), and the same outcome whatever was just heard for 131 of 152 questions where the earlier had 86. An app's own wording (`text.section`) is worth measuring the same way: a question asked at a call's start and after a long answer, the right section's reading compared.

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

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### help desk

The defaults, on a help desk's four topics. Only a topic the question offered fills, two the model cannot tell apart are asked about, and a question none of them answers, asked with the request, is held as the slot's miss.

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

<details><summary>Starter utterances (11)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| when do you open on saturday<br>_nominated opening_hours, parking_ | `subjectTopic`: `opening_hours` 0.9, `parking` 0.04, `none` 0.06 | filled: value `opening_hours`, display `opening hours`, confirm `none`, display in es `horario de apertura` |
| is there a fee if i bring it back late<br>_prompted; nominated returns, late_fees_ | `subjectTopic`: `late_fees` 0.85, `returns` 0.1, `none` 0.05 | filled: value `late_fees`, display `late fees` |
| can i bring a book back<br>_nominated returns, late_fees_ | `subjectTopic`: `returns` 0.5, `late_fees` 0.42, `none` 0.08 | disambiguate |
| where can i leave the car<br>_nominated parking_ | `subjectTopic`: `parking` 0.52, `none` 0.48 | absent |
| where can i park<br>_nominated parking_ | `subjectTopic`: `returns` 0.9, `none` 0.1 | absent |
| what about my dog<br>_prompted; nominated nothing_ | none | invalid: reason `no_topic`, raw `` |
| hello there | none | absent |
| can i bring my dog into the library<br>_nominated opening_hours_ | `subjectTopic`: `unanswered` 0.85, `opening_hours` 0.05, `none` 0.1 | invalid: reason `no_topic`, raw ``, held `true` |
| is there wifi at the library<br>_nominated opening_hours; sections [{"key":"visitor-guide#wifi","document":"visitor-guide","documentTitle":"Visitor Guide","heading":"Wi-Fi","text":"Every branch has free Wi-Fi.","score":1,"via":"keyword"}]_ | `subjectTopic`: `unanswered` 0.9, `opening_hours` 0.05, `none` 0.05<br>`subjectSection1`: yes 0.92 | filled: value `sections:visitor-guide#wifi`, display `wifi` |
| i have a question for you<br>_nominated opening_hours_ | `subjectTopic`: `none` 0.9, `unanswered` 0.05, `opening_hours` 0.05 | absent |
| i just have a quick question<br>_prompted; nominated opening_hours_ | `subjectTopic`: `none` 0.92, `unanswered` 0.05, `opening_hours` 0.03 | invalid: reason `no_topic`, raw ``, reask `true` |

</details>

#### any topic of the knowledge

Any topic the app's knowledge has fills, not only one offered on that turn; at most two are offered; the model's pick is read alone; the slot keeps its own words, id and miss reason, and its question from before (no unanswered label, unanswered ask).

```yaml
subject:
  type: topic
  accept: catalog
  cap: 2
  disambiguate: false
  fillAt: SLOT_CHOICE_CONFIRM
  criterion: The caller wants to know about {title}
  missReason: no_subject
  unanswered: ask
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
- `pnpm check` refuses a topic slot in an app with no `kb/`, since it would never ask.
- Run its checks with `pnpm --filter dialogwright test slots/topic`.
