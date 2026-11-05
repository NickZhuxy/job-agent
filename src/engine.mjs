// Generic rule-based form filler. No model calls. Unknown fields are reported, never guessed.
const DECLINE = /decline|don.?t wish|do not wish|prefer not/i;
export const RULES = [
  [/preferred (first )?name|pronoun|emergency|extension/i, null],
  [/first name|given name/i, 'first_name'], [/last name|family name|surname/i, 'last_name'],
  [/e-?mail/i, 'email'], [/^country/i, 'country'], [/phone|mobile/i, 'phone'],
  [/location|\bcity\b/i, 'location'], [/linkedin/i, 'linkedin'], [/github/i, 'github'], [/website|portfolio/i, 'website'],
  [/cover letter/i, null], [/resume|\bcv\b/i, 'resume'],
  [/graduation month/i, 'grad_month'], [/graduation year/i, 'grad_year'], [/graduation date/i, 'grad_term'], [/\bgpa\b/i, 'gpa'],
  [/school|university/i, 'school'], [/degree/i, 'degree'], [/discipline|major|field of study/i, 'discipline'],
  [/visa type/i, 'visa_type'], [/sponsor/i, 'sponsorship'], [/authorized|eligible to work/i, 'authorized'],
  [/start date/i, 'start_date'], [/how did you (hear|connect)/i, 'referral'], [/(ever )?worked (for|at)/i, 'worked_here_before'],
  [/gender|hispanic|latino|race|ethnic|veteran|disability/i, '__decline'],
];
export async function scan(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
    const labelOf = el => {
      if (el.labels && el.labels[0]) { const t = clean(el.labels[0].innerText); if (t) return t; }
      const by = el.getAttribute('aria-labelledby');
      if (by) { const t = clean(by.split(' ').map(i => document.getElementById(i)?.innerText || '').join(' ')); if (t) return t; }
      return clean(el.getAttribute('aria-label') || el.placeholder || el.name);
    };
    const out = [];
    window.__agentFieldCount ??= 0; // Keep ids stable across scans so that readback finds the same element.
    const els = document.querySelectorAll('form input, form select, form textarea');
    const seenRadio = new Set();
    for (const el of els) {
      if (['hidden', 'submit', 'button', 'search'].includes(el.type)) continue;
      if (el.closest('[hidden]') || el.closest('.iti__country-list, [role=dialog]')) continue;
      if (el.getAttribute('aria-hidden') === 'true' || el.tabIndex === -1 && el.type !== 'file' && el.getAttribute('role') !== 'combobox') continue;
      const id = el.getAttribute('data-agent-field') || 'f' + window.__agentFieldCount++; el.setAttribute('data-agent-field', id);
      const role = el.getAttribute('role');
      let kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : role === 'combobox' ? 'combobox' : el.type;
      let label = labelOf(el), opts = null;
      if (kind === 'file') { const g = el.closest('[role=group],fieldset,.file-upload'); const t = clean((g?.innerText || '').split('\n')[0]); if (t) label = t; }
      if (kind === 'radio') {
        if (seenRadio.has(el.name)) continue; seenRadio.add(el.name);
        label = clean(el.closest('fieldset')?.querySelector('legend')?.innerText || label);
        opts = [...document.querySelectorAll(`input[type=radio][name="${el.name}"]`)].map(r => clean(r.labels?.[0]?.innerText));
      }
      if (kind === 'select') opts = [...el.options].map(o => clean(o.text)).filter(t => t && !/^select/i.test(t));
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(el.labels?.[0]?.innerText || '');
      out.push({ id, kind, label, opts, required, name: el.name });
    }
    return out;
  });
}
const pickOption = (opts, want, label) => {
  if (want === '__decline') return opts.find(o => DECLINE.test(o));
  for (const w of [].concat(want)) { const hit = opts.filter(o => o.toLowerCase() === String(w).toLowerCase()); if (hit.length === 1) return hit[0]; }
  return null; // exact and unique only: never guess
};
async function fillCombo(page, loc, want, pick) {
  await loc.scrollIntoViewIfNeeded(); await loc.click();
  const menu = () => page.locator('[role=listbox]:visible [role=option], .select__menu .select__option');
  const typed = want !== '__decline' && (pick || Array.isArray(want) === false);
  if (typed) await loc.pressSequentially(String(pick ? want : want), { delay: 5 });
  await page.waitForTimeout(typed ? 450 : 120);
  for (let i = 0; i < 12 && await menu().count() === 0; i++) await page.waitForTimeout(150);
  const opts = (await menu().allInnerTexts()).map(s => s.replace(/\s+/g, ' ').trim());
  const target = pick ? opts.findIndex(o => o.startsWith(pick)) : opts.findIndex(o => o === pickOption(opts, want));
  if (target < 0) { await page.keyboard.press('Escape'); return { ok: false, opts: opts.slice(0, 12) }; }
  const value = opts[target];
  await menu().nth(target).click();
  await page.waitForTimeout(40);
  return { ok: true, value };
}
export async function run(page, profile, { resume } = {}) {
  const report = { total: 0, passes: 0, filled: [], review: [], skipped: [], checks: [], readback_failed: [] }, seen = new Set();
  // Fields can appear after earlier answers, so scan again until no new field shows up.
  for (let pass = 0; pass < 4; pass++) {
   const fields = (await scan(page)).filter(f => !seen.has(f.kind + '|' + f.label + '|' + f.name));
   if (!fields.length) break;
   report.passes++; report.total += fields.length;
   for (const f of fields) {
    seen.add(f.kind + '|' + f.label + '|' + f.name);
    const loc = page.locator(`[data-agent-field="${f.id}"]`);
    const rule = RULES.find(([re]) => re.test(f.label));
    const key = rule ? rule[1] : undefined;
    const log = v => { report.filled.push(`${f.label.slice(0, 40)} = ${String(v).slice(0, 40)}`); report.checks.push({ id: f.id, kind: f.kind, label: f.label, value: String(v) }); };
    const review = why => report.review.push({ label: f.label.slice(0, 80), kind: f.kind, required: f.required, why, opts: f.opts?.slice(0, 8) });
    if (f.kind === 'textarea') {
      const hit = Object.entries(profile.answers || {}).find(([k]) => f.label.toLowerCase().includes(k));
      if (hit) { await loc.fill(hit[1]); log('(saved answer)'); } else review('needs_llm_or_human');
      continue;
    }
    if (f.kind === 'checkbox') { review('attestation_human_only'); continue; }
    if (f.kind === 'file') {
      if (key === 'resume' && resume) { await loc.setInputFiles(resume); log('uploaded'); }
      else if (key === 'resume') review('upload_disabled'); else report.skipped.push(f.label.slice(0, 40));
      continue;
    }
    if (key === null) { report.skipped.push(f.label.slice(0, 40)); continue; }
    if (key === undefined) { (f.required ? review('no_rule') : report.skipped.push(f.label.slice(0, 40))); continue; }
    // EEO answers come only from the profile. Without a preset value, the user answers.
    const want = key === '__decline' ? (profile.eeo === 'decline' ? '__decline' : undefined) : profile[key];
    if (want === undefined) { review('no_profile_value'); continue; }
    if (f.kind === 'select') {
      const o = pickOption(f.opts, want); if (!o) { review('no_exact_option'); continue; }
      await loc.selectOption({ label: o }); log(o);
    } else if (f.kind === 'radio') {
      const o = pickOption(f.opts, want); if (!o) { review('no_exact_option'); continue; }
      await page.locator(`input[type=radio][name="${f.name}"][value="${o}"]`).check(); log(o);
    } else if (f.kind === 'combobox') {
      const r = await fillCombo(page, loc, want, profile[key + '_pick']);
      if (r.ok) log(r.value); else review('combobox_no_match:' + JSON.stringify(r.opts));
    } else { await loc.fill(String(want)); log(want); }
   }
  }
  // Readback is the verdict: a field counts as filled only if the page still shows the value after settling.
  await page.waitForTimeout(150);
  for (const c of report.checks) {
    if (c.kind === 'file' || c.kind === 'radio' || c.kind === 'checkbox') continue;
    const got = await page.locator(`[data-agent-field="${c.id}"]`).evaluate(el => {
      const box = el.closest('.select__control, .select'); const single = box?.querySelector('.select__single-value');
      if (el.getAttribute('role') === 'combobox' && single) return single.textContent;
      if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text;
      return el.value; }).catch(() => '(missing)');
    const norm = s => String(s).replace(/\D/g, '');
    const ok = got === c.value || (c.value.startsWith('(saved') && got) || (norm(c.value) && norm(got) === norm(c.value)) || got.trim() === c.value.split(' +')[0];
    if (!ok) report.readback_failed.push(`${c.label.slice(0, 30)}: got "${String(got).slice(0, 30)}"`);
  }
  return report;
}
