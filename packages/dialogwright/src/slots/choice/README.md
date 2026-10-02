# `choice`

One of a fixed list of options: a delivery speed, a library branch, a colour of case.

The model is asked one question: which of these does the caller name? It has a criterion for each option, in the order written, and one for `none`. When it chooses an option and its probability reaches `fillAt` (`SLOT_CHOICE_FILL` by default), the slot fills with that option's key. The model never writes the value: it picks a label, and the code checks that the label is one of the options. A caller who names nothing, or names something the list does not have, leaves the slot empty.

Reach for it when the caller's answer is one of a short list you can write down. For a number no list holds, an identifier, a date, a name or free words, use the type made for it.

The basic options above are enough for most lists. An advanced tier (`confirm: by-confidence` with `readBack`, `disambiguate`, `hedge`, `help`) is for a list whose entries a caller confuses or is unsure of, such as names that sound alike: it asks which of two, reads back what the caller hedged about, and answers a caller who says they do not know the name. Every advanced option is off unless written.

## Options

| Option | Default | What it does |
|---|---|---|
| `options` | none | The options the caller can choose, in order, as `key: Say` or `key: { say, means }`. The key is the value the slot takes and the label the model chooses (a letter first, then letters, digits and underscores; not `none`). `say` is how a line, the summary and the model's turn state say the option. `means` is the text of the option's criterion, sent exactly as written. At least one is needed. |
| `means` | `The caller names {say}` | The criterion for each option that has no `means` of its own, as a template over `{say}` and `{key}`. |
| `text` | none | A literal for any text part (below), sent to the model exactly as written in place of the default. One line each. |
| `keypad` | `false` | The caller can key the option by its position (1 for the first, 2 for the second) after spoken answers missed. One digit, so at most 9 options. Needs an `ask_<slot>_dtmf` line. |
| `fillAt` | `SLOT_CHOICE_FILL` | The threshold the model's probability for the option must reach: `SLOT_CHOICE_FILL` or the lower `SLOT_CHOICE_CONFIRM`. |
| `confirm` | `summary` | `summary`: a chosen option is neither acknowledged nor read back on its own; the form's final confirm covers it. `by-confidence`: it is acknowledged (`ack_<slot>`, given the option's `say` as `{<slot>}`) when `readBack` says so, and always when the caller hedged. |
| `readBack` | `implicit` | With `confirm: by-confidence`: `implicit` (always acknowledged), `below-fill` (only when the model's probability is below `SLOT_CHOICE_FILL`), `none` (never, unless the caller hedged). An error with `confirm: summary`. |
| `disambiguate` | off | `margin`: the slot reads the model's probability for every label, not only its pick. The top option must reach `SLOT_CHOICE_CONFIRM`; when a second option is within `SLOT_CHOICE_MARGIN` of it, or (while the caller hedges) reaches `SLOT_CHOICE_CONFIRM` itself, the slot asks which of the two (`disambiguate_<slot>`, given `{a}` and `{b}`). |
| `hedge` | off | A second question, a yes-or-no: is the caller unsure which option they mean? `hedge.threshold` (required) names the threshold its yes must reach, an engine one or one of the app's own in app.yaml, read from the turn by name. `hedge.byName` (default `false`): while the caller hedges, when their words name another option as a whole word (its key, an underscore read as a space, case aside), ask which of the two, though the model put its weight on one. `hedge.text` replaces its words (below). |
| `help` | off | A third question: what does the caller say without naming an option? `help.labels` is its labels in order, as `label: { means, prompt? }`; the first must have no `prompt` (it is the answer that asks for nothing, and the one a stub model picks when nothing is said), and at least one must have one. When no option is chosen and the model's top label reaches `help.threshold` (default `SLOT_HELP`) and has a `prompt`, the outcome is `help` with that line. `help.text` replaces its words (below). |
| `ids` | none | `ids.choice`: the question's id in place of the slot's own id. `ids.hedge` and `ids.help`: the hedge and help questions' ids in place of `<slot>Hedge` and `<slot>Help`. To keep the ids an existing slot was recorded with. |

### Text parts

| Part | Default | What it is |
|---|---|---|
| `instructions` | `Read asr.text. Which of these does the caller name?` | The question. |
| `none` | `Names none of these` | The criterion of the `none` label, which the model chooses when the caller names no option. |

The hedge and help questions have their own, under `hedge.text` and `help.text`:

| Part | Default | What it is |
|---|---|---|
| `hedge.text.instructions` | `Read asr.text. Is the caller unsure which one they mean?` | The hedge question. |
| `hedge.text.true` | `The caller hedges about which one they mean, as in it might be this one, or offers two for one, as in this one or that one, I am not sure` | What a yes means. |
| `hedge.text.false` | `The caller names one plainly, or names none. A caller correcting themselves, as in this one, not that one, is sure` | What a no means. |
| `help.text.instructions` | `Read asr.text and node.promptJustPlayed. Do they answer the question without naming one of the options?` | The help question; its labels' criteria are `help.labels`. |

Question wording an app overrides lives under `text:`, as in every type: `text.<part>` is a literal, sent word for word. The criteria of the options are not text parts. Each is data about one option: its own `means`, or the `means` template filled from it (`{say}` and `{key}`), the way a record slot's `label` is a template over each record. So `means` stays an option of its own and is never under `text:`.

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

The question is named after the slot (`speed` for the slot `speed`) and has one criterion per option, then `none`. With these options:

```yaml
speed:
  type: choice
  options:
    standard: standard delivery
    express: express delivery
    next_day: { say: next-day delivery, means: Delivery on the next day, whatever it is called }
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

`examples.yaml` beside this file has four configurations with starter utterances and keypad keys: a delivery speed with a keypad, a branch written in the shorthand with a question of its own (`text.instructions`), and a colour with every text in its own words and a lower threshold. In an app's `slots.yaml`:

```yaml
speed:
  type: choice
  keypad: true
  options:
    standard: standard delivery
    express: express delivery
    next_day: next-day delivery
```

## Notes

- Every slot listens on every turn, so the question is asked even while the form is on another slot, and "express, please" said at the start can fill the slot before the form asks for it.
- The keys are the model's labels and the slot's values. Keep them short and distinct, and write each option's `means` so a model can tell the options apart from each other and from `none`.
- A value that is not one of the options (a value restored from an older call, say) is displayed as it is.
- With `disambiguate` the slot reads every label's probability and takes the top one, which is almost always the model's pick; without it, the pick. A basic slot and an advanced one can therefore differ on a turn where the model's pick is not its most probable label.
- `hedge.threshold` and `help.threshold` are read from the turn by name, as every threshold is: a run's overrides and a sweep move them like the engine's. A name the turn does not have never counts as reached, so a misspelt name leaves the caller never unsure; name one the engine has or one under `thresholds` in app.yaml.
- Order matters for `help.labels` as for `options`: a stub model answers a question with no `none` with its first label, so the first is the one that asks for nothing.
- The options are readable from the built slot: `slot.config.options` holds every key with its `say`, in order, so an app's code can list them (a clip vocabulary, a stub's word list) from the one place they are written.
- Run its checks with `pnpm --filter dialogwright test slots/choice`.
