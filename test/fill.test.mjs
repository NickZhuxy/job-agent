// Runs the terminal command as a user runs it, and compares all of its output. All data is fictional, and the form is local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const FILL = path.resolve('src/fill.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-fill-'));
const library = path.join(root, 'general');
fs.mkdirSync(path.join(library, 'SWE'), { recursive: true });
fs.writeFileSync(path.join(library, 'SWE', 'Alex_Rivera_SWE.pdf'), '%PDF-1.7 fictional');

const FORM = `<title>Intern at Acme</title><h1>Intern</h1><form id="apply">
  <label for="fn">First Name</label><input id="fn" required>
  <label for="cv">Resume</label><input id="cv" type="file">
  <label for="why">Why this job?</label><textarea id="why" required></textarea>
  <label for="visa">What type of sponsorship will you require?</label><select id="visa" required><option value=""></option><option>H-1B</option><option>Other</option></select>
  <button type="submit">Submit application</button>
</form><script>document.getElementById('apply').addEventListener('submit', e => { e.preventDefault(); document.body.innerHTML = '<h2>Thank you for applying</h2>'; });</script>`;

const answer = data => JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
let base;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'text/html'); res.end(FORM); return; }
    const request = JSON.parse(body);
    if (request.messages[0].content.includes('final check')) {
      res.end(answer({ ok: true, problems: [] }));
      return;
    }
    if (request.messages[0].content.includes('one resume')) {
      res.end(answer({ resume_id: 'r1', tailor_recommended: false, reason: 'It fits the role.', company: 'Acme', role: 'Intern' }));
      return;
    }
    const { fields, applicant_feedback: feedback } = JSON.parse(request.messages[1].content);
    res.end(answer({ answers: fields.map(field => ({ id: field.id, value: feedback ? 'Second draft.' : 'First draft.' })) }));
  });
});
test.before(() => new Promise(resolve => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); })));
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

// Sends each answer when its prompt appears, and returns all of the output.
function runFill(args, replies, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HEADLESS: '1', JOB_AGENT_PROVIDER: 'openai-compatible', JOB_AGENT_BASE_URL: base, JOB_AGENT_MODEL: 'test', ...extraEnv };
    const child = spawn(process.execPath, [FILL, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', from = 0;
    const pending = [...replies];
    child.stdout.on('data', chunk => {
      out += chunk;
      while (pending.length && out.indexOf(pending[0][0], from) >= 0) {
        from = out.indexOf(pending[0][0], from) + pending[0][0].length;
        child.stdin.write(`${pending.shift()[1]}\n`);
      }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ out, err, code }));
  });
}

const writeProfile = (cwd, extra) => {
  const file = path.join(cwd, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ first_name: 'Alex', last_name: 'Rivera', ...extra }));
  return file;
};
const newFolder = () => fs.mkdtempSync(path.join(root, 'run-'));
// A prompt ends with a space. The replies above match the exact prompts.
const lines = text => text.replace(/ +$/gm, '');

test('the terminal flow with a model: resume, draft revision, follow-up question, submission, and summary', async () => {
  const cwd = newFolder();
  const profile = writeProfile(cwd, { auto_submit: true, resume_library: { language: 'any', roots: [{ dir: library, kind: 'general' }] } });
  const { out, err, code } = await runFill([`${base}/`, profile, '--model'], [
    ['Enter a to accept the recommendation, a resume id, p for a path, or s for no resume: ', 'a'],
    ['[a]ccept, [e]dit, [r]evise, or [s]kip? ', 'r'],
    ['Your feedback: ', 'Make it shorter.'],
    ['[a]ccept, [e]dit, [r]evise, or [s]kip? ', 'a'],
    ['Enter a number, or press Enter to answer on the form: ', '1'],
  ], cwd);
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.equal(lines(out).replaceAll(base, 'BASE'), `
Recommended: Alex_Rivera_SWE.pdf
Reason: It fits the role.

Enter a to accept the recommendation, a resume id, p for a path, or s for no resume:
Question: Why this job?
Draft: First draft.
[a]ccept, [e]dit, [r]evise, or [s]kip? Your feedback:
Question: Why this job?
Draft: Second draft.
[a]ccept, [e]dit, [r]evise, or [s]kip?
The form asks: What type of sponsorship will you require?
  1. H-1B
  2. Other
Enter a number, or press Enter to answer on the form:
SUBMITTED
BASE/

Resume:  Alex_Rivera_SWE.pdf
Fields:  4 filled, 0 skipped
For Simplify: added to applications.local.csv

Examine these answers:
  - Why this job? = Second draft. (model)
  - What type of sponsorship will you require? = H-1B (from you)

Model use: 3 calls, 30 input tokens, 15 output tokens

`);
  assert.match(fs.readFileSync(path.join(cwd, 'applications.local.csv'), 'utf8'), /Acme,Intern,Applied/);
  const saved = JSON.parse(fs.readFileSync(profile, 'utf8'));
  assert.equal(saved.answers['why this job?'], 'Second draft.');
  assert.equal(Object.values(saved.clarified)[0].answer, 'H-1B');
});

