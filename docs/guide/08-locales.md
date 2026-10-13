# 8. Locales

[Contents](README.md) · Previous: [7. Checking an app: `pnpm check`](07-checking-an-app-pnpm-check.md) · Next: [9. Configuration hashes](09-configuration-hashes.md)

An app speaks the language of its `prompts.yaml`, named by `locale:` in app.yaml (default `en-US`). To add a language, add `locale/<tag>/prompts.yaml` with the same shape, and, for how its library slots say their values there, an optional `locale/<tag>/slots.yaml`, and for how its lines name the caller's request, an optional `locale/<tag>/intents.yaml` (and `forms.yaml` for an internal form) (below). The library has `locale/es/prompts.yaml`, `locale/es/slots.yaml` and `locale/es/intents.yaml`:

```yaml
prompts:
  greeting:
    text: Gracias por llamar a la Biblioteca de Example Town. Puedo renovar un libro o revisar una reserva. ¿En qué puedo ayudarle?
    interruptible: true
```

- **What `check` requires.** In every locale: each prompt an intent, form, identity.yaml or app.yaml names, and each line the engine says (section 2, prompts.yaml). A line that only the app's code says (the library's `no_hold`) may be left out of a translation. A translated line may use only the variables of its prompts.yaml line, and a locale may not have a line prompts.yaml lacks. A locale's labels name an intent intents.yaml has, and an internal form forms.yaml has (below).
- **Labels, `locale/<tag>/intents.yaml` and `locale/<tag>/forms.yaml`.** The engine names the caller's request in six lines: `ack_intent`, `confirm_intent_explicit`, `disambiguate_intent`, `ack_intent_then`, `ack_queued` and `bridge_next` (`{intentLabel}`, or `{a}` and `{b}`), with the intent's `label` from intents.yaml, or an internal form's from forms.yaml. A locale gives its own in the shape of those files, the label alone; a call in that locale says it, and an intent it leaves out is said by its default label. A live call once said "le puedo ayudar a report a problem": the Spanish line with the English label.

    ```yaml
    # locale/es/intents.yaml (its first line: # yaml-language-server: $schema=../../../../packages/dialogwright/schemas/locale-intents.schema.json)
    intents:
      renew_loan:
        label: renovar un libro
      check_hold:
        label: revisar una reserva
    ```

    ```yaml
    # locale/es/forms.yaml, for a form reached only by another's next (forms.yaml's internal: true); its first line names locale-forms.schema.json
    forms:
      payment_plan:
        label: preparar un plan de pago
    ```

    `check` refuses, at the key, an intent intents.yaml does not have (with the near name), a form in `forms.yaml` that is an intent's (its label goes in `intents.yaml`) or that is no internal form, and any key but `label`. It warns, once per locale, when the locale's own prompts.yaml says one of the six lines and gives no label for a form intent, an internal form or `done` (which a caller may be asked to confirm): those are said in the default's words in the middle of its lines. A label the same in both languages is the app's to leave out, so it is a warning. The decision model is still told the default's label (the pending confirmation it reads), as it reads every question and criterion in the default language. Both files are in the configuration hashes, by their paths.
