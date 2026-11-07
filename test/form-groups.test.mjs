import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { run, scan, verifyChecks } from '../src/engine.mjs';
import { clarifyFields, needsUser } from '../src/clarify.mjs';
import { isEligible } from '../src/model.mjs';
import { submitApplication, submitBlockers } from '../src/submit.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(() => browser.close());
const form = async (html, script = '') => {
  const page = await browser.newPage();
  await page.setContent(`<form>${html}</form><script>${script}</script>`);
  return page;
};

// The education section of a Greenhouse form: one entry, and a button that adds another.
const CHOICES = {
  school: ['Columbia University', 'New York University', 'Polytechnic Institute of New York University'],
  degree: ["Bachelor's Degree", "Master's Degree"],
  discipline: ['Artificial Intelligence', 'Computer Science', 'Mathematics'],
  'start-month': ['August', 'September'],
  'end-month': ['December', 'May'],
};
const entry = n => `<div class="education--form">
  ${[['school', 'School'], ['degree', 'Degree'], ['discipline', 'Discipline'], ['start-month', 'Start date month'], ['end-month', 'End date month']]
    .map(([id, label]) => `<label for="${id}--${n}">${label}*</label><input id="${id}--${n}" role="combobox" aria-required="true">`).join('')}
  <label for="start-year--${n}">Start date year*</label><input id="start-year--${n}" type="text" required>
  <label for="end-year--${n}">End date year*</label><input id="end-year--${n}" type="text" required>
</div>`;
const EDUCATION = `<div class="education--container">${entry(0)}<button type="button" id="add">Add another</button></div><button type="button">Add another</button>`;
const EDUCATION_SCRIPT = `
  const choices = ${JSON.stringify(CHOICES)};
  const show = input => {
    document.querySelector('.select__menu')?.remove();
    const menu = document.createElement('div'); menu.className = 'select__menu';
    for (const text of choices[input.id.split('--')[0]].filter(c => c.toLowerCase().includes(input.value.toLowerCase()))) {
      const option = document.createElement('div'); option.className = 'select__option'; option.textContent = text;
      option.addEventListener('click', () => { input.value = text; menu.remove(); });
      menu.append(option);
    }
    input.after(menu);
  };
  document.addEventListener('click', event => { if (event.target.matches('[role=combobox]')) show(event.target); });
  document.addEventListener('input', event => { if (event.target.matches('[role=combobox]')) show(event.target); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.select__menu')?.remove(); });
  document.getElementById('add').addEventListener('click', () => {
    const count = document.querySelectorAll('.education--form').length;
    document.getElementById('add').insertAdjacentHTML('beforebegin', ${JSON.stringify(entry('COUNT'))}.replaceAll('COUNT', count));
  });`;
const CURRENT = { school: 'Columbia University', degree: "Master's", degree_pick: 'Master', discipline: 'Artificial Intelligence', edu_start_month: 'September', edu_start_year: '2026', grad_month: 'December', grad_year: '2027' };
const UNDERGRADUATE = { school: 'New York University', degree: "Bachelor's Degree", discipline: 'Computer Science', disciplines: ['Mathematics', 'Computer Science'], edu_start_month: 'August', edu_start_year: '2023', grad_month: 'May', grad_year: '2026' };
const value = (page, id) => page.locator(`[id="${id}"]`).inputValue();

test('the agent adds an education entry for the undergraduate degree', async () => {
  const page = await form(EDUCATION, EDUCATION_SCRIPT);
  const report = await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE });
  assert.equal(await value(page, 'school--0'), 'Columbia University');
  assert.equal(await value(page, 'degree--0'), "Master's Degree");
  assert.equal(await value(page, 'school--1'), 'New York University');
  assert.equal(await value(page, 'degree--1'), "Bachelor's Degree");
  assert.equal(await value(page, 'discipline--1'), 'Computer Science');
  assert.equal(await value(page, 'start-month--1'), 'August');
  assert.equal(await value(page, 'start-year--1'), '2023');
  assert.equal(await value(page, 'end-month--1'), 'May');
  assert.equal(await value(page, 'end-year--1'), '2026');
  assert.deepEqual(report.readback_failed, []);
  assert.deepEqual(report.review, []);
  assert.ok(report.filled.some(line => /Undergraduate School = New York University/.test(line)));
});

