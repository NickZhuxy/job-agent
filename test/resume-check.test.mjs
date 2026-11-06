import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright-core';
import { acceptAutomatically, repeatedPhrases, ruleProblems } from '../src/resume-check.mjs';
import { tailorCommand } from '../src/tailor.mjs';

const RULES = { max_pages: 1, must_include: ['Alex Rivera', 'Expected Dec 2027'], must_not_include: ['Old School', 'FX desk'] };
const GOOD = 'Alex Rivera\nState University\nExpected\nDec 2027\nBuilt a data pipeline in Python.';

test('the rules pass a resume that meets each check', () => {
  assert.deepEqual(ruleProblems({ pages: 1, text: GOOD }, RULES), []);
});

test('the rules report each problem', () => {
  const problems = ruleProblems({ pages: 2, text: 'Expected Dec 2027. Worked on the FX\ndesk. old school notes.' }, RULES);
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /2 pages/);
  assert.match(problems.join('\n'), /Alex Rivera/);
  assert.match(problems.join('\n'), /FX desk/);
  assert.match(problems.join('\n'), /Old School/);
});

test('a forbidden word must match a whole word', () => {
  const rules = { must_not_include: ['RPI'] };
  assert.deepEqual(ruleProblems({ pages: 1, text: 'Sharpie and RPIC are fine.' }, rules), []);
  assert.equal(ruleProblems({ pages: 1, text: 'Studied at RPI.' }, rules).length, 1);
});

test('a repeated phrase is found across lines, and common short phrases are not', () => {
  const twice = 'Contributed to a project; automated multi-model regression testing across\nmultiple servers in the lab.\nAutomated multi-model regression testing across multiple servers in the lab; traced a failure.';
  assert.deepEqual(repeatedPhrases(twice), ['automated multi-model regression testing across multiple servers in']);
  assert.deepEqual(repeatedPhrases('Built a data pipeline. Built a data model. Built a data tool.'), []);
});

test('the command uses the model and the effort from the profile', () => {
  const command = tailorCommand({ skill: 'resume-skill', model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(command[command.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(command[command.indexOf('--effort') + 1], 'medium');
  const plain = tailorCommand({ skill: 'resume-skill' });
  assert.equal(plain.includes('--model'), false);
  assert.equal(plain.includes('--effort'), false);
});

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-check-'));
const pdf = path.join(folder, 'resume.pdf');
test.before(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent(`<p>${GOOD.replaceAll('\n', ' ')}</p>`);
  await page.pdf({ path: pdf });
  await browser.close();
});
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));

const library = auto_accept => ({ auto_accept });
const reviewer = (answer, seen = []) => ({
  async completeJSON({ user }) {
    seen.push(user);
    if (answer instanceof Error) throw answer;
    return { data: answer, usage: {} };
  },
});
const accept = (lib, provider) => {
  const said = [];
  return acceptAutomatically(pdf, lib, provider, line => said.push(line)).then(accepted => ({ accepted, said: said.join('\n') }));
};

test('without the setting, the user decides and the model gets no resume text', async () => {
  const seen = [];
  const { accepted } = await accept(library(undefined), reviewer({ ok: true, problems: [] }, seen));
  assert.equal(accepted, false);
  assert.deepEqual(seen, []);
});

test('a resume that passes the rules and the model review is accepted', async () => {
  const seen = [];
  const { accepted, said } = await accept(library(RULES), reviewer({ ok: true, problems: [] }, seen));
  assert.equal(accepted, true);
  assert.match(said, /passed/);
  assert.match(seen[0], /Alex Rivera/);
});

test('a failed rule stops the acceptance, and the model does not run', async () => {
  const seen = [];
  const { accepted, said } = await accept(library({ must_include: ['Missing Name'] }), reviewer({ ok: true, problems: [] }, seen));
  assert.equal(accepted, false);
  assert.match(said, /Missing Name/);
  assert.deepEqual(seen, []);
});

test('the user decides if the model finds a problem, fails, or gives no clear answer', async () => {
  const cases = [
    [{ ok: false, problems: ['Sentence stops in the middle.'] }, /Sentence stops/],
    [{ ok: true, problems: ['Date conflict.'] }, /Date conflict/],
    [{ problems: [] }, /no clear answer/],
    [new Error('API down'), /API down/],
  ];
  for (const [answer, message] of cases) {
    const { accepted, said } = await accept(library(RULES), reviewer(answer));
    assert.equal(accepted, false);
    assert.match(said, message);
  }
  const { accepted, said } = await accept(library(RULES), null);
  assert.equal(accepted, false);
  assert.match(said, /model/);
});

test('a file that cannot be read goes to the user', async () => {
  const said = [];
  assert.equal(await acceptAutomatically(path.join(folder, 'missing.pdf'), library(RULES), reviewer({ ok: true, problems: [] }), line => said.push(line)), false);
  assert.match(said.join('\n'), /could not read/i);
});
