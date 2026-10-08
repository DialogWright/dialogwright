# `choice`

> Part of the [slot library](README.md). This page is generated: the prose is the type's [README](../../packages/dialogwright/src/slots/choice/README.md), and the options, text parts, question ids and examples are read from its options schema and `examples.yaml`. To change it, edit those and run `pnpm --filter dialogwright slot-docs`.

One of a fixed list of options: a delivery speed, a library branch, a colour of case.

The model is asked one question: which of these does the caller name? It has a criterion for each option, in the order written, and one for `none`. When it chooses an option and its probability reaches `fillAt` (`SLOT_CHOICE_FILL` by default), the slot fills with that option's key. The model never writes the value: it picks a label, and the code checks that the label is one of the options. A caller who names nothing, or names something the list does not have, leaves the slot empty.

Reach for it when the caller's answer is one of a short list you can write down. For a number no list holds, an identifier, a date, a name or free words, use the type made for it.

The basic options (`options`, `means`, `text`, `keypad` and `fillAt`) are enough for most lists. An advanced tier (`confirm: by-confidence` with `readBack`, `disambiguate`, `hedge`, `help`) is for a list whose entries a caller confuses or is unsure of, such as names that sound alike: it asks which of two, reads back what the caller hedged about, and answers a caller who says they do not know the name. Every advanced option is off unless written.

## Options

A slot of this type is written under its id in slots.yaml, with `type: choice` and the options below. The options are strict: an option the type does not have is an error, with the closest name offered. An option with no default is unset until written.

| Option | Type | Default | What it does |
|---|---|---|---|
| `options` | map of string or map | required | The options the caller can choose, in order, as `key: Say` or `key: { say, means }`, at most 200. The key is the value the slot takes and the label the model chooses; `say` is how it is said; the order is the order of the keypad (1, 2, 3, ...) and of the labels the model is offered. |
| `options.<key>.say` | string | required | The display: how a line, the summary and the model's turn state say the option ("an express delivery"). |
| `options.<key>.means` | string | unset | What the model is told this option is: the text of its criterion, sent exactly as written. Default: the slot's `means` template. |
| `means` | string | `The caller names {say}` | The criterion the model is given for each option that has no `means` of its own, as a template over `{say}` and `{key}`. |
| `text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions, none. |
| `keypad` | boolean | `false` | Whether the caller can key the option, by its position (1 for the first), after spoken answers missed. At most 9 options. Needs an `ask_<slot>_dtmf` line. |
| `fillAt` | one of `SLOT_CHOICE_FILL`, `SLOT_CHOICE_CONFIRM` | `SLOT_CHOICE_FILL` | The threshold the model's probability for the option must reach for the slot to fill; below it the slot stays empty. |
| `confirm` | one of `summary`, `by-confidence` | `summary` | "summary": a chosen option is neither acknowledged nor read back on its own; the form's final confirm covers it. "by-confidence": it is acknowledged (`ack_<slot>`, given the option's display as `{<slot>}`) when `readBack` says so, and always when the caller hedged (`hedge`). |
| `readBack` | one of `implicit`, `below-fill`, `none` | unset | With `confirm: by-confidence`, what a chosen option asks for: "implicit" (always acknowledged; the default), "below-fill" (only when the model is less sure of it than SLOT_CHOICE_FILL), "none" (never, unless the caller hedged). |
| `disambiguate` | one of `margin` | unset | "margin": the slot reads the model's probability for every label, not only its pick, and when a second option is within SLOT_CHOICE_MARGIN of the top one (or, while the caller hedges, reaches SLOT_CHOICE_CONFIRM) it asks which of the two (`disambiguate_<slot>`, given {a} and {b}). The top option must then reach SLOT_CHOICE_CONFIRM before anything else is read. Default: off. |
| `hedge` | map | unset | A second question, a yes-or-no: is the caller unsure which option they mean? A hedged option is read back however sure the model is (with `confirm: by-confidence`); with `disambiguate`, a hedged rival that reaches SLOT_CHOICE_CONFIRM is asked about. Its id is `ids.hedge` (default: `<slot>Hedge`). |
| `hedge.threshold` | string | required | The threshold the model's yes must reach for the caller to count as unsure: an engine threshold, or one of the app's own (app.yaml thresholds), read from the turn by name. |
| `hedge.byName` | boolean | `false` | While the caller hedges, ask which of two when their words name another option as a whole word (its key, underscores as spaces, case aside), though the model put its weight on one. |
| `hedge.text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions, true, false. |
| `help` | map | unset | A third question, asked on every turn: what does the caller say without naming an option ("I do not know the name")? When no option is chosen and the model's top label reaches `threshold` and has a prompt, the slot asks for help with that line (a help outcome) instead of being absent. Its id is `ids.help` (default: `<slot>Help`). |
| `help.threshold` | string | `SLOT_HELP` | The threshold the model's top label must reach to lead to its line. |
| `help.labels` | map of map | required | The labels of the help question, in order, as `label: { means, prompt? }`. The first must have no prompt: it is the answer that asks for no help, which a stub model chooses when nothing is said. |
| `help.labels.<key>.means` | string | required | What the model is told this label is: the text of its criterion, sent exactly as written. |
| `help.labels.<key>.prompt` | string | unset | The line said when the model chooses this label (a help outcome). None: the label asks for no help (the slot is absent). |
| `help.text` | map | unset | Text to say to the model in place of a default, word for word, by part: instructions. |
| `ids` | map | unset | Question ids in place of the defaults: `ids.choice` is the question's id (default: the slot's own id), `ids.hedge` and `ids.help` those of the hedge and help questions (default: `<slot>Hedge`, `<slot>Help`), to keep the ids an existing slot used. |
| `listen` | one of `up-front`, `form`, `anywhere`, `call` | `up-front` | Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). "form": asked and filled only while a form that has it is open; outside one its question is not sent. "anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. "call": as anywhere, and kept for the whole call, across forms (what app.yaml's carrySlots does). An identity factor listens as identity.yaml says, and takes none. |
| `offer` | one of `facts` | unset | Propose a value in place of the question. "facts": when the form would ask the slot and the app's facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling), the line asks `offer_<slot>` as a yes or no, with the value as `{<slot>}` ("Is this about 22 Alder Street?"), once per slot per form. A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks `ask_<slot>` with no attempt counted, and a value said instead fills as said. Needs app.yaml's callerNumber with a lookup, and `offer_<slot>` in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back). |

