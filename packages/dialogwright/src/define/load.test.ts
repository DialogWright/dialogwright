import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative as relativePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { caseTwins, loadAppFolder, type LoadResult } from './load';
import type { IdentityYaml, PolicyYaml } from './schema/index';

const FIXTURES = join(__dirname, '__fixtures__');
const VALID = join(FIXTURES, 'valid');

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder in the temp directory: the valid fixture, then `edit` (to break it). */
function folder(edit?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-load-'));
  scratch.push(dir);
  cpSync(VALID, dir, { recursive: true });
  edit?.(dir);
  return dir;
}

/**
 * The valid folder with the files of __fixtures__/errors/<name> laid over it (and `remove` taken
 * out), so a case holds only the file it breaks and the line numbers in its expectations are the
 * ones you see in that file.
 */
function loadCase(name: string, remove: string[] = []): LoadResult {
  return loadAppFolder(
    folder((dir) => {
      for (const file of remove) rmSync(join(dir, file));
      cpSync(join(FIXTURES, 'errors', name), dir, { recursive: true });
    }),
  );
}

describe('loadAppFolder: a valid folder', () => {
  const result = loadAppFolder(VALID);

  it('has no problems and returns the typed configuration', () => {
    expect(result.problems).toEqual([]);
    expect(result.config).not.toBeNull();
    const config = result.config!;
    expect(config.app.id).toBe('fixture-clinic');
    expect(Object.keys(config.intents.intents)).toEqual(['schedule_new', 'cancel', 'billing', 'agent', 'repeat_prompt', 'capabilities']);
    expect(config.forms.forms.schedule_new).toEqual({ slots: ['name', 'dob', 'provider', 'date'], summaryPromptId: 'confirm_schedule', hooks: ['confirmedParams', 'complete', 'onSummaryRead'] });
    const policy = config.policy as PolicyYaml;
    const identity = config.identity as IdentityYaml;
    expect(policy.purposes).toEqual({ appointment: { level: 0 } });
    expect(policy.actions.verifyPatient).toEqual({ level: 0, rules: ['identity', 'attempts'] });
    expect(identity.attempts).toBe(3);
    expect(identity.levels[1].verify).toBe('verifyPatient');
  });

  it('keys prompts by locale: prompts.yaml is the default locale, locale/<tag>/prompts.yaml the others', () => {
    const config = result.config!;
    expect(config.defaultLocale).toBe('en-US');
    expect(Object.keys(config.prompts).sort()).toEqual(['en-US', 'fr']);
    expect(config.prompts['en-US']!.greeting).toEqual({ text: 'Thanks for calling Example Family Practice. How can I help you today?', interruptible: true, mode: 'fixed' });
    expect(config.prompts.fr!.greeting!.text).toBe("Merci d'appeler Example Family Practice. Comment puis-je vous aider ?");
  });

  it("takes the default locale from app.yaml, and en-US when it says none", () => {
    const french = loadAppFolder(
      folder((dir) => {
        writeFileSync(join(dir, 'app.yaml'), 'id: x\nlocale: fr\n');
        rmSync(join(dir, 'locale'), { recursive: true });
      }),
    );
    expect(french.problems).toEqual([]);
    expect(french.config!.defaultLocale).toBe('fr');
    expect(Object.keys(french.config!.prompts)).toEqual(['fr']);
    const plain = loadAppFolder(folder((dir) => writeFileSync(join(dir, 'app.yaml'), 'id: x\n')));
    expect(plain.config!.defaultLocale).toBe('en-US');
  });

  it('treats identity.yaml as optional: without it identity is null', () => {
    const noIdentity = loadAppFolder(folder((dir) => rmSync(join(dir, 'identity.yaml'))));
    expect(noIdentity.problems).toEqual([]);
    expect(noIdentity.config!.identity).toBeNull();
  });

  it('loads the same folder to the same configuration each time', () => {
    expect(loadAppFolder(VALID).config).toEqual(result.config);
  });

  it('can say where a path is in a file that was read (for a check that finds a problem later)', () => {
    expect(result.locate('forms.yaml', ['forms', 'cancel', 'slots', 2])).toEqual({ line: 8, column: 24 });
    expect(result.locate('forms.yaml', ['forms', 'cancel'])).toEqual({ line: 7, column: 3 });
    expect(result.locate('locale/fr/prompts.yaml', ['prompts', 'greeting', 'text'])).toEqual({ line: 3, column: 11 });
    expect(result.locate('nothing.yaml', ['x'])).toBeNull();
  });
});

