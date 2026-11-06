import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { cleanPath, collectFiles, deriveFields, EXTRACT_SCHEMA, findContacts, readDocument, runSetup } from '../src/setup.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-setup-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const RESUME = 'Alex Rivera\nalex.rivera@example.com | (212) 555-0142 | linkedin.com/in/alex-rivera-test | https://github.com/alex-rivera-test\nColumbia University, MS Computer Science, December 2027';
const notes = path.join(dir, 'notes.txt');
fs.writeFileSync(notes, RESUME);
fs.writeFileSync(path.join(dir, 'secrets.env'), 'TOKEN=abc');

// Answers each question in order. An empty answer accepts the suggestion.
const scripted = answers => {
  const asked = [];
  return { asked, ask: async question => { asked.push(question); return answers.length ? answers.shift() : ''; } };
};
const say = () => {};

test('paths from a terminal work, and a folder gives only document types', () => {
  assert.equal(cleanPath(`'${notes}' `), notes);
  assert.equal(cleanPath('/a/my\\ file.pdf'), '/a/my file.pdf');
  assert.equal(cleanPath('~/x.pdf'), path.join(os.homedir(), 'x.pdf'));
  const files = collectFiles([dir, '/no/such/path']);
  assert.ok(files.includes(notes));
  assert.ok(!files.some(file => file.endsWith('.env')), 'other file types stay unread');
});

test('Word and PDF documents give text', async () => {
  const docx = path.join(dir, 'resume.docx');
  execFileSync('textutil', ['-convert', 'docx', notes, '-output', docx]);
  assert.match(await readDocument(docx), /alex\.rivera@example\.com/);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pdf = path.join(dir, 'resume.pdf');
  try {
    const page = await browser.newPage();
    await page.setContent(`<pre>${RESUME}</pre>`);
    await page.pdf({ path: pdf });
  } finally {
    await browser.close();
  }
  assert.match(await readDocument(pdf), /alex\.rivera@example\.com/);
});

test('contact patterns work with no model', () => {
  const found = findContacts(RESUME);
  assert.equal(found.email, 'alex.rivera@example.com');
  assert.equal(found.phone, '(212) 555-0142');
  assert.equal(found.linkedin, 'linkedin.com/in/alex-rivera-test');
  assert.equal(found.github, 'https://github.com/alex-rivera-test');
  assert.equal(findContacts('Worked 2024 - 2026 in New York').phone, undefined, 'a date range is not a phone number');
});

test('derived fields fill the form menus', () => {
  assert.equal(deriveFields({ linkedin: 'linkedin.com/in/a' }).linkedin, 'https://linkedin.com/in/a');
  assert.equal(deriveFields({ github: 'https://github.com/a' }).github, 'https://github.com/a');
  assert.equal('website' in deriveFields({ website: '' }), false, 'an empty value is not saved');
  const out = deriveFields({ location: 'New York', school: 'Columbia', country: 'United States', grad_month: 'December', grad_year: '2027', referral: 'LinkedIn' });
  assert.equal(out.grad_term, 'Fall 2027');
  assert.equal(out.school_pick, 'Columbia');
  assert.deepEqual(out.referral, ['LinkedIn', 'Other']);
  const kept = deriveFields({ school: 'Columbia', school_pick: 'Columbia University' }, { school: 'Columbia' });
  assert.equal(kept.school_pick, 'Columbia University', 'a value stays until its base changes');
});

test('setup with no document asks questions and writes a private file', async () => {
  const out = path.join(dir, 'asked.json');
  const io = scripted(['', 'Alex', 'Rivera', 'alex.rivera@example.com']);
  const profile = await runSetup({ ...io, say, outPath: out });
  assert.equal(profile.first_name, 'Alex');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).first_name, 'Alex');
  assert.equal(profile.eeo, undefined, 'the agent does not decline for the user by default');
  assert.equal(profile.resume_library.tailor, undefined);
});

test('a required value is asked for again', async () => {
  const io = scripted(['', '', 'Alex', 'Rivera', 'a@example.com']);
  const profile = await runSetup({ ...io, say, outPath: path.join(dir, 'again.json') });
  assert.equal(profile.first_name, 'Alex');
  assert.equal(io.asked.filter(q => q.startsWith('First name')).length, 2);
});

const extraction = overrides => ({ first_name: 'Alex', last_name: 'Rivera', email: null, phone: null, country: 'United States', location: 'New York', linkedin: null, github: null, website: null, school: 'Columbia', degree: "Master's", discipline: 'Computer Science', grad_month: 'December', grad_year: '2027', gpa: null, start_date: null, summary: 'Builds backend systems.', experience: ['Built a replay service.'], skills: ['Python'], ...overrides });