### Text parts

The text the model is sent is made of parts. Each has a default, a template over the options (a placeholder in braces is filled in), and a literal written under `text` replaces it exactly as written, on one line. A slot that must keep the words an earlier recording was made with writes them here.

| Part | What it is | Default |
|---|---|---|
| `text.instructions` | The question that asks which option the caller names, sent to the model in place of the default. | `Read asr.text. Which of these does the caller name?` |
| `text.none` | What the question's "none" label means: the caller names no option. | `Names none of these` |
| `hedge.text.instructions` | The question that asks whether the caller is unsure which option they mean. | `Read asr.text. Is the caller unsure which one they mean?` |
| `hedge.text.true` | What a yes means: the caller hedges. | `The caller hedges about which one they mean, as in it might be this one, or offers two for one, as in this one or that one, I am not sure` |
| `hedge.text.false` | What a no means: the caller is sure, or names nothing. | `The caller names one plainly, or names none. A caller correcting themselves, as in this one, not that one, is sure` |
| `help.text.instructions` | The question that asks what the caller says about the question without naming an option; its labels are `help.labels`. | `Read asr.text and node.promptJustPlayed. Do they answer the question without naming one of the options?` |

### Question ids

A question's id is the slot's id followed by the part's name (the slot `note` and the part `given` give `noteGiven`), so two slots of one type never share an id. Where a type differs, its notes say so. An id written under `ids` replaces the default: it keeps the id an existing slot was recorded with.

| Key | What it renames |
|---|---|
| `ids.choice` | The id of the question that asks which of the options the caller names. |
| `ids.hedge` | The id of the question that asks whether the caller is unsure which option they mean. |
| `ids.help` | The id of the question that asks what the caller says about the question without naming an option. |

The question's own wording an app overrides lives under `text:`, as in every type: `text.<part>` is a literal, sent word for word, and the hedge and help questions have their own under `hedge.text` and `help.text`. The defaults are listed under Text parts, after the options table. The criteria of the options are not text parts. Each is data about one option: its own `means`, or the `means` template filled from it (`{say}` and `{key}`), the way a record slot's `label` is a template over each record. So `means` stays an option of its own and is never under `text:`.

The order of `options` matters in two places. It is the keypad order, and it is the order of the labels the model is offered, which is also the order a stub model chooses from.

## The outcome

