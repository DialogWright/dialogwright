import { z } from 'zod';
import { checkAlways, identifier, matching, name, text, unique } from './common';
import { E164 } from '../../core/numberLocales';
import { ENV_REFERENCE } from '../../core/app/envReference';
import { AGENT_TIMEOUT_RANGE } from '../../agent/types';

/**
 * business.yaml: the facts of an app in agent mode (app.yaml's `mode: agent`;
 * docs/designs/2026-11-08-agent-mode.md). One file says everything about the business the line may
 * use: who it is and how it sounds, what it does and does not do, what it may claim, where it is, its
 * days and windows, its regular accounts, what a request and a booking collect, and the lines said in
 * fixed words. The engine builds the app from it (../businessApp.ts): its intents, forms, slots,
 * prompts, policy and identity, so the gate, the audit, the console and the records see an ordinary
 * app. The file is the business's own word, as prompts.yaml is: not the knowledge base, whose
 * approvals do not apply to it.
 *
 *   business: { name: Example Library, voice: "Warm, quiet and brief." }
 *   services: [{ name: holds, about: A book kept at the desk for a week. }]
 *   claims: [Holds are kept at the front desk for a week.]
 *   request:
 *     fields:
 *       - { name: patronName, type: name, question: "What's your name?" }
 *       - { name: title, type: text, about: The book's title., question: Which book is it? }
 *     readBack: "Here's the hold: {patronName}, {title}. Is that right?"
 *     then: [placeHold]
 *     done: Thanks, {patronName}. The desk will call when it's in.
 *   handoff: I'll have someone from the desk call you back.
 *   closing: Thanks for calling Example Library.
 */

/** The days of the week a business may name in `days`. */
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A field's options that are the business's windows (`windows`), by their names. */
export const WINDOWS_OPTIONS = 'windows';

/** The forms a business.yaml may define, in the order the engine builds them. */
export const BUSINESS_FORMS = ['request', 'booking', 'callback'] as const;
export type BusinessFormName = (typeof BUSINESS_FORMS)[number];

/** A phone number as a carrier sends it (E.164: +, then up to 15 digits). */
const phone = () =>
  matching(E164, 'is not a phone number in E.164 form ("+15555550142")', 'write the number as + and its country code and digits, with no spaces or dashes, for example "+15555550142"');

/**
 * An account's number: one written out (E.164), or env.<NAME>, a setting of the app's own holding one. The
 * pattern, its message and its fix are app.yaml's voice.numbers' own (the schema keeps one fix per pattern).
 */
const accountNumber = () =>
  matching(
    new RegExp(`(?:${E164.source})|(?:${ENV_REFERENCE.source})`),
    'must be an E.164 number like +15555550142, or env.<NAME>',
    'write env.<NAME> (capitals, digits and underscores) and set the variable to the number in the app\'s settings (.env), or write the number with + and the country code, in quotes ("+15555550142")',
  );

