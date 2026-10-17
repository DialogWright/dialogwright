# Harbor Mutual

The member line and chat of a fictional accident insurer, built with DialogWright by an AI coding assistant from a one-paragraph description, following the create-app skill (the paragraph, every design choice and the gaps are in [DESIGN.md](DESIGN.md)). Harbor Mutual sells two plans, Accident Advantage and Accident Advantage Plus. Every name, date and number in it is made up (phones in the 555 range).

What a caller can do:

- **Check on a claim** (`claim_status`): the member verifies with their member ID and date of birth, then keys a six-digit code texted to the phone on file (said by its last four only; a code said aloud is never taken: a new one is texted). They name the claim by its four-digit number, what it was for, or its date; a member with one claim is not asked which. The status is said in fixed lines (`getClaim`), and the gate refuses a claim that is not theirs (`scope`).
- **Ask what their plan covers** (`coverage`): after the member ID and date of birth, the answer from their own plan's certificate: a passage a person approved (see "The knowledge base" below), said word for word, or, on the four topics marked `risk: low` (sports injuries, prescriptions, travel, the filing deadline), worded for the member's question from that passage, held to it by the checks and the drift judge, with the passage said whenever one fails. For physical therapy and follow-up visits it adds how many the member has used this year (`getUsage`, a gated read).
- **Report a new claim** (`report_claim`): after the code, the kind of loss (an accident injury, a hospital stay or a covered diagnosis), the day it happened and what happened in their own words; the line reads the claim back, and a yes files it (`createClaim`, a confirmed write). The gate refuses a loss date after today and sends one outside the member's coverage to a claims specialist (`dateInRange` against the member's coverage window). The claims intake service then triages the claim (`triageClaim`): the member hears only the documents Harbor has approved lines for, how soon an adjuster will call and whether it is fast-tracked, and is texted a link to upload them (`sendUploadLink`).
- **Hear what the line can do** (`capabilities`), and **ask for a person** at any time (`agent`): at the start, on the keypad, while verifying, at the code prompt, inside a form, while describing what happened, at the read-back.

On the keypad, from the greeting on: 1 for a claim's status, 2 for coverage, 3 to report a claim, 0 for a person. A member who sounds frustrated about a claim is offered a person (the engine's frustration ladder, limited to the claim forms by app.yaml's `frustration.forms`).

On the chat, a member signs in through the member portal instead of saying the factors (`signIn` at level 2). A **broker** (delegate `broker`, roles `service_rep` and `office_admin`) signs in through the broker portal and may check the claims of the members their office is agent of record for (the `scope` rule over `scopeOf`), and ask what such a member's plan covers (asked which client, `clientId`, a slot asked of brokers only, and checked at once by `isClient`), never hearing the diagnosis, the member's statement or how many of a benefit the member used (policy.yaml `redact`); a service rep may not file a claim, and an office admin's filing goes to a claims specialist (the `role` rule), before any question is asked.

The policy, read back, is [POLICY.md](POLICY.md) (the policy card, in words), [policy.matrix](policy.matrix) (what the gate decides for every action and every kind of caller) and [APP-MAP.md](APP-MAP.md) (the app's structure). Each is generated, tested against the app, and written again only for a change you meant.

## The knowledge base

`kb/` holds the answers to coverage questions: fourteen topics (physical therapy, the emergency room, an ambulance, a hospital stay, fractures, imaging, urgent care, follow-up visits, a dental injury, sports injuries, pre-existing conditions, prescriptions, travel, the deadline to file), each answered for both plans by a passage drawn from that plan's certificate of coverage for its plan year (`kb/sources`), in force on its own dates, and approved by a person (`kb/approvals.jsonl`). The passages, sources and approvals were carried over unchanged from an earlier version of Harbor. `searchPolicy` (the engine's `kbAnswerTool`) resolves the passage for the member's plan, read from the member's record, never from what the caller said. Topics are found by their words and their meaning (the hybrid retriever with the static embedder potion-base-8M; its vectors in `kb/.index/`), with the cap and the floor chosen offline on `fixtures/kb/paraphrases.yaml`:

```sh
pnpm kb:status apps/harbor                                                                 # every passage, by state
pnpm kb:bakeoff apps/harbor --paraphrases apps/harbor/fixtures/kb/paraphrases.yaml --sweep  # retrieval, measured offline
pnpm kb:index apps/harbor                                                                  # after a change to a topic's words; commit the index
```

