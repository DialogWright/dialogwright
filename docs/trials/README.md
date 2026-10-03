# Trials: an assistant builds an app from a paragraph

The design's first goal is that a developer can point an AI coding assistant at this repository with a one-paragraph description of an app and get a working app in one session, with `pnpm check` and the scripted calls green. A trial tests that directly. A fresh assistant, with no context from the people or sessions that built the framework, is given one paragraph and one instruction: use the create-app skill in this repository (`.claude/skills/create-app/SKILL.md`). It may read anything in the repository. It builds the app and, as it goes, logs every stumble: what it was doing, what it expected, what happened, what it cost, how it got past it, and the cause (docs, skill, scaffold, error message, framework). Each stumble is then fixed, or recorded with the reason it is not, and the fix is noted against the entry.

Two trials have been run, on different paragraphs, the second after the first one's fixes:

- [2026-10-03-utility.md](2026-10-03-utility.md): Example Power & Light, a small electric utility. The app is in [apps/utility](../../apps/utility).
- [2026-10-03-transit.md](2026-10-03-transit.md): Example Metro Transit, a city bus and rail agency. The app was built in a scratch worktree and is not committed; the log is the evidence.

The logs name sections of the authoring guide by the numbers it had when the trials ran; since then policy and identity became its section 3, and what was section 3 onward moved down by one.

## The paragraphs

The utility:

