import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const files = ['index.html', 'app.js', 'overview.js', 'styles.css', 'career.js', 'learning.js', 'life.js', 'writing.js', 'research.js', 'productivity.js', 'onboarding.js', 'ai.js', 'd2l.js', 'cloud-onboarding.js', 'remote.js', 'practice.js', 'reminders.js', 'rich-writing.js', 'academic-tasks.js', 'public-jobs.js', 'career-packets.js', 'calendar-export.js', 'focus.js', 'expense-import.js', 'calendar-import.js', 'student-admin.js', 'plan-tasks.js'];
files.push('task-agents.js', 'dynamic-tasks.js', 'course-studio.js', 'course-studio.css', 'interview-studio.js', 'application-browser.js');
files.push('leetcode.js', 'leetcode.css');
// Static-only output: the dashboard contains no server, secrets or provider code.
for (const file of files) await readFile(join(root, 'public', file));
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist'));
for (const file of files) await copyFile(join(root, 'public', file), join(root, 'dist', file));
console.log(`Built local dashboard: ${files.length} static files.`);
