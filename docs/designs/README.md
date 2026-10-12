# Design documents

These are the design documents for engine features. Each one sets out the problem, the options considered, the recommendation and what it would change, so the reasoning stays with the code. A design records a proposal at a point in time; the decisions that followed are in the last entry below.

- [2026-10-07-qualify-then-collect.md](2026-10-07-qualify-then-collect.md): form checks, so a line can ask qualifying questions first and turn a caller away before collecting details.
- [2026-10-07-opener-values.md](2026-10-07-opener-values.md): what happens to values a caller says on the opening request, and why the one-form pattern is enough for now.
- [2026-10-07-caller-id.md](2026-10-07-caller-id.md): offering the carrier's caller number for a callback number slot.
- [2026-10-07-priority-handoff-slots.md](2026-10-07-priority-handoff-slots.md): a priority intent that corrects the open form, and a handoff that marks unconfirmed slot values.
- [2026-10-07-caller-id-for-apps.md](2026-10-07-caller-id-for-apps.md): caller ID as app data: a call-start lookup, proposed values, and a rule for texts.
- [2026-10-08-confirm-on-values.md](2026-10-08-confirm-on-values.md): reading back any answer, or only certain values, and a check's deciding answer before it acts.
- [2026-10-08-app-decides.md](2026-10-08-app-decides.md): business-judgement refusals become options or warnings: proposals at the greeting, proposals from later facts, checks that need identity.
- [2026-10-08-caller-id-identifies.md](2026-10-08-caller-id-identifies.md): a caller-ID match identifies the account and a knowledge factor verifies it, with a fall back to the normal identity ladder.
- [2026-10-08-offer-answers-and-consent.md](2026-10-08-offer-answers-and-consent.md): the answers an offer takes, required offers, and consent to text for the whole call.
- [2026-10-08-sub-forms-and-listening.md](2026-10-08-sub-forms-and-listening.md): `next:` and internal forms, and a per-form switch for whether its slots listen before it opens.
- [2026-10-08-flow-building-blocks.md](2026-10-08-flow-building-blocks.md): the classic IVR building blocks (telephony data in and out, data dips, ordered branches, play-only steps, collect settings) in DialogWright terms; decided, and built in the three pieces below.
- [2026-10-09-per-slot-retries.md](2026-10-09-per-slot-retries.md): the build of the flow building blocks' first piece: `attempts`, retry lines per attempt, and `onMaxAttempts` on any slot.
- [2026-10-09-call-data-and-transfers.md](2026-10-09-call-data-and-transfers.md): the build of the flow building blocks' second piece: `callData` from the carrier and the chat page, and transfer targets chosen by ordered rules, with data sent with the transfer.
- [2026-10-09-routes.md](2026-10-09-routes.md): the build of the flow building blocks' third piece: `routes.yaml` at call start, after identity and after a form, business hours, and the start hook.
- [2026-10-09-phase10-adoption.md](2026-10-09-phase10-adoption.md): Phase 10's build: DialogWright outside this repository (a build, one command line, a project of one's own, the adoption test), the adversarial suite every app inherits, and the adopter's documents.
- [2026-10-11-phase8b-many-servers.md](2026-10-11-phase8b-many-servers.md): Phase 8b trimmed to its core promise, a deploy or a failed server never drops a call: a Postgres store with one owner per call, the audit in Postgres, traces on S3-compatible storage, the console across servers, a container image and the two-server test.
- [2026-10-11-several-apps.md](2026-10-11-several-apps.md): several apps on one deployment, the app chosen by the number called (host.yaml), with a default; decided, and built after Phase 8b (its As built says how).
- [2026-10-12-the-console.md](2026-10-12-the-console.md): the console as a call-center dashboard: Live (calls in progress, alerts), Calls (history), Insights (containment, transfers, abandonment, struggles, cost), Knowledge and Health.
- [2026-10-08-decisions.md](2026-10-08-decisions.md): the maintainer's decisions on the designs above, and the principles behind them.

The [authoring guide](../guide/README.md) is the reference for how a feature works today. Where a design and the guide differ, the guide is right. The create-app skill's pattern notes are in [.claude/skills/create-app/patterns.md](../../.claude/skills/create-app/patterns.md); the trial a design cites is in [docs/trials](../trials/README.md).