test('a second round does not add a third education entry', async () => {
  const page = await form(EDUCATION, EDUCATION_SCRIPT);
  const seen = new Set();
  await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE }, { seen });
  await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE }, { seen });
  assert.equal(await page.locator('.education--form').count(), 2);
});

test('without undergraduate data the form keeps one education entry', async () => {
  const page = await form(EDUCATION, EDUCATION_SCRIPT);
  await run(page, CURRENT);
  assert.equal(await page.locator('.education--form').count(), 1);
});

test('an undergraduate value with no exact option goes to the user in Chrome, not to the model', async () => {
  const page = await form(EDUCATION, EDUCATION_SCRIPT);
  const report = await run(page, { ...CURRENT, undergraduate: { ...UNDERGRADUATE, discipline: 'Mathematics & Computer Science' } });
  const item = report.review.find(i => i.label === 'Undergraduate Discipline');
  assert.equal(item.why, 'undergraduate_no_match');
  assert.equal(item.required, true);
  assert.equal(isEligible(item), false);
  assert.equal(needsUser(item), false);
});

test('a question about undergraduate study gets the undergraduate school', async () => {
  const page = await form(`<label for="u">Undergraduate University</label>
    <select id="u"><option>Select</option><option>Columbia University</option><option>New York University</option></select>
    <label for="s">University</label>
    <select id="s"><option>Select</option><option>Columbia University</option><option>New York University</option></select>`);
  const report = await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE });
  assert.equal(await page.locator('#u option:checked').innerText(), 'New York University');
  assert.equal(await page.locator('#s option:checked').innerText(), 'Columbia University');
  assert.deepEqual(report.review, []);
});

test('a question about all schools attended goes to the user', async () => {
  const page = await form('<label for="a">All schools attended</label><input id="a" type="text" required>');
  const report = await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE });
  assert.equal(await page.locator('#a').inputValue(), '');
  assert.equal(isEligible(report.review[0]), false);
  assert.equal(needsUser(report.review[0]), true);
});

// A required question with many answers: each input keeps the required attribute after another is checked.
const checkboxes = (name, question, options, attrs = 'required') => `<fieldset class="checkbox" aria-required="true">
  <legend>${question} <span>*</span></legend>
  ${options.map((o, i) => `<div><input type="checkbox" id="${name}-${i}" name="${name}[]" value="${i}" ${attrs}><label for="${name}-${i}">${o}</label></div>`).join('')}
</fieldset>`;
const DISCIPLINES = ['Mathematics', 'Statistics', 'Computer Science', 'Other'];

test('the scan reads checkboxes with one name as one question', async () => {
  const page = await form(checkboxes('q1', 'Undergrad Discipline(s)', DISCIPLINES));
  const fields = await scan(page);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].kind, 'checkboxes');
  assert.equal(fields[0].label, 'Undergrad Discipline(s)');
  assert.deepEqual(fields[0].opts, DISCIPLINES);
  assert.equal(fields[0].required, true);
});

test('one checkbox stays one attestation', async () => {
  const page = await form('<label><input type="checkbox" name="agree" required> I agree to the terms</label>');
  const [field] = await scan(page);
  assert.equal(field.kind, 'checkbox');
});

test('the undergraduate majors are checked, and the other boxes do not stop the submission', async () => {
  const page = await form(checkboxes('q1', 'Undergrad Discipline(s)', DISCIPLINES));
  const report = await run(page, { ...CURRENT, undergraduate: UNDERGRADUATE });
  assert.equal(await page.locator('#q1-0').isChecked(), true);
  assert.equal(await page.locator('#q1-2').isChecked(), true);
  assert.equal(await page.locator('#q1-1').isChecked(), false);
  assert.deepEqual(await submitBlockers(page, report), []);
});

