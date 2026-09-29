import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const assets = ['index.html', '_headers', 'css', 'js', 'vendor'];

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const asset of assets) {
  cpSync(join(root, asset), join(output, asset), { recursive: true });
}

console.log(`Built ${output}`);
