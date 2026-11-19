import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WEB_CHAT } from '../channel/caps';
import { startEvent, textEvent, withCallData } from '../channel/events';
import { personaApp } from '../core/app/personas';
import { personaOfTurn } from '../render/config';
import { appOf, registerApp, resetAppsForTest } from '../core/app/registry';
import type { App } from '../core/app/types';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { resolve, type TurnContext } from '../core/turn';
import { ANONYMOUS } from '../gate/principal';
import { BASE } from '../kb/__fixtures__/libraryKbApp';
import { promptSay, spokenText } from '../prompts/render';
import { segmentTemplate } from '../prompts/segments';
import { choice } from '../testing/answers';
import { MESSAGE_DIR, messageCode } from '../testing/message/app';
import { policyCardText } from '../testing/policyCard';
import { checkApp } from './check';
import { AppDefinitionError, defineApp } from './defineApp';
import { LIBRARY_DIR, libraryCode } from './fixture/app';
import { loadAppFolder } from './load';
import { formatProblem } from './problems';

/**
 * Personas (app.yaml's personas, each a persona file): read and held to the app's lines by the loader and
 * check, applied to the app by personaApp, picked by appOf from the session's call data, said by
 * text-to-speech, and listed on the policy card. On the engine's library and message fixtures.
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of an app folder's YAML (no code), with `files` written over it. */
function folder(from: string, files: Record<string, string | ((text: string) => string)> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-personas-'));
  scratch.push(dir);
  cpSync(from, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof change === 'string' ? change : change(readFileSync(path, 'utf8')));
  }
  return dir;
}

const SCHEMA_LINE = '# yaml-language-server: $schema=../../../../schemas/persona.schema.json\n';

/** app.yaml with the persona key read from a chat's context, and the personas. */
const withPersonas = (files: string, from = 'persona') => (text: string): string =>
  `${text}callData:\n  persona: { from: chat.persona, redact: keep }\npersonas:\n  from: ${from}\n  files:\n${files}`;

const CALM = `${SCHEMA_LINE}prompts:
  greeting_chat:
    text: Hello, and welcome to the library. Renew a book, or check a hold?
  ack_intent:
    text: Happy to help you {intentLabel}.
    variants: ["Of course, let's {intentLabel}."]
  goodbye:
    chat: "Take care, **friend**."
`;

/** The library with two personas: calm (its own lines) and brisk (the greeting alone). */
function libraryWithPersonas(extra: Record<string, string | ((text: string) => string)> = {}): string {
  return folder(LIBRARY_DIR, {
    'app.yaml': withPersonas('    calm: personas/calm.yaml\n    brisk: personas/brisk.yaml\n'),
    'personas/calm.yaml': CALM,
    'personas/brisk.yaml': `${SCHEMA_LINE}prompts:\n  greeting:\n    text: Library. What do you need?\n`,
    ...extra,
  });
}

/** The loader's problems for a folder, formatted. */
const loadLines = (dir: string): string[] => loadAppFolder(dir).problems.map(formatProblem);

