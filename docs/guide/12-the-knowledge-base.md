# 12. The knowledge base

[Contents](README.md) · Previous: [11. Walkthroughs](11-walkthroughs.md) · Next: [13. Channels](13-channels.md)

A knowledge base is for the questions callers ask that no form handles: when are you open, what happens if I return a book late, how do I renew my card. Its answers are short passages that people approved, chosen by what the caller means, and spoken word for word. No model writes them: the model only picks which topic the caller asked about, and code finds the one approved passage for this caller and this day. Where the app marks a topic `risk: low` and frames its answer line to word the answer, a model may word that approved passage for the caller's question, held to it by checks and a judge, with the passage said whenever one fails ([12.13](#1213-answers-worded-for-the-callers-question)); every other answer is said word for word.

This section is the whole of it, in the order you meet it: the folder, how a call uses it, the three places an answer is said from, approval and staleness, building one from documents, tuning retrieval, testing and what is recorded. The examples are one small knowledge base, Example Town Library's, whose files are the ones the engine's own tests build. [The topic slot's page](../slots/topic.md) has the question the model is asked. Two example apps have one to read whole: [the clinic](../../apps/clinic/README.md#the-knowledge-base), the smallest (five topics from one visitor page, found by keywords alone), and [the utility](../../apps/utility/README.md#the-knowledge-base) (twelve topics from a website and two PDFs, found by meaning, with an account line).

### 12.1 The folder

An app with a knowledge base has a `kb/` folder beside its other files. Only `kb.yaml` and `topics.yaml` are required.

```
kb/
  kb.yaml                       the settings: the gated action that resolves a passage, the facts a passage may depend on, retrieval
  topics.yaml                   what callers ask about: a title, keywords and example questions each, and an optional line from the caller's own data
  passages/<id>.yaml            one approved answer each, in the app's default language
  sources/<doc>.yaml            the documents the answers come from, by section: what an approval is held to
  sections.yaml                 how the sections of documents approved for summarizing are found: questions and keywords each (optional, never said)
  glossary.yaml                 the words said in place of the documents' jargon, in the sections answered from (optional)
  locale/<tag>/topics.yaml      a language's titles, keywords and example questions
  locale/<tag>/passages/        a language's passages, usually translations
  pending/<id>.yaml             drafts waiting for a person: never read at run time, never said
  pending/topics.yaml           topics the drafts propose
  rejected/<id>.yaml            drafts a person turned down, with who, when and why
  approvals.jsonl               every approval, one line each, appended and never rewritten
  .index/<embedder>.json        the vectors of the topics' texts (and the sections'), for retrieval by meaning (optional; commit it)
```

Every file has a JSON Schema (`kb-settings`, `kb-topics`, `kb-sections`, `kb-glossary`, `kb-locale-topics`, `kb-passage`, `kb-source`, `kb-pending`), named on its first line like the app's other files (the examples below show the file's path there instead). A file that is not in this list is a problem, so a mistyped folder name does not go unnoticed. `pnpm check` reads all of it, and so does `defineApp`.

**kb.yaml** says how the knowledge base is read, never what it says:

```yaml
# kb/kb.yaml
action: findPassage        # the gated tool that resolves a passage for a caller (a tool with an action in policy.yaml)
applies:                   # the facts a passage may depend on, each with every value it can take
  card: [adult, junior]
localeFallback: none       # a missing translation is "unavailable" (none), or the default language's passage (default)
maxAnswerChars: 400        # an answer is spoken, so it is short (40 to 2000; default 400)
retrieval:
  cap: 8                   # the most topics a turn offers the model (default 8)
```

