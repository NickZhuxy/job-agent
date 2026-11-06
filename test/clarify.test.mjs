import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { clarifyFields, needsUser } from '../src/clarify.mjs';
import { findClarified, mentionsEmployer, questionKey, regionAllowed, run, scan, writeField } from '../src/engine.mjs';

const select = (id, label, options, required = true) => `<label for="${id}">${label}</label><select id="${id}" ${required ? 'required' : ''}><option value=""></option>${options.map(o => `<option>${o}</option>`).join('')}</select>`;
const PROFILE = {
  first_name: 'Alex', authorized: 'Yes', sponsorship: 'Yes', work_regions: ['United States', 'Singapore', 'Hong Kong'], visa_type: 'F-1',
  past_employers: ['Acme Bank', '星河'], eeo: 'decline', eeo_fallback: { gender: 'Male', race: 'Asian', hispanic: 'No', veteran: 'No', disability: 'No' },
};

let browser;
test.before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
test.after(() => browser.close());
const form = async (html, head = '') => {
  const page = await browser.newPage();
  await page.setContent(`<head>${head}</head><form>${html}</form>`);
  return page;
};
const values = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('select, input:not([type=radio]), textarea')].map(e => [e.id, e.value])));

test('a demographic question gets the option to decline first, then the preset answer', async () => {
  const page = await form([
    select('g1', 'Gender', ['Male', 'Female', 'Decline to self identify']),
    select('g2', 'Gender identity', ['Man', 'Woman', 'Transgender man']),
    select('r1', 'Race', ['Asian (Not Hispanic or Latino)', 'White', 'I prefer not to answer']),
    select('r2', 'Race or ethnicity', ['Asian (Not Hispanic or Latino)', 'White']),
    select('r3', 'Ethnic background', ['East Asian', 'South Asian']),
    select('v1', 'Are you a veteran?', ['I am a protected veteran', 'I am not a protected veteran']),
    select('v2', 'Veteran status', ['Yes', 'No', 'Prefer not to say']),
    select('d1', 'Disability status', ['Yes, I have a disability', 'No, I do not have a disability']),
    select('h1', 'Are you Hispanic or Latino?', ['Yes', 'No']),
    select('o1', 'Sexual orientation', ['Straight', 'Gay']),
  ].join(''));
  const report = await run(page, PROFILE);
  assert.deepEqual(await values(page), {
    g1: 'Decline to self identify', g2: 'Man', r1: 'I prefer not to answer', r2: 'Asian (Not Hispanic or Latino)', r3: '',
    v1: 'I am not a protected veteran', v2: 'Prefer not to say', d1: 'No, I do not have a disability', h1: 'No', o1: '',
  });
  assert.deepEqual(report.review.map(r => [r.label, r.why]), [['Ethnic background', 'no_exact_option'], ['Sexual orientation', 'no_exact_option']], 'two matches or no preset: the user answers');
  await page.close();
});

test('with no preset answers, demographic questions stay empty', async () => {
  const page = await form(select('g', 'Gender', ['Male', 'Decline to self identify']));
  const report = await run(page, { first_name: 'Alex' });
  assert.equal((await values(page)).g, '');
  assert.equal(report.review[0].why, 'no_profile_value');
  await page.close();
});

test('legal answers apply only to the named regions', async () => {
  assert.equal(regionAllowed('Are you legally authorized to work in the US?', PROFILE.work_regions), true);
  assert.equal(regionAllowed('Are you authorized to work in the U.S.?', PROFILE.work_regions), true);
  assert.equal(regionAllowed('Do you have the right to work in Hong Kong SAR?', PROFILE.work_regions), true);
  assert.equal(regionAllowed('Are you eligible to work in Singapore?', PROFILE.work_regions), true);
  assert.equal(regionAllowed('Are you authorized to work in the country of this job?', PROFILE.work_regions), true);
  assert.equal(regionAllowed('Are you authorized to work in the United Kingdom?', PROFILE.work_regions), false);
  assert.equal(regionAllowed('Are you authorized to work in Canada?', undefined), true, 'with no list, the answer applies everywhere');

  const page = await form([
    select('a', 'Are you legally authorized to work in the United States?', ['Yes', 'No']),
    select('b', 'Are you authorized to work in Singapore?', ['Yes, I am', 'No, I am not']),
    select('c', 'Are you authorized to work in Canada?', ['Yes', 'No']),
    select('d', 'Will you now or in the future require sponsorship?', ['Yes', 'No']),
  ].join(''));
  const report = await run(page, PROFILE);
  assert.deepEqual(await values(page), { a: 'Yes', b: 'Yes, I am', c: '', d: 'Yes' });
  assert.deepEqual(report.review.map(r => r.why), ['region_not_configured']);
  await page.close();
});