describe('loadAppFolder: problems', () => {
  it('a key written twice in one map is a syntax error naming the key', () => {
    const result = loadCase('syntax-duplicate-key');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'forms.yaml',
        line: 6,
        column: 5,
        path: '(file)',
        message: 'the key "slots" appears twice in the same map',
        fix: 'delete one of the two keys, or rename one if both are meant'
      }
    ]);
  });

  it('a tab used to indent is refused', () => {
    const result = loadCase('syntax-tab');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'forms.yaml',
        line: 3,
        column: 1,
        path: '(file)',
        message: 'Tabs are not allowed as indentation',
        fix: 'indent with spaces: YAML does not allow tabs for indentation'
      }
    ]);
  });

  it('a YAML tag (here one that would be a function in other loaders) is refused, never resolved', () => {
    const result = loadCase('syntax-tag');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'policy.yaml',
        line: 2,
        column: 20,
        path: '(file)',
        message: 'Unresolved tag: tag:yaml.org,2002:js/function',
        fix: 'delete the "!tag": these files are plain data, with no custom tags'
      }
    ]);
  });

  it('a %YAML directive is refused, so a file cannot switch to YAML 1.1 rules', () => {
    const result = loadCase('syntax-directive');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'prompts.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'a %YAML directive is not allowed: these files are YAML 1.2',
        fix: 'delete the %YAML line (and the --- under it if nothing else needs it)'
      }
    ]);
  });

  it('an alias bomb is refused rather than expanded', () => {
    const result = loadCase('syntax-aliases');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'app.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: "the file's aliases (*name) expand too far: an anchor may be used at most 20 times, and fewer when its value holds aliases itself",
        fix: 'write the values out in full instead of with anchors (&name) and aliases (*name); configuration needs none'
      }
    ]);
  });

  it('an empty file is a problem that says what the file starts with', () => {
    const result = loadCase('empty-file');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'policy.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'policy.yaml is empty',
        fix: 'add its content; the file starts with "actions:", each tool with its level and rules, for example "actions: { getRecord: { level: 1, rules: [identity] } }"'
      }
    ]);
  });

  it('a file that is a list instead of a map says so', () => {
    const result = loadCase('not-a-map');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'intents.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'the file must be a map, but is a list',
        fix: 'write the file as indented "key: value" lines, not a list'
      }
    ]);
  });

  it('forms.yaml: a typo in a required key (reported once, as the rename), a number where text goes, a missing hooks list and a misspelled hook', () => {
    const result = loadCase('forms-mistakes');
    expect(result.config).toBeNull();
    // summaryPrompId is the required summaryPromptId misspelt: the rename is the one fix, so
    // "required key summaryPromptId is missing" is not said as well.
    expect(result.problems).toEqual([
      {
        file: 'forms.yaml',
        line: 3,
        column: 24,
        path: 'forms.schedule_new.slots[2]',
        message: '"slots[2]" must be text, but is a number (5)',
        fix: 'write it as text, in quotes: "5"'
      },
      {
        file: 'forms.yaml',
        line: 4,
        column: 5,
        path: 'forms.schedule_new.summaryPrompId',
        message: 'unknown key "summaryPrompId" under forms.schedule_new',
        fix: 'rename "summaryPrompId" to "summaryPromptId"'
      },
      {
        file: 'forms.yaml',
        line: 6,
        column: 3,
        path: 'forms.cancel.hooks',
        message: 'required key "hooks" is missing under forms.cancel',
        fix: `add "hooks:" (a list) under forms.cancel. The code hooks this form uses, written in the app's TypeScript; "complete" is required.`
      },
      {
        file: 'forms.yaml',
        line: 12,
        column: 13,
        path: 'forms.billing.hooks[0]',
        message: '"hooks[0]" is "onSumaryRead", which is not allowed here; it must be one of "entry", "onEntry", "principalEntry", "confirmedParams", "complete", "onAnswers", "onSummaryAnswer", "keepsSlot", "onSummaryRead"',
        fix: 'change it to "onSummaryRead"'
      }
    ]);
  });

  it('forms.yaml: a repeated slot, no complete hook, a key that is not an id, and a form that is a list', () => {
    const result = loadCase('forms-more');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'forms.yaml',
        line: 3,
        column: 24,
        path: 'forms.schedule_new.slots[2]',
        message: 'slot "name" is listed twice',
        fix: 'delete one of the two "name" entries'
      },
      {
        file: 'forms.yaml',
        line: 5,
        column: 5,
        path: 'forms.schedule_new.hooks',
        message: 'every form needs a "complete" hook: it says what the form does once its slots are full',
        fix: `add "complete" to the list and write the function in the app's code`
      },
      {
        file: 'forms.yaml',
        line: 6,
        column: 3,
        path: 'forms["cancel it"]',
        message: 'the key "cancel it" is not a valid id: it must start with a letter and use only letters, digits and underscores',
        fix: 'rename it using only letters, digits and underscores, starting with a letter (for example "ask_name" or "patientId")'
      },
      {
        file: 'forms.yaml',
        line: 10,
        column: 3,
        path: 'forms.billing',
        message: '"billing" must be a map, but is a list',
        fix: 'write "billing" as indented "key: value" lines, not a list'
      }
    ]);
  });

  it('intents.yaml: a wrong kind, an informational intent with no prompt, a missing control intent, an unquoted digit and a repeated digit', () => {
    const result = loadCase('intents-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'intents.yaml',
        line: 1,
        column: 1,
        path: 'intents',
        message: 'the control intent "agent" is missing: the engine reads it by name',
        fix: 'add "agent:" with kind: control (the caller asks for a person), for example: criteria: Asks to speak with a person; label: speak with someone'
      },
      {
        file: 'intents.yaml',
        line: 5,
        column: 11,
        path: 'intents.schedule_new.kind',
        message: '"kind" is "forms", which is not allowed here; it must be one of "form", "informational", "control"',
        fix: 'change it to "form"'
      },
      {
        file: 'intents.yaml',
        line: 6,
        column: 3,
        path: 'intents.capabilities',
        message: 'an informational intent plays a prompt, and this one names none',
        fix: 'add "promptId: <id>" naming the prompt in prompts.yaml that this intent plays'
      },
      {
        file: 'intents.yaml',
        line: 16,
        column: 14,
        path: 'menu[0].digit',
        message: '"digit" must be text, but is a number (1)',
        fix: 'write it as text, in quotes: "1"'
      },
      {
        file: 'intents.yaml',
        line: 18,
        column: 14,
        path: 'menu[2].digit',
        message: 'keypad digit "2" is assigned twice',
        fix: 'give each menu entry its own digit, or delete the duplicate'
      }
    ]);
  });

  it('prompts.yaml: a mode that is not fixed, a missing text, a string where true or false goes, an empty text and a bad id', () => {
    const result = loadCase('prompts-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'prompts.yaml',
        line: 5,
        column: 11,
        path: 'prompts.greeting.mode',
        message: '"mode" is "generated", but the only value allowed is "fixed"',
        fix: 'write "fixed"'
      },
      {
        file: 'prompts.yaml',
        line: 6,
        column: 3,
        path: 'prompts.ask_name.text',
        message: 'required key "text" is missing under prompts.ask_name',
        fix: 'add "text:" (text) under prompts.ask_name. The words said.'
      },
      {
        file: 'prompts.yaml',
        line: 7,
        column: 20,
        path: 'prompts.ask_name.interruptible',
        message: '"interruptible" must be true or false, but is text ("yes")',
        fix: 'write true or false, without quotes'
      },
      {
        file: 'prompts.yaml',
        line: 9,
        column: 11,
        path: 'prompts.ask_dob.text',
        message: '"text" must not be empty',
        fix: 'give it a value, or delete the key'
      },
      {
        file: 'prompts.yaml',
        line: 11,
        column: 3,
        path: 'prompts["ask name"]',
        message: 'the key "ask name" is not a valid id: it must start with a letter and use only letters, digits and underscores',
        fix: 'rename it using only letters, digits and underscores, starting with a letter (for example "ask_name" or "patientId")'
      }
    ]);
  });

  it('policy.yaml: a level out of range, a rule listed twice, a typo in a subject key, attempts of zero and an unknown role access', () => {
    const result = loadCase('policy-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'policy.yaml',
        line: 2,
        column: 20,
        path: 'toolLevel.bookAppointment',
        message: '"bookAppointment" is 3, which is not allowed here; it must be one of 0, 1, 2',
        fix: 'use one of 0, 1, 2'
      },
      {
        file: 'policy.yaml',
        line: 5,
        column: 29,
        path: 'rulesFor.bookAppointment[2]',
        message: 'rule "R3" is listed twice',
        fix: 'delete one of the two "R3" entries'
      },
      {
        file: 'policy.yaml',
        line: 8,
        column: 42,
        path: 'subjects.cancelAppointment.vai',
        message: 'unknown key "vai" under subjects.cancelAppointment',
        fix: 'rename "vai" to "via"'
      },
      {
        file: 'policy.yaml',
        line: 10,
        column: 14,
        path: 'maxAttempts',
        message: '"maxAttempts" must be at least 1',
        fix: 'use a value of at least 1'
      },
      {
        file: 'policy.yaml',
        line: 12,
        column: 31,
        path: 'roles.cancelAppointment.clerk',
        message: '"clerk" is "allowed", which is not allowed here; it must be one of "allow", "refuse", "person"',
        fix: 'change it to "allow"'
      }
    ]);
  });

  it('app.yaml: a bad id and locale, a missing brand mark, a short levels list, a javascript: link, two bad spoken-digit rules and a threshold that is not a number', () => {
    const result = loadCase('app-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'app.yaml',
        line: 1,
        column: 5,
        path: 'id',
        message: '"Fixture Clinic" is not a valid app id: it must be lowercase, starting with a letter, with only letters, digits, hyphens and underscores',
        fix: 'rename it, for example "my-app" or "parcels"'
      },
      {
        file: 'app.yaml',
        line: 2,
        column: 9,
        path: 'locale',
        message: '"english" is not a language tag like "en-US" or "fr"',
        fix: 'write a language tag: a lowercase language ("en", "fr") optionally followed by a region ("en-US", "pt-BR")'
      },
      {
        file: 'app.yaml',
        line: 3,
        column: 1,
        path: 'brand.mark',
        message: 'required key "mark" is missing under brand',
        fix: `add "mark:" (text) under brand. The console's short mark, top left (for example "EP").`
      },
      {
        file: 'app.yaml',
        line: 6,
        column: 3,
        path: 'console.levels',
        message: '"levels" must have exactly three entries, one each for levels 0, 1 and 2',
        fix: 'give it exactly 3 entries'
      },
      {
        file: 'app.yaml',
        line: 11,
        column: 13,
        path: 'console.links[0].href',
        message: 'href must be a path starting with "/" or an http(s) address',
        fix: 'write a path such as "/chat", or a full "https://..." address; other schemes (javascript:, data:) are refused'
      },
      {
        file: 'app.yaml',
        line: 16,
        column: 16,
        path: 'voice.spokenDigits[0].pattern',
        message: 'pattern is not a valid regular expression (Invalid regular expression: /(unclosed/g: Unterminated group)',
        fix: 'write a regular expression JavaScript accepts, as its source without the surrounding slashes (for example \\d{4,}); in YAML, single quotes keep backslashes as they are'
      },
      {
        file: 'app.yaml',
        line: 18,
        column: 16,
        path: 'voice.spokenDigits[1].pattern',
        message: 'a "lead" rule needs two capture groups (the words before the digits, then the digits), and this pattern has 0',
        fix: 'wrap the words before the digits and the digits in parentheses, as in (parcel )(\\d{4,}); or use spell: groups, which needs no capture groups'
      },
      {
        file: 'app.yaml',
        line: 21,
        column: 16,
        path: 'thresholds.TIME_OF_DAY',
        message: '"TIME_OF_DAY" must be a number, but is text ("high")',
        fix: 'write a number without quotes'
      }
    ]);
  });

  it('identity.yaml: a missing tool, a kind that is not a lowercase word, a repeated factor slot and a number where a tool name goes', () => {
    const result = loadCase('identity-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'identity.yaml',
        line: 1,
        column: 1,
        path: 'sendCodeTool',
        message: 'required key "sendCodeTool" is missing at the top of the file',
        fix: 'add "sendCodeTool:" (text) at the top of the file. The tool that texts the one-time code.'
      },
      {
        file: 'identity.yaml',
        line: 1,
        column: 14,
        path: 'subjectKind',
        message: '"Patient" is not a valid kind: it must be a lowercase word (letters, digits, underscores)',
        fix: 'write a lowercase word such as "customer" or "patient"'
      },
      {
        file: 'identity.yaml',
        line: 2,
        column: 26,
        path: 'factorSlots[1]',
        message: 'factor slot "patientId" is listed twice',
        fix: 'delete one of the two "patientId" entries'
      },
      {
        file: 'identity.yaml',
        line: 4,
        column: 11,
        path: 'codeTool',
        message: '"codeTool" must be text, but is a number (7)',
        fix: 'write it as text, in quotes: "7"'
      }
    ]);
  });

  it('locale folders: a bad tag, the default locale repeated, and a folder with no prompts.yaml', () => {
    const result = loadCase('locale-mistakes');
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'locale/de',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'locale/de has no prompts.yaml, so the locale de has no prompts',
        fix: 'add locale/de/prompts.yaml with a "prompts:" map (same shape as prompts.yaml), or delete the folder'
      },
      {
        file: 'locale/en-US',
        line: 1,
        column: 1,
        path: '(file)',
        message: "locale/en-US is the app's default locale (en-US), whose prompts are in prompts.yaml",
        fix: 'move the prompts you want into prompts.yaml and delete locale/en-US, or give app.yaml a different "locale:" if en-US is not the default'
      },
      {
        file: 'locale/FR_fr',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'locale/FR_fr is not a language tag like "fr" or "pt-BR"',
        fix: "rename the folder to the locale's language tag (for example locale/fr or locale/pt-BR)"
      }
    ]);
  });

  it('a required file that is missing, with the misspelled file that is there named as the likely cause', () => {
    const result = loadCase('stray-and-misnamed', [ 'policy.yaml' ]);
    expect(result.config).toBeNull();
    expect(result.problems).toEqual([
      {
        file: 'policy.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'policy.yaml is missing',
        fix: 'create policy.yaml; it starts with "actions:", each tool with its level and rules, for example "actions: { getRecord: { level: 1, rules: [identity] } }". There is a "polcy.yaml" here: rename it to policy.yaml.'
      },
      {
        file: 'polcy.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: 'polcy.yaml is not a file DialogWright reads; the YAML files are app.yaml, intents.yaml, forms.yaml, prompts.yaml, policy.yaml, identity.yaml, slots.yaml',
        fix: 'rename polcy.yaml to policy.yaml'
      }
    ]);
  });

});