const field = z
  .strictObject({
    name: identifier().describe('The field\'s name: the read-back\'s and the done line\'s {placeholder}, the param of the same name in every call the form makes, and the name the agent model gives its value by (for example callerName, day).'),
    type: identifier().describe('The slot type from the library the value is checked by (docs/slots/README.md): choice, date, digits, name or text. birthdate is refused (an identity factor\'s type, and the conversation is sent to the agent model). A type that takes no value from outside its own fill (record, reference, topic) is refused, since in agent mode the model understands the value and the slot type checks it.'),
    question: text().describe('The field\'s question, said word for word when the line asks for it in fixed words (the agent\'s reply was not said, or the field is next and nothing else is): its ask_<form>_<field> line.'),
    about: text().optional().describe('What the value is, for the agent model ("The title of the book, as the caller gave it."). Default: none, the field\'s name alone.'),
    options: z
      .union([z.literal(WINDOWS_OPTIONS), unique(text(), 'option').min(2, { error: 'must list at least two options' })])
      .optional()
      .describe(`A choice field's options: a list of the words each option is said by ("one", "not sure"), or "${WINDOWS_OPTIONS}", the names of the business's windows. Only on a choice field, which needs it.`),
    optional: z.boolean().optional().describe('true: the form may be read back without it. Default false: the read-back waits for it. Every field is sent by the form\'s `then`, so an optional field is still named in the read-back (the caller confirms what is sent), with `says.unset` for when it is left empty.'),
    says: z
      .record(text(), z.union([
        text(),
        z.strictObject({
          readBack: text().describe('What the read-back says for the option.'),
          done: text().describe('What the done line says for the option.'),
        }).describe('The option said one way in the read-back and another in the done line ("yes": { readBack: "and we\'ll text you at", done: "Reply to our text with a photo." }).'),
      ]))
      .optional()
      .describe('A choice field: how each option is said in the form\'s read-back and done line, by the option\'s words ("large print": "in large print"), or `{ readBack, done }` for words of each line, and `unset`, what is said there when an optional field is left empty. An option not listed is said by its words. Only on a choice field. Default: none, each option by its words.'),
    length: z.int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).max(40, { error: 'must be at most 40' }).optional().describe('A digits field\'s number of digits (10 for a phone number with its area code). Only on a digits field, which needs it.'),
    offer: z
      .literal('callerNumber')
      .optional()
      .describe('A digits field that may be the number the caller is calling from: "callerNumber" offers it (the slot\'s callerNumber). Only on a digits field.'),
    countryCode: z
      .string()
      .regex(/^\d{1,3}$/, 'countryCode is one to three digits, such as "1"')
      .optional()
      .describe('With offer: callerNumber, the country calling code the carrier writes before the number ("1" for +1), taken off the number calling to fill the field. Default "1".'),
    freeFrom: matching(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/, 'is not a tool and a list of its result ("availability.windows")', 'write the tool a field of the same form sees, a dot, and the field of its result that lists the free options, for example "availability.windows"')
      .optional()
      .describe('A choice field whose value must be free: <tool>.<list>, a tool a field of the same form sees (`sees`) and the field of its checked result that lists the free options, by their keys (availability.windows). Once the model has been shown that result, a value not in its list is refused (range), and the model is asked again with what is free, so the line never takes, or promises, a full option. Only on a choice field. Default: none.'),
    full: z
      .union([
        text(),
        z.strictObject({
          some: text().optional().describe('Said where another option is free: the default "We\'re full for the {<field>} on {<day>}. We have the {free}."'),
          none: text().optional().describe('Said where nothing is free on that day, before the day\'s own question (the day is asked again): the default "We\'re full on {<day>}."'),
          ask: text().optional().describe('The question said after `some` where exactly one option is free, in place of the field\'s own question ("Does the {free} work for you?"; the agent-mode design, call 55): {free} is that option, as the field says it, and a yes to it fills the field with it. It may name {free} and the field that sees the tool (the day) only. Where two or more are free, the field\'s own question. Default: none, the field\'s own question always.'),
        }).describe('The line where another option is free (`some`) and where none is (`none`), and the question after `some` where one option is free (`ask`), each optional, its default the engine\'s.'),
      ])
      .optional()
      .describe('A `freeFrom` field: what is said, in fixed words, when the option the caller asked for is full, in place of the plain retry line. A string is said where another option is free, followed by the field\'s question; `{ some, none }` words each case. Its {placeholders}: the form\'s fields by name (this field\'s own is the option asked for, the field that sees the tool is what it was looked up for, the day), and in `some`, {free}, the options free, as the field says them, joined by or ("morning or afternoon"). Where nothing is free on that day, `none` is said (default "We\'re full on {<day>}."), and the day cleared and asked again; the attempt counts on this field as the retry did. Only on a field with `freeFrom`. Default: the engine\'s lines, "We\'re full for the {<field>} on {<day>}. We have the {free}." and "We\'re full on {<day>}."'),
    sees: identifier()
      .optional()
      .describe('A tool whose result the agent model may see once the field is filled (the maintainer\'s decision 2): the tool, in the app\'s code, is called through the gate with the field\'s value, and its result, checked by the tool\'s reply check in a closed form, reaches the model. For example availability, for a day.'),
    figures: z
      .enum(['free', 'cited'])
      .optional()
      .describe('A text field: whether the figures of the value the agent model gives are held to the caller\'s words it cites (the text slot\'s `figures`). "free": not compared, the read-back being the guard; "cited": a figure the words do not have is refused (a note "waived fee of $40 agreed" from words that name no fee). Only on a text field. Default: free (the maintainer\'s decision, 2026-11-10).'),
    redact: z
      .enum(['none', 'last4', 'length', 'length-summarized'])
      .optional()
      .describe('How the value is masked wherever it leaves the turn, as its slot type takes it: a digits field last4 (its default), length or none; a text field none only (its default), since its value is read back as the line understood it; no other type takes one. length-summarized is refused: in agent mode the conversation is sent to the agent model, so a value kept only by its length would be sent whole. Default: the slot type\'s own.'),
  })
  .describe('One field a form collects: its name, its slot type and its fixed question.');

