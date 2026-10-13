# 7. Checking an app: `pnpm check`

[Contents](README.md) · Previous: [6. The form hooks](06-the-form-hooks.md) · Next: [8. Locales](08-locales.md)

```sh
pnpm check                                          # every app folder under apps/
pnpm check ../../apps/clinic                        # one folder (paths are relative to packages/dialogwright)
pnpm check --json ../../apps/clinic                 # the problems as JSON, for a program or an assistant
```

(`pnpm check` runs the `dialogwright check` command in the engine package, so a folder you name is relative to `packages/dialogwright`.)

At the repository root, `pnpm check` finds every folder under `apps/` that has an `app.yaml`. It exits 0 when no folder has a problem, 1 when one has, and 2 for a command it does not understand. CI runs it on every push.

It checks, in one pass:

1. **Each file against its schema.** Unknown keys, wrong types, a missing required file, a YAML syntax error. A misspelt name offers the near match, and a top-level key that belongs in another file names that file (`purposes` in identity.yaml: `move "purposes" and what is under it to policy.yaml`).
2. **The folder against the code**: every slot, tool, hook and custom rule the YAML names exists in the code; every hook the code writes is listed in forms.yaml; every tool in the code has an action in policy.yaml and every action is a tool; every custom rule the code defines is named by a `custom:` rule; every prompt the YAML names is in prompts.yaml; the identity tools, factor slots and carried slots exist; what the console names (form and slot labels, the slot order, question prefixes, a lookup fact's tool) and the clips name (a voice tag's clip, a clip's variables) exists; an action that runs the `confirmed` rule has a form with `confirmedParams` to confirm it; every form's `calls` names tools the code defines, and, when forms declare `calls`, every action is reached by a form or the identity flow; every form's `checks` names a `check: true` action and the form's own slots or an identity factor (which it warns of), each check action is named by a form, has no tool in the code, no `confirmed` rule and a `level` written out when the highest is more than the form's entry proves (a level written out above it is warned of), and every line a check says is in prompts.yaml; app.yaml's `callerNumber.lookup` is an action whose tool takes `callerNumber` alone, reached at call start, and a slot that may be left empty (`onNo` or `ifNone: skip`, or `onMaxAttempts` that skips it) is not named in its form's summary line; a slot's `onMaxAttempts` enters a form there is that does not list the slot, never skips an identity factor, and says lines prompts.yaml has; every slot app.yaml's `textConsent` covers exists and offers the caller's number (`callerNumber`), and `offerAnswers` is beside `offer: facts`; every threshold a slot's options name (a `hedge.threshold`) is one of the engine's or one under `thresholds:` in app.yaml; and the whole app passes the engine's own `validateApp`.
3. **The engine's own lines in every locale**: every line the engine says by name, and the lines it builds for each slot and for a role rule's reason (section 2, prompts.yaml), exists in prompts.yaml and in each `locale/<tag>/prompts.yaml`. A missing line's message says when the engine says it and, when it gives the line variables, which ones (`..., and gives it {first}  ->  add "signin_thanks:" with its text (it may use {first}) and interruptible to prompts.yaml`).
4. **The keypad menu**: every key names a form intent, an informational intent or `agent`; a key for another control intent is refused, since the engine ignores it.
5. **A caller who is done**: an app that says `anything_else` ("Is there anything else I can help with?") has a `done` intent, so "no, that's all" ends the call with the goodbye rather than the no-match line (section 2, intents.yaml). The fix is the intent, ready to paste.
6. **Each locale against prompts.yaml**: a translated line uses only the variables the prompts.yaml line has (the code fills those and no others, so another would fail when it is said), and a locale has no line that prompts.yaml does not (it would never be said). A locale's labels (`locale/<tag>/intents.yaml`, `forms.yaml`) name an intent intents.yaml has and an internal form forms.yaml has ([8](08-locales.md#8-locales)).
7. **The corpus**: every intent has at least one labelled example in `corpus.jsonl`, when app.yaml names a fixtures directory. The corpus must be inside the package (a link that leads out is refused) and at most 16 MB.

The format is one line per problem, `file:line:column  path  message  ->  fix`, and then a summary line (`N problems in <folder>`, or `<folder>: ok`). A problem in the code has no YAML line, so it reads `app.ts` (or `src/app.ts`) and a code path such as `code.forms.renew_loan.entry`.

A warning is a line that starts `warning: ` in the same format. It is printed and never counted: the exit code is the problems'. Under `--json` the warnings go to stderr and the JSON is the problems. Three things are warnings about a form's checks: an `on` reason the check's rules never refuse for (the outcome would never apply; a custom rule's reasons are the ones its examples expect), a rule a check holds the caller to that no action in the form's `calls` runs (the write would not hold what the check held), and a check that reads a slot that may be skipped (it never runs then). A numbered retry or no-input line a slot's ladder never reaches is warned of too ([When a slot runs out](05-writing-a-slot.md#when-a-slot-runs-out-attempts-and-onmaxattempts)). Others are about the number the caller is calling from: a form with a slot that offers it and no summary, a call-start lookup above level 0 or with its number recorded with `keep`, a `callerNumber` rule in an app that keeps no number, and one on a param no slot that offers the number holds ([The number the caller is calling from](02-the-files-one-by-one.md#the-number-the-caller-is-calling-from-callernumber), [3.3](03-policy-and-identity.md#33-the-built-in-rules)). Others are about languages: a locale whose own lines say an intent's label (`{intentLabel}`) and that gives no label of its own for a request they can name ([8](08-locales.md#8-locales)); a locale spoken or heard on the phone as a language tag with no region (`es`, which Twilio refused on a live call); and a language other than English heard by a recognizer that hears English only, its own, the server's default flux for the default locale, or another language's where it names none ([13.3](13-channels.md#133-languages-on-the-phone)).

When a schema problem is found, the cross-checks against the code do not run until it is fixed, because a file that does not parse cannot be linked. Fix the schema problems first, then run it again. Any other problem does not hold the rest back: an app module that builds the app with `defineApp` throws when the folder and the code disagree, and `check` still reads the code that `defineApp` was given, so the lines the code needs (a keypad slot's `ask_<slot>_dtmf`, a portal's sign-in lines) are reported in the same run as the problem that made it throw.

These are real messages. The folder was a copy of the library fixture, with these edits: an unknown key `colour: blue` in app.yaml, `level: three` for `renewLoan` in policy.yaml. The first run:

```
app.yaml:5:1  colour  unknown key "colour" in this file  ->  delete "colour"; the keys allowed in this file are id, locale, brand, console, voice, handoff, wording, thresholds, carrySlots, unsureIntent, changeSlotWithValue, anythingElseSilence, callerNumber, fixtures, prompts
policy.yaml:4:12  actions.renewLoan.level  "level" is "three", which is not allowed here; it must be one of 0, 1, 2  ->  use one of 0, 1, 2
2 problems in broken-library
```

After fixing those two, with these further edits made at the same time (the slot `branch` misspelt `branche` in forms.yaml, the hook `entry` listed for `renew_loan` but not written, the `goodbye` prompt deleted, the `hours` intent naming a prompt `opening_hours` that does not exist, `known-branch` misspelt `known_branch` in policy.yaml, and the Spanish `anything_else` line deleted):

```
intents.yaml:19:15  intents.hours.promptId  prompt "opening_hours" is not in prompts.yaml  ->  add "opening_hours:" to prompts.yaml with its text and interruptible
forms.yaml:6:13  forms.renew_loan.hooks[0]  form "renew_loan" declares the hook "entry", but the code does not define it  ->  write it in app.ts (code.forms.renew_loan.entry), or delete "entry" from this list
forms.yaml:8:19  forms.check_hold.slots[1]  slot "branche" is not defined  ->  rename it to "branch", or add it to the app's slots in app.ts (code.slots.branche)
prompts.yaml:2:1  prompts  prompt "goodbye" is missing from prompts.yaml; the engine says it when a call ends  ->  add "goodbye:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche" is missing from prompts.yaml; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to prompts.yaml
prompts.yaml:2:1  prompts  prompt "ask_branche_retry" is missing from prompts.yaml; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to prompts.yaml
policy.yaml:2:1  actions  custom rule "known-branch" (code.customRules["known-branch"]) is not named by any action's rules, so it never runs  ->  add "- custom: known-branch" to the rules of the action it guards, or delete the rule from app.ts (code.customRules["known-branch"])
policy.yaml:12:17  actions.findHold.rules[1].custom  custom rule "known_branch" is not defined in the code  ->  rename it to "known-branch", or add it to app.ts (code.customRules.known_branch), or delete this rule
locale/es/prompts.yaml:3:1  prompts  prompt "opening_hours" is missing from the es prompts; intents.yaml:19 (intents.hours.promptId) says it  ->  add "opening_hours:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "anything_else" is missing from the es prompts; the engine says it when a form is done and it asks whether there is more  ->  add "anything_else:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche" is missing from the es prompts; the engine says it when it asks for the slot "branche"  ->  rename "ask_branch" to "ask_branche" if that is the line, or add "ask_branche:" with its text and interruptible to locale/es/prompts.yaml
locale/es/prompts.yaml:3:1  prompts  prompt "ask_branche_retry" is missing from the es prompts; the engine says it when it asks for the slot "branche" again after an answer that missed  ->  rename "ask_branch_retry" to "ask_branche_retry" if that is the line, or add "ask_branche_retry:" with its text and interruptible to locale/es/prompts.yaml
12 problems in broken-library
```

(The folder name is whatever you pass.) One mistake can show up in several places: the single typo `branche` produced the unknown slot and four missing prompts, and renaming the slot back to `branch` clears all of them. Fix from the top down and run it again.

A corpus problem reads:

```
intents.yaml:15:3  intents.hours  intent "hours" has no examples in the corpus (fixtures/corpus.jsonl)  ->  add a line to fixtures/corpus.jsonl such as {"id":"hours-01","text":"<what a caller says to mean this>","intent":"hours","context":"no_form"}
```

And an app that asks "anything else?" with no `done` intent (the library fixture with `done` taken out):

```
intents.yaml:2:1  intents  the app asks whether there is anything else (the line "anything_else", said when a form is done) but has no "done" intent, so a caller who answers "no, that's all" is not understood: they hear the no-match line instead of the goodbye, then the keypad menu or a person  ->  add under intents: done: { criteria: "Says they are finished and need nothing more, as in no thanks, that's all, I'm all set, nothing else, I don't need anything else, or goodbye, including a bare no when just asked whether there is anything else", label: finish up, kind: control }; then give it corpus lines, such as {"id":"dn-01","text":"no, that's all","intent":"done","context":"anything_else"} (the anything_else context needs testing.seed.anythingElse; "no_form" otherwise)
```

If the folder has no app module, `check` checks the YAML only and says so (`<dir>: checked the YAML only; there is no app.ts (or src/app.ts) to check it against`). An app module that cannot be imported is reported as a problem against that file, with how to see the full error.

An app's own tests can run the same check, so a broken folder fails `pnpm test` as well. `checkApp` is exported by `'dialogwright'`; pass the app's code so nothing is imported, and expect no problems (the clinic's `src/app.test.ts` does this):

```ts
import { checkApp, formatProblem } from 'dialogwright';
import { CLINIC_DIR, code } from './app';

it('passes dialogwright check', async () => {
  expect((await checkApp(CLINIC_DIR, { code })).map(formatProblem)).toEqual([]);
});
```

`loadAppFolder` (the YAML alone, with each problem) and the `DefineAppOptions` and `CheckOptions` types are exported too.

`pnpm verify` is a different command: the type check and the unit tests (`pnpm typecheck && pnpm test`). Run both before committing an app change, then the regressions the root CLAUDE.md names.

For generated wording ([16](16-generated-wording.md)), `check` refuses `mode: generative` on a prescribed line, a generated line with no `goal`, a generated line that names an identifier (an identity factor, or a slot hidden whole in the records) or says a knowledge base's answer (`{answer}`), a `from` that names a variable the line does not have, a `goal`, `when` or `from` on a line that is not generated, a form whose `wording: generative` generates no line, a generated line whose `from` names a value a `confirmed` rule of its form's action covers without `summarizesConfirmed: true` (and that setting where none is covered), a form whose `summary.onNo: read-back` has no summary or no `read_back_exact` line, and, in a locale's prompts.yaml, anything but a generated line's `goal`. For a framed line (`generate`), it refuses one that is prescribed or says a `mode`, or a `goal` or `from` of the whole line; a span its text does not have, a span named for a slot, a span with no `from`, and a `from` that is not a slot, is another span, holds an identifier or, for a line of a form, is not one of the form's slots; in a locale, a text that does not say every span prompts.yaml frames, and a span there with more than its `goal` or one prompts.yaml does not frame. It warns, and never refuses, of a line generated whole from collected content (`mode: generative` with `from`), pointing to the framed form: whether such a line says the caller's words as theirs rests on a model's judgement; and of a span worded from a slot the records mask (`redact`), whose value a model is then sent whole. What a generated line says can only be checked as it is said: the checks of 16.6 run on every line, in the regression too. `check` does require each custom rule to be defined with examples (`defineRule`), which the policy matrix runs.