| What the caller said | The outcome |
|---|---|
| An option, and the model's probability reaches `fillAt` | `filled`: the value is the option's key, the display its `say`; with `confirm: summary` no read-back is asked for, with `by-confidence` as `readBack` says |
| The model chooses `none`, or a label that is not an option | `absent`, so the form asks again |
| An option, but the model's probability is below `fillAt` | `absent` |
| No answer | `absent` |

With the advanced options, read in this order:

| What the caller said | The outcome |
|---|---|
| Nothing chosen (no answer, `none`, a label that is not an option, below `SLOT_CHOICE_CONFIRM` with `disambiguate` or below `fillAt`) | with `help`: `help` with the line of the help label the model ranks top, when it reaches `help.threshold` and has a `prompt`; otherwise `absent` |
| Two options, the second within `SLOT_CHOICE_MARGIN` of the top (with `disambiguate`) | `disambiguate` between the two keys |
| A hedge (the hedge question at `hedge.threshold` or above), and a second option at `SLOT_CHOICE_CONFIRM` or above (with `disambiguate`) | `disambiguate` between the two |
| A hedge, and words that name another option (with `hedge.byName`) | `disambiguate` between the option chosen and the one named first |
| A hedge, and one option | `filled`, acknowledged (with `confirm: by-confidence`) however sure the model is |
| One option, below `SLOT_CHOICE_FILL` (with `readBack: below-fill`) | `filled`, acknowledged |
| One option, at `SLOT_CHOICE_FILL` or above (with `readBack: below-fill`) | `filled`, not acknowledged |

## The question

The question's id is the slot's own id (`speed` for the slot `speed`, unless `ids.choice` names another), and the hedge and help questions are `<slot>Hedge` and `<slot>Help`. The question has one criterion per option, then `none`. With these options:

```yaml
speed:
  type: choice
  options:
    standard: standard delivery
    express: express delivery
    next_day: { say: next-day delivery, means: "Delivery on the next day, whatever it is called" }
```

the question, sent to the model, is:

> Read asr.text. Which of these does the caller name?
>
> - `standard`: The caller names standard delivery
> - `express`: The caller names express delivery
> - `next_day`: Delivery on the next day, whatever it is called
> - `none`: Names none of these

## Prompts

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `keypad`, `ask_<slot>_dtmf`. With `confirm: by-confidence`, `ack_<slot>` (given `{<slot>}`). With `disambiguate` or `hedge.byName`, `disambiguate_<slot>` (given `{a}` and `{b}`). With `help`, each label's `prompt`. The slot says nothing else, and declares each of these (`slot.prompts`); `dialogwright check` requires each in every locale.

## The advanced tier, written out

```yaml
pickup:
  type: choice
  keypad: true
  fillAt: SLOT_CHOICE_CONFIRM
  confirm: by-confidence
  readBack: below-fill
  disambiguate: margin
  options:
    north: the North branch
    northgate: the Northgate branch
    riverside: the Riverside branch
  hedge:
    threshold: SLOT_DETECT
    byName: true
  help:
    labels:
      neither: { means: "Names a branch, or says nothing about whether they know its name" }
      knows: { means: "Says they know the branch's name, without saying it", prompt: ask_pickup_name }
      unknown: { means: "Says they do not know the branch's name, or asks which branches there are", prompt: pickup_list }
```

asks three questions on every turn: `pickup` (which branch), `pickupHedge` (is the caller unsure) and `pickupHelp` (what they say without naming one), and leads to `ack_pickup`, `disambiguate_pickup`, `ask_pickup_name`, `pickup_list` and `ask_pickup_dtmf`. "North, I think" at 0.5 fills the North branch and says it back; "the north gate one" with North at 0.48 and Northgate at 0.42 asks which; "it might be Northgate, or maybe Riverside" asks between those two however sure the model is of Northgate; "I don't know what it's called" reads the list.

## Examples

The starter examples, listed below, are four configurations with starter utterances and keypad keys: a delivery speed with a keypad, a branch written in the shorthand with a question of its own (`text.instructions`), a colour with every text in its own words and a lower threshold, and a pickup branch with the advanced options. In an app's `slots.yaml`:

```yaml
speed:
  type: choice
  keypad: true
  options:
    standard: standard delivery
    express: express delivery
    next_day: next-day delivery
```

### Starter examples

Each configuration below is built and run by the type's tests (the conformance kit), so what it shows is what the slot does. A slot reads the model's answers, not the caller's words, so an utterance lists both.

#### delivery speed

Three options with their own display and a keypad. The model is told each option means "The caller names <what it says>", and chooses by the keys.