/**
 * The reasons the gate and the engine give of their own: a `when` reason that were one of them would make a
 * refusal on the condition look like another (a `confirmation` one reads the read-back again, say).
 */
export const RESERVED_REASONS: readonly string[] = [
  'identity', 'scope', 'role', 'confirmed', 'confirmation', 'attempts', 'fields', 'dateInRange', 'limit', 'oneOf', 'noneOf', 'callerNumber',
  'not-one-of', 'one-of', 'value-missing', 'unlisted', 'unknown-tool', 'unknown-rule', 'subject', 'delegate', 'minimization', 'branch',
  'rule-error', 'rule-invalid', 'result-unchecked', 'after-unchecked',
];

/**
 * One tool a form's yes calls: its name, or `{ tool, when }`, a tool called only where a field of the form
 * holds one option (the caller's consent to a text: `{ tool: sendText, when: { field: textOk, is: "yes" } }`).
 * The condition is the gate's: compiled to a `oneOf` rule on the tool's param, so with any other value the
 * gate refuses the tool, the refusal is audited, and the form goes on without it.
 */
const thenStep = z.union([
  identifier(),
  z
    .strictObject({
      tool: identifier().describe('The tool, as a plain entry names it.'),
      when: z
        .strictObject({
          field: identifier().describe('A choice field of the form.'),
          is: text().describe('The option the field must hold, by its words ("yes"): with any other, or none, the gate refuses the tool.'),
          reason: name()
            .refine((r) => !RESERVED_REASONS.includes(r), { error: 'is a reason the gate gives of its own, so a refusal on this condition could not be told from it' })
            .optional()
            .describe('The reason the gate records when it refuses the tool ("no-consent"), none of the gate\'s own (confirmation, identity, scope, ...). Default "<field>-not-<option>".'),
        })
        .describe('The condition the gate holds the tool to: a oneOf rule on the field\'s param.'),
    })
    .describe('A tool called only where a field of the form holds one option.'),
]);

/** A form's `then` entry, as written. */
export type ThenStepYaml = z.infer<typeof thenStep>;

const formShape = {
  about: text().optional().describe('What the form is for, as the agent model is told ("a hold on a book, collected in a pick-up window"). Default: the form\'s name.'),
  label: text().optional().describe('The form in a few words, as the line names it ("send a request"). Default: the engine\'s words for the form.'),
  fields: z.array(field).min(1, { error: 'must list at least one field' }).describe('What the form collects, in the order its fixed questions are asked.'),
  readBack: text().describe('The read-back: the line, in fixed words, that says what the line understood, with each field\'s value as its slot type displays it ({name}), and asks the caller to confirm it. A yes sends the form\'s `then` to the gate.'),
  then: z
    .array(thenStep)
    .min(1, { error: 'must name at least one tool' })
    .check(checkAlways((items, ctx) => {
      if (!Array.isArray(items)) return;
      const seen = new Set<string>();
      items.forEach((item, i) => {
        const tool = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as { tool?: unknown }).tool : undefined;
        if (typeof tool !== 'string') return;
        if (seen.has(tool)) ctx.addIssue({ code: 'custom', path: [i], message: `tool "${tool}" is listed twice`, params: { fix: `delete one of the two "${tool}" entries` } });
        seen.add(tool);
      });
    }))
    .describe('The tools a yes at the read-back calls, in order, each through the gate: the first is the form\'s write. Each is called with the form\'s values by field name (and, on a form for accounts, the account as `account`), and each carries exactly what the caller confirmed. A tool follows one form only. A tool after the first may be `{ tool, when: { field, is } }`, called only where a choice field of the form holds that option (a text sent only with the caller\'s consent): the gate refuses it otherwise, and the form goes on without it.'),
  done: text().describe('The line said, in fixed words, once the form\'s tools have run, with the values as {placeholders}.'),
  cancel: text()
    .optional()
    .describe('The question asked, in fixed words, where the caller says at the read-back that they don\'t want to go ahead ("never mind"; the agent-mode design, call 55): a yes ends the call with nothing sent, a no reads the request back again. It names no field. Default: "Do you want to cancel this request?"'),
};

