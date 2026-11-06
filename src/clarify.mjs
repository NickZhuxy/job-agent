// Asks the user about the questions that the rules and the model must not answer, such as visa follow-up questions.
// The answer stays in the profile, so the agent does not ask the same question again.
import { comboOptions, questionKey, verifyChecks, writeField } from './engine.mjs';
import { SENSITIVE } from './model.mjs';

const WAITS_FOR_USER = /^(follow_up|region_not_configured|no_rule|no_profile_value|no_exact_option|combobox_no_match|model_no_answer|model_option_not_exact)/;
// The profile does not store these secrets.
const NEVER_SAVED = /password|social security|\bssn\b/i;
const MAX_ROUNDS = 3;

export const needsUser = item =>
  !['file', 'checkbox'].includes(item.kind) && !NEVER_SAVED.test(item.label)
  && (item.why === 'follow_up' || (item.required && (WAITS_FOR_USER.test(item.why) || SENSITIVE.test(item.label))));

async function askOne(item, opts, { ask, say }) {
  say(`\nThe form asks: ${item.label}`);
  if (opts?.length) opts.forEach((option, index) => say(`  ${index + 1}. ${option}`));
  for (;;) {
    const typed = (await ask(opts?.length ? 'Enter a number, or press Enter to answer on the form: ' : 'Enter your answer, or press Enter to answer on the form: ')).trim();
    if (!typed || !opts?.length) return typed;
    const chosen = opts[Number(typed) - 1] ?? opts.find(option => option.toLowerCase() === typed.toLowerCase());
    if (chosen) return chosen;
    say('Enter one of the numbers.');
  }
}

// Changes the report: an answered item moves from review to filled. refill finds the fields that the answers made visible.
export async function clarifyFields(page, profile, report, { ask, say, onSave, refill }) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pending = report.review.filter(needsUser);
    if (!pending.length) break;
    let wrote = false;
    for (const item of pending) {
      const opts = item.kind === 'combobox' ? await comboOptions(page, item.id) : item.opts;
      const answer = await askOne(item, opts, { ask, say });
      if (!answer) { item.why = 'user_skipped'; continue; }
      const written = await writeField(page, item, answer);
      if (written === null) { item.why = 'write_failed'; continue; }
      report.review.splice(report.review.indexOf(item), 1);
      report.filled.push(`${item.label.slice(0, 40)} = ${String(written).slice(0, 40)} (from you)`);
      report.checks.push({ id: item.id, kind: item.kind, label: item.label, value: String(written) });
      profile.clarified = { ...profile.clarified, [questionKey(item.label)]: { question: item.label, answer: written } };
      onSave?.();
      wrote = true;
    }
    if (!wrote) break;
    const next = await refill();
    for (const key of ['filled', 'skipped', 'checks', 'review']) report[key].push(...next[key]);
    report.total += next.total;
    report.passes += next.passes;
    if (report.model && next.model) for (const key of ['calls', 'input_tokens', 'output_tokens']) report.model[key] += next.model[key];
  }
  report.readback_failed = await verifyChecks(page, report.checks);
  return report;
}
