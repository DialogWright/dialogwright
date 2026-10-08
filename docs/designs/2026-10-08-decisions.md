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
