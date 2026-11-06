// Generic rule-based form filler. No model calls. Unknown fields are reported, never guessed.
import path from 'path';
const DECLINE = /decline|prefer not|rather not|choose not|(don.?t|do not) (wish|want)|not to (answer|say|disclose|identify)/i;
const CJK = /[㐀-鿿]/;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const RULES = [
  [/preferred (first )?name|pronoun|emergency|extension/i, null],
  [/signature date|date signed|today.?s date/i, '__today'], [/\bsignature\b|\bsign your\b|typ(e|ing) your (full |legal )?name/i, '__signature'], [/\b(full|legal) name\b/i, '__full_name'],
  [/first name|given name/i, 'first_name'], [/last name|family name|surname/i, 'last_name'],
  [/e-?mail/i, 'email'], [/^country/i, 'country'], [/phone|mobile/i, 'phone'],
  [/location|\bcity\b/i, 'location'], [/linkedin/i, 'linkedin'], [/github/i, 'github'], [/website|portfolio/i, 'website'],
  [/cover letter/i, null], [/resume|\bcv\b/i, 'resume'],
  [/graduation month/i, 'grad_month'], [/graduation year/i, 'grad_year'], [/graduation date/i, 'grad_term'], [/\bgpa\b/i, 'gpa'],
  [/school|university/i, 'school'], [/degree/i, 'degree'], [/discipline|major|field of study/i, 'discipline'],
  [/visa type/i, 'visa_type'], [/sponsor/i, 'sponsorship'], [/authorized|eligible to work/i, 'authorized'],
  [/start date|available to start|earliest .*start/i, 'start_date'], [/how did you (hear|connect)/i, 'referral'], [/worked (for|at|with)|(previously|ever|been) employed (by|at|with)|former employee/i, 'worked_here_before'],
  [/gender|\bsex\b|hispanic|latin[oax]|\brace\b|ethnic|veteran|military|disabilit|sexual|lgbt/i, '__eeo'],
];
// Contact fields use short labels. A long sentence that contains "email" is a question, not an email field.
const SHORT_LABEL_ONLY = new Set(['first_name', 'last_name', 'email', 'phone', 'location', 'linkedin', 'github', 'website']);
const MAX_SHORT_LABEL = 40;
const findRule = label => RULES.find(([re, key]) => re.test(label) && !(SHORT_LABEL_ONLY.has(key) && label.length > MAX_SHORT_LABEL));
// A saved yes or no answers the main question only. The user answers each follow-up question once.
const YES_NO_KEYS = new Set(['authorized', 'sponsorship', 'worked_here_before']);
const FOLLOW_UP = /\bif (yes|so|you|applicable)\b|please (explain|describe|specify|provide|list)|^(what|which|when|where|who|how)\b|\btype of\b|\bdetails?\b/i;
// These checkboxes accept terms. An optional checkbox, such as for email updates, stays empty.
const ATTESTATION = /certify|attest|consent|agree|acknowledge|accept|confirm|understand|terms|privacy|i have read/i;
const todayFor = kind => { const [y, m, d] = new Date().toLocaleDateString('en-CA').split('-'); return kind === 'date' ? `${y}-${m}-${d}` : `${m}/${d}/${y}`; };
const fullName = profile => profile.legal_name ?? [profile.first_name, profile.last_name].filter(Boolean).join(' ');
// A question about undergraduate study gets that GPA. Other questions get the GPA of the current school.
const gpaFor = (label, profile) => (/undergrad|bachelor/i.test(label) && profile.gpa_undergraduate) || profile.gpa;
// The first match wins, because "transgender" also contains "gender".
const EEO_TOPICS = [['orientation', /sexual|orientation|lgbt|transgender/i], ['hispanic', /hispanic|latin[oax]/i], ['race', /\brace\b|ethnic/i], ['gender', /gender|\bsex\b/i], ['veteran', /veteran|military/i], ['disability', /disabilit/i]];
const GENDER_WORDS = { male: 'man', female: 'woman' };

