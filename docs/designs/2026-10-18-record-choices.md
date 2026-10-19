# A record question that names its choices

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18); built on main.**

## The problem

A record slot asks which of the caller's records they mean ("Which one is it?"). On a chat the records are answer buttons; on a call the caller hears no list, so a caller with two bookings must remember both, or guess how to name them.

## The decision

A slot may give its question lines values (SlotSpec.questionVars). A record slot gives `{choices}`: the records its question offers, each as its `display` says it (else its key), said in a row with "or" in the call's language (Intl.ListFormat's disjunction: "A or B", "A, B, or C", "A, B o C"). The turn adds them to the decision when it asks `ask_<slot>`, one of its other wordings, or one of its retries (core/questionVars.ts), so the line said and the line the turn keeps are the same; the harness does too when it sets a corpus line at the question. The app's line uses `{choices}` or not: it suits a short list. `pnpm check` refuses a question line that uses a value the slot does not give.