test('the terminal flow with no model and no automatic submission fills the form and reports', async () => {
  const cwd = newFolder();
  const profile = writeProfile(cwd, {});
  const { out, err, code } = await runFill([`${base}/`, profile], [['Enter a number, or press Enter to answer on the form: ', '']], cwd);
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.equal(lines(out), `
The form asks: What type of sponsorship will you require?
  1. H-1B
  2. Other
Enter a number, or press Enter to answer on the form:
FILLED, NOT SUBMITTED. Examine the form in Chrome.

Resume:  none
Fields:  1 filled, 0 skipped

Not filled:
  - Resume
  - Why this job? (required)
  - What type of sponsorship will you require? (required)

`);
  assert.equal(fs.existsSync(path.join(cwd, 'applications.local.csv')), false);
});

test('a resume that passes the check is accepted with no question', async () => {
  const cwd = newFolder();
  const pdf = path.join(cwd, 'general', 'SWE', 'Alex_Rivera_SWE.pdf');
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent('<p>Alex Rivera</p><p>Built a data pipeline.</p>');
  await page.pdf({ path: pdf });
  await browser.close();
  const profile = writeProfile(cwd, { resume_library: { language: 'any', auto_accept: { max_pages: 2, must_include: ['Alex Rivera'] }, roots: [{ dir: path.dirname(path.dirname(pdf)), kind: 'general' }] } });
  const { out, err, code } = await runFill([`${base}/`, profile, '--model'], [
    ['[a]ccept, [e]dit, [r]evise, or [s]kip? ', 'a'],
    ['Enter a number, or press Enter to answer on the form: ', '1'],
  ], cwd);
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.match(out, /The resume passed the check\. The agent accepts it\./);
  assert.doesNotMatch(out, /a resume id, p for a path/);
  assert.match(out, /Resume: +Alex_Rivera_SWE\.pdf/);
});

test('the --no-submit and --json options work', async () => {
  const cwd = newFolder();
  const profile = writeProfile(cwd, { auto_submit: true, clarified: { 'what type of sponsorship will you require': { question: 'q', answer: 'Other' } }, answers: { 'why this job': 'Saved text.' } });
  const { out, code } = await runFill([`${base}/`, profile, '--no-submit', '--json'], [], cwd);
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(report.submission, undefined);
  assert.deepEqual(report.review.map(item => item.label), ['Resume']);
});

test('a missing profile starts the setup first', async () => {
  const cwd = newFolder();
  const missing = path.join(cwd, 'missing.json');
  const child = spawn(process.execPath, [FILL, `${base}/`, missing], { cwd, env: { ...process.env, HEADLESS: '1', JOB_AGENT_PROVIDER: 'none' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const first = await new Promise(resolve => child.stdout.once('data', chunk => resolve(String(chunk))));
  child.kill();
  assert.match(first, /does not exist\. Setup starts now\./);
});

test('with no URL, the command shows its usage', async () => {
  const { err, code } = await runFill([], [], newFolder());
  assert.equal(code, 1);
  assert.match(err, /^Usage: node src\/fill\.mjs/);
});