describe('loadAppFolder: files that are not there, or not safe to read', () => {
  const only = (result: LoadResult) => result.problems;

  it('reports each required file that is missing, with what it starts with, and the optional one is not required', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dialogwright-empty-'));
    scratch.push(empty);
    const result = loadAppFolder(empty);
    expect(result.config).toBeNull();
    expect(result.problems.map((p) => [p.file, p.message])).toEqual([
      ['app.yaml', 'app.yaml is missing'],
      ['intents.yaml', 'intents.yaml is missing'],
      ['forms.yaml', 'forms.yaml is missing'],
      ['prompts.yaml', 'prompts.yaml is missing'],
      ['policy.yaml', 'policy.yaml is missing'],
    ]);
    expect(result.problems[0]).toEqual({
      file: 'app.yaml',
      line: 1,
      column: 1,
      path: '(file)',
      message: 'app.yaml is missing',
      fix: 'create app.yaml; it starts with an id, for example "id: my-app".',
    });
  });

  it('says a folder that does not exist does not exist, and a file is not a folder', () => {
    const missing = loadAppFolder(join(tmpdir(), 'dialogwright-no-such-folder'));
    expect(missing.config).toBeNull();
    expect(missing.problems).toEqual([
      {
        file: '.',
        line: 1,
        column: 1,
        path: '(file)',
        message: `the app folder "${join(tmpdir(), 'dialogwright-no-such-folder')}" does not exist`,
        fix: 'pass the path of the folder that holds app.yaml, intents.yaml, forms.yaml, prompts.yaml and policy.yaml',
      },
    ]);
    const file = loadAppFolder(join(VALID, 'app.yaml'));
    expect(file.problems.map((p) => p.message)).toEqual([`the app folder "${join(VALID, 'app.yaml')}" is not a directory`]);
  });

  it('refuses a file that is a link to somewhere outside the folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dialogwright-outside-'));
    scratch.push(outside);
    writeFileSync(join(outside, 'policy.yaml'), 'toolLevel: {}\nrulesFor: {}\nconfirmedFields: []\nmaxAttempts: 3\n');
    const dir = folder((d) => {
      rmSync(join(d, 'policy.yaml'));
      symlinkSync(join(outside, 'policy.yaml'), join(d, 'policy.yaml'));
    });
    const result = loadAppFolder(dir);
    expect(result.config).toBeNull();
    expect(only(result)).toEqual([
      {
        file: 'policy.yaml',
        line: 1,
        column: 1,
        path: '(file)',
        message: `policy.yaml resolves to ${join(realpath(outside), 'policy.yaml')}, which is outside the app folder`,
        fix: 'replace the link with a regular file (or a link to a file) inside the app folder; files outside it are never read',
      },
    ]);
  });

  it('refuses a locale folder that is a link to a folder outside, and a link up out of the folder by a relative path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dialogwright-outside-'));
    scratch.push(outside);
    writeFileSync(join(outside, 'prompts.yaml'), 'prompts: {}\n');
    const dir = folder((d) => symlinkSync(outside, join(d, 'locale', 'de')));
    const result = loadAppFolder(dir);
    expect(result.config).toBeNull();
    expect(only(result).map((p) => `${p.file}: ${p.message}`)).toEqual([`locale/de/prompts.yaml: locale/de/prompts.yaml resolves to ${join(realpath(outside), 'prompts.yaml')}, which is outside the app folder`]);

    const relative = folder((d) => {
      rmSync(join(d, 'intents.yaml'));
      symlinkSync(relativePath(d, join(outside, 'prompts.yaml')), join(d, 'intents.yaml'));
    });
    expect(loadAppFolder(relative).problems.map((p) => p.file + ': ' + p.message.replace(/ resolves to .*, which/, ' resolves elsewhere, which'))).toEqual([
      'intents.yaml: intents.yaml resolves elsewhere, which is outside the app folder',
    ]);
  });

  it('refuses a link that goes nowhere', () => {
    const dir = folder((d) => {
      rmSync(join(d, 'forms.yaml'));
      symlinkSync(join(d, 'no-such-file.yaml'), join(d, 'forms.yaml'));
    });
    const result = loadAppFolder(dir);
    expect(result.config).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ file: 'forms.yaml', path: '(file)', message: 'forms.yaml is a link to a file that does not exist' });
  });

  it('accepts a link that stays inside the folder', () => {
    const dir = folder((d) => {
      mkdirSync(join(d, 'shared'));
      cpSync(join(d, 'forms.yaml'), join(d, 'shared', 'forms.yaml'));
      rmSync(join(d, 'forms.yaml'));
      symlinkSync(join(d, 'shared', 'forms.yaml'), join(d, 'forms.yaml'));
    });
    expect(loadAppFolder(dir).problems).toEqual([]);
  });

  it('refuses a directory where a file belongs, a file that is too big and one that is not UTF-8', () => {
    const big = `forms: {}\n# ${'x'.repeat(1024 * 1024)}\n`;
    const dir = folder((d) => {
      rmSync(join(d, 'policy.yaml'));
      mkdirSync(join(d, 'policy.yaml'));
      writeFileSync(join(d, 'forms.yaml'), big);
      writeFileSync(join(d, 'prompts.yaml'), Buffer.from([0x70, 0xff, 0xfe, 0x0a]));
    });
    const result = loadAppFolder(dir);
    expect(result.problems.map((p) => [p.file, p.message, p.fix])).toEqual([
      ['forms.yaml', `forms.yaml is ${Buffer.byteLength(big)} bytes, over the 1048576 byte limit`, 'split the content, or remove what does not belong in a configuration file'],
      ['prompts.yaml', 'prompts.yaml is not valid UTF-8 text', 'save the file as UTF-8'],
      ['policy.yaml', 'policy.yaml is not a regular file', 'make policy.yaml a file of YAML text, not a directory or device'],
    ]);
  });

  it('never throws, whatever is in the files', () => {
    for (const garbage of ['', '\0\0\0', '{{{{', '- - - -', '"unterminated', '!!binary |\n  AAAA', '&a [*a]', 'a: *missing', '? [1, 2]\n: x', '---\n---\n', '﻿id: x']) {
      const dir = folder((d) => {
        for (const file of ['app.yaml', 'intents.yaml', 'forms.yaml', 'prompts.yaml', 'policy.yaml', 'identity.yaml']) writeFileSync(join(d, file), garbage);
      });
      expect(() => loadAppFolder(dir), JSON.stringify(garbage)).not.toThrow();
      expect(loadAppFolder(dir).config).toBeNull();
    }
  });
});