describe('app.yaml\'s personas and a persona file, as the loader reads them', () => {
  it('reads each file, by its value, into the configuration and its hashes', () => {
    const loaded = loadAppFolder(libraryWithPersonas());
    expect(loaded.problems.map(formatProblem)).toEqual([]);
    expect(Object.keys(loaded.config!.personas!)).toEqual(['calm', 'brisk']);
    expect(loaded.config!.personas!.calm!.prompts!.ack_intent!.text).toBe('Happy to help you {intentLabel}.');
    expect(Object.keys(loaded.config!.hashes.files ?? {}).filter((f) => f.startsWith('personas/'))).toEqual(expect.arrayContaining(['personas/calm.yaml', 'personas/brisk.yaml']));
  });

  it('refuses a from that is not a callData key', () => {
    const dir = folder(LIBRARY_DIR, { 'app.yaml': withPersonas('    calm: personas/calm.yaml\n', 'voice_style'), 'personas/calm.yaml': CALM });
    expect(loadLines(dir)).toEqual([expect.stringMatching(/^app\.yaml:\d+:\d+ {2}personas\.from {2}personas\.from names "voice_style", which is not a key of callData.* -> {2}name one of "persona"/)]);
  });

  it('refuses a file that is not there, and one outside the folder or not a .yaml file', () => {
    expect(loadLines(folder(LIBRARY_DIR, { 'app.yaml': withPersonas('    calm: personas/missing.yaml\n') }))).toEqual([expect.stringMatching(/personas\.files\.calm {2}the persona "calm" is in personas\/missing\.yaml, which is not in the app folder {2}-> {2}create personas\/missing\.yaml/)]);
    const outside = loadLines(folder(LIBRARY_DIR, { 'app.yaml': withPersonas('    calm: ../calm.yaml\n    loud: personas/loud.txt\n') }));
    expect(outside).toHaveLength(2);
    for (const l of outside) expect(l).toContain('is not a persona file in the app folder');
  });

  it('refuses a file its schema refuses: an unknown key, a line that gives nothing, a budget out of range', () => {
    const dir = folder(LIBRARY_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  greeting:\n    words: 10\n  ask_intent: {}\nstyle:\n  words: { chat: 1000 }\n`,
    });
    const problems = loadLines(dir);
    expect(problems.some((l) => l.startsWith('personas/calm.yaml:') && l.includes('prompts.greeting') && l.includes('words'))).toBe(true);
    expect(problems.some((l) => l.includes('prompts.ask_intent') && l.includes('gives none of text, variants and chat'))).toBe(true);
    expect(problems.some((l) => l.includes('style.words.chat') && l.includes('at most 400'))).toBe(true);
  });

  it('refuses a line prompts.yaml does not have, and a prescribed one', () => {
    const dir = folder(LIBRARY_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'prompts.yaml': (t) => t.replace('  goodbye:\n', '  goodbye:\n    prescribed: true\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  greetng:\n    text: Hi.\n  goodbye:\n    text: Bye now.\n`,
    });
    expect(loadLines(dir)).toEqual([
      expect.stringMatching(/^personas\/calm\.yaml:3:3 {2}prompts\.greetng {2}the line "greetng" is not in prompts\.yaml.* -> .*rename it to "greeting"/),
      expect.stringMatching(/^personas\/calm\.yaml:5:3 {2}prompts\.goodbye {2}the line "goodbye" is prescribed \(prompts\.yaml's prescribed: true\).* -> {2}delete "goodbye" from the persona/),
    ]);
  });

  it('refuses a variable the app\'s own line does not name, in the text, a variant or the chat version', () => {
    const dir = folder(LIBRARY_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  ack_intent:\n    text: Happy to help, {name}, to {intentLabel}.\n    variants: ["On it: {thing}."]\n  goodbye:\n    chat: "Bye, {name}."\n`,
    });
    const problems = loadLines(dir);
    expect(problems).toEqual([
      expect.stringContaining('prompts.ack_intent.text  the persona\'s text of "ack_intent" names {name}, which the app\'s own line "ack_intent" does not'),
      expect.stringContaining('prompts.ack_intent.variants[0]  the persona\'s variant "On it: {thing}." names {thing}'),
      expect.stringContaining('prompts.goodbye.chat  the persona\'s chat version of "goodbye" names {name}'),
    ]);
    expect(problems[0]).toContain('->  name only {intentLabel} here');
  });

  it('refuses a framed line\'s text that leaves out its span, and a budget for a span the app does not generate', () => {
    const dir = folder(MESSAGE_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  confirm_take_message:\n    text: "I'll tell {recipient} that {caller}, on {phone}, called. Pass it on?"\nspans:\n  confirm_take_message:\n    summary: { words: 40 }\n    gist: { words: 40 }\n  read_back_exact:\n    summary: { words: 40 }\n  no_such_line:\n    summary: { words: 40 }\n`,
    });
    const problems = loadLines(dir);
    expect(problems).toEqual([
      expect.stringContaining('prompts.confirm_take_message.text  the line "confirm_take_message" is framed (prompts.yaml\'s generate), and the persona\'s text leaves out its span {summary}'),
      expect.stringContaining('spans.confirm_take_message.gist  the line "confirm_take_message" generates {summary}, not {gist}'),
      expect.stringContaining('spans.read_back_exact.summary  the line "read_back_exact" has no generated span'),
      expect.stringContaining('spans.no_such_line  the line "no_such_line" is not in prompts.yaml'),
    ]);
  });

  it('refuses personas in an app in agent mode', () => {
    const problems = loadLines(folder(LIBRARY_DIR, { 'app.yaml': (t) => `${t}mode: agent\npersonas:\n  from: persona\n  files: { calm: personas/calm.yaml }\n` }));
    expect(problems.some((l) => l.startsWith('app.yaml:') && l.includes('personas  personas reword a scripted app\'s lines'))).toBe(true);
  });
});