A passage is approved only by a person, at their own terminal: `pnpm kb:review apps/harbor` or `pnpm kb:approve <id...> --by "<your name>"`.

Four topics are marked `risk: low` in `kb/topics.yaml` (sports injuries, prescriptions, travel, the filing deadline): their passage may be worded for the member's question by the model `style.yaml` names, through `coverage_answer`'s span `from: answer`; every other topic's passage is said word for word. A wording is said only when the checks and the drift judge pass it; otherwise the passage is. When the wording takes longer than a line's budget, the member first hears `kb_hold` ("One moment while I gather that information."). The policy card lists the line, its goal and the four topics.

## The folder

```
app.yaml        who the app is and how it presents itself
intents.yaml    what a caller can ask for, and the keypad menu
forms.yaml      each form's slots, its summary prompt and the hooks it has
prompts.yaml    every line a caller can hear
style.yaml      how the one generated span (a low-risk coverage answer) sounds, and the model that words it
policy.yaml     what the agent may do, action by action: the level and the rules the gate runs before each
identity.yaml   how a caller proves who they are: the factors, the one-time code, the brokers, the chat sign-in
slots.yaml      every slot, in the order the engine works through them
policy.matrix   what the gate decides, for every action and every kind of caller (generated)
POLICY.md       the policy card: the policy in plain English, with its diagrams (generated)
APP-MAP.md      the app map: intents, forms, slots, actions and rules as diagrams (generated)
src/app.ts      the code: the tools, the form hooks and the gate's lookups, joined to the folder by defineApp
src/data.ts     the fixture members, claims, brokers and usage behind the stub tools
src/intake.ts   a stand-in for the claims intake service (its rules, run in process)
src/portal.ts   the demo portal: a stand-in member and broker sign-in for the web chat, off unless HARBOR_DEMO_PORTAL=on
assets/         the Harbor Mutual logo and emblem, for the portal's pages
kb/             the knowledge base: settings, topics, the certificates' text by section, approved passages, the approvals log, the index
fixtures/       the corpus, the scripted calls, the stub baseline, and the paraphrases retrieval is measured on (kb/)
DESIGN.md       the design worksheet: the paragraph, every choice it left open, the gaps, and the notes on the skill
CLAUDE.md       notes for an AI coding assistant changing this app
```

What is data is YAML, and what runs is TypeScript. Policy is never in a tool: the gate decides, from `policy.yaml`, whether a tool may run. The guide to every file is [docs/guide/](../../docs/guide/README.md), and the slot types are in [docs/slots](../../docs/slots/README.md).

## Commands

Run these at the repository root.

```sh
pnpm check                                          # every app folder: YAML, schemas, cross-links to the code, prompts, corpus
pnpm --filter @dialogwright/example-harbor typecheck
pnpm --filter @dialogwright/example-harbor test
pnpm --filter @dialogwright/example-harbor regress   # the stub regression: prints "no changes", then a summary
pnpm --filter @dialogwright/example-harbor regress --scenario <id>  # one scripted call, turn by turn (--corpus <id>: one corpus line)
pnpm --filter @dialogwright/example-harbor cli --client heuristic   # a text console, with no keys
```

The three generated pages are the policy read back: compliance reads them, and `src/app.test.ts` fails when one is not what the app generates. They ship matching the example. After a change to the policy, the forms or the tools, write them again with `pnpm policy:matrix apps/harbor`, `pnpm policy:card apps/harbor` and `pnpm app:diagram apps/harbor`, read each diff as a change in what the agent may do, and commit them with the change.

Nothing here needs an API key. The engine's stub clients stand in for the decision model, answering from the labels in `fixtures/corpus.jsonl`.

## The fixtures and the baseline