test('an unanswered group is one blocker, and it goes to the user but not to the model', async () => {
  const page = await form(checkboxes('q2', 'Which offices interest you?', ['Hong Kong', 'Singapore']));
  const report = await run(page, CURRENT);
  const [item] = report.review;
  assert.equal(item.kind, 'checkboxes');
  assert.equal(isEligible(item), false);
  assert.equal(needsUser(item), true);
  assert.deepEqual(await submitBlockers(page, report), ['Which offices interest you? (no_rule)']);
});

test('the question for more than one answer shows the skip method of the caller', async () => {
  const page = await form(checkboxes('q2', 'Which offices interest you?', ['Hong Kong', 'Singapore']));
  const report = await run(page, CURRENT);
  const asked = [];
  await clarifyFields(page, { ...CURRENT }, report, { ask: async question => { asked.push(question); return ''; }, say: () => {}, skipHint: 'send -' });
  assert.deepEqual(asked, ['Enter one or more numbers with commas between them, or send - to answer on the form: ']);
});

test('the user can select more than one answer, and the agent uses them again', async () => {
  const html = checkboxes('q2', 'Which offices interest you?', ['Hong Kong', 'Tokyo', 'Singapore']);
  const page = await form(html);
  const profile = { ...CURRENT };
  const seen = new Set();
  const report = await run(page, profile, { seen });
  const answers = ['9', '1, 3'];
  await clarifyFields(page, profile, report, { ask: async () => answers.shift(), say: () => {}, onSave: () => {}, refill: () => run(page, profile, { seen }) });
  assert.equal(await page.locator('#q2-0').isChecked(), true);
  assert.equal(await page.locator('#q2-1').isChecked(), false);
  assert.equal(await page.locator('#q2-2').isChecked(), true);
  assert.deepEqual(await submitBlockers(page, report), []);

  const again = await form(html);
  await run(again, profile);
  assert.equal(await again.locator('#q2-2').isChecked(), true);
  assert.equal(await again.locator('#q2-1').isChecked(), false);
});

test('a saved list of answers does not fit a question with one answer', async () => {
  const page = await form('<label for="o">Which offices interest you?</label><select id="o" required><option>Select</option><option>Hong Kong</option></select>');
  const clarified = { 'which offices interest you': { question: 'Which offices interest you?', answer: ['Hong Kong', 'Tokyo'] } };
  const report = await run(page, { ...CURRENT, clarified });
  assert.equal(report.review[0].why, 'no_rule');
});

// How did you hear about the job: LinkedIn first, then a career website, then a job board.
const SOURCE = { referral: ['LinkedIn'] };
const sourceSelect = (question, options) => `<label for="h">${question}</label><select id="h" required><option>Select</option>${options.map(o => `<option>${o}</option>`).join('')}</select>`;
const chosen = page => page.locator('#h option:checked').innerText();

test('LinkedIn comes first for any company name', async () => {
  const page = await form(sourceSelect('How did you hear about Acme Trading?', ['Company Website', 'LinkedIn Job Post', 'Other']));
  await run(page, SOURCE);
  assert.equal(await chosen(page), 'LinkedIn Job Post');
});

test('a career website comes next, and a career fair is not a website', async () => {
  const page = await form(sourceSelect('How did you hear about this role?', ['Career Fair', 'Careers Page', 'Referral', 'Other']));
  await run(page, SOURCE);
  assert.equal(await chosen(page), 'Careers Page');
});

test('a job board comes after the career website', async () => {
  const page = await form(sourceSelect('How did you find this job?', ['Employee', 'Online Job Board', 'Other']));
  await run(page, SOURCE);
  assert.equal(await chosen(page), 'Online Job Board');
});