```yaml
speed:
  type: choice
  keypad: true
  options:
    standard:
      say: standard delivery
    express:
      say: express delivery
    next_day:
      say: next-day delivery
```

<details><summary>Starter utterances (4)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| next day please | `speed`: `next_day` 0.93, `express` 0.04, `none` 0.03 | filled: value `next_day`, display `next-day delivery`, confirm `none`, display in es `next-day delivery` |
| whichever is cheapest | `speed`: `standard` 0.5, `express` 0.3, `none` 0.2 | absent |
| I have a question about my order | `speed`: `none` 0.95, `standard` 0.05 | absent |
| overnight | `speed`: `overnight` 0.9, `none` 0.1 | absent |

</details>

<details><summary>Keypad (4)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `1` | any | `standard`, said `standard delivery` |
| `3` | any | `next_day`, said `next-day delivery` |
| `4` | any | no value |
| `0` | any | no value |

</details>

#### branch

The shorthand (a bare string for what the option says), with a question of its own and no keypad. In Spanish (a locale's slots.yaml, here `wording`) the branches are said in Spanish; the question stays as it is.

```yaml
branch:
  type: choice
  text:
    instructions: Read asr.text. Which library branch does the caller name?
  options:
    north: North
    riverside: Riverside
    old_mill: Old Mill
```

In `locale/es/slots.yaml`:

```yaml
branch:
  options:
    north: Norte
    old_mill:
      say: Viejo Molino
```

<details><summary>Starter utterances (6)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the Riverside one | `branch`: `riverside` 0.9, `north` 0.06, `none` 0.04 | filled: value `riverside`, display `Riverside` |
| the one by the old mill | `branch`: `old_mill` 0.82, `none` 0.18 | filled: value `old_mill`, display `Old Mill` |
| the main library | `branch`: `none` 0.9, `north` 0.1 | absent |
| la sucursal del norte<br>_locale es_ | `branch`: `north` 0.91, `riverside` 0.05, `none` 0.04 | filled: value `north`, display `Norte` |
| la del viejo molino<br>_locale es-US_ | `branch`: `old_mill` 0.84, `none` 0.16 | filled: value `old_mill`, display `Viejo Molino` |
| la de la ribera<br>_locale es_ | `branch`: `riverside` 0.9, `none` 0.1 | filled: value `riverside`, display `Riverside` |

</details>

#### colour

Every text in its own words (the question and `none` under `text`, `means` on an option and a template for the rest, a question id kept), a stricter threshold, and a keypad.

```yaml
colour:
  type: choice
  text:
    instructions: Read asr.text alone. Which colour of case does the caller want?
    none: Names no colour of case
  means: A request for the {key} case, said as {say}
  fillAt: SLOT_CHOICE_CONFIRM
  keypad: true
  ids:
    choice: caseColour
  options:
    black: black
    white:
      say: white
      means: White, or ivory, or cream
    green:
      say: forest green
```

<details><summary>Starter utterances (3)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the white one, I think | `caseColour`: `white` 0.62, `black` 0.3, `none` 0.08 | filled: value `white`, display `white`, confirm `none`, display in es `white` |
| I do not mind | `caseColour`: `white` 0.4, `black` 0.35, `none` 0.25 | absent |
| forest green | `caseColour`: `green` 0.95, `none` 0.05 | filled: value `green`, display `forest green` |

</details>

<details><summary>Keypad (2)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `2` | any | `white`, said `white` |
| `9` | any | no value |

</details>

#### pickup branch

The advanced options: a branch to collect a book from, two of whose names sound alike. A branch is taken at SLOT_CHOICE_CONFIRM and acknowledged below SLOT_CHOICE_FILL; two close in the model's probabilities are asked about; a caller who hedges is read back however sure the model is, and one who hedges between two names the words both say is asked which; a caller who answers without naming one is asked for the name or read the list.

```yaml
pickup:
  type: choice
  keypad: true
  fillAt: SLOT_CHOICE_CONFIRM
  confirm: by-confidence
  readBack: below-fill
  disambiguate: margin
  text:
    instructions: Read asr.text. Which library branch does the caller want to collect the book from?
    none: Names no branch
  options:
    north: the North branch
    northgate: the Northgate branch
    riverside: the Riverside branch
    old_mill: the Old Mill branch
  hedge:
    threshold: SLOT_DETECT
    byName: true
  help:
    labels:
      neither:
        means: Names a branch, or says nothing about whether they know its name
      knows:
        means: Says they know the branch's name, without saying it
        prompt: ask_pickup_name
      unknown:
        means: Says they do not know the branch's name, or asks which branches there are
        prompt: pickup_list
```

<details><summary>Starter utterances (8)</summary>

| The caller says | The model answers | The slot gives |
|---|---|---|
| the Riverside one | `pickup`: `riverside` 0.92, `none` 0.05, `north` 0.03<br>`pickupHedge`: yes 0.1<br>`pickupHelp`: `neither` 0.95, `knows` 0.03, `unknown` 0.02 | filled: value `riverside`, display `the Riverside branch`, confirm `none`, display in es `the Riverside branch` |
| north, I think it was | `pickup`: `north` 0.5, `none` 0.4, `riverside` 0.1<br>`pickupHedge`: yes 0.2<br>`pickupHelp`: `neither` 0.9, `knows` 0.05, `unknown` 0.05 | filled: value `north`, display `the North branch`, confirm `implicit` |
| the north gate one | `pickup`: `north` 0.48, `northgate` 0.42, `none` 0.1<br>`pickupHedge`: yes 0.1<br>`pickupHelp`: `neither` 0.9, `knows` 0.05, `unknown` 0.05 | disambiguate |
| it might be Northgate, or maybe Riverside | `pickup`: `northgate` 0.9, `none` 0.06, `riverside` 0.04<br>`pickupHedge`: yes 0.9<br>`pickupHelp`: `neither` 0.9, `knows` 0.05, `unknown` 0.05 | disambiguate |
| maybe the old mill one | `pickup`: `old_mill` 0.95, `none` 0.05<br>`pickupHedge`: yes 0.9<br>`pickupHelp`: `neither` 0.9, `knows` 0.05, `unknown` 0.05 | filled: value `old_mill`, display `the Old Mill branch`, confirm `implicit` |
| I don't know what it's called | `pickup`: `none` 0.9, `north` 0.1<br>`pickupHedge`: yes 0.3<br>`pickupHelp`: `unknown` 0.85, `neither` 0.1, `knows` 0.05 | help: promptId `pickup_list` |
| yes, I have the name | `pickup`: `none` 0.95, `north` 0.05<br>`pickupHedge`: yes 0.1<br>`pickupHelp`: `knows` 0.8, `neither` 0.15, `unknown` 0.05 | help: promptId `ask_pickup_name` |
| hang on a moment | `pickup`: `none` 0.95, `north` 0.05<br>`pickupHedge`: yes 0.1<br>`pickupHelp`: `neither` 0.9, `knows` 0.05, `unknown` 0.05 | absent |

</details>

<details><summary>Keypad (3)</summary>

| Keys | Locale | The slot gives |
|---|---|---|
| `2` | any | `northgate`, said `the Northgate branch` |
| `4` | any | `old_mill`, said `the Old Mill branch` |
| `5` | any | no value |

</details>

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot, and "express, please" said at the start can fill the slot before the form asks for it.
- The keys are the model's labels and the slot's values. Keep them short and distinct, and write each option's `means` so a model can tell the options apart from each other and from `none`.
- A value that is not one of the options (a value restored from an older call, say) is displayed as it is.
- With `disambiguate` the slot reads every label's probability and takes the top one, which is almost always the model's pick; without it, the pick. A basic slot and an advanced one can therefore differ on a turn where the model's pick is not its most probable label.
- `hedge.threshold` and `help.threshold` are read from the turn by name, as every threshold is: a run's overrides and a sweep move them like the engine's. A name the turn does not have never counts as reached, so a misspelt name leaves the caller never unsure; name one the engine has or one under `thresholds` in app.yaml.
- Order matters for `help.labels` as for `options`: a stub model answers a question with no `none` with its first label, so the first is the one that asks for nothing.
- The options are readable from the built slot: `slot.config.options` holds every key with its `say`, in order, so an app's code can list them (a clip vocabulary, a stub's word list) from the one place they are written.
- In another locale an option can be said in that locale's words: `locale/<tag>/slots.yaml` gives `options: { <key>: <said> }` (or `{ say: <said> }`) for the slot, and the display, the acknowledgement, the summary and the model's turn state use it in sessions in that locale. Only `say`: the criteria (`means`, or the `means` template filled from the options' own `say`) stay as written, in every locale, since the model reads them and the keys are its labels. An option the slot does not have is refused, at its line.
- Run its checks with `pnpm --filter dialogwright test slots/choice`.