describe('a persona\'s lines, as check holds them', () => {
  it('holds its variants and chat versions to the rules of a line\'s words, in the persona\'s file', async () => {
    const dir = libraryWithPersonas({
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  greeting:\n    text: Hello.\n    variants: ["Hi."]\n  ack_intent:\n    chat: "Sure, **{intentLabel}**."\n    variants: ["Of course, {intentLabel}."]\n  goodbye:\n    chat: "# Bye"\n`,
    });
    const problems = (await checkApp(dir, { code: libraryCode })).map(formatProblem).filter((l) => l.startsWith('personas/'));
    expect(problems).toEqual([
      expect.stringContaining('personas/calm.yaml:5:5  prompts.greeting.variants  the line "greeting" has variants, other wordings said in turn, which only the lines said in turn have'),
      expect.stringContaining('prompts.ack_intent.chat  the line "ack_intent" has a chat version and variants'),
      expect.stringContaining('prompts.goodbye.chat  the line "goodbye"\'s chat version has'),
    ]);
  });

  it('defineApp holds each persona\'s app to the App contract: a chat version on a line its form generates is refused', () => {
    const dir = folder(MESSAGE_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}prompts:\n  ask_recipient:\n    chat: "Who is it **for**?"\n`,
    });
    let error: unknown;
    try {
      defineApp(dir, messageCode);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppDefinitionError);
    expect((error as AppDefinitionError).problems.map(formatProblem)).toEqual([expect.stringMatching(/^personas\/calm\.yaml:1:1 {2}\(file\) {2}validateApp refused the app as the persona "calm" words it: app "message": the line "ask_recipient" has a chat version and is generated/)]);
  });
});

describe('personaApp: the app as a persona words it', () => {
  const app = defineApp(libraryWithPersonas(), libraryCode);

  it('replaces the lines it words field by field, marks them the persona\'s, and keeps every other part of the app', () => {
    const calm = personaApp(app, 'calm');
    expect(calm).not.toBe(app);
    expect(calm.prompts.manifest.greeting_chat).toEqual({ ...app.prompts.manifest.greeting_chat, text: 'Hello, and welcome to the library. Renew a book, or check a hold?', persona: 'calm' });
    expect(calm.prompts.manifest.ack_intent).toEqual({ ...app.prompts.manifest.ack_intent, text: 'Happy to help you {intentLabel}.', variants: ["Of course, let's {intentLabel}."], persona: 'calm' });
    // A chat version alone leaves the line's words, and its clips, the app's.
    expect(calm.prompts.manifest.goodbye).toEqual({ ...app.prompts.manifest.goodbye, chat: 'Take care, **friend**.' });
    expect(calm.prompts.manifest.ask_intent).toBe(app.prompts.manifest.ask_intent);
    expect(calm.prompts.tags).toBe(app.prompts.tags);
    for (const part of ['policy', 'forms', 'slots', 'tools', 'intents', 'personas', 'locales'] as const) expect(calm[part]).toBe(app[part]);
  });

  it('makes one app per persona, and gives the app itself for no value or one that names no persona', () => {
    expect(personaApp(app, 'calm')).toBe(personaApp(app, 'calm'));
    expect(personaApp(app, 'brisk')).not.toBe(personaApp(app, 'calm'));
    expect(personaApp(app, 'loud')).toBe(app);
    expect(personaApp(app, undefined)).toBe(app);
    const without = defineApp(LIBRARY_DIR, libraryCode);
    expect(personaApp(without, 'calm')).toBe(without);
  });

  it('gives generated wording the persona text and word budgets it names, and a span its budget', () => {
    const message = defineApp(folder(MESSAGE_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n'),
      'personas/calm.yaml': `${SCHEMA_LINE}style:\n  persona: a slow, gentle librarian\n  words: { chat: 80 }\nspans:\n  confirm_take_message:\n    summary: { words: 45 }\n`,
    }), messageCode);
    const calm = personaApp(message, 'calm');
    expect(calm.generated!.style).toEqual({ ...message.generated!.style, persona: 'a slow, gentle librarian', words: { voice: 40, chat: 80 } });
    expect(calm.generated!.lines.confirm_take_message!.spans!.summary).toEqual({ ...message.generated!.lines.confirm_take_message!.spans!.summary, words: 45 });
    expect(calm.generated!.lines.ask_recipient).toBe(message.generated!.lines.ask_recipient);
    expect(calm.generated!.prescribed).toBe(message.generated!.prescribed);
    expect(calm.prompts.manifest).toEqual(message.prompts.manifest);
  });

  it('a persona\'s descriptions given as a list are said in turn, by the turn number; one description replaces the app\'s list', () => {
    const message = defineApp(folder(MESSAGE_DIR, {
      'app.yaml': withPersonas('    calm: personas/calm.yaml\n    brisk: personas/brisk.yaml\n'),
      'style.yaml': (text: string) => text.replace(/^persona:.*$/m, 'persona: [a warm clerk, a cheerful clerk]'),
      'personas/calm.yaml': `${SCHEMA_LINE}style:\n  persona: [a slow librarian, a gentle librarian, a quiet librarian]\n`,
      'personas/brisk.yaml': `${SCHEMA_LINE}style:\n  persona: a brisk librarian\n`,
    }), messageCode);
    // The app's own list: the first is the persona, and each turn takes the next.
    expect(message.generated!.style).toMatchObject({ persona: 'a warm clerk', personas: ['a warm clerk', 'a cheerful clerk'] });
    expect([0, 1, 2, 3].map((t) => personaOfTurn(message.generated!.style, t))).toEqual(['a warm clerk', 'a cheerful clerk', 'a warm clerk', 'a cheerful clerk']);
    const calm = personaApp(message, 'calm').generated!.style;
    expect(calm).toMatchObject({ persona: 'a slow librarian', personas: ['a slow librarian', 'a gentle librarian', 'a quiet librarian'] });
    expect([0, 1, 2, 3, 4].map((t) => personaOfTurn(calm, t))).toEqual(['a slow librarian', 'a gentle librarian', 'a quiet librarian', 'a slow librarian', 'a gentle librarian']);
    // One description in a persona replaces the app's list whole.
    const brisk = personaApp(message, 'brisk').generated!.style;
    expect(brisk.persona).toBe('a brisk librarian');
    expect(brisk.personas).toBeUndefined();
    expect(personaOfTurn(brisk, 3)).toBe('a brisk librarian');
  });
});