test('a follow-up question goes to the user, not to the saved yes', async () => {
  const page = await form([
    select('a', 'What type of visa sponsorship will you require?', ['H-1B', 'Yes']),
    '<label for="b">If you need sponsorship, please explain</label><input id="b">',
    select('c', 'Which visa type will you need?', ['F-1', 'H-1B']),
  ].join(''));
  const report = await run(page, PROFILE);
  assert.deepEqual(await values(page), { a: '', b: '', c: '' });
  assert.deepEqual(report.review.map(r => r.why), ['follow_up', 'follow_up', 'follow_up']);
  assert.ok(report.review.every(needsUser), 'also an optional follow-up');
  await page.close();
});

test('the employer list answers "have you worked here" for each company', async () => {
  assert.equal(mentionsEmployer('Software Intern', 'https://careers.acmebank.com/jobs/1', 'Acme Bank'), true, 'a URL has no spaces');
  assert.equal(mentionsEmployer('Software Intern', 'https://example.com', 'Acme Bank'), false);
  assert.equal(mentionsEmployer('星河云 实习生', 'https://example.com', '星河'), true);
  assert.equal(mentionsEmployer('Bank of Macmeria', 'https://example.com', 'Acme'), false, 'a part of a word does not count');

  const question = select('w', 'Have you ever worked for this company?', ['Yes', 'No']);
  const here = await form(`${question}<h1>Intern at Acme Bank</h1>`);
  await run(here, PROFILE);
  assert.equal((await values(here)).w, 'Yes');
  await here.close();

  const other = await form(question, '<title>Intern at Globex</title>');
  await run(other, PROFILE);
  assert.equal((await values(other)).w, 'No');
  await other.close();

  const page = await form(question);
  await run(page, PROFILE, { company: 'Acme Bank' });
  assert.equal((await values(page)).w, 'Yes', 'the company from resume selection counts');
  await page.close();

  const none = await form(question);
  const report = await run(none, { first_name: 'Alex' });
  assert.equal(report.review[0].why, 'no_profile_value', 'with no list, the user answers');
  await none.close();
});

// Jane Street hides each radio input, styles its label, and puts the question in a paragraph before the list.
const HIDE_RADIOS = '<style>input[type=radio]{display:none}</style>';
const HIDDEN_RADIOS = `<p id="interviewed-label">Have you interviewed before? <span>*</span></p>
  <ul><li><input type="radio" id="i1" name="interviewed" value="true" required><label for="i1"><span></span><div>Yes</div></label></li>
  <li><input type="radio" id="i0" name="interviewed" value="false" required><label for="i0"><span></span><div>No</div></label></li></ul>`;

test('a radio group without a legend takes its question from the text before the group', async () => {
  const page = await form(HIDDEN_RADIOS, HIDE_RADIOS);
  const [field] = await scan(page);
  assert.equal(field.label, 'Have you interviewed before?');
  assert.deepEqual(field.opts, ['Yes', 'No']);
});

test('a hidden radio input is selected through its label', async () => {
  const page = await form(HIDDEN_RADIOS, HIDE_RADIOS);
  const [field] = await scan(page);
  assert.equal(await writeField(page, field, 'No'), 'No');
  assert.equal(await page.locator('#i0').isChecked(), true);
});

test('a radio button works when its value is not its label', async () => {
  const page = await form('<fieldset><legend>Will you require sponsorship?</legend><label><input type="radio" name="s" value="1"> Yes</label><label><input type="radio" name="s" value="0"> No</label></fieldset>');
  await run(page, PROFILE);
  assert.equal(await page.evaluate(() => document.querySelector('input[name=s]:checked')?.value), '1');
  await page.close();
});

