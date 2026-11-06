import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, formatResumeChoice } from '../src/summary.mjs';

const REPORT = {
  total: 4, passes: 1,
  filled: ['First Name = Alex', 'Resume/CV = Alex_Rivera.pdf', 'Discipline = Computer Science (model)', 'Pronouns = They (from you)'],
  review: [], skipped: ['Cover Letter'],
  checks: [{ id: 'f0', kind: 'text', label: 'First Name', value: 'Alex' }],
  readback_failed: [],
  model: { name: 'scripted', calls: 1, input_tokens: 100, output_tokens: 10, errors: [] },
  resume_selection: { path: 'Alex_Rivera.pdf', source: 'tailored', usage: { input_tokens: 20, output_tokens: 5 }, tailor_error: null },
};

test('a submitted form gets a short summary with the items to examine', () => {
  const text = formatReport({ ...REPORT, submission: { submitted: true, url: 'https://example.com/confirmation' } });
  assert.match(text, /^SUBMITTED$/m);
  assert.match(text, /https:\/\/example\.com\/confirmation/);
  assert.match(text, /Resume: +Alex_Rivera\.pdf \(tailored\)/);
  assert.match(text, /Fields: +4 filled, 1 skipped/);
  assert.match(text, /Discipline = Computer Science/);
  assert.match(text, /Pronouns = They/);
  assert.match(text, /Skipped: +Cover Letter/);
  assert.match(text, /2 calls, 120 input tokens, 15 output tokens/);
  assert.ok(!text.includes('{'), 'no JSON');
  assert.ok(!text.includes('f0'), 'no internal field ids');
  assert.ok(!text.includes('First Name'), 'routine fields stay out of the summary');
});

test('each result that is not a submission tells the user what to do', () => {
  const summary = submission => formatReport({ ...REPORT, submission });
  assert.match(formatReport(REPORT), /^FILLED, NOT SUBMITTED/m);
  const blocked = summary({ submitted: false, why: 'form_not_ready', blockers: ['Why this job? (no_rule)', 'Invalid: Country*'] });
  assert.match(blocked, /^NOT SUBMITTED/m);
  assert.match(blocked, /- Why this job\?$/m);
  assert.match(blocked, /- Invalid: Country\*$/m);
  assert.match(summary({ submitted: false, why: 'no_submit_button' }), /Submit the form in Chrome/);
  assert.match(summary({ submitted: false, why: 'needs_user_check' }), /CAPTCHA/);
  assert.match(summary({ submitted: false, why: 'form_errors', errors: ['Phone is invalid'] }), /- Phone is invalid$/m);
  assert.match(summary({ submitted: false, why: 'not_confirmed', clicked: true }), /before you submit again/);
});

test('problems appear, and a required field is listed one time', () => {
  const report = {
    ...REPORT,
    review: [{ label: 'Why this job?', required: true, why: 'no_rule' }, { label: 'Portfolio link', required: false, why: 'no_profile_value' }],
    readback_failed: ['Email: got ""'],
    model: { ...REPORT.model, errors: ['timeout'] },
    resume_selection: { ...REPORT.resume_selection, source: 'model', tailor_error: 'exit code 1' },
  };
  const open = formatReport(report);
  assert.match(open, /- Why this job\? \(required\)$/m);
  assert.match(open, /- Portfolio link$/m);
  assert.match(open, /Email: got ""/);
  assert.match(open, /timeout/);
  assert.match(open, /exit code 1/);
  assert.ok(!open.includes('(tailored)'));

  const blocked = formatReport({ ...report, submission: { submitted: false, why: 'form_not_ready', blockers: ['Why this job? (no_rule)'] } });
  assert.equal(blocked.match(/Why this job/g).length, 1);
  assert.match(blocked, /- Portfolio link$/m);
});

test('a run with no model and no resume selection still has a summary', () => {
  const text = formatReport({ total: 1, passes: 1, filled: ['First Name = Alex'], review: [], skipped: [], checks: [], readback_failed: [] });
  assert.match(text, /^FILLED, NOT SUBMITTED/m);
  assert.match(text, /Fields: +1 filled, 0 skipped/);
  assert.ok(!/Model|Resume|Skipped/.test(text));
});

const CHOICE = {
  candidates: [
    { id: 'tailored', kind: 'tailored', folder: 'Alex_Acme', name: 'Alex_Acme.pdf' },
    { id: 'r1', kind: 'general', folder: 'SWE', name: 'Alex_SWE.pdf' },
    { id: 'r2', kind: 'general', name: 'Alex.pdf' },
  ],
  selected: { id: 'tailored', name: 'Alex_Acme.pdf' },
  reason: 'The job is at a top firm.',
  tailored: { seconds: 340, path: '/resumes/Alex_Acme.pdf', notes: '**What I changed**\n- Moved a bullet.\n\n**Points to examine**\n- Confirm the `city`.' },
  tailorRecommended: true,
  tailorConfigured: true,
};

test('the resume choice shows the recommendation first, and notes have no markdown marks', () => {
  const text = formatResumeChoice(CHOICE);
  assert.ok(text.indexOf('Recommended') < text.indexOf('Other resumes'));
  assert.match(text, /Recommended: +Alex_Acme\.pdf/);
  assert.match(text, /File: +\/resumes\/Alex_Acme\.pdf/);
  assert.match(text, /Made in 340 seconds/);
  assert.match(text, /^ {2}What I changed$/m);
  assert.match(text, /^ {2}- Confirm the city\.$/m);
  assert.ok(!/\*\*|`/.test(text));
  assert.match(text, /r1 +SWE \/ Alex_SWE\.pdf/);
  assert.match(text, /r2 +Alex\.pdf/);
  assert.equal(text.match(/Alex_Acme\.pdf/g).length, 2, 'the recommendation is not listed again');
});

test('the resume choice reports a tailoring failure and a missing skill', () => {
  const failed = formatResumeChoice({ candidates: CHOICE.candidates.slice(1), selected: { id: 'r1', name: 'Alex_SWE.pdf' }, tailorError: 'exit code 1', tailorRecommended: true, tailorConfigured: true });
  assert.match(failed, /Tailoring failed\. exit code 1/);
  const missing = formatResumeChoice({ candidates: CHOICE.candidates.slice(1), selected: null, tailorRecommended: true, tailorConfigured: false });
  assert.match(missing, /may need a tailored resume/);
  assert.ok(!/Recommended/.test(missing));
  assert.match(missing, /^Resumes$/m);
});
