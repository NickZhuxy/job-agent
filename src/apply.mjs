// One application, from the job page to the report. The caller supplies the user interface in io:
// ask(question) returns the reply, say(text) shows text. attach(file), release(), and skipHint are optional.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { APPLICATIONS_FILE, describeJob, recordApplication } from './applications.mjs';
import { run } from './engine.mjs';
import { fillWithModel } from './agent.mjs';
import { clarifyFields } from './clarify.mjs';
import { chooseResume } from './resume.mjs';
import { acceptAutomatically } from './resume-check.mjs';
import { submitApplication } from './submit.mjs';
import { formatResumeChoice } from './summary.mjs';

export const STAGE_SUBMITTING = 'Submitting';

// Returns { report, browser }. The caller decides when the browser closes, because the form can stay open for review.
// A cancel through signal is possible until the stage changes to STAGE_SUBMITTING.
export async function applyToJob({ url, profilePath, resume, provider = null, noSubmit = false, headless = false, canWait = !headless, applicationsFile = APPLICATIONS_FILE, io, signal, onStage }) {
  const { ask, say } = io;
  const stage = name => { signal?.throwIfAborted(); onStage?.(name); };

  async function confirm(item, draft) {
    say(`\nQuestion: ${item.label}\nDraft: ${draft}`);
    for (;;) {
      const choice = (await ask('[a]ccept, [e]dit, [r]evise, or [s]kip? ')).trim().toLowerCase();
      if (choice === 'a') return { action: 'accept' };
      if (choice === 'e') return { action: 'edit', text: await ask('Your text: ') };
      if (choice === 'r') return { action: 'revise', feedback: await ask('Your feedback: ') };
      if (!choice || choice === 's') return { action: 'skip' };
      say('Enter a, e, r, or s.');
    }
  }
  async function confirmResume(choice) {
    const { candidates, selected, tailored, tailorError } = choice;
    say(`\n${formatResumeChoice(choice)}\n`);
    // The job needs a tailored resume, and the recommendation is only the nearest other resume: the user decides.
    if (tailorError) say('Tailoring failed, so the agent does not accept a resume by itself.');
    else if (selected && await acceptAutomatically(selected.path, profile.resume_library, provider, say)) return { action: 'accept' };
    if (tailored) io.attach?.(tailored.path);
    for (;;) {
      const answer = (await ask(`Enter ${selected ? 'a to accept the recommendation, ' : ''}a resume id, p for a path, or s for no resume: `)).trim().toLowerCase();
      if (answer === 'a' && selected) return { action: 'accept' };
      if (candidates.some(c => c.id === answer)) return { action: 'choose', id: answer };
      if (!answer || answer === 's') return { action: 'skip' };
      if (answer === 'p') {
        const file = (await ask('Resume path: ')).trim();
        if (fs.existsSync(file)) return { action: 'path', path: file };
        say('That file does not exist.');
      } else say('Enter one of the listed choices.');
    }
  }

  stage('Opening the page');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const browser = await chromium.launch({ channel: 'chrome', headless });
  // Each step that uses the page stops when the browser closes.
  const stopBrowser = () => browser.close().catch(() => {});
  signal?.addEventListener('abort', stopBrowser, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    // Approved answers go back to the answer library. The example profile stays unchanged.
    const saveProfile = () => {
      if (!profilePath.startsWith('examples/')) fs.writeFileSync(profilePath, JSON.stringify(profile, null, 1));
    };
    const saveAnswer = (item, text) => {
      profile.answers = { ...profile.answers, [item.label.toLowerCase()]: text };
      saveProfile();
    };

    stage('Selecting a resume');
    const selection = resume ? null : await chooseResume(page, profile, {
      provider,
      confirmResume,
      signal,
      onTailor: ({ company, role }) => say(`\nThis job needs a tailored resume (${company ?? 'company'}, ${role ?? 'role'}). Tailoring starts now. It can take several minutes.`),
    });
    const resumePath = resume ?? selection?.path ?? undefined;
    const seen = new Set();
    const company = selection?.company;
    const fillRound = () => (provider
      ? fillWithModel(page, profile, { resume: resumePath, provider, confirm, onApproved: saveAnswer, seen, company })
      : run(page, profile, { resume: resumePath, seen, company }));
    stage('Filling the form');
    const report = await fillRound();
    stage('Asking about new questions');
    await clarifyFields(page, profile, report, { ask, say, onSave: saveProfile, refill: fillRound, skipHint: io.skipHint });
    if (selection) report.resume_selection = { ...selection, path: selection.path && path.basename(selection.path) };
    io.release?.();
    if (profile.auto_submit && !noSubmit) {
      // The page changes after the submission, so the job name is read first.
      const job = describeJob(await page.evaluate(() => ({ title: document.title, heading: document.querySelector('h1')?.innerText?.trim() })), selection);
      stage(STAGE_SUBMITTING);
      report.submission = await submitApplication(page, report, { say, canWait, profile, resume: resumePath });
      if (report.submission.submitted) report.application_log = recordApplication(applicationsFile, { ...job, url, resume: resumePath && path.basename(resumePath) });
    }
    return { report, browser };
  } catch (error) {
    await stopBrowser();
    throw error;
  } finally {
    signal?.removeEventListener('abort', stopBrowser);
  }
}
