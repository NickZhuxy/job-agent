import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { run } from '../src/engine.mjs';
import { submitApplication, submitBlockers } from '../src/submit.mjs';

const PROFILE = { first_name: 'Alex', last_name: 'Rivera', auto_submit: true, gpa: '3.9', gpa_undergraduate: '3.5' };
let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(() => browser.close());

const FORM = `<h1>Thank you for your interest in this job</h1><form id="apply">
  <label for="fn">First Name</label><input id="fn" required>
  <label for="sig">Electronic signature</label><input id="sig" required>
  <label for="day">Signature date</label><input id="day" type="date" required>
  <label><input type="checkbox" id="terms" required> I certify that this information is accurate</label>
  <label><input type="checkbox" id="news"> Send me email updates</label>
  <button type="button">Add another</button><button type="submit">Submit application</button>
</form><script>
  window.clicks = 0;
  document.getElementById('apply').addEventListener('submit', e => {
    e.preventDefault(); window.clicks++;
    const mode = window.mode ?? 'ok';
    if (mode === 'ok') document.body.innerHTML = '<h2>Thank you for applying</h2>';
    if (mode === 'error') { const p = document.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = 'Phone is invalid'; document.body.append(p); }
    if (mode === 'code') { const p = document.createElement('p'); p.textContent = 'Enter the verification code from your email'; document.body.append(p); setTimeout(() => { document.body.innerHTML = '<h2>Your application has been submitted</h2>'; }, 1500); }
  });
</script>`;

const filled = async (mode, profile = PROFILE) => {
  const page = await browser.newPage();
  await page.setContent(FORM);
  await page.evaluate(m => { window.mode = m; }, mode);
  return { page, report: await run(page, profile) };
};

test('the agent signs, accepts required terms, leaves optional boxes, and submits one time', async () => {
  const { page, report } = await filled('ok');
  assert.equal(await page.inputValue('#sig'), 'Alex Rivera');
  assert.match(await page.inputValue('#day'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await page.isChecked('#terms'), true);
  assert.equal(await page.isChecked('#news'), false);
  assert.deepEqual(await submitBlockers(page, report), []);
  const result = await submitApplication(page, report);
  assert.equal(result.submitted, true);
  assert.equal(await page.evaluate(() => window.clicks), 1);
  await page.close();
});

test('without auto_submit, the agent does not sign or accept terms', async () => {
  const { page, report } = await filled('ok', { first_name: 'Alex', last_name: 'Rivera' });
  assert.equal(await page.inputValue('#sig'), '');
  assert.equal(await page.isChecked('#terms'), false);
  assert.ok(report.review.some(r => r.why === 'attestation_human_only'));
  await page.close();
});

test('an empty required field stops the submission, and the button stays unclicked', async () => {
  const page = await browser.newPage();
  await page.setContent(`${FORM.replace('</form>', '<label for="why">Why this job?</label><textarea id="why" required></textarea></form>')}`);
  const report = await run(page, PROFILE);
  const result = await submitApplication(page, report);
  assert.equal(result.submitted, false);
  assert.equal(result.why, 'form_not_ready');
  assert.match(result.blockers.join(), /Why this job/);
  assert.equal(await page.evaluate(() => window.clicks), 0);
  await page.close();
});

test('a failed readback stops the submission', async () => {
  const { page, report } = await filled('ok');
  report.readback_failed = ['Email: got ""'];
  const result = await submitApplication(page, report);
  assert.equal(result.why, 'form_not_ready');
  assert.equal(await page.evaluate(() => window.clicks), 0);
  await page.close();
});

test('page errors are reported, and the agent does not click again', async () => {
  const { page, report } = await filled('error');
  const result = await submitApplication(page, report);
  assert.equal(result.submitted, false);
  assert.equal(result.why, 'form_errors');
  assert.equal(await page.evaluate(() => window.clicks), 1);
  await page.close();
});

test('text on the job page is not a confirmation', async () => {
  const { page, report } = await filled('nothing');
  const result = await submitApplication(page, report, { confirmWaitMs: 5000 });
  assert.equal(result.submitted, false);
  assert.equal(result.why, 'not_confirmed');
  await page.close();
});

test('a verification code waits for the user, and with no user the agent stops', async () => {
  const { page, report } = await filled('code');
  const messages = [];
  const result = await submitApplication(page, report, { say: line => messages.push(line) });
  assert.equal(result.submitted, true);
  assert.ok(messages.some(line => /verification code/.test(line)));
  await page.close();

  const second = await filled('code');
  const stopped = await submitApplication(second.page, second.report, { canWait: false });
  assert.deepEqual(stopped, { submitted: false, why: 'needs_user_check' });
  await second.page.close();
});

test('a question about undergraduate study gets that GPA', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for="a">GPA</label><input id="a"><label for="b">Undergraduate GPA</label><input id="b"><label for="c">Graduate GPA</label><input id="c"><label for="d">Full legal name</label><input id="d"></form>`);
  await run(page, PROFILE);
  assert.deepEqual(await page.evaluate(() => ['a', 'b', 'c', 'd'].map(id => document.getElementById(id).value)), ['3.9', '3.5', '3.9', 'Alex Rivera']);
  await page.close();
});

test('real form labels go to the correct values', async () => {
  const page = await browser.newPage();
  const fields = {
    a: 'Start date year', b: 'Start date month', c: 'End date year', d: 'End date month', e: 'Earliest start date',
    f: 'What grade did you achieve in your Bachelors (or equivalent) degree?', g: 'What Masters degree qualification do you expect to be awarded?', h: 'Degree', i: 'School',
    j: 'When will you be available to start a permanent, full-time graduate role?', k: 'GPA (4.0 scale)',
    l: 'Please indicate your current Grade Point Average (GPA), or equivalent, and the maximum GPA/equivalent on the grading scale used by your institution.',
  };
  await page.setContent(`<form>${Object.entries(fields).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}">`).join('')}</form>`);
  await run(page, { ...PROFILE, edu_start_year: '2026', edu_start_month: 'September', grad_year: '2027', grad_month: 'December', start_date: '2027-05-31', degree: "Master's", school: 'Columbia' });
  assert.deepEqual(await page.evaluate(ids => ids.map(id => document.getElementById(id).value), Object.keys(fields)), ['2026', 'September', '2027', 'December', '2027-05-31', '', '', "Master's", 'Columbia', '', '3.9', '']);
  await page.close();
});

test('a hidden required input is named by the label near it, and a question is listed one time', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form>
    <div><label>How did you hear about us?*</label><div><input class="requiredInput" required aria-hidden="true" tabindex="-1"></div></div>
    <div><label>Bachelors grade*</label><div><input class="requiredInput" required aria-hidden="true" tabindex="-1"></div></div>
  </form>`);
  const report = { review: [{ label: 'Bachelors grade', why: 'no_rule', required: true }] };
  assert.deepEqual(await submitBlockers(page, report), ['Bachelors grade (no_rule)', 'Invalid: How did you hear about us?*']);
  await page.close();
});

test('a required question with a skip rule goes to review, and it stops the submission', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label for="p">Please share your preferred pronouns:</label><input id="p" aria-required="true"><label for="q">Pronouns</label><input id="q"><button type="submit">Submit application</button></form>`);
  const report = await run(page, PROFILE);
  assert.deepEqual(report.review.map(r => r.label), ['Please share your preferred pronouns:']);
  assert.deepEqual(report.skipped, ['Pronouns']);
  assert.equal((await submitApplication(page, report)).why, 'form_not_ready');
  await page.close();
});