const form = z.strictObject(formShape).describe('A form: what it collects, its read-back, the tools a yes calls and its done line.');

const booking = z
  .strictObject({
    for: z.literal('accounts').describe('Who may book: "accounts", a caller the number they call from matches to one of `accounts` (identity level 1 by a caller-ID match). Any other caller may not.'),
    ...formShape,
  })
  .describe('The booking a regular account makes: a form open only to an account, recognized by the number it calls from.');

const service = z
  .strictObject({
    name: text().describe('The service as the line names it ("holds").'),
    about: text().optional().describe('What it is, in the business\'s words: something the line may say.'),
  })
  .describe('One service the business offers.');

const window = z
  .strictObject({
    name: identifier().describe('The window\'s name, as a choice field with options: windows takes it and the read-back says it ("morning").'),
    says: text().describe('What the window is, in the business\'s words, which the line may say ("from 9 to noon").'),
    capacity: z.int({ error: 'must be a whole number' }).min(1, { error: 'must be at least 1' }).optional().describe('How many requests or bookings the window takes, for the app\'s own calendar. Never said by the line.'),
  })
  .describe('One window of the day something is dropped off or collected in.');

const account = z
  .strictObject({
    name: text().describe('The account\'s name, as the line and the read-back say it ({account}).'),
    numbers: unique(accountNumber(), 'number').min(1, { error: 'must list at least one number' }).describe('The numbers the account calls from: each written out (E.164, in quotes) or env.<NAME>, a setting of the app\'s own (its settings file under a host, or the environment) holding one, for a number that stays out of the file (a tester\'s own phone). A setting unset is left out, with a note as the server starts; one set to anything but an E.164 number stops the server. A call from one of them is recognized as the account, by caller ID. Caller ID can be forged: the policy card says what a forged number could do.'),
  })
  .describe('One regular account, booked straight in.');

