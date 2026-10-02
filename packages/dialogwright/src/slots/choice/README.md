# `choice`

One of a fixed list of options: a delivery speed, a library branch, a colour of case.

The model is asked one question: which of these does the caller name? It has a criterion for each option, in the order written, and one for `none`. When it chooses an option and its probability reaches `fillAt` (`SLOT_CHOICE_FILL` by default), the slot fills with that option's key. The model never writes the value: it picks a label, and the code checks that the label is one of the options. A caller who names nothing, or names something the list does not have, leaves the slot empty.

Reach for it when the caller's answer is one of a short list you can write down. For a number no list holds, an identifier, a date, a name or free words, use the type made for it.

## Options

| Option | Default | What it does |
|---|---|---|
| `options` | none | The options the caller can choose, in order, as `key: Say` or `key: { say, means }`. The key is the value the slot takes and the label the model chooses (a letter first, then letters, digits and underscores; not `none`). `say` is how a line, the summary and the model's turn state say the option. `means` is the text of the option's criterion, sent exactly as written. At least one is needed. |
| `means` | `The caller names {say}` | The criterion for each option that has no `means` of its own, as a template over `{say}` and `{key}`. |
| `text` | none | A literal for any text part (below), sent to the model exactly as written in place of the default. One line each. |
| `keypad` | `false` | The caller can key the option by its position (1 for the first, 2 for the second) after spoken answers missed. One digit, so at most 9 options. Needs an `ask_<slot>_dtmf` line. |
| `fillAt` | `SLOT_CHOICE_FILL` | The threshold the model's probability for the option must reach: `SLOT_CHOICE_FILL` or the lower `SLOT_CHOICE_CONFIRM`. |
| `confirm` | `summary` | `summary`: a chosen option is neither acknowledged nor read back on its own; the form's final confirm covers it. |
| `ids` | none | `ids.choice`: the question's id in place of the slot's own id, to keep the id an existing slot was recorded with. |

### Text parts

| Part | Default | What it is |
|---|---|---|
| `instructions` | `Read asr.text. Which of these does the caller name?` | The question. |
| `none` | `Names none of these` | The criterion of the `none` label, which the model chooses when the caller names no option. |

Question wording an app overrides lives under `text:`, as in every type: `text.<part>` is a literal, sent word for word. The criteria of the options are not text parts. Each is data about one option: its own `means`, or the `means` template filled from it (`{say}` and `{key}`), the way a record slot's `label` is a template over each record. So `means` stays an option of its own and is never under `text:`.

The order of `options` matters in two places. It is the keypad order, and it is the order of the labels the model is offered, which is also the order a stub model chooses from.

## The outcome

| What the caller said | The outcome |
|---|---|
| An option, and the model's probability reaches `fillAt` | `filled`: the value is the option's key, the display its `say`, and no read-back is asked for |
| The model chooses `none`, or a label that is not an option | `absent`, so the form asks again |
| An option, but the model's probability is below `fillAt` | `absent` |
| No answer | `absent` |

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

`ask_<slot>` and `ask_<slot>_retry` as for every slot. With `keypad`, `ask_<slot>_dtmf`. The slot says nothing else. `dialogwright check` requires each in every locale.

## Examples

`examples.yaml` beside this file has three configurations with starter utterances and keypad keys: a delivery speed with a keypad, a branch written in the shorthand with a question of its own (`text.instructions`), and a colour with every text in its own words and a lower threshold. In an app's `slots.yaml`:

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
- The options are readable from the built slot: `slot.config.options` holds every key with its `say`, in order, so an app's code can list them (a clip vocabulary, a stub's word list) from the one place they are written.
- Run its checks with `pnpm --filter dialogwright test slots/choice`.
