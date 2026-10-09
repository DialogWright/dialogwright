// The second half of the package's build (`pnpm --filter dialogwright build`, after the code): copies
// the pages the package carries (src/define/shipped.ts: the authoring guide's chapters and the page of
// pointers it was, the slot types' pages and the create-app skill) from
// this repository into the package's docs/ and skills/, which are git-ignored, so a project that
// installs the package reads them in node_modules/dialogwright. A link to another shipped page stays a
// link between the copies; a link to a page the package does not carry becomes a link to that page on
// GitHub (shipped.ts packageCopy); the skill's copy too, and create-app re-links it again when it
// writes it into a project (createApp.ts projectSkillPage).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCopy, packagePathOf, SHIPPED } from '../src/define/shipped';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

function files(repoPath: string): string[] {
  const abs = join(REPO_ROOT, repoPath);
  if (!statSync(abs).isDirectory()) return [repoPath];
  return readdirSync(abs).sort().flatMap((name) => files(posix.join(repoPath, name)));
}

for (const folder of ['docs', 'skills']) rmSync(join(PACKAGE_DIR, folder), { recursive: true, force: true });
let count = 0;
for (const [repo] of SHIPPED) {
  for (const file of files(repo.replace(/\/$/, ''))) {
    const pkgPath = packagePathOf(file)!;
    const to = join(PACKAGE_DIR, pkgPath);
    mkdirSync(dirname(to), { recursive: true });
    if (!file.endsWith('.md')) cpSync(join(REPO_ROOT, file), to);
    else {
      writeFileSync(to, packageCopy(readFileSync(join(REPO_ROOT, file), 'utf8'), file));
    }
    count += 1;
  }
}
console.log(`shipped ${count} pages into docs/ and skills/`);