const REGION_ALIASES = { us: 'united states', 'u.s': 'united states', usa: 'united states', 'u.s.a': 'united states', america: 'united states', uk: 'united kingdom', 'u.k': 'united kingdom', hk: 'hong kong', 'hong kong sar': 'hong kong', sg: 'singapore' };
const regionName = text => { const name = String(text).trim().toLowerCase().replace(/\.+$/, ''); return REGION_ALIASES[name] ?? name; };
const WORK_PLACE = /\b(?:work|working|employment|employed)\s+(?:legally\s+|lawfully\s+)?(?:in|within)\s+(?:the\s+)?([A-Z][\p{L}.]*(?:\s+[A-Z][\p{L}.]*)*)/u;
// A legal answer applies only to the regions that the user named. A label with no region name gets the answer.
export function regionAllowed(label, regions) {
  const named = label.match(WORK_PLACE)?.[1];
  return !regions?.length || !named || regions.map(regionName).includes(regionName(named));
}

// The label, the URL, and the page headings name the company. Other page text can name clients or partners.
export function mentionsEmployer(context, url, name) {
  const lower = name.toLowerCase();
  if (CJK.test(name)) return context.includes(name);
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(lower)}($|[^\\p{L}\\p{N}])`, 'iu').test(`${context}\n${url}`)) return true;
  return lower.includes(' ') && url.toLowerCase().includes(lower.replace(/[^\p{L}\p{N}]+/gu, ''));
}
async function workedHere(page, profile, label, company) {
  if (!profile.past_employers?.length) return profile.worked_here_before;
  const headings = await page.evaluate(() => [document.title, ...[...document.querySelectorAll('h1, h2')].slice(0, 3).map(h => h.innerText)].join('\n'));
  const context = [label, company ?? '', headings].join('\n');
  return profile.past_employers.some(name => mentionsEmployer(context, page.url(), name)) ? 'Yes' : 'No';
}

// The agent stores what the user tells it, and uses it again for the same question or a nearly identical one.
export const questionKey = label => label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const NEGATION = /\b(not|no|never|without)\b/;
export function findClarified(store, label) {
  if (!store) return null;
  const key = questionKey(label);
  if (store[key]) return store[key].answer;
  const words = new Set(key.split(' '));
  for (const [other, entry] of Object.entries(store)) {
    const otherWords = new Set(other.split(' '));
    const shared = [...words].filter(word => otherWords.has(word)).length;
    const similar = shared / (words.size + otherWords.size - shared) >= 0.85;
    if (similar && NEGATION.test(key) === NEGATION.test(other)) return entry.answer;
  }
  return null;
}

function eeoFallback(opts, want) {
  if (!want) return null;
  const direct = pickOption(opts, want);
  if (direct) return direct;
  const unique = hits => (hits.length === 1 ? hits[0] : null);
  if (/^no$/i.test(want)) return unique(opts.filter(o => /\b(not|don.?t|do not)\b/i.test(o)));
  const words = [want, GENDER_WORDS[want.toLowerCase()]].filter(Boolean).map(word => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'));
  return unique(opts.filter(o => words.some(word => word.test(o)) && !/trans|non-?binary/i.test(o)));
}
// Returns a function that selects an option. Without a preset value, the user answers.
function eeoChooser(label, profile) {
  if (profile.eeo !== 'decline') return undefined;
  const topic = EEO_TOPICS.find(([, pattern]) => pattern.test(label))?.[0];
  return opts => opts.find(o => DECLINE.test(o)) ?? eeoFallback(opts, profile.eeo_fallback?.[topic]) ?? null;
}
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
function pickOption(opts, want) {
  if (typeof want === 'function') return want(opts);
  for (const w of [].concat(want)) { const hit = opts.filter(o => o.toLowerCase() === String(w).toLowerCase()); if (hit.length === 1) return hit[0]; }
  // "Yes, I am authorized" answers a yes or no question if only one option starts with that word.
  for (const w of [].concat(want)) {
    if (!/^(yes|no)$/i.test(w)) continue;
    const hit = opts.filter(o => new RegExp(`^${w}\\b`, 'i').test(o));
    if (hit.length === 1) return hit[0];
  }
  return null; // exact and unique only: never guess
}
// The value attribute of a radio button is often not its label, so the position selects it.
const checkRadio = (page, field, option) => page.locator(`input[type=radio][name="${field.name}"]`).nth(field.opts.indexOf(option)).check();
const comboMenu = page => page.locator('[role=listbox]:visible [role=option], .select__menu .select__option');
async function fillCombo(page, loc, want, pick) {
  await loc.scrollIntoViewIfNeeded(); await loc.click();
  const menu = () => comboMenu(page);
  const typed = typeof want !== 'function' && (pick || Array.isArray(want) === false);
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
// Lists the options of a combobox. The list is empty if the field loads options only after typing.
export async function comboOptions(page, id) {
  const loc = page.locator(`[data-agent-field="${id}"]`);
  await loc.scrollIntoViewIfNeeded(); await loc.click();
  for (let i = 0; i < 8 && await comboMenu(page).count() === 0; i++) await page.waitForTimeout(100);
  const opts = (await comboMenu(page).allInnerTexts()).map(s => s.replace(/\s+/g, ' ').trim());
  await page.keyboard.press('Escape');
  return opts;
}
// Writes one value that is already validated. Returns the written value, or null if the page did not accept it.
export async function writeField(page, field, value) {
  const loc = page.locator(`[data-agent-field="${field.id}"]`);
  if (field.kind === 'select') { await loc.selectOption({ label: value }); return value; }
  if (field.kind === 'radio') { await checkRadio(page, field, value); return value; }
  if (field.kind === 'combobox') { const r = await fillCombo(page, loc, value); return r.ok ? r.value : null; }
  await loc.fill(value);
  return value;
}
export async function run(page, profile, { resume, seen = new Set(), company } = {}) {
  const report = { total: 0, passes: 0, filled: [], review: [], skipped: [], checks: [], readback_failed: [] };
  // Fields can appear after earlier answers, so scan again until no new field shows up.
  for (let pass = 0; pass < 4; pass++) {
   const fields = (await scan(page)).filter(f => !seen.has(f.kind + '|' + f.label + '|' + f.name));
   if (!fields.length) break;
   report.passes++; report.total += fields.length;
   for (const f of fields) {
    seen.add(f.kind + '|' + f.label + '|' + f.name);
    const loc = page.locator(`[data-agent-field="${f.id}"]`);
    const rule = findRule(f.label);
    const key = rule ? rule[1] : undefined;
    const log = v => { report.filled.push(`${f.label.slice(0, 40)} = ${String(v).slice(0, 40)}`); report.checks.push({ id: f.id, kind: f.kind, label: f.label, value: String(v) }); };
    const review = why => report.review.push({ id: f.id, name: f.name, label: f.label.slice(0, 300), kind: f.kind, required: f.required, why, opts: f.opts });
    // An answer that the user gave for this question comes first.
    const clarified = f.kind === 'file' || f.kind === 'checkbox' ? null : findClarified(profile.clarified, f.label);
    if (clarified !== null && (!f.opts || f.opts.includes(clarified))) {
      const written = await writeField(page, f, clarified);
      if (written !== null) { log(written); continue; }
    }
    if (f.kind === 'textarea') {
      const hit = Object.entries(profile.answers || {}).find(([k]) => f.label.toLowerCase().includes(k));
      if (hit) { await loc.fill(hit[1]); log('(saved answer)'); } else review('needs_llm_or_human');
      continue;
    }
    if (f.kind === 'checkbox') {
      if (profile.auto_submit && f.required && ATTESTATION.test(f.label)) { await loc.check(); log('checked'); } else review('attestation_human_only');
      continue;
    }
    if (f.kind === 'file') {
      if (key === 'resume' && resume) { await loc.setInputFiles(resume); log(path.basename(resume)); }
      else if (key === 'resume') review('upload_disabled'); else report.skipped.push(f.label.slice(0, 40));
      continue;
    }
    if (key === null) { report.skipped.push(f.label.slice(0, 40)); continue; }
    if (key === undefined) { (f.required ? review('no_rule') : report.skipped.push(f.label.slice(0, 40))); continue; }
    const isChoice = ['select', 'radio', 'combobox'].includes(f.kind);
    if (YES_NO_KEYS.has(key) && (!isChoice || FOLLOW_UP.test(f.label))) { review('follow_up'); continue; }
    if (key === 'visa_type' && /need|require|sponsor/i.test(f.label)) { review('follow_up'); continue; }
    if ((key === 'authorized' || key === 'sponsorship') && !regionAllowed(f.label, profile.work_regions)) { review('region_not_configured'); continue; }
    if ((key === '__signature' || key === '__today') && !profile.auto_submit) { review('attestation_human_only'); continue; }
    const want = key === '__eeo' ? eeoChooser(f.label, profile)
      : key === 'worked_here_before' ? await workedHere(page, profile, f.label, company)
      : key === '__signature' || key === '__full_name' ? fullName(profile)
      : key === '__today' ? todayFor(f.kind)
      : key === 'gpa' ? gpaFor(f.label, profile)
      : profile[key];
    if (want === undefined) { review('no_profile_value'); continue; }
    if (f.kind === 'select') {
      const o = pickOption(f.opts, want); if (!o) { review('no_exact_option'); continue; }
      await loc.selectOption({ label: o }); log(o);
    } else if (f.kind === 'radio') {
      const o = pickOption(f.opts, want); if (!o) { review('no_exact_option'); continue; }
      await checkRadio(page, f, o); log(o);
    } else if (f.kind === 'combobox') {
      const r = await fillCombo(page, loc, want, profile[key + '_pick']);
      if (r.ok) log(r.value); else review('combobox_no_match:' + JSON.stringify(r.opts));
    } else if (typeof want === 'function') { review('no_exact_option'); } else { await loc.fill(String(want)); log(want); }
   }
  }
  // Readback is the verdict: a field counts as filled only if the page still shows the value after settling.
  report.readback_failed = await verifyChecks(page, report.checks);
  return report;
}
export async function verifyChecks(page, checks) {
  const failed = [];
  await page.waitForTimeout(150);
  for (const c of checks) {
    if (c.kind === 'file') {
      // Some forms replace the file input after upload, so the page text also counts.
      const attached = await page.evaluate(({ id, name }) => document.querySelector(`[data-agent-field="${id}"]`)?.files?.[0]?.name === name || document.body.innerText.includes(name), { id: c.id, name: c.value });
      if (!attached) failed.push(`${c.label.slice(0, 30)}: file "${c.value}" not attached`);
      continue;
    }
    if (c.kind === 'radio' || c.kind === 'checkbox') continue;
    const got = await page.locator(`[data-agent-field="${c.id}"]`).evaluate(el => {
      const box = el.closest('.select__control, .select'); const single = box?.querySelector('.select__single-value');
      if (el.getAttribute('role') === 'combobox' && single) return single.textContent;
      if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text;
      return el.value; }).catch(() => '(missing)');
    const norm = s => String(s).replace(/\D/g, '');
    const text = String(got ?? '');
    const ok = got === c.value || (c.value.startsWith('(saved') && text) || (norm(c.value) && norm(text) === norm(c.value)) || text.trim() === c.value.split(' +')[0];
    if (!ok) failed.push(`${c.label.slice(0, 30)}: got "${text.slice(0, 30)}"`);
  }
  return failed;
}