test('documents go to the model only after consent, and each value stays a suggestion', async () => {
  const sent = [];
  const provider = { name: 'scripted', async completeJSON({ user }) { sent.push(user); return { data: extraction({ authorized: 'Yes', school: 'Columbia' }), usage: {} }; } };

  const refused = scripted([notes, '', 'n', 'Alex', 'Rivera']);
  const noConsent = await runSetup({ ...refused, say, provider, outPath: path.join(dir, 'refused.json') });
  assert.equal(sent.length, 0, 'no consent, no model call');
  assert.equal(noConsent.email, 'alex.rivera@example.com', 'the local patterns still work');

  const answers = [notes, '', 'y'];
  for (let i = 0; i < 2; i++) answers.push('');
  answers.push('alex@work.example'); // Replaces the email from the document.
  const io = scripted(answers);
  const profile = await runSetup({ ...io, say, provider, outPath: path.join(dir, 'doc.json') });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Columbia University/);
  assert.equal(profile.first_name, 'Alex');
  assert.equal(profile.email, 'alex@work.example');
  assert.equal(profile.grad_term, 'Fall 2027');
  assert.equal(profile.model_context.summary, 'Builds backend systems.');
  assert.deepEqual(profile.model_context.experience, ['Built a replay service.']);
  assert.equal(profile.authorized, undefined, 'a document cannot answer a legal question');
  assert.ok(io.asked.some(q => q.includes('authorized') && !q.includes('[Yes]')));
});

test('the extraction schema has no union types', () => {
  assert.ok(Object.values(EXTRACT_SCHEMA.properties).every(p => typeof p.type === 'string'), 'the Claude API allows 16 at most');
});

test('a model failure does not stop setup', async () => {
  const provider = { name: 'failing', completeJSON: async () => { throw new Error('API down'); } };
  const messages = [];
  const io = scripted([notes, '', 'y', 'Alex', 'Rivera']);
  const profile = await runSetup({ ...io, say: line => messages.push(line), provider, outPath: path.join(dir, 'down.json') });
  assert.equal(profile.email, 'alex.rivera@example.com');
  assert.ok(messages.some(line => line.includes('API down')));
});

test('the skill can have more than one material folder', async () => {
  const folders = ['/material/one', '/material/two with space', ''];
  const ask = async question => {
    if (question.startsWith('First name')) return 'Alex';
    if (question.startsWith('Last name')) return 'Rivera';
    if (question.startsWith('Email')) return 'a@example.com';
    if (question.startsWith('Do you want automatic tailoring')) return 'y';
    if (question.startsWith('Name of your resume skill')) return 'resume-skill';
    if (question.startsWith('Folder:')) return folders.shift();
    return '';
  };
  const out = path.join(dir, 'skill.json');
  const profile = await runSetup({ ask, say, outPath: out });
  assert.deepEqual(profile.resume_library.tailor.material_dirs, ['/material/one', '/material/two with space']);
  folders.push('');
  const again = await runSetup({ ask, say, outPath: out });
  assert.deepEqual(again.resume_library.tailor.material_dirs, ['/material/one', '/material/two with space'], 'a second run keeps the folders');
});

test('a user can skip automatic tailoring and still select resumes', async () => {
  const io = scripted(['', 'Alex', 'Rivera', 'a@example.com']);
  const profile = await runSetup({ ...io, say, outPath: path.join(dir, 'skip.json') });
  assert.equal(profile.resume_library.tailor, undefined);
  assert.equal(profile.resume_library.tailor_policy, undefined);
  assert.ok(io.asked.some(q => q.startsWith('Do you want automatic tailoring')));
  assert.ok(!io.asked.some(q => q.startsWith('Name of your resume skill') || q.startsWith('Which jobs need')), 'no question about a function that the user skipped');
  assert.ok(io.asked.some(q => q.startsWith('Folder of general resumes')));
});

test('a second run keeps saved answers and other values', async () => {
  const out = path.join(dir, 'again2.json');
  fs.writeFileSync(out, JSON.stringify({ first_name: 'Alex', last_name: 'Rivera', email: 'a@example.com', answers: { why: 'Because.' }, eeo: 'decline', school: 'Columbia', school_pick: 'Columbia University', resume_library: { name_tokens: ['Al'], roots: [{ dir: '/resumes/general', kind: 'general' }] } }));
  const profile = await runSetup({ ...scripted([]), say, outPath: out });
  assert.deepEqual(profile.answers, { why: 'Because.' });
  assert.equal(profile.eeo, 'decline');
  assert.equal(profile.school_pick, 'Columbia University');
  assert.deepEqual(profile.resume_library.name_tokens, ['Al']);
  assert.deepEqual(profile.resume_library.roots, [{ dir: '/resumes/general', kind: 'general' }]);
});
