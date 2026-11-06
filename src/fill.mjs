// Fills one application form. If the profile sets auto_submit, the agent also signs and submits it.
// Otherwise, and with --no-submit, the form stays open for review.
// Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model] [--no-submit] [--json]
// If the profile does not exist, setup starts first.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { APPLICATIONS_FILE, describeJob, recordApplication } from './applications.mjs';
import { run } from './engine.mjs';
import { fillWithModel } from './agent.mjs';
import { clarifyFields } from './clarify.mjs';
import { createProvider } from './providers.mjs';
import { chooseResume } from './resume.mjs';
import { runSetup } from './setup.mjs';
import { submitApplication } from './submit.mjs';
import { formatReport, formatResumeChoice } from './summary.mjs';

const args = process.argv.slice(2);
const useModel = args.includes('--model');
const noSubmit = args.includes('--no-submit');
const showJson = args.includes('--json');
const [url, profilePath = 'profile.local.json', resume] = args.filter(arg => !arg.startsWith('--'));
if (!url) {
  console.error('Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model] [--no-submit] [--json]');
  process.exit(1);
}

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
if (!fs.existsSync(profilePath)) {
  console.log(`${profilePath} does not exist. Setup starts now.`);
  await runSetup({ ask: question => prompt.question(question), say: console.log, provider: await createProvider().catch(() => null), outPath: profilePath });
}
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const provider = useModel ? await createProvider() : null;
const headless = process.env.HEADLESS === '1';
const browser = await chromium.launch({ channel: 'chrome', headless });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

async function confirm(item, draft) {
  console.log(`\nQuestion: ${item.label}\nDraft: ${draft}`);
  const choice = (await prompt.question('[a]ccept, [e]dit, [r]evise, or [s]kip? ')).trim().toLowerCase();
  if (choice === 'a') return { action: 'accept' };
  if (choice === 'e') return { action: 'edit', text: await prompt.question('Your text: ') };
  if (choice === 'r') return { action: 'revise', feedback: await prompt.question('Your feedback: ') };
  return { action: 'skip' };
}
async function confirmResume(choice) {
  const { candidates, selected } = choice;
  console.log(`\n${formatResumeChoice(choice)}\n`);
  const answer = (await prompt.question(`Enter ${selected ? 'a to accept the recommendation, ' : ''}a resume id, p for a path, or s for no resume: `)).trim();
  if (answer === 'a') return { action: 'accept' };
  if (answer === 'p') return { action: 'path', path: (await prompt.question('Resume path: ')).trim() };
  if (candidates.some(c => c.id === answer)) return { action: 'choose', id: answer };
  return { action: 'skip' };
}
// Approved answers go back to the answer library. The example profile stays unchanged.
function saveProfile() {
  if (!profilePath.startsWith('examples/')) fs.writeFileSync(profilePath, JSON.stringify(profile, null, 1));
}
function saveAnswer(item, text) {
  profile.answers = { ...profile.answers, [item.label.toLowerCase()]: text };
  saveProfile();
}

const selection = resume ? null : await chooseResume(page, profile, {
  provider,
  confirmResume,
  onTailor: ({ company, role }) => console.log(`\nThis job needs a tailored resume (${company ?? 'company'}, ${role ?? 'role'}). Tailoring starts now. It can take several minutes.`),
});
const resumePath = resume ?? selection?.path ?? undefined;
const seen = new Set();
const company = selection?.company;
const fillRound = () => (useModel
  ? fillWithModel(page, profile, { resume: resumePath, provider, confirm, onApproved: saveAnswer, seen, company })
  : run(page, profile, { resume: resumePath, seen, company }));
const report = await fillRound();
await clarifyFields(page, profile, report, { ask: question => prompt.question(question), say: console.log, onSave: saveProfile, refill: fillRound });
if (selection) report.resume_selection = { ...selection, path: selection.path && path.basename(selection.path) };
prompt.close();
if (profile.auto_submit && !noSubmit) {
  // The page changes after the submission, so the job name is read first.
  const job = describeJob(await page.evaluate(() => ({ title: document.title, heading: document.querySelector('h1')?.innerText?.trim() })), selection);
  report.submission = await submitApplication(page, report, { say: console.log, canWait: !headless, profile });
  if (report.submission.submitted) report.application_log = recordApplication(APPLICATIONS_FILE, { ...job, url, resume: resumePath && path.basename(resumePath) });
}
console.log(`\n${showJson ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);

if (headless || report.submission?.submitted) {
  await browser.close();
} else {
  console.log('Review the form in Chrome. Close Chrome when you finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
