// Run by `prepublishOnly`: refuse to publish while repository placeholders remain.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDERS = ['<REPO_URL>', '<STANDIN_REPO_URL>'];
const problems = [];
for (const file of ['package.json', 'README.md']) {
  const text = readFileSync(resolve(root, file), 'utf8');
  for (const p of PLACEHOLDERS) if (text.includes(p)) problems.push(`${file} still contains ${p}`);
}
if (problems.length > 0) {
  console.error(`Refusing to publish:\n  ${problems.join('\n  ')}\nReplace the placeholders with the real repository URLs first.`);
  process.exit(1);
}
console.log('No repository placeholders left.');