test('the preference comes before a saved answer, and a saved answer comes before a question', async () => {
  const clarified = { 'how did you hear about us': { question: 'How did you hear about us?', answer: 'Other' } };
  const first = await form(sourceSelect('How did you hear about us?', ['LinkedIn', 'Other']));
  await run(first, { ...SOURCE, clarified });
  assert.equal(await chosen(first), 'LinkedIn');
  const second = await form(sourceSelect('How did you hear about us?', ['Friend', 'Other']));
  await run(second, { ...SOURCE, clarified });
  assert.equal(await chosen(second), 'Other');
});

test('without a suitable option the user answers, not the model', async () => {
  const page = await form(sourceSelect('How did you hear about Acme?', ['Friend', 'Campus Event']));
  const report = await run(page, SOURCE);
  const [item] = report.review;
  assert.equal(item.why, 'source_no_match');
  assert.equal(isEligible(item), false);
  assert.equal(needsUser(item), true);
});

test('a text question gets the first source', async () => {
  const page = await form('<label for="h">How did you hear about us?</label><input id="h" type="text">');
  await run(page, SOURCE);
  assert.equal(await page.locator('#h').inputValue(), 'LinkedIn');
});

test('a saved answer to a long question is found again', async () => {
  const question = `Do you need a visa? ${'Read this long text about visas and travel. '.repeat(10)}`;
  const page = await form(`<label for="v">${question}</label><select id="v" required><option>Select</option><option>No</option><option>Yes</option></select>`);
  const profile = { ...CURRENT };
  const seen = new Set();
  const report = await run(page, profile, { seen });
  await clarifyFields(page, profile, report, { ask: async () => '1', say: () => {}, onSave: () => {}, refill: () => run(page, profile, { seen }) });
  const again = await form(`<label for="v">${question}</label><select id="v" required><option>Select</option><option>No</option><option>Yes</option></select>`);
  const next = await run(again, profile);
  assert.equal(await again.locator('#v option:checked').innerText(), 'No');
  assert.deepEqual(next.review, []);
});

test('an approved text answer is used again for the same question only', async () => {
  const page = await form(`<label for="e">Current or most recent employer</label><input id="e" type="text" required>
    <label for="o">Most recent employer in your country</label><input id="o" type="text" required>`);
  const report = await run(page, { answers: { 'current or most recent employer': 'Example Corp' } });
  assert.equal(await page.locator('#e').inputValue(), 'Example Corp');
  assert.equal(await page.locator('#o').inputValue(), '');
  assert.equal(report.review[0].label, 'Most recent employer in your country');
});

// The page keeps the form behind a dialog after the submission. It counts each selection of a file.
const DIALOG_FORM = `<form onsubmit="event.preventDefault(); document.getElementById('thanks').style.display = 'block'">
  <input type="file" name="resume" onchange="window.selections = (window.selections || 0) + 1">
  <button type="submit">Submit</button></form>
  <div id="thanks" class="modal" style="display: none">Thank you for your application.</div>`;
const openAt = async url => {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: DIALOG_FORM }));
  await page.goto(url);
  return page;
};
const EMPTY_REPORT = { review: [], readback_failed: [] };
const pdf = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-')), 'resume.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  return file;
};

test('a confirmation in a dialog counts, and Jane Street gets the resume again before the click', async () => {
  const page = await openAt('https://www.janestreet.com/apply');
  const result = await submitApplication(page, EMPTY_REPORT, { resume: pdf() });
  assert.equal(result.submitted, true);
  assert.equal(await page.evaluate(() => window.selections), 1);
});

test('other sites do not get the resume again', async () => {
  const page = await openAt('https://jobs.example.com/apply');
  const result = await submitApplication(page, EMPTY_REPORT, { resume: pdf() });
  assert.equal(result.submitted, true);
  assert.equal(await page.evaluate(() => window.selections), undefined);
});