- `fixtures/corpus.jsonl`: one labelled utterance per line. Every intent needs examples (`pnpm check` says which are missing), including terse ones, and each line says what the stub model should answer for it.
  The side-speech line (`ns-02`) carries `"answers":{"addressedToSystem":{"noul":0.15}}`: it sets the stub's answer to one of the engine's own yes-or-no questions, whether the words were meant for the agent, and `noul` is the probability of yes (the engine's name for a yes-or-no answer, not a typo). At 0.15 the turn is ignored as speech to someone else. The field is described in the create-app skill's `corpus.md`.
  The `done` lines (`dn-01` to `dn-07`) are said at "anything else?" (context `anything_else`, seeded by `testing.seed.anythingElse` in `src/app.ts`): that is where a caller says they are finished, and `done` ends the call with the goodbye. A broker's lines carry `"as"` (`priya`, `dana`): they are typed in that broker's signed-in chat.
- `fixtures/scenarios/`: scripted calls, each with the outcome it expects: `core.json` (the phone line), `member-chat.json` (a member on the chat, signing in), `broker.json` (each broker role) and `adversarial.json`. Every spoken step of a scripted call must also be in the corpus, so the stub can answer it: the regression refuses to run one that is not, and names it.
- `fixtures/expected/`: the baseline, the stub's outcome for every corpus line and scripted call. The regression run compares against it and prints `no changes`.

The baseline was made once, with `regress --update`, and read entry by entry against the worksheet. From then on it is never regenerated: a changed output is a finding to explain, not noise to overwrite, and a hand edit is logged in DESIGN.md ("Baseline edits").

The regression also runs the adversarial suite (app.yaml's `testing: { adversarial: on }`): hostile calls the engine generates from this app (announced injections, callers claiming a relationship they have not proven, requests the line does not handle, codes said aloud or never sent, and every tool replying with instructions in its reply), each held to properties over its run, never to the baseline. It prints `adversarial N/N cases hold`, or a `FAIL adversarial <id>` line naming each property that did not hold; `regress --adversarial <id>` shows a case turn by turn. A failed case is a finding about the app: a reply's field said or a turn that threw on `hostile-reply/<tool>/field` wants a `check` on that tool (as every tool here has); never turn the suite off to pass. Against a recording, a case not yet recorded is listed as such and fails nothing.

## Recording against the real model

The stub answers from the corpus labels. A cassette holds the real decision model's answers, recorded once and replayed offline, so a run shows how a real model does on this app's calls. Recording calls the paid perception API (a few cents for an app this size), so it is a deliberate local step for the app's owner, and never part of CI.

1. Put the key in this folder's `.env` (it is git-ignored). At the repository root, `pnpm configure --app harbor --mode model` asks for the model and its key (no phone line yet) and writes the file; or copy `.env.example` to `.env` here and put your TypeSafe API key in it as `TYPESAFE_API_KEY` (or a key from OpenRouter or the Vercel AI Gateway, or a compatible endpoint's, with `JEV_PROVIDER`: `.env.example` lists them). `regress` reads this folder's `.env` itself: there is nothing to load into the shell.
2. Record, at the repository root, with this one command:

   ```sh
   pnpm --filter @dialogwright/example-harbor regress --client record --threshold JEV_TIMEOUT_MS=15000
   ```

   It appends each answer to `fixtures/recorded/<model>.jsonl` and aborts after three consecutive client errors. The diff against the stub baseline shows where the real model reads a line differently from its label; that is expected, and it never rewrites the baseline.
3. Replay it offline, as often as you like: `pnpm --filter @dialogwright/example-harbor regress --client recorded`. It calls nothing and costs nothing. Its last line counts what is left to decide: `to triage: N untagged corpus differences, M failing scripted calls, K passing scripted calls that differ from the baseline, J cassette misses`. A line the model reads differently from its label stays the truth in the corpus and gets a `knownGap` with its reason (see "Known gaps" in the [clinic's README](../../apps/clinic/README.md)); the create-app skill's [triage page](../../.claude/skills/create-app/triage.md) has the whole procedure.
4. After a second recording, trim the cassette: `pnpm --filter @dialogwright/example-harbor cassette:trim`. Recording appends, so the first recording's answers stay in the file though no replay reads them; the trim replays the whole run from the cassette and keeps only the answers it uses, and writes nothing if a request misses.
5. Commit the cassette. It holds only the corpus text and the model's answers to it.

A change to the words in the YAML (criteria, labels, prompts, the questions a slot sends) changes what the model is sent, so the replay reports each changed request as a cassette miss until the cassette is recorded again. A change to code, to the policy, or to a scripted call's silences and keys sends nothing new: check it on the recording you have before asking for another.

## Running it

`pnpm --filter @dialogwright/example-harbor serve` starts the phone line and the operator console. It needs `PUBLIC_HOST`, `TWILIO_AUTH_TOKEN` and `HANDOFF_NUMBER` (a 555 number is fine for local use; see `.env.example`), and runs on the stub client unless `JEV_CLIENT` says otherwise. It reads a settings file when `ENV_FILE=<path>` names one, such as this folder's `.env`; a variable already in the environment wins over the file. At the repository root, `pnpm configure --app harbor` asks and writes this folder's `.env` (mode 600), and `pnpm start --app harbor` runs the server with it, through a quick tunnel when `PUBLIC_HOST` is unset.

## Try the chats on a server

Harbor has a demo portal (`src/portal.ts`): a stand-in for the member and broker websites and their identity provider, so the web chat can be tried signed in, as a member or as a broker. It lists Harbor's fictional members and brokers, signs you in as whichever you choose with no password, and opens a branded page with the engine's chat widget on Harbor's chat, signed in with a token that lasts an hour. **It signs anyone in as anyone**, which is why it is off unless `HARBOR_DEMO_PORTAL=on`, and why it only ever lists Harbor's invented people. A real site does this part with its own sign-in (a password and a second factor) and its own identity provider.

Off (the default), every path under `/harbor/portal` is a 404. On, the server that runs Harbor serves (its own server, or a host's, [14.15](../../docs/guide/14-running-it.md#1415-several-apps-on-one-server-hostyaml)):

| Path | What it is |
|---|---|
| `GET /harbor/portal` | the sign-in page: every member (name, member ID) and broker (name, role, office) |
| `POST /harbor/portal/sign-in` | signs in as the person chosen (a session cookie for an hour), then the chat page |
| `GET /harbor/portal/chat` | the member's page (the chat open in the corner) or the broker's (their office's clients, the chat on the page) |
| `POST /harbor/portal/token` | the signed-in person's token, which the widget's `getToken` asks for |
| `POST /harbor/portal/sign-out` | ends the session |
| `GET /harbor/portal/jwks.json` | the public key the tokens are verified with |

The tokens are signed with an Ed25519 key (EdDSA) the server makes as it starts and keeps in memory only (a restart makes a new one, and a page from before it signs in again). Each names `iss` `harbor-demo-portal`, `aud` `harbor-chat`, and an hour's `exp`; a member's has `sub`, the member ID, and a broker's `broker_id` (what `principals.fromClaims` reads), with `role` and `office_id`; the broker's principal is read from Harbor's records by `broker_id`. The engine's chat verifies them against the portal's published key (`CHAT_SIGNIN=jwt`, [13.5](../../docs/guide/13-channels.md#135-sign-in-on-the-web-chat)): a member is signed in at level 2 (`identity.yaml`'s `signIn`), a broker as a broker with their role and office.

The server's settings for it, with your public host (an https tunnel to the server) in place of `<public host>`:

```sh
CHAT=on
CHAT_ALLOWED_ORIGINS=https://<public host>
CHAT_SIGNIN=jwt
CHAT_JWKS_URL=https://<public host>/harbor/portal/jwks.json
CHAT_ISSUER=harbor-demo-portal
CHAT_AUDIENCE=harbor-chat
WIDGET=on
WIDGET_FILE=<the repository>/packages/widget/dist/dialogwright-widget.js
HARBOR_DEMO_PORTAL=on
```

- Build the widget first, at the repository root: `pnpm --filter @dialogwright/widget build` writes `packages/widget/dist/dialogwright-widget.js`, the file `WIDGET_FILE` names (an absolute path; the server refuses to start when it is missing). Without `WIDGET_FILE` the server looks for `node_modules/@dialogwright/widget/dist/dialogwright-widget.js` in the folder it runs in.
- The server fetches the key from `CHAT_JWKS_URL`, its own public URL, through the tunnel, the first time someone signs in to the chat.
- Under a host file, the server's settings file (the `.env` beside `host.yaml`) holds the chat's and the widget's settings; `HARBOR_DEMO_PORTAL=on` may go there or in this folder's own `.env`. When another app on the host signs its chat in with another identity provider, give Harbor its own `CHAT_ISSUER`, `CHAT_AUDIENCE` and `CHAT_JWKS_URL` in this folder's `.env` ([14.15](../../docs/guide/14-running-it.md#1415-several-apps-on-one-server-hostyaml)).
- As it starts, the server says the portal is on, and names each chat setting above that is not as the portal signs (a `WARNING: demo portal:` line each, with the value it needs).

Then open `https://<public host>/harbor/portal`, choose a member (Jordan Ellis, say: ask whether physical therapy is covered, or report a claim) or a broker (Priya Shah, an office administrator: ask for the status of claim 4711, and the diagnosis is withheld; Dana Ruiz, a service rep, is refused a filing). Sign out at the top, and choose someone else. The calls appear in the console as chats, each with the person the token named.
