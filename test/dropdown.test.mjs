import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { run, scan, writeField } from '../src/engine.mjs';
import { submitBlockers } from '../src/submit.mjs';

// A button that controls an option list, with the answer in a hidden input. Jane Street uses this structure.
const dropdown = (name, question, options, { value = '', style = '' } = {}) => `<div class="field" style="${style}">
  <div><p>${question} <span>*</span></p><small>Search before you select.</small></div>
  <div class="dd">
    <div role="button" tabindex="0" aria-expanded="false" aria-controls="${name}-options">
      <p>Select an option</p><input type="hidden" name="${name}" class="required" value="${value}">
    </div>
    <div id="${name}-options" hidden>${options}</div>
  </div>
</div>`;
const items = list => `<ul>${list.map(o => `<li>${o}</li>`).join('')}</ul>`;
const SCRIPT = `<script>
  document.addEventListener('click', event => {
    const button = event.target.closest('[aria-controls]');
    if (button) { document.getElementById(button.getAttribute('aria-controls')).hidden = false; return; }
    const option = event.target.closest('li');
    if (!option) return;
    const list = option.closest('[id$="-options"]');
    list.parentElement.querySelector('input[type=hidden]').value = option.innerText.trim();
    list.hidden = true;
  });
</script>`;

let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(() => browser.close());
const form = async html => {
  const page = await browser.newPage();
  await page.setContent(`<form>${html}</form>${SCRIPT}`);
  return page;
};
const hiddenValue = (page, name) => page.locator(`input[name="${name}"]`).inputValue();

test('the scan finds a custom dropdown with its question, options, and required state', async () => {
  const page = await form(dropdown('college', 'Select your school.', items(['Columbia University', 'New York University'])));
  const [field] = await scan(page);
  assert.equal(field.kind, 'dropdown');
  assert.equal(field.label, 'Select your school.');
  assert.deepEqual(field.opts, ['Columbia University', 'New York University']);
  assert.equal(field.required, true);
});

test('the scan ignores a hidden dropdown and a dropdown that already has a value', async () => {
  const page = await form([
    dropdown('code', 'Country code', items(['United States (+1)', 'China (+86)']), { value: 'United States (+1)' }),
    dropdown('second', 'Secondary major', items(['Physics']), { style: 'display:none' }),
  ].join(''));
  assert.deepEqual((await scan(page)).filter(f => f.kind === 'dropdown'), []);
});

const part = (name, title, options) => `<div class="part"><label>${title}</label><div class="dd">
  <div role="button" tabindex="0" aria-expanded="false" aria-controls="${name}-options"><p>Select an option</p><input type="hidden" name="${name}"></div>
  <div id="${name}-options" hidden>${items(options)}</div>
</div></div>`;

test('two dropdowns that answer one question get that question and its required state', async () => {
  const page = await form(`<div class="field"><p>When will you begin full-time work? <span>*</span></p>
    <div class="parts">${part('month', 'Month', ['January', 'June'])}${part('year', 'Year', ['2027', '2028'])}</div></div>`);
  const fields = await scan(page);
  assert.deepEqual(fields.map(f => [f.label, f.required]), [
    ['When will you begin full-time work? - Month', true],
    ['When will you begin full-time work? - Year', true],
  ]);
});

test('adjacent dropdowns with their own questions keep those questions', async () => {
  const page = await form(`<div class="row">${dropdown('major', 'What is your major?', items(['Physics']))}${dropdown('minor', 'What is your minor?', items(['Art']))}</div>`);
  assert.deepEqual((await scan(page)).map(f => f.label), ['What is your major?', 'What is your minor?']);
});

test('a rule selects a dropdown option, and readback passes', async () => {
  const page = await form(dropdown('college', 'Select your school.', items(['New York University', 'Columbia University'])));
  const report = await run(page, { school: 'Columbia University' });
  assert.equal(await hiddenValue(page, 'college'), 'Columbia University');
  assert.deepEqual(report.review, []);
  assert.deepEqual(report.readback_failed, []);
});

test('an option in a closed category can be selected', async () => {
  const nested = `<div><p>Competitions</p><div style="display:none">${items(['Putnam', 'ICPC'])}</div></div>`;
  const page = await form(dropdown('source', 'How did you hear about us?', nested));
  const [field] = await scan(page);
  assert.deepEqual(field.opts, ['Putnam', 'ICPC']);
  assert.equal(await writeField(page, field, 'ICPC'), 'ICPC');
  assert.equal(await hiddenValue(page, 'source'), 'ICPC');
});

test('an empty required dropdown stops the submission', async () => {
  const page = await form(dropdown('year', 'When did your degree begin?', items(['2022', '2023'])));
  const report = await run(page, {});
  assert.deepEqual(report.review.map(item => [item.label, item.required]), [['When did your degree begin?', true]]);
  assert.equal((await submitBlockers(page, report)).length, 1);
  assert.equal(await hiddenValue(page, 'year'), '');
});

// Jane Street opens the student section after the answer Yes. Until then the section has a height of zero.
const COLLAPSIBLE = `<div>Are you a student?</div>
  <div><input type="radio" name="student" id="yes" onchange="document.querySelector('.reveal').style.cssText = ''"><label for="yes">Yes</label>
  <input type="radio" name="student" id="no"><label for="no">No</label></div>
  <div class="reveal" style="max-height: 0; overflow: hidden; opacity: 0">
    <label for="mail">School email</label><input id="mail" type="email" required>
    ${dropdown('college', 'Select your school.', items(['Columbia University', 'New York University']))}
  </div>`;

test('fields in a collapsed section wait until an answer opens the section', async () => {
  const page = await form(COLLAPSIBLE);
  const labels = async () => (await scan(page)).map(f => f.label);
  assert.deepEqual(await labels(), ['Are you a student?']);
  await page.locator('#yes').check();
  assert.deepEqual(await labels(), ['Are you a student?', 'School email', 'Select your school.']);
});

test('the agent fills a field after the section opens', async () => {
  const page = await form(COLLAPSIBLE);
  const profile = { school: 'Columbia University', email: 'a@example.edu', clarified: { 'are you a student': { question: 'Are you a student?', answer: 'Yes' } } };
  const report = await run(page, profile);
  assert.equal(await hiddenValue(page, 'college'), 'Columbia University');
  assert.equal(await page.locator('#mail').inputValue(), 'a@example.edu');
  assert.deepEqual(report.review, []);
});

test('a LinkedIn label with an example of the format is still the LinkedIn field', async () => {
  const page = await form(`<label for="l">LinkedIn profile URL (E.g., 'https://www.linkedin.com/in/your-name')</label><input id="l" type="text">
    <label for="q">Tell us why your LinkedIn activity matters to you in a few short sentences</label><input id="q" type="text">`);
  await run(page, { linkedin: 'linkedin.com/in/example' });
  assert.equal(await page.locator('#l').inputValue(), 'linkedin.com/in/example');
  assert.equal(await page.locator('#q').inputValue(), '');
});
