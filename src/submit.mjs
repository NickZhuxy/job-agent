// Submits a filled form, if the report shows no open problem. The agent clicks the button one time only.
// A CAPTCHA or a verification code stays with the user.
const CONFIRMED = /thank you for (applying|your application)|application (has been |was )?(received|submitted)|successfully (submitted|applied)|(we.?ve|we have) received your application/i;
const CHALLENGE_FRAMES = 'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], iframe[title*="challenge" i]';
const CODE_REQUEST = /(verification|security|confirmation) code/i;
const ERROR_WAIT_MS = 5000, USER_WAIT_MS = 600000, POLL_MS = 500;

// Lists the reasons not to submit. An empty list means that the form is ready.
export async function submitBlockers(page, report) {
  const blockers = report.review.filter(item => item.required).map(item => `${item.label.slice(0, 60)} (${item.why})`);
  for (const failed of report.readback_failed ?? []) blockers.push(`Readback: ${failed}`);
  const invalid = await page.evaluate(() => [...document.querySelectorAll('form :invalid')]
    .filter(el => el.tagName !== 'FORM' && el.tagName !== 'FIELDSET' && el.getClientRects().length)
    .map(el => {
      if (el.labels?.[0]) return el.labels[0].innerText.trim();
      if (el.name || el.id) return el.name || el.id;
      // A custom dropdown can keep a hidden required input with no label of its own.
      for (let node = el.parentElement; node && node.tagName !== 'FORM'; node = node.parentElement) {
        const label = node.querySelector('label');
        if (label) return label.innerText.trim();
      }
      return 'unnamed field';
    }));
  const plain = text => text.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const listed = new Set(report.review.filter(item => item.required).map(item => plain(item.label)));
  for (const name of invalid) if (!listed.has(plain(name))) blockers.push(`Invalid: ${name.slice(0, 60)}`);
  return blockers;
}

async function findSubmitButton(page) {
  const buttons = page.locator('form button, form input[type=submit]');
  const found = [];
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    if (!await button.isVisible()) continue;
    const info = await button.evaluate(el => ({ type: el.getAttribute('type'), text: (el.innerText || el.value || '').trim() }));
    found.push({ button, ...info });
  }
  const named = found.filter(b => /submit|send application|^apply\b/i.test(b.text));
  if (named.length) return named[named.length - 1].button;
  const typed = found.filter(b => b.type === 'submit');
  return typed.length === 1 ? typed[0].button : null;
}

const challengeVisible = async page => {
  const frames = page.locator(CHALLENGE_FRAMES);
  for (let i = 0; i < await frames.count(); i++) {
    const box = await frames.nth(i).boundingBox();
    if (box && box.width > 100 && box.height > 100 && await frames.nth(i).isVisible()) return true;
  }
  return false;
};

export async function submitApplication(page, report, { say = () => {}, canWait = true, userWaitMs = USER_WAIT_MS } = {}) {
  const blockers = await submitBlockers(page, report);
  if (blockers.length) return { submitted: false, why: 'form_not_ready', blockers };
  const button = await findSubmitButton(page);
  if (!button) return { submitted: false, why: 'no_submit_button' };

  const startUrl = page.url();
  await button.click();
  const started = Date.now();
  let told = false;
  while (Date.now() - started < (told ? userWaitMs : ERROR_WAIT_MS)) {
    await page.waitForTimeout(POLL_MS);
    const text = await page.locator('body').innerText().catch(() => '');
    // Job text can also thank the reader, so the page must also change.
    const formGone = page.url() !== startUrl || !await button.isVisible().catch(() => false);
    if (CONFIRMED.test(text) && formGone) return { submitted: true, url: page.url() };
    if (await challengeVisible(page) || CODE_REQUEST.test(text)) {
      if (!canWait) return { submitted: false, why: 'needs_user_check' };
      if (!told) say('The page asks for a CAPTCHA or a verification code. Complete it in Chrome. The agent waits.');
      told = true;
      continue;
    }
    const errors = await page.evaluate(() => [...document.querySelectorAll('[aria-invalid="true"], .error, .field-error, [role=alert]')]
      .filter(el => el.getClientRects().length).map(el => (el.innerText || el.name || el.id || '').trim()).filter(Boolean).slice(0, 5));
    if (errors.length && Date.now() - started >= ERROR_WAIT_MS - POLL_MS) return { submitted: false, why: 'form_errors', errors };
  }
  return { submitted: false, why: 'not_confirmed', clicked: true };
}
