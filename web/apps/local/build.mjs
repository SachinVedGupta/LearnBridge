import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const files = ['index.html', 'app.js', 'styles.css', 'career.js', 'learning.js', 'life.js', 'writing.js', 'research.js', 'productivity.js'];
// Static-only output: the dashboard contains no server, secrets or provider code.
for (const file of files) await readFile(join(root, 'public', file));
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist'));
for (const file of files) await copyFile(join(root, 'public', file), join(root, 'dist', file));
console.log(`Built local dashboard: ${files.length} static files.`);
