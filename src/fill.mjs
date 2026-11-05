// Fills one application form and leaves it open for review. This tool never submits.
// Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model]
import { chromium } from 'playwright-core';
import fs from 'fs';
import readline from 'readline/promises';
import { run } from './engine.mjs';
import { fillWithModel } from './agent.mjs';
import { createProvider } from './providers.mjs';

const args = process.argv.slice(2);
const useModel = args.includes('--model');
const [url, profilePath = 'examples/profile.example.json', resume] = args.filter(arg => arg !== '--model');
if (!url) {
  console.error('Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model]');
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const provider = useModel ? await createProvider() : null;
const headless = process.env.HEADLESS === '1';
const browser = await chromium.launch({ channel: 'chrome', headless });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
async function confirm(item, draft) {
  console.log(`\nQuestion: ${item.label}\nDraft: ${draft}`);
  const choice = (await prompt.question('[a]ccept, [e]dit, [r]evise, or [s]kip? ')).trim().toLowerCase();
  if (choice === 'a') return { action: 'accept' };
  if (choice === 'e') return { action: 'edit', text: await prompt.question('Your text: ') };
  if (choice === 'r') return { action: 'revise', feedback: await prompt.question('Your feedback: ') };
  return { action: 'skip' };
}
// Approved answers go back to the answer library. The example profile stays unchanged.
function saveAnswer(item, text) {
  if (profilePath.startsWith('examples/')) return;
  profile.answers = { ...profile.answers, [item.label.toLowerCase()]: text };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 1));
}

const report = useModel
  ? await fillWithModel(page, profile, { resume, provider, confirm, onApproved: saveAnswer })
  : await run(page, profile, { resume });
prompt.close();
console.log(JSON.stringify(report, null, 2));

if (headless) {
  await browser.close();
} else {
  console.log('Review the form in Chrome. Close Chrome when you finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
