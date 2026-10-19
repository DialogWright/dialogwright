# Confirmed fields per action

Date: 2026-10-18. Status: **decided (the maintainer, 2026-10-18); built on main.**

## The problem

A confirmed write is hashed as its form's summary is read (`confirmedParams`), and the gate's `confirmed` rule compares the write's values with that hash. The hash was taken over one list per app (`PolicyTables.confirmedFields`), since at read-back time the engine did not know which action the form would call, and `check` required every `confirmed` rule to name the same fields (Decision 5). An app with several writes listed the union in each rule, and each write sent every field, empty where it had none: a booking line's cancel "confirmed" a service, a name and an address; its policy card said so; its audit carried the empty fields; and a write that forgot one was refused.

## The decision

Each form's read-back is hashed over the confirmed fields of the action it writes (core/confirmedFields.ts):

- **Which action.** forms.yaml's new `writes: <action>`, else the one action with a `confirmed` rule among the form's `calls`. A form that calls two confirmed actions names its own with `writes`; `check` refuses a `writes` that names an action without a confirmed rule.
- **Each its own list.** With every confirming form's action known, the `confirmed` rules may name different fields, and each write sends only its own.
- **As before otherwise.** A form whose action is not known (no `calls`, as in an app that does not declare them, or two confirmed actions and no `writes`) is hashed over the app's one list, and `check` requires the lists to agree then, its fix naming both ways out. Every app written before keeps working unchanged.
