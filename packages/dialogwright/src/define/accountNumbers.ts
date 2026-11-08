import { envVariableOf } from '../core/app/envReference';
import { E164 } from '../core/numberLocales';

/**
 * The numbers an account of an agent-mode app calls from (business.yaml's `accounts[].numbers`), read: each a
 * number written out (E.164, in quotes) or `env.<NAME>`, a setting of the app's own (its settings file under a
 * host, or the environment) holding one, so a number that must not be in the repository (a tester's own phone)
 * stays in the settings, as app.yaml's voice.numbers does. Read by the call-start lookup and the recognition at
 * call time (ToolContext.env) and by the server as it starts (accountNumbersFrom, server/transfer.ts).
 */

/** One number of an account, read: the account's key, the number, and the setting it was read from (absent for a number written out). */
export interface AccountNumber {
  readonly account: string;
  readonly number: string;
  readonly variable?: string;
}

/**
 * Every account's numbers, in the order written, each `env.<NAME>` read by `env` (its value trimmed). A setting
 * unset or blank is left out and named in `unset` (never an error: the account is recognized by its other
 * numbers); one set to a value that is not E.164 is left out and named in `invalid` (the server refuses to start
 * on it); `clashes` names each number on file for two accounts once read (a setting whose value is another
 * account's number), which the server refuses too. A number written out is taken as written: the schema and
 * the file's own checks hold its form and its uniqueness.
 */
export function accountNumbersOf(accounts: Readonly<Record<string, readonly string[]>>, env: (name: string) => string | undefined): { numbers: AccountNumber[]; unset: string[]; invalid: string[]; clashes: { a: AccountNumber; b: AccountNumber }[] } {
  const numbers: AccountNumber[] = [];
  const unset: string[] = [];
  const invalid: string[] = [];
  for (const [account, listed] of Object.entries(accounts)) {
    for (const entry of listed) {
      const variable = envVariableOf(entry);
      if (variable === null) {
        numbers.push({ account, number: entry });
        continue;
      }
      const value = env(variable)?.trim();
      if (value === undefined || value === '') unset.push(variable);
      else if (!E164.test(value)) invalid.push(variable);
      else numbers.push({ account, number: value, variable });
    }
  }
  const clashes: { a: AccountNumber; b: AccountNumber }[] = [];
  numbers.forEach((a, i) => {
    for (const b of numbers.slice(i + 1)) if (a.account !== b.account && a.number === b.number) clashes.push({ a, b });
  });
  return { numbers, unset, invalid, clashes };
}

/** The account each number calling is on file for, as the call-start lookup and the recognition read it: the first account listed with it. */
export function accountByNumber(accounts: Readonly<Record<string, readonly string[]>>, env: (name: string) => string | undefined): Map<string, string> {
  const byNumber = new Map<string, string>();
  for (const n of accountNumbersOf(accounts, env).numbers) if (!byNumber.has(n.number)) byNumber.set(n.number, n.account);
  return byNumber;
}

/** The settings an account's numbers name (`env.<NAME>`), by account key, in order: what the policy card and the startup note name, never their values. */
export function accountSettingsOf(accounts: Readonly<Record<string, readonly string[]>>): { account: string; variable: string }[] {
  return Object.entries(accounts).flatMap(([account, listed]) => listed.flatMap((n) => {
    const variable = envVariableOf(n);
    return variable === null ? [] : [{ account, variable }];
  }));
}