- **Folders.** `locale/` holds one folder per locale, named by its language tag. A file there is a problem, and so are two folders whose names differ only in letter case (`pt-BR` and `pt-br`), which would be one locale.
- **Fallback.** A line missing from a locale is said from the default locale, one line at a time, so a half-translated app still works.
- **Choosing the locale.** The session starts in the default locale. A channel can name another: the `session.start` event carries a `locale`. On the phone the relay adapter reads it from a custom parameter named `locale`, which the start document sets from app.yaml's `voice.numbers` for the number called; a web chat asks for one as it starts (`start.locale`, the widget's `locale` option or the page's `<html lang>`). See [13.3](13-channels.md#133-languages-on-the-phone) and [13.4](13-channels.md#134-web-chat). It is matched against the app's locales: the same tag (letter case aside), else the app's locale that is the request's language alone (`es-US` finds `es`), else the app's first locale in that language (`es` finds `es-MX`), else the default. The request is untrusted: it is only compared, and what is used is always one of the app's own tags. An intent with `locale:` switches the call mid-way ([13.3](13-channels.md#133-languages-on-the-phone)).
- **The knowledge base** has its own wording and passages per locale, with its own fallback rule (`localeFallback`): see [12.7](12-the-knowledge-base.md#127-locales-and-fallback).
- **Spoken text.** A translated line is spoken by text to speech. Recorded clips are in the default language only.
- **Slots hear and say the session's language.** A slot's context carries the session's locale (`ctx.locale`), and the library types read it. What changes for a Spanish session (`es`, or any `es-*` tag); every other locale, and an app without locales, reads and says values exactly as en-US always has:
  - **Numbers.** The spans a number question offers and the digits read from them are Spanish: "cinco cinco cinco dos cero cuatro uno siete", "cincuenta y cinco cincuenta y dos cero cuatro diecisiete", "mil novecientos noventa y uno". Accents are optional ("dieciséis", "dieciseis"); a span keeps them as said. The engine keeps one word table per language (`core/extract/lexicon.ts`), English and Spanish so far.
  - **Names.** Word spans are Unicode ("María José"), the words around a name are Spanish ("me llamo", "soy", "sí"), a compound surname is one span ("Muñoz de la Cruz": `de`, `del`, `la`, `las`, `los`, `y`, `e` inside a name, never at its ends), and a name is said back with its particles in lower case ("María José Muñoz de la Cruz").
  - **Dates.** A day is said "martes, 22 de septiembre", a birth date "22 de noviembre de 1991", a span of days "la próxima semana" or "en diciembre". A date said as numbers puts the day first: the default month and day questions say so to the model, and the keypad takes `DDMM` (a `date`) and `DDMMYYYY` (a `birthdate`), the same number of keys; write the `ask_<slot>_dtmf` line in each locale to match.
  - **Wording, `locale/<tag>/slots.yaml`.** Words an app chooses for a value are given per locale, by slot id: a choice option's `say` and a text slot's stand-in. They replace the slot's own for sessions in that locale; an option left out keeps its own words.

    ```yaml
    # yaml-language-server: $schema=../../../../packages/dialogwright/schemas/locale-slots.schema.json
    branch:
      options:
        north: Norte
        riverside: { say: Ribera }
    note:
      say: su nota
    ```

    `defineApp` builds each library slot it names again with its wording, whether the slot is in slots.yaml or built in code with `defineSlot`, and `check` reports, at the line: a slot the app does not have (with the closest name), a slot written by hand in code (it has no options to word; format its `display` by `locale` instead), a library slot changed in code after it was built (`{ ...slot, dtmf }`: built again it would lose the change), a type that takes no wording (`digits`, `date`, `birthdate`, `name` and `record` say their values by locale themselves), an option the slot does not have, and any key but `say`. The file is in the configuration hashes, by its path. An app that is not a folder (`defineSlots`) has no locale files.
  - **What stays in the default language, by design.** The questions: their instructions and criteria are what the model reads, and their labels are keys (`north`, `november`), so a Spanish caller is asked about in English, with the Spanish words among a span question's choices. A choice option's `means` and a record's `label` are criteria, so they are not worded per locale either.
- **On the phone and in a chat.** The call's language, its voice and recognizer per carrier, and a switch mid-call are [13.3](13-channels.md#133-languages-on-the-phone): give a locale's `tts` and `transcription` a region (`es-US`, not `es`, which Twilio refuses), and a recognizer that hears its language; a chat's request for a language is [13.4](13-channels.md#134-web-chat). An app without locales, and a one-locale en-US app, sends exactly what it did before: no languages, and text frames in `en-US`.
- **Known limits.** The phone's own (hints after a switch, and what is still to be confirmed on a live call) are in [13.3](13-channels.md#133-languages-on-the-phone).
  - A slot written by hand in code formats its own values: it says them in Spanish only if it reads `ctx.locale` and `display(value, locale)`.
  - Spanish is the one language besides English the slots read and say; another language's sessions read words as English and say values in English until its lexicon and formats are added.
  - Matching a requested locale looks at the language and the whole tag, not at a script subtag: a request for `zh-Hant` in an app with only `zh-Hans` finds `zh-Hans` by its language, `zh`.
- **Generated lines.** A line the app generates ([16](16-generated-wording.md)) is generated in the call's language only where the locale's prompts.yaml gives it a `goal` of its own; elsewhere the locale's fixed line is said. A locale's prompts.yaml gives a generated line only its goal: `mode`, `prescribed`, `when` and `from` are prompts.yaml's, for every locale (`check` says so).
- An app with neither `locale:` in app.yaml nor a `locale/` folder behaves exactly as before: its App has no locales, its sessions carry no locale, and nothing it writes changes. `locale:` alone (as the clinic has) gives the App its locales, the default's and no others.
