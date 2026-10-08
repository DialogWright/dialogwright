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
- [2026-10-08-decisions.md](2026-10-08-decisions.md): the maintainer's decisions on the designs above, and the principles behind them.

The [authoring guide](../authoring-an-app.md) is the reference for how a feature works today. Where a design and the guide differ, the guide is right. The create-app skill's pattern notes are in [.claude/skills/create-app/patterns.md](../../.claude/skills/create-app/patterns.md); the trial a design cites is in [docs/trials](../trials/README.md).
