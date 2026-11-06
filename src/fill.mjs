// Fills one application form from the terminal. If the profile sets auto_submit, the agent also signs and submits it.
// Otherwise, and with --no-submit, the form stays open for review.
// Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf] [--model] [--no-submit] [--json]
// If the profile does not exist, setup starts first.
import fs from 'fs';
import readline from 'readline/promises';
import { applyToJob } from './apply.mjs';
import { createProvider } from './providers.mjs';
import { runSetup } from './setup.mjs';
import { formatReport } from './summary.mjs';

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
const ask = question => prompt.question(question);
if (!fs.existsSync(profilePath)) {
  console.log(`${profilePath} does not exist. Setup starts now.`);
  await runSetup({ ask, say: console.log, provider: await createProvider().catch(() => null), outPath: profilePath });
}
const provider = useModel ? await createProvider() : null;
const headless = process.env.HEADLESS === '1';
const { report, browser } = await applyToJob({ url, profilePath, resume, provider, noSubmit, headless, io: { ask, say: console.log, release: () => prompt.close() } });
console.log(`\n${showJson ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);

if (headless || report.submission?.submitted) {
  await browser.close();
} else {
  console.log('Review the form in Chrome. Close Chrome when you finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
