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