> Build a phone and chat assistant for Example Power & Light, a small electric utility. Callers can report a power outage at their address (no verification needed, but they confirm the address and what they are seeing before we file it), hear their current balance and due date (they must verify with their account number and date of birth), and set up a payment arrangement that splits their balance into installments (this needs a one-time code sent to their phone; the first payment date must be within 30 days, and the arrangement can't exceed what they owe). Property managers who manage several accounts can check balances for their buildings and report outages for them, but a payment arrangement for a tenant's account must be handed to a person. Callers can also ask for the outage map website and office hours. Anyone can ask for a person at any time.

The transit agency:

> Build a phone and chat assistant for Example Metro Transit, a city bus and rail agency. Riders can report an item they lost on a bus or train (no verification needed; they describe the item, say the route and the day they lost it, which must be within the last 30 days, and confirm before we file it), check the balance on their fare card (they verify with the card number and the ZIP code on file), and set up automatic reloading (this needs a one-time code sent to their phone; the reload amount must be between 10 and 100 dollars). Employers who manage commuter benefit cards for their staff can check those cards' balances, but any change to automatic reloading on an employee's card must go to a person. Riders can also ask for service alerts and the customer office's hours. Anyone can ask for a person at any time.

The two have the same shape on purpose (a write anyone may make with a confirmation, a read behind verification, a write behind a one-time code with a bound, a delegate whose write goes to a person, two informational answers, a person on request), with different values: a money amount the caller names, a date bound in the past rather than the future, a ZIP code factor, a delegate who is an employer.

## The two trials side by side

| | Trial 1: utility | Trial 2: transit |
|---|---|---|
| Wall-clock time to a green app | about 15 minutes | about 11 minutes |
| Entries in the log | 19 | 16 |
| Stumbles, by cause (each log's own table) | 11: docs 4, skill 2, error message or check staging 2, framework 3, scaffold 0 | 12 (10 entries, two with two causes): framework 4, docs 2, skill 2, error message 1, scaffold 1, policy card output 1, the builder's own shell 1 |
| Framework stumbles that blocked a green run | 1: a framework test that listed the folders with a `policy.matrix` failed on the new app, so `pnpm -r test` stayed red | 0: every check, test and regression was green at the end |
| Scripted calls passing on the first regression | 26 of 34 (3 of the 8 failures were the builder's expectations) | 35 of 37 |
| Places the builder read framework source or another app because the docs were not enough | 3: `core/app/types.ts`, `core/turn.ts`, the harness's `runner.ts` and `regress.ts` | 4: `core/app/types.ts`, `jev/types` (what `noul` is), the clinic's scenarios (when the keypad menu listens), the clinic's golden tests |
| What reading the policy matrix found in its own policy | `sendCode` was allowed for a property manager on a tenant's account, so a manager could have had a one-time code texted to a tenant's phone. Fixed with `role: { manager: refuse }`. | The same: `sendCode` was allowed for an employer on an employee's card. Fixed with `role: { benefits_admin: refuse }`. |
| Other findings in its own app, from reading the generated pages | None wrong; two known gaps seen in the baseline (an address is the whole turn; the corpus runs as one caller) | Reading the baseline: the balance form read the card from the caller instead of the slot, overriding the gate's `scope` rule; fixed in the app. Reading the card: the one confirmed list makes a lost item report "confirm" a dollar amount. |

The minute counts are an assistant's, so they are small; the count and the kind of stumbles say more. Both builders found the same hole in their own policy, and found it the same way: by reading the matrix the gate decides, not by writing a test. That hole is now a `check` problem (below).

## What the first trial's fixes changed for the second

Every stumble of the first trial was fixed or recorded (the utility log says which, entry by entry). The second trial met none of them again:

- **A failing scripted call is readable.** `regress --scenario <id>` prints the call turn by turn with every gate decision. The first builder wrote a throwaway script to see a call's turns; the second says no failure took more than a minute to understand.
- **`pnpm check` reports every missing line in one run, with the variables the engine gives it.** The first builder met missing lines over two runs and grepped the engine for `{first}`. The second went from 53 problems to 5 to none in two runs, each with the right fix.
- **A new app does not break the framework's tests.** The matrix, policy card and app map tests no longer list the folders with those pages, so the second app's `pnpm -r test` was green with its own `policy.matrix`, `POLICY.md` and `APP-MAP.md`.
- **patterns.md covered the paragraph.** The fields of `Party`, `PrincipalDirectory` and `PortalConfig`; `redact: none` beside `say: null` (the second app's item description used it); the order of the chat's sign-in lines; that a completed form's slots are cleared. None of these was a stumble the second time.
- **A relative date bound** (`today+30`, `today-30`) replaced a custom rule: the second app's 30 days in the past are one `dateInRange` rule.
- **A keypad menu key for an informational intent plays its line.** The second app put office hours on the menu and it worked; what it lacked was when the menu listens (now documented).
- **Step 7 of the skill** writes and reads the policy card and the app map, which is where the second builder saw the one-list oddity.

## What the second trial's stumbles changed

Each entry of the transit log ends with its fix. In short:

- `check` says which file an unknown top-level key belongs in (`purposes` in identity.yaml: move it to policy.yaml), and every snippet in patterns.md names its file.
- `check` refuses, when identity.yaml has delegates, an action for the one-time code's `send:` tool with no `role` rule that keeps them out (or one that allows a role), with the rule as the fix. The utility passes (it refuses its managers). It is the hole both trials found by reading the matrix, now caught before anyone reads it.
- The regression refuses to run a scripted call with a spoken step whose words no corpus line has, as it refuses a duplicate text, and lists every one. The testkit's, the clinic's and the utility's calls had none.
- The policy card says an identical redaction once in its defaults line (both trials saw "account by its last four; account by its last four"). The utility's card is rewritten; the others are unchanged.
- `testing.policyMatrix` needs a record id for each subject only when a rule scopes by a record.
- patterns.md, corpus.md and the authoring guide say when the keypad menu listens (after the second missed answer to the intent question, on a call with a keypad), what a corpus line's `answers` field and `noul` are, and how to hold a whole amount the caller names until there is a money type.

## What remains

Work on the engine and its harness that the trials showed, not done here (an engine change goes through the Phase 4 branch with its own verification):

- **An amount of money.** A slot type for an amount the caller names: "a hundred and fifty", cents, and keypad entry. Until then, a whole amount is a `digits` slot with a mask (patterns.md), which reads numbers as identifiers.
- **One seeded caller for the corpus.** Every corpus line inside a form runs as `testing.seed.caller`, so a delegate's answer inside a form cannot run as the delegate; the delegate's path inside forms is covered only by scripted calls.
- **One confirmed list per app.** Every action with a `confirmed` rule names the same fields, so the policy card says a lost item report confirms a dollar amount. Forms now declare `calls`, which could let each write confirm its own list.
- **`regress` cannot add only new baseline entries.** Adding a corpus line or a scripted call to an app with a baseline means `--update` of the whole baseline, which the rules forbid on an existing one, or a hand edit.
- **The menu offered again after an informational key starts "Let's try the keypad."** The `nomatch_dtmf_menu` line is said after the informational line, and its opening reads as if the caller had missed again.

Also open:

- **The testkit's `sendCode` lets its agents send a code.** The engine's own test app has delegates (agents, as viewer or clerk) and a `sendCode` action with no role rule, which is the hazard the new check refuses; the testkit is not an app folder, so `pnpm check` does not read it. Adding `role: { viewer: refuse, clerk: refuse }` changes no verdict in the testkit's stub run, but it adds a role line to every `sendCode` decision in the testkit's gate-event golden and to the shadow gate's comparison against the frozen tables. Left for a decision rather than changed here.
- **The authoring guide is long** (over a thousand lines). The skill says to read it a section at a time; it has not been split.
