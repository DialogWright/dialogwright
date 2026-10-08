# Decisions, 2026-10-08 (the maintainer, on the overnight designs)

Standing principle: the framework provides building blocks and
safe defaults; the app decides. The trial app is a test: never
tune it by hand; give the framework and the create-app skill the options, and let the next trial run use
them. Focus now: every option a normal IVR app might use, and a skill that finds them and teaches a new
Claude to use them.

1. **Confirmation on any answer.** Any slot may read back always, by confidence, only at the summary, or
   only for certain values (`rent` but not `own`). A check's outcome may read back the deciding answer
   before it acts (for refusals that can't be listed as values). The skill teaches when: an answer that
   ends the call or turns a caller away is confirmed first.
2. **What a lookup may say before identity:** the app's call. The framework supplies the caller ID and the
   lookup result; no restriction.
3. **Where a proposal is made:** anywhere the app likes, the greeting included. Remove the "at the slot"
   restriction.
4. **Caller ID as an identifier.** Very common: a caller-ID match identifies the account, a knowledge
   factor verifies it ("I see an account associated with the number you are calling from. To access this
   account please provide your birthday or say different account."). Caller ID + birthday may replace
   member ID + birthday; "different account", a no or a failed factor fall back to the normal ladder; the
   app sets the level it reaches. Build it on a fixture; an app outside this repository opts in later.
5. **Utility opt-in to proposals:** not now.
6. **The offer's answers follow its question.** "Shall I look up your account from your caller ID, or just
   tell me the account number" takes yes, no or digits; "Are you calling about the account ending in
   1234" takes yes or no. Configurable per offer.
7. **Skippable or required:** a text offer for an appointment reminder may be declined; one needed for a
   one-time code can't be skipped. Already `onNo: ask | skip`; make sure "required" is expressible (and
   documented in the skill).
8. **Consent to text, recorded every time it's granted.** Plus a call-wide "up-front text offer" (asked at
   the start: permission to text helpful links throughout the call); if granted, later text moments use
   it; if declined, each moment asks again, accept or decline. Every grant is recorded.
9. **A check that needs the caller verified first:** allow it (a warning at most), not a refusal.
10. **Proposing facts loaded after identity:** allow it, not only facts from the call-start lookup.
11. **The screened fixture in CI:** unit tests are fine.
12. **Forms reached only from another form, and which slots listen up front.** A sub-form reached only
    from another form (`next:`) needs no intent and its slots should not listen at the top level (values
    said early may be asked again, acceptable). A form-level option (whether its slots listen before the
    form is entered, true or false), so a designer can decide per form, root forms included; per-slot
    `listen` still overrides. The maintainer asked to be told if this causes problems not yet anticipated.
13. **Names:** fine as they are.

Also: design the flow building blocks (classic IVR building blocks in DialogWright terms: telephony data
in and out, data dips, ordered branch conditions with a default, play-only states, collect states with configurable
retries and confirmations) for review before building.

## Build order (agreed 2026-10-08)

Each item goes through the usual loop: a design note where one is needed (here, in docs/designs/), an
implementer in a worktree from local main, a reviewer, the full local CI suite, the private scan and a
check that an app outside this repository is unchanged, then a fast-forward of local main. Nothing is
pushed until a set is proven on calls.

1. Confirmation on any answer, or only on certain values (`rent` not `own`), and a check outcome that
   reads back the deciding answer before it acts (decision 1).
2. Business-judgement refusals in `pnpm check` and the engine become options or warnings: proposals
   anywhere (the greeting included), a check needing identity, proposals from facts loaded after
   identity (decisions 2, 3, 9, 10).
3. Caller ID as an identifier: a caller-ID match identifies the account, a knowledge factor verifies it,
   "different account" falls back; the app sets the level (decision 4). On a fixture.
4. An offer's answers follow its question: yes/no, digits, or both, per offer; "required" offers that
   can't be skipped (decisions 6, 7).
5. Call-wide consent: an up-front text offer covering the call; declined means ask at each moment; every
   grant recorded (decision 8).
6. Sub-forms and listening: `next:` forms that need no intent and inherit shared slots; a per-form switch
   for whether its slots listen before the form is entered (decision 12).
7. The create-app skill teaches all of the above: when each option fits.
8. A design (for review, not built) of the flow building blocks: telephony data in and out, data dips,
   ordered branch conditions with a default, play-only steps.

Then: live checks 9 (a withheld caller ID on each carrier) and 10 (the called number on Telnyx), Stage 6
run 2 (a fresh agent builds the foundation repair line from its paragraph, with a company name), and
the push of the proven batch to GitHub.
