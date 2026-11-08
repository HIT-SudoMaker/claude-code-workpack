import fs from 'node:fs';

const action = process.argv[2];
const files = ['README.md', 'LICENSE'];

if (!['prepare', 'clean'].includes(action)) throw new Error('unknown-package-files-action');

for (const file of files) {
  const destination = new URL(`./${file}`, import.meta.url);
  if (action === 'prepare') fs.copyFileSync(new URL(`../../${file}`, import.meta.url), destination);
  else fs.rmSync(destination, { force: true });
}
