// Fills one application form. If the profile sets auto_submit, the agent also signs and submits it.
// Otherwise, and with --no-submit, the form stays open for review.
// Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model] [--no-submit]
// If the profile does not exist, setup starts first.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { run } from './engine.mjs';
import { fillWithModel } from './agent.mjs';
import { clarifyFields } from './clarify.mjs';
import { createProvider } from './providers.mjs';
import { chooseResume } from './resume.mjs';
import { runSetup } from './setup.mjs';
import { submitApplication } from './submit.mjs';

const args = process.argv.slice(2);
const useModel = args.includes('--model');
const noSubmit = args.includes('--no-submit');
const [url, profilePath = 'profile.local.json', resume] = args.filter(arg => !arg.startsWith('--'));
if (!url) {
  console.error('Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model] [--no-submit]');
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
async function confirmResume({ candidates, selected, tailorRecommended, reason, tailored, tailorError, tailorConfigured }) {
  console.log('\nResumes:');
  for (const c of candidates) console.log(`  ${c.id}  [${c.kind}] ${c.folder ? `${c.folder} / ` : ''}${c.name}`);
  if (selected) console.log(`Recommended: ${selected.id} (${selected.name})`);
  if (reason) console.log(`Reason: ${reason}`);
  if (tailored) console.log(`Tailored resume, made in ${tailored.seconds} seconds. Examine it before you accept it:\n  ${tailored.path}\n${tailored.notes}`);
  if (tailorError) console.log(`Tailoring failed. ${tailorError}`);
  if (tailorRecommended && !tailorConfigured) console.log('This job may need a tailored resume. Run setup to add a resume skill, or enter the path of a tailored resume.');
  const answer = (await prompt.question(`${selected ? '[a]ccept, ' : ''}a resume id, a [p]ath, or [s]kip upload? `)).trim();
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
if (profile.auto_submit && !noSubmit) report.submission = await submitApplication(page, report, { say: console.log, canWait: !headless });
console.log(JSON.stringify(report, null, 2));

if (headless || report.submission?.submitted) {
  await browser.close();
} else {
  console.log('Review the form in Chrome. Close Chrome when you finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