test('a combobox gets the same answers as a select field', async () => {
  const combo = (id, label, options) => `<label for="${id}">${label}</label><input id="${id}" role="combobox" data-options="${options.join('|')}">`;
  const page = await form([
    combo('g', 'Gender', ['Male', 'Female', 'Decline To Self Identify']),
    combo('v', 'Veteran Status', ['I am not a protected veteran', 'I am a protected veteran']),
    combo('w', 'Have you ever worked for Acme Bank before, as an employee or a contractor?', ['Yes', 'No']),
    combo('a', 'Are you authorized to work in the country for which you applied?', ['Yes', 'No']),
  ].join(''));
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'listbox');
    document.body.append(menu);
    const close = () => { menu.replaceChildren(); };
    for (const input of document.querySelectorAll('[role=combobox]')) {
      const show = () => {
        const typed = input.value.toLowerCase();
        menu.replaceChildren(...input.dataset.options.split('|').filter(o => o.toLowerCase().includes(typed)).map(o => {
          const item = document.createElement('div');
          item.setAttribute('role', 'option');
          item.textContent = o;
          item.addEventListener('click', () => { input.value = o; close(); });
          return item;
        }));
      };
      input.addEventListener('click', show);
      input.addEventListener('input', show);
    }
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  });
  const report = await run(page, PROFILE);
  assert.deepEqual(await values(page), { g: 'Decline To Self Identify', v: 'I am not a protected veteran', w: 'Yes', a: 'Yes' });
  assert.deepEqual(report.review, []);
  assert.deepEqual(report.readback_failed, []);
  await page.close();
});

test('similar questions use a saved answer, and a negated question does not', () => {
  const store = { [questionKey('Which visa will you need to work for us after your studies end?')]: { question: 'q', answer: 'H-1B' } };
  assert.equal(findClarified(store, 'which VISA will you need to work for us after your studies end'), 'H-1B');
  assert.equal(findClarified(store, 'Which visa will you need to work for us after your studies end, today?'), 'H-1B');
  assert.equal(findClarified(store, 'Which visa will you not need to work for us after your studies end?'), null);
  assert.equal(findClarified(store, 'Which city do you prefer?'), null);
  assert.equal(findClarified(undefined, 'Any'), null);
});

const FOLLOW_UP_FORM = [
  select('s', 'Will you now or in the future require sponsorship?', ['Yes', 'No']),
  `<div id="wrap" hidden>${select('t', 'What type of sponsorship will you require?', ['H-1B', 'Other'], false)}</div>`,
  '<label for="n">Citizenship</label><input id="n" required>',
  '<label for="m">Expected salary</label><input id="m" required>',
  '<label><input type="checkbox" id="c" required> I certify this</label>',
].join('');
const showFollowUp = page => page.evaluate(() => document.getElementById('s').addEventListener('change', () => { document.getElementById('wrap').hidden = false; }));

test('the agent asks each follow-up once, saves the answer, and uses it on the next form', async () => {
  const profile = { ...PROFILE };
  let saves = 0;
  const asked = [];
  const replies = ['China', '100000', '1']; // The citizenship field shows first. The follow-up shows in the second scan.
  const io = { ask: async question => { asked.push(question); return replies.shift() ?? ''; }, say: () => {}, onSave: () => { saves++; } };

  const page = await form(FOLLOW_UP_FORM);
  await showFollowUp(page);
  const seen = new Set();
  const refill = () => run(page, profile, { seen });
  const report = await refill();
  await clarifyFields(page, profile, report, { ...io, refill });
  assert.deepEqual(await values(page), { s: 'Yes', t: 'H-1B', n: 'China', m: '100000', c: 'on' });
  assert.equal(await page.isChecked('#c'), false, 'without auto_submit, the user checks an attestation');
  assert.equal(saves, 3);
  assert.equal(Object.keys(profile.clarified).length, 3);
  assert.ok(JSON.stringify(profile.clarified).includes('salary'), 'a salary answer is saved');
  assert.ok(report.filled.some(line => line.includes('(from you)')));
  assert.deepEqual(report.readback_failed, []);
  await page.close();

  const second = await form(FOLLOW_UP_FORM);
  await showFollowUp(second);
  const again = new Set();
  const refillAgain = () => run(second, profile, { seen: again });
  const report2 = await refillAgain();
  asked.length = 0;
  await clarifyFields(second, profile, report2, { ...io, refill: refillAgain });
  assert.deepEqual(asked, [], 'the next form asks nothing');
  assert.deepEqual(await values(second), { s: 'Yes', t: 'H-1B', n: 'China', m: '100000', c: 'on' });
  await second.close();
});

test('an empty answer leaves the field for the form and saves nothing', async () => {
  const page = await form(select('t', 'What type of sponsorship will you require?', ['H-1B', 'Other']));
  const profile = { ...PROFILE };
  const seen = new Set();
  const refill = () => run(page, profile, { seen });
  const report = await refill();
  await clarifyFields(page, profile, report, { ask: async () => '', say: () => {}, refill });
  assert.equal(profile.clarified, undefined);
  assert.equal(report.review[0].why, 'user_skipped');
  await page.close();
});
