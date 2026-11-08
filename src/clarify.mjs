// Asks the user about the questions that the rules and the model must not answer, such as visa follow-up questions.
// The answer stays in the profile, so the agent does not ask the same question again.
import { comboOptions, questionKey, verifyChecks, writeField } from './engine.mjs';
import { SENSITIVE } from './model.mjs';

const WAITS_FOR_USER = /^(follow_up|region_not_configured|no_rule|no_profile_value|no_exact_option|combobox_no_match|model_no_answer|model_option_not_exact|source_no_match|undergraduate_no_match)/;
// The profile does not store these secrets.
export const NEVER_SAVED = /password|social security|\bssn\b/i;
const MAX_ROUNDS = 3;
// A question for one answer to an earlier question. The form can show it when it does not apply.
const CONDITIONAL = /\bif\b.*\b(yes|so|other|above|selected|applicable)\b|please (specify|explain)/i;

export const needsUser = item =>
  !['file', 'checkbox'].includes(item.kind) && !NEVER_SAVED.test(item.label)
  && (item.why === 'follow_up' || (item.required && (WAITS_FOR_USER.test(item.why) || SENSITIVE.test(item.label))));

// An optional question can help the application, but only the user knows the answer.
export const asksOptional = item =>
  !['file', 'checkbox'].includes(item.kind) && !SENSITIVE.test(item.label) && !NEVER_SAVED.test(item.label) && !CONDITIONAL.test(item.label);

async function askOne(item, opts, { ask, say, skipHint = 'press Enter' }) {
  say(`\nThe form asks${item.why === 'optional' ? ' (optional)' : ''}: ${item.label}`);
  if (opts?.length) opts.forEach((option, index) => say(`  ${index + 1}. ${option}`));
  else say('The agent enters your text in the form exactly as you type it, and keeps it for similar questions.');
  const many = item.kind === 'checkboxes';
  for (;;) {
    const how = many ? 'Enter one or more numbers with commas between them' : opts?.length ? 'Enter a number' : 'Enter your answer';
    const typed = (await ask(`${how}, or ${skipHint} to answer on the form: `)).trim();
    if (!typed || !opts?.length) return typed;
    if (many) {
      const picks = typed.split(/[,，\s]+/).filter(Boolean).map(number => opts[Number(number) - 1]);
      if (picks.every(Boolean)) return picks;
      say('Enter numbers from the list.');
      continue;
    }
    const chosen = opts[Number(typed) - 1] ?? opts.find(option => option.toLowerCase() === typed.toLowerCase());
    if (chosen) return chosen;
    say('Enter one of the numbers.');
  }
}

// Changes the report: an answered item moves from review to filled. refill finds the fields that the answers made visible.
export async function clarifyFields(page, profile, report, { ask, say, onSave, refill, skipHint }) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pending = [...report.review.filter(needsUser), ...(report.optional ?? []).splice(0).filter(asksOptional)];
    if (!pending.length) break;
    let wrote = false;
    for (const item of pending) {
      const opts = item.kind === 'combobox' ? await comboOptions(page, item.id) : item.opts;
      const answer = await askOne(item, opts, { ask, say, skipHint });
      // An optional question stays in the skipped list. It does not stop the submission.
      const optional = item.why === 'optional';
      if (!answer) { if (!optional) item.why = 'user_skipped'; continue; }
      const written = await writeField(page, item, answer);
      if (written === null) { if (!optional) item.why = 'write_failed'; continue; }
      if (optional) report.skipped.splice(report.skipped.indexOf(item.label.slice(0, 40)), 1);
      else report.review.splice(report.review.indexOf(item), 1);
      report.filled.push(`${item.label.slice(0, 70)} = ${String(written).slice(0, 40)} (from you)`);
      report.checks.push({ id: item.id, kind: item.kind, label: item.label, value: String(written) });
      profile.clarified = { ...profile.clarified, [questionKey(item.label)]: { question: item.label, answer: written } };
      onSave?.();
      wrote = true;
    }
    if (!wrote) break;
    const next = await refill();
    for (const key of ['filled', 'skipped', 'checks', 'review']) report[key].push(...next[key]);
    (report.optional ??= []).push(...(next.optional ?? []));
    report.total += next.total;
    report.passes += next.passes;
    if (report.model && next.model) for (const key of ['calls', 'input_tokens', 'output_tokens']) report.model[key] += next.model[key];
  }
  report.readback_failed = await verifyChecks(page, report.checks);
  return report;
}
