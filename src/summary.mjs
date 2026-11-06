// Text for the terminal. The full report is available with --json.
const RESULTS = {
  form_not_ready: 'NOT SUBMITTED. Complete these fields in Chrome, then submit the form:',
  no_submit_button: 'NOT SUBMITTED. The agent did not find one submit button. Submit the form in Chrome.',
  needs_user_check: 'CLICKED SUBMIT. The page asks for a CAPTCHA or a code, and in headless mode the agent cannot wait for you.',
  form_errors: 'CLICKED SUBMIT, AND THE PAGE SHOWS ERRORS. The agent did not click again:',
  not_confirmed: 'CLICKED SUBMIT, AND NO CONFIRMATION APPEARED. Examine the page in Chrome before you submit again.',
};
const list = items => items.map(item => `  - ${item}`);

function resultLines(submission) {
  if (!submission) return ['FILLED, NOT SUBMITTED. Examine the form in Chrome.'];
  if (submission.submitted) return ['SUBMITTED', submission.url];
  const details = (submission.blockers ?? submission.errors ?? []).map(item => item.replace(/ \(\w+\)$/, ''));
  return [RESULTS[submission.why] ?? `NOT SUBMITTED. ${submission.why}`, ...list(details)];
}

export function formatReport(report) {
  const { submission, resume_selection: selection, model } = report;
  const lines = [...resultLines(submission), ''];

  if (selection) {
    lines.push(`Resume:  ${selection.path ?? 'none'}${selection.source === 'tailored' ? ' (tailored)' : ''}`);
    if (selection.tailor_error) lines.push(`Tailoring failed: ${selection.tailor_error}`);
  }
  lines.push(`Fields:  ${report.filled.length} filled, ${report.skipped.length} skipped`);
  if (report.skipped.length) lines.push(`Skipped: ${report.skipped.join(', ')}`);
  if (report.application_log?.file) lines.push(`For Simplify: added to ${report.application_log.file}`);
  if (report.application_log?.error) lines.push(`For Simplify: not added to the file. ${report.application_log.error}`);

  const toExamine = report.filled.filter(item => /\((model|from you)\)$/.test(item));
  if (toExamine.length) lines.push('', 'Examine these answers:', ...list(toExamine));

  // The result lines already list the required fields that stop a submission.
  const notFilled = report.review.filter(item => !(submission?.blockers && item.required));
  if (notFilled.length) lines.push('', 'Not filled:', ...list(notFilled.map(item => `${item.label.slice(0, 70)}${item.required ? ' (required)' : ''}`)));
  if (report.readback_failed?.length) lines.push('', 'Values that did not stay in the form:', ...list(report.readback_failed));
  if (model?.errors?.length) lines.push('', 'Model errors:', ...list(model.errors));

  const usage = [model, selection?.usage].filter(Boolean);
  if (usage.length) {
    const calls = (model?.calls ?? 0) + (selection?.usage ? 1 : 0);
    const total = key => usage.reduce((sum, item) => sum + (item[key] ?? 0), 0);
    lines.push('', `Model use: ${calls} calls, ${total('input_tokens')} input tokens, ${total('output_tokens')} output tokens`);
  }
  return lines.join('\n');
}

const plainNotes = notes => notes.replace(/\*\*|`/g, '').split('\n').map(line => (line.trim() ? `  ${line.trim()}` : ''));
const resumeLine = c => `  ${c.id.padEnd(4)} ${c.folder ? `${c.folder} / ` : ''}${c.name}`;

export function formatResumeChoice({ candidates, selected, reason, tailored, tailorError, tailorRecommended, tailorConfigured }) {
  const lines = [];
  if (selected) lines.push(`Recommended: ${selected.name}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (tailorError) lines.push(`Tailoring failed. ${tailorError}`);
  if (tailorRecommended && !tailorConfigured) lines.push('This job may need a tailored resume. Run setup to add a resume skill, or enter the path of a tailored resume.');
  if (tailored) lines.push(`File: ${tailored.path}`, `Made in ${tailored.seconds} seconds. Examine it before you accept it.`, '', 'Notes:', ...plainNotes(tailored.notes ?? ''));
  const others = candidates.filter(c => c.id !== selected?.id);
  if (others.length) lines.push('', selected ? 'Other resumes:' : 'Resumes', ...others.map(resumeLine));
  return lines.join('\n');
}