describe('loadAppFolder: the review fixes', () => {
  /** The valid folder with `file`'s text changed by `edit`. */
  const edited = (file: string, edit: (text: string) => string): string =>
    folder((dir) => writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), 'utf8'))));

  it('a key JavaScript objects reserve (__proto__, constructor, prototype) is a problem at the key, never dropped without a word', () => {
    const dir = edited('app.yaml', (t) => t.replace('    billing: Billing\n', '    billing: Billing\n    __proto__: Hidden\n    constructor: Built\n'));
    const result = loadAppFolder(dir);
    expect(result.config).toBeNull();
    expect(result.problems.map((p) => [p.file, p.line, p.column, p.path, p.message])).toEqual([
      ['app.yaml', 15, 5, 'console.formLabels.__proto__', 'the key "__proto__" is a name JavaScript objects reserve, so it cannot be a key in these files'],
      ['app.yaml', 16, 5, 'console.formLabels.constructor', 'the key "constructor" is a name JavaScript objects reserve, so it cannot be a key in these files'],
    ]);
    const prompts = loadAppFolder(edited('prompts.yaml', (t) => t.replace('prompts:\n', 'prompts:\n  prototype:\n    text: x\n    interruptible: true\n')));
    expect(prompts.problems.map((p) => p.path)).toEqual(['prompts.prototype']);
  });

  it('a key that is not a valid id is reported at the key, not at the text it holds', () => {
    const dir = edited('app.yaml', (t) => t.replace('    billing: Billing\n', '    pay bill: Billing\n'));
    expect(loadAppFolder(dir).problems.map((p) => [p.line, p.column, p.path])).toEqual([[14, 5, 'console.formLabels["pay bill"]']]);
  });

  it('fixtures.dir must stay inside the package: an absolute path and one with ".." are refused at the line that says them', () => {
    for (const bad of ['/etc', '../elsewhere', 'fixtures/../../up', 'C:/fixtures', '\\\\server\\share']) {
      const dir = edited('app.yaml', (t) => t.replace('  dir: fixtures', `  dir: ${JSON.stringify(bad)}`));
      const problems = loadAppFolder(dir).problems;
      expect(problems, bad).toHaveLength(1);
      expect(problems[0], bad).toMatchObject({ file: 'app.yaml', path: 'fixtures.dir', fix: 'write the folder relative to the package root, for example "fixtures"' });
      expect(problems[0]!.message, bad).toContain('is not a folder inside the package');
    }
    for (const good of ['fixtures', 'test/fixtures', 'fixtures/', './fixtures', 'a..b']) {
      expect(loadAppFolder(edited('app.yaml', (t) => t.replace('  dir: fixtures', `  dir: ${JSON.stringify(good)}`))).problems, good).toEqual([]);
    }
  });

  it('locale/ holds folders: a file there is a problem (hidden files aside), and so is a file named locale', () => {
    const dir = folder((d) => {
      writeFileSync(join(d, 'locale', 'prompts.yaml'), 'prompts: {}\n');
      writeFileSync(join(d, 'locale', '.DS_Store'), '');
    });
    expect(loadAppFolder(dir).problems.map((p) => [p.file, p.message, p.fix])).toEqual([
      ['locale/prompts.yaml', 'locale/prompts.yaml is a file; locale/ holds one folder per locale, each with its prompts.yaml', 'move it into a folder named for its language tag: locale/<tag>/prompts.yaml (for example locale/fr/prompts.yaml)'],
    ]);
    const flat = folder((d) => {
      rmSync(join(d, 'locale'), { recursive: true });
      writeFileSync(join(d, 'locale'), '');
    });
    expect(loadAppFolder(flat).problems.map((p) => [p.file, p.message])).toEqual([
      ['locale', 'locale is a file; it must be a folder with one folder per locale (locale/<tag>/prompts.yaml)'],
    ]);
  });

  it('two locale folders that differ only by letter case are one locale, and the second is a problem', () => {
    expect([...caseTwins(['pt-br', 'fr', 'pt-BR', 'PT-BR'])]).toEqual([['pt-BR', 'PT-BR'], ['pt-br', 'PT-BR']]);
    expect(caseTwins(['fr', 'pt-BR', 'es'])).toEqual(new Map());
    // Where the file system keeps both (it does not ignore letter case), the loader reports the second.
    const dir = folder((d) => {
      cpSync(join(d, 'locale', 'fr'), join(d, 'locale', 'pt-BR'), { recursive: true });
      cpSync(join(d, 'locale', 'fr'), join(d, 'locale', 'pt-br'), { recursive: true });
    });
    const caseSensitive = readdirSync(join(dir, 'locale')).length === 3;
    expect(loadAppFolder(dir).problems.map((p) => [p.file, p.message, p.fix])).toEqual(
      caseSensitive
        ? [['locale/pt-br', 'locale/pt-br and locale/pt-BR are the same locale: a language tag\'s letter case does not make it another', 'merge the two into one folder, with the tag written the usual way (language lowercase, region uppercase, as in pt-BR)']]
        : [],
    );
  });
});

/** The real path of a directory (the temp directory is itself a link on some systems). */
const realpath = (path: string): string => realpathSync(path);
