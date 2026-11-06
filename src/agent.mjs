// Rules fill first. The model handles the remaining eligible fields. New fields start another round.
import { run, comboOptions, writeField, verifyChecks } from './engine.mjs';
import { askModel, isEligible, validateAnswers } from './model.mjs';

const MAX_ROUNDS = 3, MAX_REVISIONS = 3, JOB_TEXT_CHARS = 6000;
const TEXT_KINDS = new Set(['text', 'textarea', 'email', 'tel', 'url', 'date', 'number']);

export async function fillWithModel(page, profile, { resume, provider, confirm, onApproved, seen = new Set(), company } = {}) {
  const report = { total: 0, passes: 0, filled: [], review: [], skipped: [], checks: [], readback_failed: [], model: { name: provider.name, calls: 0, input_tokens: 0, output_tokens: 0, errors: [] } };
  const addUsage = usage => { report.model.calls++; report.model.input_tokens += usage?.input_tokens ?? 0; report.model.output_tokens += usage?.output_tokens ?? 0; };
  const hold = (item, why, value) => report.review.push({ ...item, why, ...(value ? { value } : {}) });
  const write = async (item, value) => {
    const written = await writeField(page, item, value);
    if (written === null) { hold(item, 'write_failed', value); return false; }
    report.filled.push(`${item.label.slice(0, 40)} = ${written.slice(0, 40)} (model)`);
    report.checks.push({ id: item.id, kind: item.kind, label: item.label, value: written });
    return true;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const rules = await run(page, profile, { resume, seen, company });
    for (const key of ['filled', 'skipped', 'checks']) report[key].push(...rules[key]);
    report.total += rules.total; report.passes += rules.passes;

    const items = [];
    for (const item of rules.review) {
      if (!isEligible(item)) { report.review.push(item); continue; }
      if (item.kind === 'combobox') {
        item.opts = await comboOptions(page, item.id);
        if (!item.opts.length) { hold(item, 'combobox_needs_search'); continue; }
      } else if (!item.opts?.length && !TEXT_KINDS.has(item.kind)) { report.review.push(item); continue; }
      items.push(item);
    }
    if (!items.length) break;

    const jobText = (await page.locator('body').innerText()).slice(0, JOB_TEXT_CHARS);
    let result;
    try {
      const { answers, usage } = await askModel(provider, items, profile.model_context, jobText);
      addUsage(usage);
      result = validateAnswers(items, answers);
    } catch (error) {
      report.model.errors.push(error.message);
      for (const item of items) hold(item, 'model_error');
      break;
    }

    let wrote = false;
    for (const { item, why, value } of result.rejected) hold(item, why, value);
    for (const { item, value } of result.choices) wrote = (await write(item, value)) || wrote;
    for (const { item, value } of result.drafts) {
      if (!confirm) { hold(item, 'needs_confirmation', value); continue; }
      let draft = value, approved = null;
      for (let i = 0; i < MAX_REVISIONS && approved === null; i++) {
        const decision = await confirm(item, draft);
        if (decision.action === 'accept') approved = draft;
        else if (decision.action === 'edit') approved = decision.text;
        else if (decision.action === 'revise') {
          try {
            const { answers, usage } = await askModel(provider, [item], profile.model_context, jobText, { draft, feedback: decision.feedback });
            addUsage(usage);
            const next = validateAnswers([item], answers).drafts[0];
            if (next) draft = next.value;
          } catch (error) { report.model.errors.push(error.message); break; }
        } else break;
      }
      if (approved === null) { hold(item, 'user_skipped', draft); continue; }
      if (await write(item, approved)) { wrote = true; await onApproved?.(item, approved); }
    }
    if (!wrote) break;
  }
  report.readback_failed = await verifyChecks(page, report.checks);
  return report;
}
