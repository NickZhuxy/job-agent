import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeJob, recordApplication } from '../src/applications.mjs';
import { formatReport } from '../src/summary.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-applications-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const fresh = () => path.join(fs.mkdtempSync(path.join(root, 'run-')), 'applications.local.csv');
const JOB = { company: 'Globex', role: 'Data Engineer', url: 'https://example.com/jobs/1', resume: 'Alex_Rivera.pdf', date: '2026-11-06' };

test('the first application makes the file with a header, and later applications add one row each', () => {
  const file = fresh();
  recordApplication(file, JOB);
  recordApplication(file, { ...JOB, company: 'Initech', url: 'https://example.com/jobs/2' });
  assert.deepEqual(fs.readFileSync(file, 'utf8').trimEnd().split('\n'), [
    'Company,Position Title,Status,Posting Link,Notes',
    'Globex,Data Engineer,Applied,https://example.com/jobs/1,Applied 2026-11-06. Resume: Alex_Rivera.pdf',
    'Initech,Data Engineer,Applied,https://example.com/jobs/2,Applied 2026-11-06. Resume: Alex_Rivera.pdf',
  ]);
});

test('only the user can read the file', () => {
  const file = fresh();
  recordApplication(file, JOB);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('commas, quotes, line breaks, and non-Latin names stay in one correct cell', () => {
  const file = fresh();
  recordApplication(file, { ...JOB, company: 'Acme, "Global"\nInc', role: '量化研究实习生' });
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n').split(',量化')[0], '"Acme, ""Global""\nInc"');
  assert.match(fs.readFileSync(file, 'utf8'), /,量化研究实习生,Applied,/);
});

test('text from a job page cannot run as a spreadsheet formula', () => {
  const file = fresh();
  recordApplication(file, { ...JOB, company: '=HYPERLINK("https://example.com")', role: '+1' });
  const row = fs.readFileSync(file, 'utf8').split('\n')[1];
  assert.ok(row.startsWith(`"'=HYPERLINK(""https://example.com"")",'+1,`));
});

test('the job name comes from the model, and a page heading that contains it is more exact', () => {
  const selection = { company: 'Globex', role: 'Data Engineer' };
  assert.deepEqual(describeJob({ title: 'x', heading: 'Data Engineer - Hong Kong 2027' }, selection), { company: 'Globex', role: 'Data Engineer - Hong Kong 2027' });
  assert.deepEqual(describeJob({ title: 'x', heading: 'Apply for this job' }, selection), { company: 'Globex', role: 'Data Engineer' });
});

test('with no model, the job name comes from the page, and an unknown company stays empty', () => {
  assert.deepEqual(describeJob({ title: 'Job Application for Data Engineer at Globex', heading: 'Data Engineer' }, null), { company: 'Globex', role: 'Data Engineer' });
  assert.deepEqual(describeJob({ title: 'Careers', heading: undefined }, null), { company: '', role: '' });
});

test('the summary tells where the record is, and a failed record does not hide the result', () => {
  const report = { filled: [], review: [], skipped: [], readback_failed: [], submission: { submitted: true, url: 'https://example.com/done' } };
  assert.match(formatReport({ ...report, application_log: { file: 'applications.local.csv' } }), /For Simplify: +added to applications\.local\.csv/);
  const failed = formatReport({ ...report, application_log: { error: 'disk full' } });
  assert.match(failed, /^SUBMITTED$/m);
  assert.match(failed, /not added.*disk full/);
});