test('a confirmation in a hidden dialog does not count', async () => {
  const page = await browser.newPage();
  await page.setContent('<form onsubmit="event.preventDefault()"><button type="submit">Submit</button></form><div class="modal" style="display: none">Thank you for your application.</div>');
  const result = await submitApplication(page, EMPTY_REPORT, { canWait: false, confirmWaitMs: 1000 });
  assert.equal(result.submitted, false);
});

test('the agent waits for a confirmation that appears after the error wait', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form onsubmit="event.preventDefault(); setTimeout(() => document.getElementById('thanks').style.display = 'block', 6000)"><button type="submit">Submit</button></form>
    <div id="thanks" class="modal" style="display: none">Thank you for your application.</div>`);
  const result = await submitApplication(page, EMPTY_REPORT, {});
  assert.equal(result.submitted, true);
});

test('an error in a dialog is a form error, so the report does not say that the result is unknown', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form onsubmit="event.preventDefault(); document.getElementById('failed').style.display = 'block'"><button type="submit">Submit</button></form>
    <div id="failed" class="modal" style="display: none">There was an error processing your application.</div>
    <div class="modal" style="display: none">Thank you for your application.</div>`);
  const result = await submitApplication(page, EMPTY_REPORT, {});
  assert.equal(result.why, 'form_errors');
  assert.match(result.errors[0], /error processing/);
});

test('a choice in a multi-select dropdown counts as written', async () => {
  const page = await form(`<div class="select__control"><div class="select__multi-value__label">Master’s</div><input id="d" role="combobox" data-agent-field="f1"></div>`);
  assert.deepEqual(await verifyChecks(page, [{ id: 'f1', kind: 'combobox', label: 'Degree', value: 'Master’s' }]), []);
  const empty = await form('<div class="select__control"><input id="d" role="combobox" data-agent-field="f1"></div>');
  assert.equal((await verifyChecks(empty, [{ id: 'f1', kind: 'combobox', label: 'Degree', value: 'Master’s' }])).length, 1);
});

const OPTIONAL = `<label for="o">Other than the posted location, which offices interest you?</label><input id="o" type="text">
  <label for="c">If you said yes above, please tell us more.</label><input id="c" type="text">
  <label for="g">Were you ever convicted of a crime?</label><input id="g" type="text">
  <label for="f">Cover Letter</label><input id="f" type="file">`;

test('an optional question goes to the user, and the answer stays for the next form', async () => {
  const page = await form(OPTIONAL);
  const profile = { ...CURRENT };
  const seen = new Set();
  const report = await run(page, profile, { seen });
  const said = [];
  const asked = [];
  await clarifyFields(page, profile, report, { ask: async question => { asked.push(question); return 'Hong Kong'; }, say: line => said.push(line), onSave: () => {}, refill: () => run(page, profile, { seen }) });
  assert.equal(asked.length, 1, 'a conditional question, a sensitive question, and a file do not go to the user');
  assert.match(said.join('\n'), /The form asks \(optional\): Other than the posted location/);
  assert.match(said.join('\n'), /exactly as you type it/);
  assert.equal(await page.locator('#o').inputValue(), 'Hong Kong');
  assert.ok(report.filled.some(line => /Hong Kong \(from you\)/.test(line)));
  assert.ok(!report.skipped.some(line => line.startsWith('Other than')));
  assert.deepEqual(report.review, []);
  const again = await form(OPTIONAL);
  await run(again, profile);
  assert.equal(await again.locator('#o').inputValue(), 'Hong Kong');
});

test('an optional question that the user skips does not stop the submission', async () => {
  const page = await form(OPTIONAL);
  const profile = { ...CURRENT };
  const report = await run(page, profile);
  await clarifyFields(page, profile, report, { ask: async () => '', say: () => {}, onSave: () => {}, refill: () => run(page, profile) });
  assert.deepEqual(report.review, []);
  assert.ok(report.skipped.some(line => line.startsWith('Other than')));
  assert.equal(profile.clarified, CURRENT.clarified);
  assert.deepEqual(await submitBlockers(page, report), []);
});