`applies` is the one thing that makes passages differ by caller. A fact is a name and the values it can take; every topic needs a passage in force for every combination, and `pnpm check` lists a combination that has none. An app whose answers are the same for everyone leaves it out. The retrieval settings are in [12.10](#1210-retrieval-settings).

**topics.yaml** names what callers ask about. Retrieval reads each topic's title, keywords and example questions; the topic question offers the title. A title is spoken, so an approval covers it: renaming a topic sends its passages back for review ([12.8](#128-approval-staleness-and-withholding)).

```yaml
# kb/topics.yaml
opening_hours:
  title: Opening hours
  keywords: [opening hours, open, closed, hours]
  asks:
    - When are you open?
    - Are you open on Sunday?
  risk: low
late_fees:
  title: Late fees
  keywords: [late fee, overdue, fine]
  asks:
    - How much is the fee for a late book?
  accountLine:
    text: Your card has {balance} in late fees right now.
    from: getFees
```

`keywords` are words and phrases that name the topic exactly (a plan name, a code); a keyword said whole counts for more. `asks` are example questions in a caller's own words. `risk` is `regulated` (the default: only an approved passage is ever said) or `low`, which marks content a later release may let an app answer in generated wording, grounded in approved passages; nothing reads it yet. `accountLine` is explained in [12.5](#125-answers-through-the-gate).

**A source** is a document's text by section. An approval is held to the section's text, so a changed word makes the passages drawn from it stale. You can write one by hand, or have `pnpm kb:ingest` read it from the document ([12.9](#129-building-one-from-documents)).

```yaml
# kb/sources/patron-guide.yaml
document: Example Town Library Patron Guide
provenance:
  file: patron-guide.pdf
  retrieved: 2025-12-01
sections:
  "1.1":
    heading: Opening hours
    text: >-
      All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m.
      to 4 p.m. All branches are closed on Sunday.
  "3.1":
    heading: Late fees on adult cards
    text: An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.
  "3.2":
    heading: Late fees on junior cards
    text: Junior cards are not charged late fees.
```

**A passage** is one approved answer: the topic it answers, who it answers (`applies`), the days it is in force, the source section it is drawn from, the answer, and its approval.

```yaml
# kb/passages/late-fees-junior.yaml
id: late-fees-junior
topic: late_fees
version: "2026.1"
applies: { card: junior }
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 18345c1533866b482125f9f1f66d537d51741e4c0fce296322696bf920018b6a
  hash: 83130b55c5f2be7a628620a4dcacca0dac5b6d8bfb97b4852b5816c7c65c3a03
```

- `id` is the file's name. `version` is the passage's own ("2026.1") and is recorded with every answer.
- `applies` gives, for each fact of kb.yaml, a value or a list of values; a fact left out means any value. A topic's passages must not overlap: no two may be in force for the same caller on the same day, and `check` refuses a pair that would.
- `effective` is a range of days, both ends inclusive; no `to` means open-ended. A change in the tariff is a second passage that starts the day after the first one's `to`, so the history stays in the repository and a caller always hears the one in force today.
- `answer` is fixed text: no `{variable}`, no braces at all, no more than `maxAnswerChars`. It is said exactly as written, so write it to be heard: numbers as people say them, no abbreviations.
- `approval` is written by `pnpm kb:approve`, never by hand ([12.8](#128-approval-staleness-and-withholding)).

The second adult passage, `late-fees-adult`, differs only in `applies: { card: adult }`, its source section and its words. Last year's rate would keep its own passage, ending with `effective: { from: 2025-01-01, to: 2025-12-31 }`.

```yaml
# kb/passages/late-fees-adult.yaml
id: late-fees-adult
topic: late_fees
version: "2026.1"
applies: { card: adult }
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "3.1" }
answer: Late books on an adult card cost 25 cents a day, up to 5 dollars a book.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: a3502dd02204f66615d5227dfafdb55a5b53572022c5982f1c5e53036ee9b850
  hash: f2a183c49c4bdec0ab8b3253d90d5fd1a5a0b58a368882173ee7c6aa92a53ae7
```

```yaml
# kb/passages/opening-hours.yaml
id: opening-hours
topic: opening_hours
version: "2026.1"
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "1.1" }
answer: We're open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We're closed on Sunday.
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c
  hash: be0ce40c52aeb3f1db18d14e464e98d8c16d885e44ed070889526fd19c236a30
```

**A locale** has its own topic wording and its own passages, under `locale/<tag>/`:

```yaml
# kb/locale/es/topics.yaml
opening_hours:
  title: Horario
  keywords: [horario, abierto, cerrado]
  asks:
    - ¿A qué hora abren?
late_fees:
  title: Multas por retraso
  keywords: [multa, retraso]
  accountLine:
    text: Su tarjeta tiene {balance} en multas ahora mismo.
```

```yaml
# kb/locale/es/passages/opening-hours-es.yaml
id: opening-hours-es
topic: opening_hours
version: "2026.1"
effective: { from: 2026-01-01 }
source: { document: patron-guide, section: "1.1" }
answer: Abrimos de lunes a viernes de 9 de la mañana a 8 de la noche, y los sábados de 10 a 4. Los domingos cerramos.
translates: opening-hours
approval:
  owner: Patron Services
  approvedBy: Branch Manager
  on: 2025-12-10
  sourceHash: 1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c
  hash: fe8bf374b3b707e2dd142f8ba25c6e5b0852abb505f7483d680f8e395c8d630b
```

More in [12.7](#127-locales-and-fallback).

**A draft** is a passage waiting for a person. It has no `approval`, and says where it came from, with the words of the source it was drawn from:

```yaml
# kb/pending/late-fees-junior-2025.yaml: a draft, never said
id: late-fees-junior-2025
topic: late_fees
version: "2025.1"
applies: { card: junior }
effective: { from: 2025-01-01, to: 2025-12-31 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
drafted:
  by: kb:draft
  on: 2026-10-02
  excerpt: Junior cards are not charged late fees.
```

`pending/topics.yaml` is a `topics.yaml`-shaped file of the topics the drafts propose. Nothing in `pending/` is read when a call runs.

**A rejected draft** is the draft as it was, with who turned it down and why, kept in the repository so the same draft is not proposed again:

```yaml
# kb/rejected/late-fees-junior-2025.yaml: a draft a person turned down
id: late-fees-junior-2025
topic: late_fees
version: "2025.1"
applies: { card: junior }
effective: { from: 2025-01-01, to: 2025-12-31 }
source: { document: patron-guide, section: "3.2" }
answer: There are no late fees on a junior card.
drafted:
  by: kb:draft
  on: 2026-10-02
  excerpt: Junior cards are not charged late fees.
rejected:
  by: Branch Manager
  on: 2026-10-03
  reason: The 2025 fee schedule is out of date; the 2026 passage says it.
```

**The approvals log** has one JSON line for each approval, written by `pnpm kb:approve` and only ever appended to. It keeps the source section's text as it was approved (`sourceText`), so a later review can show what changed in it, and `pnpm check` holds every passage's approval to a line of its id and hash:

```jsonl
{"id":"opening-hours","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c","hash":"be0ce40c52aeb3f1db18d14e464e98d8c16d885e44ed070889526fd19c236a30","from":"pending","sourceText":"All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday."}
{"id":"late-fees-adult","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"a3502dd02204f66615d5227dfafdb55a5b53572022c5982f1c5e53036ee9b850","hash":"f2a183c49c4bdec0ab8b3253d90d5fd1a5a0b58a368882173ee7c6aa92a53ae7","from":"pending","sourceText":"An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item."}
{"id":"late-fees-junior","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"18345c1533866b482125f9f1f66d537d51741e4c0fce296322696bf920018b6a","hash":"83130b55c5f2be7a628620a4dcacca0dac5b6d8bfb97b4852b5816c7c65c3a03","from":"pending","sourceText":"Junior cards are not charged late fees."}
{"id":"opening-hours-es","version":"2026.1","approvedBy":"Branch Manager","owner":"Patron Services","on":"2025-12-10","sourceHash":"1faa2dc4c217f7cccda164cf836746cf75b4d55ffe84f087255d58cba3e67d6c","hash":"fe8bf374b3b707e2dd142f8ba25c6e5b0852abb505f7483d680f8e395c8d630b","from":"pending","sourceText":"All branches are open Monday to Friday from 9 a.m. to 8 p.m. and on Saturday from 10 a.m. to 4 p.m. All branches are closed on Sunday."}
```

### 12.2 How a call uses it

Four steps, and only the second is a model's: nominate, select, resolve, speak.

1. **Nominate.** Before a turn is planned, the engine runs the app's retriever once on what the caller said, in their language and for today, and gets back up to `cap` topics, best first, each with a score and how it was found (`keyword`, `dense` or `app`). This is the turn's one asynchronous step, since the questions are built before the model is asked.
2. **Select.** The topic slot asks the model one question over those topics and "none": which does the caller ask about? The model answers with a probability for each. Code reads them: a topic is chosen when it reaches the threshold, two that cannot be told apart make the slot ask which one was meant, and "none" or a weak answer chooses nothing.
3. **Resolve.** The form's completion reads the answer through the gate, with the topic and, where the policy says whose record it is, the caller's id. The tool finds the one passage in force: for this topic, for this caller's facts, on today's date, in the call's language, approved and not stale.
4. **Speak.** The passage's answer is said word for word through the `kb_answer` line, followed by the topic's account line when it has one and the caller's own data allows it (on a topic marked `risk: low` whose answer line words its answer, a wording of the passage for the caller's question may be said in its place, [12.13](#1213-answers-worded-for-the-callers-question)). When there is no passage to say, the caller hears the `kb_unavailable` line and is offered a person, once per call.

**When retrieval runs.** Only on a turn where all of these hold: the app has a knowledge base, the turn has the caller's words (speech or text, not after the call has ended or while a downstream service's answer is awaited), and a topic slot is among the slots the turn asks. A turn that is none of these is exactly the turn it was without a knowledge base: no retrieval, no extra question, the same request to the model. An app with no `kb/` folder is unchanged byte for byte.

**On the turn a question interrupts a task.** With another form open, the topic slot is not among the slots the turn asks, so the turn's request has no topic question, as before. When the model's answers then name the form that answers as an aside to the task ([below](#125-answers-through-the-gate)) and its topic is not known, the engine retrieves for the same words and, when anything is nominated, makes a second, small request on them: the topic question alone, with the same turn state. Only that turn makes it, so every other turn's request is the one it always was. It has what is left of the turn's `JEV_TIMEOUT_MS` after the turn's own request, so the caller waits on the model no longer than on any other turn (a recording, run with a raised `JEV_TIMEOUT_MS`, gives it the same room). If nothing is nominated, no time is left, or the second request fails or is late, the aside asks its own question ("What would you like to know?").

**When the topics are asked.** Only when retrieval nominated something. Nominating is the cheap, fast check that a knowledge question is plausible, so a call that never asks one never pays for the question. A turn on which nothing was nominated asks nothing, and the slot has no value.

**A question nothing answers.** The topic question tells a question none of the nominated topics answers (`unanswered`) from a turn that asks no question (`none`: "I have a question"). A question asked with the request that nothing answers ("does my plan cover cosmetic surgery?") is the slot's miss, said when the form comes to the slot, at once or after the identity its entry needs: the caller hears `ask_<slot>_retry`, never the slot's question as if they had not asked. At the slot's own question, the retry line is said to a question nothing answers, and a turn that says nothing about what the caller wants ("I have a question about my plan") hears the question again; each counts as a try, so three in a row end as any slot's do. So write the retry line to say that nothing answers that, and what can be asked ("I couldn't find anything in your plan information that answers that. I can tell you about things like physical therapy, hospital stays, or fractures. What would you like to know?"). It is the topic slot's `unanswered: retry`, the default; `unanswered: ask` keeps the question from before ([the slot's page](../slots/topic.md#a-question-no-topic-answers)). `kb:gaps` counts a question read as unanswered among the questions nothing answered ([12.9](#129-building-one-from-documents)).

**The budget.** The caller waits on retrieval, so it has 150 milliseconds (`RETRIEVE_BUDGET_MS`, fixed: it is a latency budget, not a threshold you tune). It fails open. A retriever that throws, returns something that is not a list of topics, or is not back in time nominates nothing, the turn goes on without a knowledge question, and the trace says which it was (`failed: 'error' | 'invalid' | 'late'`). The engine's own retrievers answer in well under a millisecond, so the budget is there for a retriever of your own that calls out. The budget bounds a retriever that returns a promise; one that answers synchronously runs to the end before the turn goes on (JavaScript cannot stop it), so a retriever of your own that may take long must be asynchronous.

**Determinism.** The same words, language, day and knowledge base nominate the same topics in the same order with the same scores, on any machine. The nominations shape the model's request, so this is what lets a recorded call replay exactly.

### 12.3 The topic slot

A form that answers from the knowledge base has one `topic` slot. Its value is a topic's id, which is how the completion finds the passage; it never holds an answer.

```yaml
# slots.yaml
subject:
  type: topic
  cap: 4
```

The slot opts in to retrieval, so naming it is what makes a turn retrieve. It asks one choice question over the nominated topics (`subjectTopic`, with each topic's id as a label and `none`), fills when the model's probability for a topic reaches `SLOT_CHOICE_FILL`, and asks "Do you mean {a} or {b}?" when the top two are within `KB_TOPIC_MARGIN` of each other. It says a topic by its title, in the call's language where the knowledge gives one. Its options (`cap`, `accept`, `disambiguate`, `fillAt`, the question's words) and its outcomes are on [its page](../slots/topic.md). `pnpm check` refuses a topic slot in an app with no `kb/`, since it would never ask.

When a caller's words name a task the engine confirms first ("can I park there with my pass?", then "yes"), the topic is read from the topics nominated for the words that named the task, not from the "yes".

### 12.4 Lines the answers are said through

Three lines in `prompts.yaml` (and in every locale), plus the slot's own:

```yaml
# prompts.yaml
prompts:
  ask_subject:
    text: What would you like to know?
    interruptible: true
  ask_subject_retry:
    text: Sorry, what would you like to know about the library?
    interruptible: true
  disambiguate_subject:
    text: Is that about {a}, or {b}?
    interruptible: true
  kb_answer:
    text: '{answer}'
    interruptible: false
  kb_unavailable:
    text: I'm sorry, I don't have an answer to that I can give you right now.
    interruptible: false
```

`kb_answer` says `{answer}` and nothing else: the passage's text, then the account line after a space. `answer` must be among `app.yaml`'s `prompts.dataVars`, because a line that carries a passage is spoken whole. `kb_unavailable` has no variable. A form may name its own two lines (`answers: { answer, unavailable }`). An answer line framed to word its answer for the caller's question has a third, optional line, `kb_hold`, said while a slow wording is finished ([12.13](#1213-answers-worded-for-the-callers-question)).

### 12.5 Answers through the gate

A form that answers says so in `forms.yaml`, and its completion is the engine's, so it has no `complete` hook in code:

```yaml
# forms.yaml
forms:
  ask_library:
    slots: [subject]
    summaryPromptId: null
    answers: { slot: subject }
```

`answers` takes `slot` (the form's topic slot), and optionally `via` (the resolving action, default kb.yaml's `action`), `answer` and `unavailable` (the two lines), `subject` (below) and `midTask` (below). The intent is an ordinary form intent:

```yaml
# intents.yaml
intents:
  ask_library:
    criteria: Asks a question about the library, its cards or its fees
    label: answer a question
    kind: form
```

**About whom: `subject`.** A subject is answered about themselves: the resolving action, and an account line's tool, are sent the caller's own id under the param their `scope` rule names. A delegate (someone acting for subjects, identity.yaml's `delegates`) names whom they ask about: give the form a slot for it, asked of delegates only ([`askedOf`](05-writing-a-slot.md#a-slot-asked-only-of-some-callers-askedof)), and name it as the subject. Its value is then the subject param of both reads, and the gate's scope rule decides whether this delegate may read that subject's answer; a check on the slot (`checks:`, an action with `check: true` and the same `scope` rule) refuses at once, before the topic is asked. A field a delegate may not see (policy.yaml `redact`, such as the count an account line says) leaves the account line out. Without `subject`, a caller who is not a subject is answered about no one (the scope rule refuses):

```yaml
# forms.yaml
forms:
  coverage:
    slots: [clientId, coverageTopic]     # clientId: askedOf: [broker]
    summaryPromptId: null
    hooks: [entry, principalEntry]       # principalEntry: () => null, so a broker makes no entry call of a member's own
    answers: { slot: coverageTopic, subject: clientId }
    checks:
      - action: isClient                 # check: true, rules: [identity, scope: { param: clientId }]
        with: [clientId]
        on:
          scope: { say: coverage_not_client, then: anything-else }
```

`pnpm check` refuses a `subject` that is not one of the form's slots, is its topic slot, or is in an app without identity.yaml.

**In the middle of a task: an aside (`midTask`).** A caller at "Shall I make that change?" who asks "actually, what are your hours?" wants the hours and then the change. So a form with `answers:` is an aside by default (`midTask: aside`): asked for while another form is open, whether the model reads the turn as replacing the task or adding to it, the task is set aside exactly as it stands, the answer is said, and the task resumes where it was. Its question is asked again, or its summary or confirmation, with no attempt counted:

```text
Caller: Tuesday works.
Agent:  It would move to Tuesday, September 22 at 8:30 AM. Shall I make that change?
Caller: Actually, what are your hours?
Agent:  We're open Monday through Friday, from 8 in the morning to 5 in the evening. Tuesday, September 22 at 8:30 AM. Does that work?
Caller: Yes.
```

- **The topic said with the question is the one answered.** The turn of the switch asks the topic in a second, small request on the same words ([12.2](#122-how-a-call-uses-it)), so the caller is not asked "What would you like to know?" after saying it. When the topic cannot be read (nothing nominated, the model chose none), the aside asks its own question, answers, and the task resumes.
- **What else the words said for the task fills it** first, as an informational intent's do ("Tuesday, and what are your hours?").
- **No answer to give** is the same as anywhere else: the `kb_unavailable` line and a person offered, once per call ("...connect you to a person, or keep going?"). Turned down, the task resumes; once declined on the call, the unavailable line is followed by the task's question at once. One behaviour for a missing answer in the middle of a task, whether it came from an aside or an informational intent's passage, and the offer's line already says "or keep going".
- **A turn read as answering the question** is the form's, as for any other intent: an aside is taken for a replacing or an added request only. At a summary it is not: a question read at `INTENT_ROUTE` (0.7) or more is answered as an aside, and the summary asked again, even when the model reads it as answering the read-back ("wait, how long do I have to file a claim?" at "Shall I file the claim?"), unless app.yaml says `questionAtSummary: summary` ([app.yaml](02-the-files-one-by-one.md#appyaml)). An informational intent is answered there the same way. A replacing request is read at the thresholds a switch to another form uses: at `INTENT_SWITCH` it is taken, and between `INTENT_IMPLICIT` and `INTENT_SWITCH` the caller is asked first ("Just to check, do you want to ...?"). An added request is read as a queued one is, on its share of what is not the task in hand, at `INTENT_IMPLICIT`, with no band where it is asked about. Either is asked about first when the request is hedged ("maybe I should ask about parking").
- **A route after the aside** (routes.yaml `afterForm` on the answering form) runs when the aside is done, before the task resumes. One that ends the call, hands it to a person or goes to "anything else?" ends the task too, unfinished, so `pnpm check` warns of it; `continue`, with or without a line, is the usual one.
- **In the aside**, asking for the task again ("never mind, let's do the reschedule") goes back to it where it stood; asking for another task gives the one set aside up, as a replaced task is. A handoff in the aside (a person asked for, the offer for a question with no answer accepted, a frustrated caller) names the task set aside first in the handoff's `queued`, with what it collected in its slots, and its transfer target is chosen on that task, not on the question.
- **A summary's yes said with the question** ("yes, and what are your hours?") is not taken: the answer is said and the summary is asked again, so nothing is written on a yes the caller said before hearing the answer.

`midTask: task` keeps the form a task like any other: a replacing request replaces the form in hand (gone after the answer), an added one is queued after it, and its topic is asked once it is open. Its turns make the one request they always made. Choose it only for a form whose answer ends the task, which is rare.

```yaml
# forms.yaml
forms:
  ask_library:
    slots: [subject]
    summaryPromptId: null
    answers: { slot: subject, midTask: task } # aside (the default): the task resumes after the answer
```

**The resolving tool.** The action kb.yaml names is a tool in the app's code with an action in `policy.yaml`, like any other: the gate decides whether it may run, and the rules you give it (`identity`, `scope`, ...) apply as to any read. The engine ships the tool for an app with a `kb/` folder:

```ts
// src/app.ts, in code.tools
findPassage: kbAnswerTool({
  facts: (_params, sys) => {
    const kind = (sys as LibrarySystems).cardKind; // read from the library's records, never from what the caller said
    return kind === null ? null : { card: kind };
  },
}),
```

and its action in `policy.yaml`, with its `topic` param declared under `audit:` like every param that is not a slot:

```yaml
# policy.yaml
actions:
  findPassage:
    level: 0
    rules: [identity]
audit:
  topic: keep
```

- **The facts are read by code.** `facts(params, systems, turn)` returns the caller's value for each fact kb.yaml's `applies` names, read from the system of record. They are never taken from what the caller said, since a caller who says "I have a junior card" does not get the junior answer. It returns null when there is no record to read them from (no passage: `no-facts`). Without `facts`, only a passage that applies to every caller answers.
- **The params** are `topic` and, when the answer is a subject's (the action's `scope` rule names a param), that param first: `kbAnswerTool({ subject: 'cardNumber', facts })`. The completion fills it with the subject's id from the session, where the scope rule names one.
- **When there is no answer** the tool says why: `unknown-topic`, `not-in-force`, `no-translation`, `ambiguous`, `stale` (with the withheld passage's record), or `no-facts`. Whatever the reason, the caller hears the `kb_unavailable` line and is offered a person. A yes to that offer, plain or "yes, connect me to someone", is a handoff for a person (`live-agent`, its `handoff_live_agent` line), not a frustrated caller's: the caller asked something there was no answer to. A refusal by the gate is the engine's usual one.
- **An app that resolves answers in its own code** gives a tool of its own that returns the same shape (`{ answer, source }` or `{ unavailable }`, with `source` the knowledge record `kbSourceOf` builds). A `complete` hook may also delegate: `complete: kbCompletion({ slot: 'subject' })`.

**Account lines.** A topic may add a line from the caller's own data after the approved answer: "Your card has 2 dollars in late fees right now." It is `accountLine` in topics.yaml (and each locale's wording): its `text` has `{variables}`, and `from` is a second gated tool that reads the caller's data. That tool is an ordinary read with its own action in `policy.yaml`, declaring the `fields` its result has (`ToolDef.fields`), and every variable of the line must be one of them. The line is said only when the read is allowed and has a value for every variable; a refused read, a record with nothing in it, or a missing field leaves the line out and the answer is said alone. A line is never said with a gap in it. The approved answer is the same either way, and the account line's text is part of what an approval covers.

### 12.6 Informational passages

For an answer that is the same for everyone and needs no question, an informational intent can name a passage instead of a prompt:

```yaml
# intents.yaml
intents:
  hours:
    criteria: Asks when the library is open
    label: hear the opening hours
    kind: informational
    passage: opening-hours
```

There is no retrieval and no gate: the passage in force today for that passage's topic, in the call's language, is said through `kb_answer`. It keeps what the knowledge base adds to a fixed line: approval, staleness, effective dates and a variant for each language. Because there is no gate and so no facts about the caller, no passage of its topic may apply to some callers only (`check` says which); use a form that answers for that. An intent names the passage of the default language, and a call in another language hears its translation. It may also be a key on the keypad menu. When it cannot be said (not in force, stale, no translation), the caller hears `kb_unavailable` and is offered a person once per call; declining returns them to the question they were on.

### 12.7 Locales and fallback

A language has its own wording for each topic (`kb/locale/<tag>/topics.yaml`: title, keywords, example questions and account line text, for the topics it words) and its own passages (`kb/locale/<tag>/passages/`, each with `translates:` naming the default language's passage of the same topic). The tag is one the app speaks, with a `locale/<tag>/prompts.yaml` ([section 8](08-locales.md#8-locales)), and the examples in [12.1](#121-the-folder) are a Spanish pair.

- A call hears the passages of the language the session chose, and retrieval reads a topic's wording in that language, falling back to the default's wording for a topic that has none.
- **Fallback** is kb.yaml's `localeFallback`. `none` (the default) says nothing when a topic has no passage in the caller's language: the answer is unavailable and a person is offered. That fails closed, which is right for regulated text, since a translation is something a person approved. `default` speaks the default language's passage instead. Choose it only where hearing the other language is acceptable.
- A translation is approved like any other passage, against the same source section, and goes stale the same way: changing the section withholds the default and every translation until each is approved again.
- Questions to the model are never translated: the topic question's labels are topic ids and its instructions are in English, as for every slot.

### 12.8 Approval, staleness and withholding

A passage is said only while it is approved and nothing it was approved over has changed. Its `approval` records the content's owner (a team), the person who approved it, the day, and two hashes: `sourceHash`, of its source section's text, and `hash`, of everything approved: the passage's `id`, its locale (the `kb/locale/<tag>` it is in, or the default), its `version`, the topic, the topic's title (in the default locale, and in the passage's own where that locale gives one), the answer, `applies`, the effective dates, the source text and the topic's account line. Whitespace aside, any change to one of them makes the passage **stale**. A topic's title is spoken (the topic question offers it, and a caller asked which of two topics they meant hears both), so renaming a topic sends its passages back for review; and an approval copied with its file to another id or locale does not hold there. At run time a stale passage is **withheld**: the caller hears the unavailable line and is offered a person once, and the trace records the passage with `fresh: false`. `pnpm check` fails on a passage that is stale or was never approved, and on an approval with no line of its id and hash in `kb/approvals.jsonl` (written by hand or copied, not by `kb:approve`, so no one is on record for it); its fix names the two commands below.

- `pnpm kb:status [app folder]` lists the passages by state: approved and fresh; approved outside `kb:approve` (no line in the log); stale because the source section changed; stale because the passage was edited (`git diff` shows the edit); never approved; and the drafts in `kb/pending/`. Each comes with its fix.
- `pnpm kb:approve <id...> --by "<your name>" [--owner "<team>"] [--dir <app folder>]` approves each passage as it is now, after a person has read it against its source. It first asks you to confirm at your terminal (the ids, your name, the team, and that you read each against its source); where there is no terminal (a script, a pipe, an assistant's shell) it refuses, unless `--yes` confirms on the command line, and `--yes` is refused when `CI` is set. It writes the `approval` in place, keeping the file's comments and layout, and appends one line to `kb/approvals.jsonl` (`id`, `version`, `approvedBy`, `owner`, `on`, both hashes, `from`: `passage` or `pending`, and `sourceText`). `--owner` is needed the first time; a re-approval keeps the owner unless `--owner` says otherwise. A passage approved outside it is approved again the same way, which puts a person on record for it.
- A draft is approved by id too: `kb:approve` checks it as the passage it would be and moves it into `kb/passages/` (or `kb/locale/<tag>/passages/`), dropping `drafted`.
- `kb:approve` writes nothing for an id it refuses. It refuses an id that is no passage or draft, a passage that would fail `pnpm check` for anything but its approval (an unknown topic or source, a variable in the answer, an overlap with another passage, a locale the app does not speak), a draft with no excerpt, or one not in its section word for word, shorter than 4 words and 20 characters, or missing a number its answer says (as `kb:draft` and `kb:review` hold an excerpt), and a `--by` that names no person. **An assistant or a tool may draft a passage, and only a person approves one.**
- An app moving approved content from an earlier format may carry its approvals over with a script of its own: one line per passage with `from: migration`, the original `approvedBy`, `owner` and `on`, the hashes taken under this format, and a `note` that says what the original approval covered and what its owners are to confirm. `kb:status` marks those passages `(migrated: <note>)` for as long as they stand on that approval, and the people who own the content confirm the migration in review: `kb:review` lists them under "Approvals to confirm", and a passage's "Confirm this approval" appends a line under the reviewer's name (`from: passage`, the same hashes) without changing the passage. The log is appended to, never rewritten: when the hash's definition changes, the migration is taken again as new lines, and the last line with a passage's id and hash is the one that stands.

The files an approval stands on are the ones `CODEOWNERS` should protect ([3.12](03-policy-and-identity.md#312-who-reviews-it-codeowners)): the passages, their sources, the topics, `kb.yaml` and the approvals log. Drafts are left open, since a draft is never said and approving it changes `kb/passages/`.

### 12.9 Building one from documents

Answers scale only if they are cheap to make, so the knowledge base has an authoring pipeline, in its own package (`@dialogwright/kb-author`, which an app never imports and the engine does not depend on). It never runs on a call. Every step before the last is a proposal, and the last is a person. Start from an app whose `kb/` already has `kb.yaml` and `topics.yaml` ([12.1](#121-the-folder)): `kb:ingest` writes `kb/sources` into any app folder, but until those two files exist `pnpm check` reports each as missing and `kb:status` does not take the folder as a knowledge base.

```sh
pnpm kb:ingest docs/ --dir apps/my-app                                  # 1. documents or a website into kb/sources
pnpm kb:draft apps/my-app                                                # 2. a model drafts passages into kb/pending
pnpm kb:review apps/my-app                                               # 3. a person approves, edits or rejects each draft
pnpm kb:approve <id...> --by "<your name>"                               #    (the same approval, from the command line)
pnpm kb:refresh apps/my-app                                              # 4. read the sources again; withhold what changed
pnpm kb:gaps apps/my-app [--traces traces/*.jsonl] [--since 2026-10-01]  # 5. what callers asked that nothing answered
```

**Ingest.** `kb:ingest <folder | file | url> --dir <app folder>` reads PDF, DOCX, HTML, Markdown and text files, or a website to a link depth (`--depth`, default 1; `--include '/help/**'` narrows it), and writes each document as `kb/sources/<doc>.yaml`: its title, its provenance (its URL, or its file's path from the app folder, and the day it was read) and its text by section. Sections are cut at headings (h1 to h3, a DOCX's Heading 1 to 3, Markdown's `#` to `###`, a PDF's larger or bold type; a PDF's headers, footers, page numbers, footnote markers and contents page are dropped, its cover read as its title, and its tables read row by row with their columns' headings, so a booklet's benefits grid says which figure is which: [the package's README](../../packages/kb-author/README.md)) and named by the heading path (`late-fees`, `shifts/training`); a PDF's section records the page it starts on (`page`, `lastPage`), and a PDF without headings is cut by page. A website is crawled politely: the start page's host only (unless `--allow-host`), robots.txt followed, one request a second (`--rate`), at most 50 pages (`--max-pages`), no cookies or sign-ins; linked PDF and DOCX files are read too. It reads only public addresses: a host on a loopback, private, link-local or other non-public network is refused (each host resolved before each request, and the connection pinned to the address checked), unless `--allow-private` names a site on your own network. A file is read only up to its limits (50 MB; a DOCX's zip at most 50 MB uncompressed and checked before it is opened, so a zip bomb is refused; a PDF at most 500 pages, opened with code evaluation off). Re-ingesting is safe: the same documents give the same bytes, an unchanged document is not rewritten, and each run says per section what was added (`+`), changed (`~`) and removed (`-`). `--dry-run` shows it without writing. A source written by hand is never overwritten. Crawling is for you to run; it never runs in CI.

**Draft.** `kb:draft` gives each source's sections that nothing cites yet (no passage, draft or rejected draft; `--all` for every section) to a drafter: by default Claude through the Messages API, with **your own** `ANTHROPIC_API_KEY`, from the environment or from a `.env` file where you run it (the file is git-ignored; never commit a key, and never put one in CI, a test or a fixture). The default model is `claude-haiku-4-5`; `--model` takes another, and `--topic-hint "<what to cover>"` steers it. It proposes, for each answer a document supports, a topic (one `topics.yaml` has, or a new one with a title, keywords and example questions), a spoken answer of one or two sentences, and the exact words of the section that support it. Every draft is checked before it is written, and a draft that fails is reported with its reasons and never written:

| Check | Why |
|---|---|
| the excerpt is in the section word for word | the answer is held to what the document says |
| the excerpt is at least 4 words and 20 characters, and says every number the answer says (amounts, times, dates, counts in figures) | an answer cannot hang a fee or a date on a fragment that does not hold it |
| the answer is within `maxAnswerChars` and has no brace | a spoken answer is short, and is fixed text |
| the topic is one that exists, or a new one proposed with a title | a draft cannot name a topic out of the air |
| `applies` and dates are ones kb.yaml allows | the passage can be resolved |
| it does not repeat another passage's or draft's answer | no near-duplicates |

A draft that passes is `kb/pending/<id>.yaml`, and a new topic goes to `kb/pending/topics.yaml`, never to `topics.yaml`. Drafting is pluggable (a `Drafter` is `{ id, draft(request) }`; the tests use a fake), **never runs in CI** (`kb:draft` refuses when `CI` is set), and nothing pending is ever said. A model can be wrong; the excerpt check proves the answer cites the document, not that it says what the document means, which is what the person reviewing is for.

**Review.** `kb:review` starts a small server on 127.0.0.1 on a free port (`--port` for a fixed one) and prints its URL with a one-time token that every request needs. It answers only this machine and stops with Ctrl-C. It is not the operator console: the console's sign-in (`CONSOLE_AUTH=token`, section 14) is for one owner watching calls, with no roles to say who may approve what callers are told, so a page that approves stays on this machine. The page lists the proposed topics, the drafts, the passages withheld (stale or edited) and those approved outside `kb:approve` (fresh, but with no line in `kb/approvals.jsonl`, which `pnpm check` refuses), each beside its source section with the excerpt marked, and, for a source that changed, a word diff of the section as it was approved (read from `kb/approvals.jsonl`) against the section now. It asks each browser once for your name and your team (kept in a signed, HttpOnly session cookie, so another browser is another reviewer), then you can: approve (it is `kb:approve` itself); edit, then approve (the answer, `applies`, the dates and a draft's excerpt, checked as a draft is); reject (the draft moves to `kb/rejected/<id>.yaml` with who, when and why); and for a proposed topic, accept it into `topics.yaml` with its title as you review it (callers hear a topic's title when the topic question offers it), under another id if you rename it (its drafts follow), or merge it into a topic the knowledge base has. A draft of a proposed topic is approved after its topic. Every change carries a hash of what its page showed, and is refused when the file or its source section changed since it was opened (reload and review it again). Every page reads without JavaScript, and every field has a label. After accepting topics in an app with an embedder, run `pnpm kb:index`.

**Refresh.** `kb:refresh` reads every source again from its provenance (the file, or the crawl with the settings it had) and writes those that changed, nothing else. It reads a file only inside the app folder (a `../`, absolute or linked path out of it is refused), reads a URL only through the crawler's public-address check (`--allow-private` for your own network), and prints the hosts it will ask before it asks them. It lists the passages now withheld because their section changed (review them in `kb:review`), those whose section is gone (point them at the section that says it now, or delete them), and the sections nothing cites, to draft from with `kb:draft --source <doc>`. A source written by hand, or whose file is gone, is left alone and listed.

**Gaps.** `kb:gaps` reads the traces of real calls (`--traces`: a file, a folder or a glob; by default `$TRACE_DIR`, else the app's `traces/`, else `./traces`) and ranks what callers asked that the knowledge base did not answer: a topic question answered `unanswered`, or `none` on words that read as a question; words that look like a question with no topic nominated; a passage that could not be said (stale, not in force, no translation, no facts); and a close call between two topics. They are grouped by the nearest topic and ranked, each group with a few of the callers' words and the fix for each kind it holds: write a passage, draft from a source section nothing cites, re-approve the stale passage, add a translation, add keywords or asks to the topic. The words are the traces' own, so keep a report as private as the traces; a turn on which an identity value was masked is counted but its words are not shown. The review page has the same list as its Gaps tab. What counts as a gap is the engine's, exported from `'dialogwright'` for a tool of your own: `gapTurnOf(record, file, line)` (`gapTurnsOfLines` for a trace's lines) reads a trace record as a turn (`GapTurn`, the caller's words, what retrieval nominated, the answers, the slots masked), and `collectGaps(turns, context)` returns the gaps (`Gap`, of a `GapKind`, with its nearest topic) and what it counted (`GapCollectStats`); the context gives the app's topic slots, its informational intents and a nearest-topic function (`GapCollectContext`), and `looksLikeQuestion`, `topicQuestionOf`, `GAP_KINDS` and `QUESTION_WORDS` are the pieces it is made of. The console's Insights and Knowledge pages count them by the same rules, by their nearest topic and never with the words ([14.9](14-running-it.md#149-looking-at-calls-from-your-phone)). An app with a slot whose `redact` is `length-summarized` keeps every caller's words by their length in its traces ([16.3](16-generated-wording.md#163-summarizing-what-a-caller-said-a-framed-line)), so none of these finds its callers' questions: no gap is found by its words, and one read from the answers alone shows its words by their length.

[The package's README](../../packages/kb-author/README.md) has the extraction, crawling, drafting and review rules in full.

### 12.10 Retrieval settings

Unless the app's code gives a retriever of its own (`code.knowledge.retriever`, an object with an `id` and `nominate({ text, locale, todayIso })` that returns `{ topic, title, score, via }` entries, deterministic and quick), the engine's is used, set in kb.yaml:

```yaml
# kb/kb.yaml, with an embedder
action: findPassage
applies:
  card: [adult, junior]
retrieval:
  cap: 8                    # the most topics a turn offers (default 8)
  embedder: potion-base-8M  # optional: also find topics by meaning, not only by their words
  floor: 0.3                # optional: the similarity below which a topic found by meaning is not offered
```

- **Without `embedder`**, topics are found by their words alone: BM25 over each topic's title, keywords and example questions, with a boost for a keyword said whole. Accents and common endings are folded, and greetings and question words are ignored.
- **With `embedder`**, the same keyword search runs beside a dense one, and the two rankings are merged by reciprocal rank fusion. A topic found by meaning counts only at `floor` or above (default: the model's own); a keyword match always counts. The model is potion-base-8M, a static model run in TypeScript: about a hundredth of a millisecond per question, and the same numbers on every machine, so a recorded call replays exactly.
- **The index.** Every topic's vectors are in `kb/.index/<embedder>.json`, which you commit. Write it with `pnpm kb:index [app folder]` after any change to `topics.yaml` or a locale's wording; it embeds only the texts that changed, and gives the same bytes for the same topics. `pnpm check` reports a topic whose texts the index no longer matches, with the fix.
- **The model.** The weights are not in the repository: `pnpm kb:model` downloads them once, at a pinned revision, checks each file's SHA-256, and keeps them in `~/.cache/dialogwright/models` (or `$DIALOGWRIGHT_MODEL_DIR`). `kb:index` downloads them when they are missing. A call never downloads anything: an app whose weights are not in the cache retrieves by keywords alone, and the trace's `retrieverId` says so (`keyword` rather than `hybrid:potion-base-8M`).
- **A fallback is said.** When kb.yaml names an embedder and the engine's retriever is keywords alone all the same (the weights not in the cache, or not the pinned ones; the index missing, not an index, or another model's), `defineApp`, `defineKnowledge` and `registerApp` warn on stderr with the reason and the command that fixes it. With `NODE_ENV=production`, or `DIALOGWRIGHT_REQUIRE_EMBEDDER=1`, `registerApp` throws instead, so a server does not start without retrieval by meaning. `pnpm check` stays independent of the model cache: it reports the index, never the weights, and says nothing of a fallback.
- **Choose `cap` and `floor` offline, never by re-recording calls.** They change what the model is asked, which re-keys a recording. Write a paraphrase set ([12.11](#1211-testing)) and run `pnpm kb:bakeoff <app folder> --paraphrases fixtures/kb/paraphrases.yaml --sweep`. It reports each retriever's recall at the cap (the share of a topic's paraphrases whose nominations include it), how many topics it offers per question (and per question about nothing), and its speed; the sweep then shows recall against candidates for every floor and cap, so a floor is picked by what it costs.
- **ONNX.** A larger model (bge-small, through the optional `@huggingface/transformers`) is available to code as `OnnxEmbedder` from `dialogwright/kb/onnx`, used with `HybridRetriever`, and the bake-off includes it when the package is installed and `--onnx-revision <commit>` names the model's commit. `OnnxEmbedder.create({ revision })` needs that commit (40 hex characters): there is no default, since a branch such as `main` moves under a committed index. It is not the default: it is a large native install, and its numbers can differ in the last bits between machines.

An app that keeps a retriever of its own and later moves to the engine's hybrid one changes the topics some turns offer, so it re-records the calls those turns are in. Plan that as a deliberate step.

### 12.11 Testing

- **Paraphrase sets.** `fixtures/kb/paraphrases.yaml` maps each topic id to things callers say about it in words other than its own title, keywords and example questions, and `none:` to things no topic answers:

  ```yaml
  # fixtures/kb/paraphrases.yaml
  opening_hours:
    - What time do you close tonight?
    - Is the library open on Saturday mornings?
  late_fees:
    - I returned a book late, what do I owe?
    - How much do you charge for overdue DVDs?
  none:
    - Where do I park?
    - I would like to speak to a librarian.
  ```

  Collect them from real wording, from the people who answer the phones, and from `kb:gaps`, and write at least eight for each topic. `pnpm kb:bakeoff` reads the file, and an id that is not a topic is an error.
- **The recall test.** A test of the app's own that holds retrieval to its paraphrases, so a change to a topic's wording or a retriever's settings that loses recall fails in CI instead of on a call:

  ```ts
  // src/kb.test.ts
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { expect, it } from 'vitest';
  import { bakeoff, defaultRetriever, loadKnowledgeFolder, parseParaphrases } from 'dialogwright';

  const APP = fileURLToPath(new URL('..', import.meta.url));

  it('nominates the right topic for what callers say', async () => {
    const kb = loadKnowledgeFolder(`${APP}kb`).kb!;
    const paraphrases = parseParaphrases(readFileSync(`${APP}fixtures/kb/paraphrases.yaml`, 'utf8'), kb);
    const result = await bakeoff(defaultRetriever(kb).retriever, paraphrases, 'en-US', '2026-10-03');
    expect(result.recall).toBeGreaterThanOrEqual(0.9); // the floor you chose from the sweep
    expect(result.noneCandidates).toBeLessThanOrEqual(2); // few topics offered for questions about nothing
  });
  ```

- **Goldens.** Write each retriever's nominations for every paraphrase to a file you commit and compare it in a test, as the engine does for its own fixture. A change to a keyword or a floor then shows as a diff of what is offered, to read and accept. Write it deliberately, never to make a test pass.
- **Turns.** To test a form that answers, `fixedRetriever` from `'dialogwright/testing'` nominates exactly what a test says for given words, and a call's answers are written out as for any slot ([the corpus guide](../../.claude/skills/create-app/corpus.md) labels the topic question). The stub regression runs the app's real retriever, so a corpus line about a topic exercises nomination, selection, resolution and speaking against the baseline.
- **State.** `pnpm check` is the test of the knowledge base itself: every passage approved with matching hashes, a passage in force for every topic and every combination of facts, no overlaps, every link to the app, the index current.

### 12.12 What is recorded

- **The trace** has `retrieval` on each turn retrieval ran: the retriever's id (`hybrid:potion-base-8M`, `keyword`, or your own), the SHA-256 of the index it read, the topics it nominated each with score and `via`, and `failed` (with `message` for an error) when it nominated nothing because it did not answer as asked. The turn's timing has `retrieveMs`.
- **The second request** of a turn a question interrupted a task on is `followUp` in its trace record: why it was made (`aside-topic`), the slot, its questions and answers, where they came from, and the error when it failed (the turn went on without it). Its tokens and cost are in the turn's `usage`, its time is `timing.followUpMs` (folded into the regression's ask latency and the console's Health latency, as the time the caller waited on the model that turn), a cassette keys it by its own state and question (recorded and replayed like any request; a miss on it is a cassette miss), and the console's call detail notes it beside the turn's own. `kb:gaps` reads its topic question as the turn's.
- **The knowledge record** is on the turn that answered (`kb` in the trace, `TurnOut.kb`) and on the console's source card: the passage, its version, the facts it answered for (`applies`, only those it depends on), its language, the source document and section, the days it is in force, who approved it and when, the first 12 hex characters of both hashes, and `fresh`. A passage that was withheld has its record with `fresh: false`. It is never part of what the model is asked.
- **The audit** has a `kb_answer` row for each answer: the passage's id, its version, whether it was fresh, its language and the short hashes. It holds nothing of the caller's. Where a wording of the passage was said ([12.13](#1213-answers-worded-for-the-callers-question)), a `kb_worded` row follows, naming the passage, its version and its approval's short hash; a wording that fell back has the generated wording's `render_fallback` row instead.
- **What was said of it**, on a turn whose answer line words its answer: the knowledge record's `said` (`passage` or `worded`), shown on the console's source card, and the trace's render line for the answer, with the wording beside the approved passage it stands for (`fixed`), the passage's id, and why the passage was said where it was (the topic regulated, a check or the judge, too slow).
- **The configuration hashes** include every file of `kb/` that is read (kb.yaml, topics, passages, sources and the locale files), so a call is tied to the exact knowledge it ran under. Drafts, rejected drafts, the approvals log and the index are not in them; the index's own hash is in the retrieval record.

### 12.13 Answers worded for the caller's question

A passage is written once for every caller who asks about its topic, so it answers the topic, not the question, and it is as long as its fullest case. On the topics you choose, a model may word the approved passage for the question the caller asked: "does it cover the ambulance if I hurt myself skiing?" hears the yes first, and only what bears on it. Two switches, both required; with either off, the passage is said word for word, as always.

1. **The topic allows it.** In `kb/topics.yaml`, `risk: low` (the default is `regulated`). Which topics are low risk is your call, never the framework's: a topic whose answer describes what is done (where a plan applies, which activities, a deadline) is a candidate; one whose answer is a regulated term (a benefit's amount, an exclusion with conditions) may well not be. `risk` is not part of what an approval covers, so marking a topic low sends nothing back for review.
2. **The answer line asks for it.** The form's answer line frames its `{answer}` as a span worded from the answer:

```yaml
# prompts.yaml
prompts:
  kb_answer:
    text: '{answer}'
    interruptible: false
    generate:
      answer:
        from: answer        # the approved passage, as resolved for this caller
        goal: Answer the caller's question from the passage, in a sentence or two.
  kb_hold:                  # optional: said before an answer whose wording is slow
    text: One moment while I gather that information.
    interruptible: false
```

`from: answer` names the passage the knowledge completion resolved for this caller, rather than a slot. `pnpm check` holds it to a form's answer line (`answers.answer`, default `kb_answer`), as the line's `{answer}` itself, never prescribed, and warns where no topic is `risk: low`. The span's `words` defaults to the passage's word count and a quarter more (ten more at least), so a long passage's answer is never cut to fit a short budget and a faithful wording may take a few more words than the passage; set it to ask for something shorter. The topic's account line (the caller's own data) is never sent to a model: it is said after the wording word for word, as it is after the passage.

**What the model is given**: the goal, the sentence the answer is said in (the line's own words, the answer a gap), the approved passage as it would be said (the only facts there are) and the caller's question in their own words (the words the topic was heard in, kept on the topic slot, never words said at a sensitive question, and screened again for an injection before they are sent). Nothing else: no record, no other passage, no transcript. An informational intent's passage ([12.6](#126-informational-passages)) has no question kept, and is said word for word.

**What holds it to the passage**: the checks of [16.6](16-generated-wording.md#166-the-checks-the-judge-and-the-fallback), with the passage as what it was given (no figure the passage does not have, the caller's question being no source of facts; no question; the budget; style.yaml's `avoid`), then the drift judge, which is given the goal, the passage, the question and the wording heard in its line, and refuses one that says anything other than what the passage says for that question: anything added (a name, a company or a place among it), anything changed or turned around, or a condition, a limit or an exclusion that bears on the answer left out.

**Say in the goal what the answer must keep.** The judge refuses a wording that leaves out a condition that bears on the answer, so a goal that asks only for something short invites a wording it will refuse, and the caller then hears the whole passage. On Harbor Mutual's live call of 2026-10-17, "You have 180 days from the date of your accident to file a claim." was refused: the passage says a claim sent later may still be reviewed, but payment isn't guaranteed. Its goal now says what the answer is for: "Answer the member's question from their plan's passage, in a sentence or two, keeping anything the passage says that changes the answer." That is a goal, what the answer must do, not instructions for its words: a model is given the goal and the full context, never a procedure.

**The fallback is the passage**, word for word, whenever a check fails, the judge refuses, the model errs, or the wording and its checks are not done within `RENDER_ANSWER_TIMEOUT_MS` (4 s on a call and 6 s in a chat by default, [14.12](14-running-it.md#1412-the-options)). When they run past a line's own budgets (the wording's and the checks'), the caller first hears the hold line, `kb_hold` (or, where the app has none, the engine's "One moment while I gather that information."), and then the answer, or the passage. The hold line is said only in a language the app gives it in: a locale's own `kb_hold`, or the engine's words for a call in English. In a language with neither, no hold line is said and the answer has only a line's budget, so the caller never waits in silence (`pnpm check` warns of such a language).

What is recorded is in [12.12](#1212-what-is-recorded); the policy card lists each answer line that may be worded, its goal and the topics marked low. Harbor Mutual is the worked example ([its worksheet](../../apps/harbor/DESIGN.md), "Knowledge"); the design and the maintainer's decision are [docs/designs/2026-10-16-kb-summaries.md](../designs/2026-10-16-kb-summaries.md).

### 12.14 Answers from approved documents

A passage is the answer to a topic, written and approved one at a time. For content nothing regulates (a member handbook, a library's visitor guide, an office's how-tos) that is more than it needs: an app may answer from the documents themselves, where no topic answers, once a person has approved each document for summarizing. It is the third kind of knowledge, beside a regulated topic (its passage word for word) and a low-risk one (its passage worded, the passage its fallback): the lowest risk, content not important enough to write a passage for. It fills in around the other two; where a topic answers, its passage wins ([the design](../designs/2026-10-17-kb-documents.md)).

**Turn it on** in kb/kb.yaml, and say through which line such an answer is said:

```yaml
# kb/kb.yaml
action: searchPolicy
documents:
  summarize: on
  cap: 3            # how many sections retrieval nominates (kb:bakeoff --sections --sweep)
  floor: 0.3
```

```yaml
# prompts.yaml
prompts:
  kb_documents_answer:
    text: '{answer}'      # said when the answer cannot be worded: the not-found line, by default
    interruptible: false
    generate:
      answer:
        from: sections
        retry: 1          # once more when the judge refuses (measure it first: below)
        goal: Answer the caller's question from the sections, in a sentence or two.
```

**A person approves each document, once.** `pnpm kb:approve --document <doc> --by "<name>" --owner "<team>"`: they have read it whole, and callers may hear answers worded from its sections. The approval holds the document's hash (its title, its applies, and each section's heading, text and `summarize`); a changed word withholds the whole document until a person approves it again, and `pnpm kb:status` lists it with its fix. A document never approved is never answered from; `pnpm check` warns of each, once summarizing is on.

**A long document** (a benefits booklet of a hundred pages and more, hundreds of sections) is harder to find in than a short one: a question's words match many sections, and the right one must be among the few the decision model is asked of. Measure it with `pnpm kb:bakeoff <dir> --sections <file> --sweep` on paraphrases of the sections callers ask about (a line may name the other sections that answer it as well, `{ say: "is an x-ray covered", also: ["booklet#diagnostic-x-ray"] }`, so a cost said in a summary and the rules said in a chapter both count), then choose:

```yaml
# kb/kb.yaml
action: answerQuestion
documents:
  summarize: on
  cap: 6                 # more sections asked of: more found, a longer request
  floor: 0.65
  retrieval: dense       # by their meaning alone; hybrid (the default) fuses their keywords too
  embedder:              # a contextual model of the sections' own, in place of retrieval.embedder
    onnx: Xenova/bge-small-en-v1.5
    revision: ea104dacec62c0de699686887e3f920caeb4f3e3   # the model repository's commit
```

**Questions that find a section.** A document says "late fees" where a caller says "overdue fine" (a benefits booklet says "Tier 1" where a caller says "generic"), and a section under a long parent can rank below its parent. `kb/sections.yaml` gives a section the questions callers ask that it answers, in their words, and keywords, as `topics.yaml` gives a topic, by `<document>#<section>`:

```yaml
# kb/sections.yaml
"patron-guide#3.1":
  asks: [what is the fine for an overdue book, do I pay if I bring a book back late]
  keywords: [overdue fine]
```

Retrieval reads them beside the section's text (`pnpm kb:index` after a change); they are never said, so a document's approval does not cover them and adding one needs no approval again. Add them where a question's right section was not offered: `pnpm kb:gaps` lists what callers asked that nothing answered, and `pnpm kb:bakeoff --sections` measures a change. `pnpm check` refuses a key that names no section. On the booklet above, questions for 23 of its sections took 30 questions written after them (held out) from 70% to 93% with the right section among the six nominated.

**Plain words in place of jargon.** A booklet's tables say "CYD" and "Non-Participating Provider"; a caller knows neither, and neither does the decision model asked whether a section answers. `kb/glossary.yaml` says the words heard in their place:

```yaml
# kb/glossary.yaml
CYD: calendar year deductible
Non-Participating Provider: out-of-network provider
Participating Provider: in-network provider
```

A term matches as a whole word or phrase (a hyphen joins words), its case as written, the longest first, in one pass. The glossary's words are what the sections answered from by summarizing say everywhere they are read: the section question, the index, the wording and its judge, and the opening said when a wording fails. A source file keeps the document's own words (its provenance, a refresh), and an approved passage is said as approved, never replaced: write it plain. A document's approval covers its sections as replaced, so a change of the glossary that reaches one withholds it until a person reads it and approves it again (`pnpm kb:status` lists it); with no glossary, nothing changes.

`documents.embedder` is opt-in: the app installs the optional package it runs on (`pnpm add @huggingface/transformers`, some hundreds of megabytes), `pnpm kb:index` writes the sections' vectors to an index of their own (`kb/.index/onnx-<model>.json`; the topics keep `retrieval.embedder`'s), `pnpm check` holds that index to the sections' texts without the package, and the server loads the model when it starts (a model that cannot be loaded leaves the sections' keywords). Its vectors can differ in their last digits from one machine to another, which can move a section near the floor in or out of the nominations and so change a recorded request: build the index and record the cassette on one machine. On a 123-page booklet (291 sections, 114 paraphrases of 38 of them), the right section was among the six nominated for 75% of the lines with the static model and keywords, 86% with bge-small fused with keywords, and 88% with bge-small alone (keywords on common words crowd the right section out of a long document).

**What is never summarized:** a section a passage cites (the passage speaks for it, word for word or worded with its own fallback); a section marked `summarize: false`; and any section of a document whose top says `summarize: false` (a certificate that is only the source of regulated passages, say), which needs no approval and is never warned of. A document may say whom its answers are for (`applies`, as a passage does), read from the system of record by code.

**On a call:** with summarizing on, retrieval nominates sections beside the topics (their headings and sentences are in the index: `pnpm kb:index`), and the topic slot asks, in the turn's own request, one yes-or-no of each: does this section say what the caller asks about? Where no topic fills and the caller asked something (not "I have a question"), the sections read yes at `KB_SECTION_ANSWERS` (0.55) or above, at most two, are the answer's. The knowledge tool resolves them through the gate as it resolves a passage (each still approved, each document applying to the caller, the call in the default language: sections are not translated), and the answer is worded from them, held to them by the checks (no figure they do not have, the word budget, 60 by default) and the documents drift judge, with the caller's question. Its record names the document and sections (`passageId: document:<doc>`, `from: documents`), as does the audit's `kb_worded` row.

**When it cannot be worded** (a check fails, the judge refuses, the model errs or is late, or no model is configured), the line's own text is said: forms.yaml's `answers.documents.onFail` says what that is, `not-found` (the default: the not-found line below) or `opening` (the best section's first sentences word for word, in the `kb_documents_opening` frame, "Here's what our guide says: {opening}", where the app has it). The sections themselves are never said as they are.

**A question nothing answers** (no topic, no section) gets the not-found reply, where the app has `kb_not_found`: that line in turn through its variants, then the guide to what can be asked (`kb_guide`) the first time on the call and again after two such replies in a row without it (the topic slot's `notFound.remind`), then the slot's question. It is not counted as a try by default (`notFound.counts: false`, the maintainer's decision of 2026-10-17): the knowledge base lacked it, the caller did not fail, so they may ask as often as they like; an app that wants a limit sets `counts: true`, and three in a row end as any slot's misses do. Without `kb_not_found`, the slot's retry line is said, as before.

**While it is worded:** an answer from documents has a longer limit (`RENDER_DOCUMENTS_TIMEOUT_MS`: 6 s on a call, 8 s in a chat). Past a line's budgets the caller hears the hold line (`kb_hold`, in turn through its `variants`); past half the limit, where the app has it, a second (`kb_hold_more`, with its own variants), so a long wait is never silence. Both go to the caller as soon as they are due, on both carriers and in a chat.

**Measure it before turning it on:** the section retriever on paraphrases of what each section answers and of questions none does (`pnpm kb:bakeoff <dir> --sections <file> --sweep`, every document's sections whatever their approval: measuring needs none), and the documents judge on labelled answers (`pnpm render:judge-eval --cases <file>`, cases `speaks: documents` with the sections as `content`; Harbor Mutual's are `apps/harbor/fixtures/judge/documents.jsonl`). A second draw (`retry`) is judged by the same judge, so its risk is the judge's miss rate on such answers: turn it on where that is measured low.

