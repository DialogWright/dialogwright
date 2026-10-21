# More than one way to prove a level

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18); built on main.**

## The problem

A level of the identity ladder has one set of factors and one tool that checks them. The create-app skill lists the gap ("your account number, or your phone number and ZIP code": no either-or verification). A booking line met it: a caller proves a booking by its code, or, without the code, by the phone number and zip code on it, which finds every upcoming booking of theirs; the caller then says which one ("the Hyundai", "the Tuesday one").

## The decision

identity.yaml's level 1 may list `ways` in place of `factors` and `verify`:

```yaml
levels:
  1:
    name: booking found
    ways:
      - { factors: [bookingCode], verify: findByCode }
      - { factors: [bookingPhone, bookingZip], verify: findByPhoneZip, say: identity_by_phone }
    failedPrompt: identity_failed
```

- **Asking.** A step-up asks the first way's factors, in order. A caller who gives a factor of another way ("my number is ...") is asked the rest of that way. A missed answer to a way's question ("I don't know the code") moves to the next way, with no attempt counted: its `say` line first, where it has one ("No problem, I can find it by your phone number and zip code."), then its first factor. Every way's factors listen while identity is asked, so a caller may give any of them at any time. A missed answer on the last way is retried as any slot's is.
- **Checking.** The first way whose factors are all filled is checked by its own tool, which returns the principal as a verify tool always has. What the principal stands for, and so what the gate's `scope` allows, is the app's: one booking for a code, every booking of a phone and zip for the other.
- **Failing.** A failed check counts against the level's attempts, one count shared by every way (each way's tool has the `attempts` rule, which reads the one count); the factors are emptied, and the way that failed is asked again from its first factor after `failedPrompt`.
- **Everything else** that treats identity factors specially (they are masked, never dictated, never given a caller's number, left out of a handoff) holds for every way's factors, as one set.
- A level with `ways` took no `callerId` at first (the caller-ID match identified one set of factors); since 2026-10-21 it may (below). The policy card lists each way.

## What it costs

Nothing for an app whose levels name `factors`: one way, asked and checked as before. The session keeps the way being asked (`Session.identityWay`) only for an app with ways.

## Addendum, 2026-10-21: a caller-ID match on a level with ways

The booking line that met the gap asked next for caller ID: a caller on their own phone should not have to give the phone the booking is under. Its second way is the phone and the house number on the booking (the zip, which most of its customers share, proved next to nothing), so the number calling can stand in for the phone.

- `callerId` may stand beside `ways`. The factors it `identifies` are all of one way and leave at least one of that way's factors to ask; `pnpm check` refuses factors of two ways, or every factor of the way.
- On a call the lookup matched, that way is asked first (`Session.identityWay`), with the caller-ID question in place of its first factor left to ask, and its own tool checks it with the identified factors filled from the match, as for one set of factors. A caller who gives another way's factor at the question is checked by that way.
- A missed answer at the caller-ID question ("I don't know") sets the match aside (`declined`) and moves to the first of the other ways, with no attempt counted, after its `say` line or `identity_caller_declined`. "Different account", a no and a failed check set the match aside as before; the matched way is then asked from its first factor.
- A call with no match asks the ways in their order. An app without `callerId`, or with one set of factors, is unchanged.
