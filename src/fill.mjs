// Fills one application form and leaves it open for review. This tool never submits.
// Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf]
import { chromium } from 'playwright-core';
import fs from 'fs';
import { run } from './engine.mjs';

const [url, profilePath = 'examples/profile.example.json', resume] = process.argv.slice(2);
if (!url) {
  console.error('Usage: node src/fill.mjs <form-url> [profile.json] [resume.pdf]');
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const headless = process.env.HEADLESS === '1';
const browser = await chromium.launch({ channel: 'chrome', headless });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

const report = await run(page, profile, { resume });
console.log(JSON.stringify(report, null, 2));

if (headless) {
  await browser.close();
} else {
  console.log('Review the form in Chrome. Close Chrome when you finish.');
  await new Promise(resolve => browser.on('disconnected', resolve));
}