describe('a call or chat in a persona', () => {
  let app: App;
  beforeEach(() => {
    resetAppsForTest();
    app = defineApp(libraryWithPersonas(), libraryCode);
    registerApp(app);
  });

  const tc = (): TurnContext => {
    const systems = app.systems();
    return { nowMs: 0, todayIso: '2026-10-03', thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...systems, codes: mockCodeVerifier } };
  };

  it('appOf gives the persona its call data names, and the app for none', () => {
    expect(appOf({ appId: app.id, callData: { persona: 'calm' } })).toBe(personaApp(app, 'calm'));
    expect(appOf({ appId: app.id, callData: { persona: 'nobody' } })).toBe(app);
    expect(appOf({ appId: app.id })).toBe(app);
  });

  it('a chat that starts with the persona\'s value hears its greeting and its acknowledgement; one without, the app\'s', () => {
    const t = tc();
    const started = resolve(newSession('persona-chat', 0, WEB_CHAT, ANONYMOUS, app.id), withCallData(startEvent(), { persona: 'calm' }), null, t);
    expect(started.session.callData).toEqual({ persona: 'calm' });
    expect(spokenText(appOf(started.session), started.decision, started.session.locale, { shown: true })).toBe('Hello, and welcome to the library. Renew a book, or check a hold?');
    const asked = resolve(started.session, textEvent('I want to renew a book'), { ...BASE, intent: choice({ renew_loan: 0.95, none: 0.05 }) }, t);
    expect(spokenText(appOf(asked.session), asked.decision, asked.session.locale, { shown: true })).toMatch(/^Happy to help you renew a book\. /);

    const plain = resolve(newSession('plain-chat', 0, WEB_CHAT, ANONYMOUS, app.id), startEvent(), null, t);
    expect(spokenText(appOf(plain.session), plain.decision, plain.session.locale, { shown: true })).toBe(app.prompts.manifest.greeting_chat!.text);
  });

  it('says a persona\'s line by text-to-speech where the app has a clip of its own line', () => {
    const clipIds = segmentTemplate('greeting', app.prompts.manifest.greeting!.text).map((s) => ('id' in s ? s.id : ''));
    const ctx = { clips: new Map(clipIds.map((id) => [id, `${id}.wav`])), audioBase: 'https://example.test/audio/' };
    expect(promptSay(app, 'greeting', {}, true, ctx).parts).toEqual([{ audio: 'https://example.test/audio/greeting.0.wav' }]);
    expect(promptSay(personaApp(app, 'brisk'), 'greeting', {}, true, ctx).parts).toEqual([{ text: 'Library. What do you need?' }]);
    // A line the persona does not word keeps its clips.
    expect(promptSay(personaApp(app, 'calm'), 'greeting', {}, true, ctx).parts).toEqual([{ audio: 'https://example.test/audio/greeting.0.wav' }]);
  });

  it('lists each persona on the policy card: its persona text, its budgets and the lines it rewords', () => {
    const card = policyCardText(app, LIBRARY_DIR);
    expect(card).toContain('## Personas');
    expect(card).toContain('| `calm` | the app\'s | the app\'s | `greeting_chat`, `ack_intent` (and its variants), `goodbye` (its chat version only) |');
    expect(card).toContain('| `brisk` | the app\'s | the app\'s | `greeting` |');
    expect(policyCardText(defineApp(LIBRARY_DIR, libraryCode), LIBRARY_DIR)).not.toContain('## Personas');
  });
});