export const businessSchema = z
  .strictObject({
    business: z
      .strictObject({
        name: text().describe('The business\'s name ("Example Library").'),
        says: text().optional().describe('The name as the line says it, where it differs. Default: name.'),
        kind: text().optional().describe('What kind of business it is, for the agent model ("a public library").'),
        voice: text().describe('How the line sounds, in the business\'s own words, for the agent model: the persona.'),
        owner: text().optional().describe('The owner\'s name, where the line refers to the owner ("Dana").'),
        oneOwner: z.boolean().optional().describe('true: the business is one person, and the line never speaks of a team. For the agent model.'),
        examples: z
          .array(text())
          .optional()
          .describe('Replies the owner wrote, to show the agent model the tone: examples, never rules and never facts. Measured on 2026-11-09: with them, no reply held a figure the facts do not. Default: none.'),
      })
      .describe('Who the business is and how it sounds.'),
    services: z.array(service).min(1, { error: 'must list at least one service' }).describe('What the business does: the only services the line speaks of.'),
    notOffered: z.array(text()).optional().describe('What it does not do, which the line may say it does not ("book sales"). Default: none.'),
    claims: z.array(text()).optional().describe('The reassurance the line may give, in the business\'s words: the only claims, and the only place a turnaround or a promise may come from. Default: none.'),
    background: z.array(text()).optional().describe('Context for the agent model only, never said as a claim. Default: none.'),
    prices: z
      .strictObject({
        quote: text().optional().describe('How a price is given, for the agent model ("at the desk"). Never a figure.'),
        say: text().describe('The price line, said word for word when a caller asks about price: the line never says a figure.'),
        forms: unique(z.enum(BUSINESS_FORMS), 'form')
          .min(1, { error: 'must name at least one form' })
          .optional()
          .describe('The forms in which the agent model may name the price line: with another form open, it is not offered (and not said if named), so a price line about one kind of work is never said in another ("[request]": an account\'s bookings are billed otherwise). With no form open it is offered. Default: every form.'),
      })
      .optional()
      .describe('How prices are given. Without it, the line has no price line to say.'),
    where: z
      .strictObject({
        place: text().describe('Where the business is, in its words: something the line may say.'),
        mobile: z.boolean().optional().describe('true: the business also comes to the caller. Default false, which the line may say.'),
      })
      .optional()
      .describe('Where the business is.'),
    days: unique(z.enum(WEEKDAYS), 'day').min(1, { error: 'must list at least one day' }).optional().describe('The days of the week it works, which the line may say. Default: none said.'),
    windows: z
      .array(window)
      .min(1, { error: 'must list at least one window' })
      .optional()
      .describe('The windows of the day, which a choice field takes with options: windows. Default: none.'),
    accounts: z.array(account).optional().describe('The regular accounts, each with the numbers it calls from. Needed by a booking. Default: none.'),
    request: form.optional().describe('What any caller\'s request collects, its read-back, the tools a yes calls and its done line.'),
    booking: booking.optional(),
    callback: form.optional().describe('A callback note a caller who wants a person leaves (there is no live transfer): what it collects (a number to call back on), its read-back, its tools and its done line. Without it, a caller who wants a person hears the handoff line.'),
    greeting: z
      .union([
        text(),
        z
          .strictObject({
            call: text().optional().describe('The line a call opens on. Default: "Thanks for calling <says>. How can I help?"'),
            chat: text().optional().describe('The line a web chat opens on. Default: "Hi, this is <says>. What can I help with?"'),
          })
          .describe('The opening line of each channel, each with its own default.'),
      ])
      .optional()
      .describe('The opening line, in fixed words: a string is the line a call opens on (a chat opens on the chat default), or { call, chat }, each channel\'s own. Default: "Thanks for calling <says>. How can I help?" on a call, "Hi, this is <says>. What can I help with?" in a chat.'),
    handoff: text().describe('The line said when a caller asks for a person, in fixed words: a callback, not a transfer. A statement, not a question ("I\'ll have someone from the desk call you back."): it is said where nothing waits for an answer, and the callback form, where there is one, asks for the number.'),
    closing: z
      .union([
        text(),
        z
          .strictObject({
            call: text().optional().describe('The line a call ends on. Default: "Thanks for calling <says>."'),
            chat: text().optional().describe('The line a web chat ends on. Default: "Thanks for chatting with <says>. Goodbye."'),
          })
          .describe('The closing line of each channel, each with its own default.'),
      ])
      .describe('The closing line, in fixed words: a string is the line a call ends on (a chat ends on the chat default), or { call, chat }, each channel\'s own. The call\'s is also the closing the agent model is told of. Default within { call, chat }: "Thanks for calling <says>." on a call, "Thanks for chatting with <says>. Goodbye." in a chat.'),
    owner: z
      .strictObject({
        notify: z.enum(['text', 'print']).describe('How the owner hears of each request and booking: "text", a text message (printed until texting is registered), or "print", printed only.'),
        number: phone().optional().describe('The owner\'s number (E.164), for the app\'s own tools. A real number may stay out of the file, in the app\'s settings (its code reads it with ctx.env). Default: none.'),
        summary: text().describe('The owner\'s summary of each request and booking, a fixed template with the values as {placeholders}: never a generated line.'),
      })
      .optional()
      .describe('Where requests and bookings go: the owner\'s number and the summary sent. For the app\'s own tools.'),
    tools: z
      .record(identifier(), text())
      .optional()
      .describe('What each tool a form calls does, in a few words, by its name ("placeHold: place the hold"): the action\'s description on the policy card, the console and the audit. Default: the tool\'s name in words.'),
    texts: z
      .record(identifier(), text())
      .optional()
      .describe('The texts the app\'s own code sends, in the business\'s fixed words, by a name its code reads them by (photoRequest: "Reply to this text with a photo of the damage."), with the {placeholders} its code fills: never a generated line, and never said on a call. Default: none.'),
    values: z
      .strictObject({
        refusedUncounted: z
          .int({ error: 'must be a whole number' })
          .min(0, { error: 'must be at least 0' })
          .max(10, { error: 'must be at most 10' })
          .optional()
          .describe('How many times a field\'s value the agent model gives may be refused by the field\'s check (not in its shape, or cited from words the caller never said) with no attempt counted: the field\'s question is asked again, since the model\'s value refused is not the caller\'s miss and the read-back is the guard. Past it, each refusal of the field counts an attempt on its ladder (its retry line, the keypad, a person), so a call never loops; the count is the field\'s, kept until it is filled or its form closes. A value out of the field\'s range (a day in the past, a full window) always counts. 0: each refusal counts, as before 2026-11-10. Default 2 (the maintainer\'s decision, 2026-11-10).'),
        earlierWords: z
          .boolean()
          .optional()
          .describe('Whether a value the agent model gives may cite the caller\'s words from an earlier turn of the call, where this turn\'s do not have them (the model gives a value a turn after it was said): only to fill a text, name or digits field still empty, whose check ties the value to its words; never a choice or a date, and never to change a value held. false: this turn\'s words only, as before 2026-11-10. Default true (the maintainer\'s decision, 2026-11-10).'),
      })
      .optional()
      .describe('How the values the agent model gives are held to the caller\'s words, and what a refusal costs the caller. Default: { refusedUncounted: 2, earlierWords: true }.'),
    waiting: z
      .strictObject({
        afterMs: z
          .int({ error: 'must be a whole number of ms' })
          .min(100, { error: 'must be at least 100' })
          .describe('How long into a turn, ms, with the agent model\'s answer not in, one of `lines` is said.'),
        upToMs: z
          .int({ error: 'must be a whole number of ms' })
          .min(AGENT_TIMEOUT_RANGE.min, { error: `must be at least ${AGENT_TIMEOUT_RANGE.min}` })
          .max(AGENT_TIMEOUT_RANGE.max, { error: `must be at most ${AGENT_TIMEOUT_RANGE.max}` })
          .describe(`How long, ms from the model first asked, the turn then waits for its answers (the first, an asking again after one not in its shape, a second shown a tool's result), in place of AGENT_TIMEOUT_VOICE_MS where that is shorter; past it, the turn's fallback (the question it was waiting on). The reply's checks and wording come after. ${AGENT_TIMEOUT_RANGE.min} to ${AGENT_TIMEOUT_RANGE.max}, more than afterMs.`),
        lines: z
          .array(text())
          .min(1, { error: 'must list at least one line' })
          .max(6, { error: 'must list at most six lines' })
          .describe('The short lines said while the model is slow, in fixed words, each a statement ("One sec."): one at most a turn, in turn, so the same one is never said twice in a row on a call (with two or more).'),
      })
      .check(checkAlways((value, ctx) => {
        const w = value as { afterMs?: unknown; upToMs?: unknown };
        if (typeof w.afterMs === 'number' && typeof w.upToMs === 'number' && w.afterMs >= w.upToMs) ctx.addIssue({ code: 'custom', path: ['afterMs'], message: `is ${w.afterMs}, not less than upToMs (${w.upToMs}), so no line could be said before the wait ends`, params: { fix: 'make afterMs less than upToMs (1200 and 4000, say)' } });
      }))
      .optional()
      .describe('On a call, what the caller hears while the agent model is slow: past `afterMs` into a turn with its answer not in, one of `lines` is said at once (once the decision model\'s reading is in, and never over a caller it reads as not finished), and the turn waits for the model up to `upToMs`; past that, its fallback. Not on a turn decided without the answer (a read-back, a turn the decision model settles). What the caller says over a line, before the turn\'s own, answers nothing. Voice only (a chat\'s own budget, AGENT_TIMEOUT_CHAT_MS, is already long). Default: none, the turn waiting AGENT_TIMEOUT_VOICE_MS and saying nothing meanwhile.'),
    lines: z
      .record(identifier(), text())
      .optional()
      .describe('The engine\'s own lines in the business\'s words, by id (nomatch_open, no_input, anything_else, goodbye_chat, ...), in place of their defaults. Default: the engine\'s words.'),
  })
  .check(checkAlways((value, ctx) => {
    const b = value as { request?: unknown; booking?: unknown };
    if (typeof b !== 'object' || b === null) return;
    if (b.request === undefined && b.booking === undefined) ctx.addIssue({ code: 'custom', path: [], message: 'has neither a request nor a booking, so a caller can ask for nothing', params: { fix: 'add "request:" (what any caller\'s request collects), "booking:" (an account\'s booking), or both' } });
  }))
  .describe('business.yaml: the facts of an app in agent mode, from which the engine builds the app.');

export type BusinessYaml = z.infer<typeof businessSchema>;
export type BusinessFieldYaml = z.infer<typeof field>;
export type BusinessFormYaml = z.infer<typeof form> & { for?: 'accounts' };
