import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { run } from '../src/engine.mjs';
import { chooseResume, companyToken, filterCandidates, scanLibrary, selectResume } from '../src/resume.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-resumes-'));
const files = [
  'general/SWE/Alex_Rivera_SWE_Resume.pdf', 'general/SWE/Alex_Rivera_SWE_Resume 2.pdf', 'general/SWE/亚历克斯_软件工程简历.pdf', 'general/SWE/notes.tex',
  'general/Quant Dev/Alex_Rivera_Quant_Dev_Resume.pdf',
  'targeted/Alex_Rivera_Acme_Backend/Alex_Rivera_Acme_Backend.pdf', 'targeted/Alex_Rivera_Acme_Backend/Alex_Rivera_Other.pdf',
  'targeted/Alex_Rivera_Globex_Data/Alex_Rivera_Globex_Data.pdf',
];
for (const f of files) { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'fictional resume text SECRET-CONTENT'); }
const library = { roots: [{ dir: path.join(root, 'general'), kind: 'general' }, { dir: path.join(root, 'targeted'), kind: 'targeted' }, { dir: path.join(root, 'missing'), kind: 'general' }], tailor_policy: 'Tailor for Acme.' };
const profile = { first_name: 'Alex', last_name: 'Rivera', resume_library: library };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const names = list => list.map(c => c.name);

test('the scan removes Finder copies, other languages, other files, and stray files', () => {
  assert.deepEqual(names(scanLibrary(library)), ['Alex_Rivera_Quant_Dev_Resume.pdf', 'Alex_Rivera_SWE_Resume.pdf', 'Alex_Rivera_Acme_Backend.pdf', 'Alex_Rivera_Globex_Data.pdf']);
  assert.deepEqual(names(scanLibrary({ ...library, language: 'zh' })), ['亚历克斯_软件工程简历.pdf']);
});

test('a targeted resume needs its company in the job text', () => {
  assert.equal(companyToken('Alex_Rivera_Globex_Corp_Data', ['Alex', 'Rivera']), 'Globex');
  const all = scanLibrary(library);
  const tokens = ['Alex', 'Rivera'];
  assert.deepEqual(names(filterCandidates(all, 'Backend Engineer at Acme', tokens)), ['Alex_Rivera_Quant_Dev_Resume.pdf', 'Alex_Rivera_SWE_Resume.pdf', 'Alex_Rivera_Acme_Backend.pdf']);
  assert.deepEqual(names(filterCandidates(all, 'Works with acmecorp clients', tokens)).includes('Alex_Rivera_Acme_Backend.pdf'), false, 'whole word only');
});

const provider = (reply, log = []) => ({ name: 'scripted', async completeJSON({ user }) { log.push(user); return { data: reply(JSON.parse(user)), usage: { input_tokens: 1, output_tokens: 1 } }; } });

test('the model sees names only, and an unknown id selects nothing', async () => {
  const log = [], candidates = scanLibrary(library);
  const good = await selectResume(provider(r => ({ resume_id: r.resumes[1].id, tailor_recommended: false, reason: 'SWE role' }), log), candidates, 'SWE job');
  assert.equal(good.selected.name, 'Alex_Rivera_SWE_Resume.pdf');
  assert.ok(!log[0].includes(root), 'no local paths');
  assert.ok(!log[0].includes('SECRET-CONTENT'), 'no resume content');
  const bad = await selectResume(provider(() => ({ resume_id: '../../etc/passwd', tailor_recommended: false, reason: '' })), candidates, 'job');
  assert.equal(bad.selected, null);
});

const FORM = `<h1>Backend Engineer at Acme</h1><form><label for="r">Resume</label><input type="file" id="r" required></form>`;

test('the file attaches only after approval, and readback confirms it', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const attached = () => page.evaluate(() => document.getElementById('r').files[0]?.name ?? null);
    const pick = provider(r => ({ resume_id: r.resumes.find(x => x.kind === 'targeted').id, tailor_recommended: false, reason: 'Same company and role' }));

    let shown;
    const accepted = await chooseResume(page, profile, { provider: pick, confirmResume: async info => { shown = { info, file: await attached() }; return { action: 'accept' }; } });
    assert.equal(shown.file, null, 'nothing is attached while the user decides');
    assert.equal(shown.info.selected.name, 'Alex_Rivera_Acme_Backend.pdf');
    assert.ok(!names(shown.info.candidates).includes('Alex_Rivera_Globex_Data.pdf'));
    assert.equal(accepted.source, 'model');

    const report = await run(page, profile, { resume: accepted.path });
    assert.equal(await attached(), 'Alex_Rivera_Acme_Backend.pdf');
    assert.deepEqual(report.readback_failed, []);

    const skipped = await chooseResume(page, profile, { provider: pick, confirmResume: async () => ({ action: 'skip' }) });
    assert.equal(skipped.path, null);
    const chosen = await chooseResume(page, profile, { provider: pick, confirmResume: async ({ candidates }) => ({ action: 'choose', id: candidates.find(c => /Quant/.test(c.name)).id }) });
    assert.equal(path.basename(chosen.path), 'Alex_Rivera_Quant_Dev_Resume.pdf');
    assert.equal(chosen.source, 'user');
    const missing = await chooseResume(page, profile, { provider: pick, confirmResume: async () => ({ action: 'path', path: '/no/such/file.pdf' }) });
    assert.equal(missing.path, null);
    const noUser = await chooseResume(page, profile, { provider: pick });
    assert.equal(noUser.path, null, 'without approval there is no upload');
    const failing = { name: 'failing', completeJSON: async () => { throw new Error('API down'); } };
    const failed = await chooseResume(page, profile, { provider: failing, confirmResume: async ({ selected }) => { assert.equal(selected, null); return { action: 'skip' }; } });
    assert.equal(failed.error, 'API down');

    await page.setContent(FORM);
    const wrong = await run(page, profile, { resume: accepted.path });
    assert.deepEqual(wrong.readback_failed, []);
    await page.evaluate(() => { document.getElementById('r').value = ''; });
    const { verifyChecks } = await import('../src/engine.mjs');
    assert.equal((await verifyChecks(page, wrong.checks)).length, 1, 'a detached file fails readback');
  } finally {
    await browser.close();
  }
});
