// All data is fictional. The Discord objects are fakes, the forms are local, and no test contacts Discord.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { STAGE_SUBMITTING } from '../src/apply.mjs';
import { commandData, createClient, createRemote, jobRunner, loadConfig, parseJobUrl, safeText, splitMessage } from '../src/discord.mjs';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-discord-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// Fake Discord objects.
const command = (commandName, options = {}, user = OWNER, guildId = null) => {
  const replies = [];
  return {
    commandName, guildId, replies,
    user: { id: user },
    isChatInputCommand: () => true,
    options: { getString: name => options[name] ?? null, getInteger: name => options[name] ?? null },
    reply: async payload => { replies.push(payload); },
  };
};
const message = (content, author = OWNER, guildId = null) => ({ content, guildId, author: { id: author } });

const until = async (check, what = 'the expected state') => {
  for (let i = 0; i < 400; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    if (await check()) return;
  }
  assert.fail(`Timeout: ${what}`);
};

function fixture(runJob, { failFiles = false } = {}) {
  const sent = [];
  const logs = [];
  const remote = createRemote({
    ownerId: OWNER,
    flushMs: 1,
    log: (...items) => logs.push(items.join(' ')),
    runJob,
    send: async payload => {
      if (failFiles && payload.files) throw new Error('Request entity too large');
      sent.push(payload);
    },
  });
  const text = () => sent.map(item => item.content ?? '').join('\n');
  return { remote, sent, logs, text };
}
const apply = async (remote, url) => {
  const interaction = command('apply', { url });
  await remote.onCommand(interaction);
  return interaction.replies[0].content;
};
const statusOf = async remote => {
  const interaction = command('status');
  await remote.onCommand(interaction);
  return interaction.replies[0].content;
};
const cancel = async (remote, job = null) => {
  const interaction = command('cancel', { job });
  await remote.onCommand(interaction);
  return interaction.replies[0].content;
};
// A job that stays open until the test ends it. A cancel rejects it.
const heldJobs = () => {
  const started = [];
  const runJob = (job, context) => new Promise((resolve, reject) => {
    started.push({ job, resolve, ...context });
    context.signal.addEventListener('abort', () => reject(context.signal.reason));
  });
  return { started, runJob };
};

test('safeText hides secrets and home paths, and it breaks masked links', () => {
  assert.equal(safeText('Password = hunter2\nEmail question = yes', '/Users/test'), 'Password = [hidden]\nEmail question = yes');
  assert.match(safeText('Draft: my password is hunter2', '/Users/test'), /^\[hidden/);
  assert.match(safeText('Your SSN', '/Users/test'), /^\[hidden/);
  assert.match(safeText('Number: 123-45-6789', '/Users/test'), /^\[hidden/);
  assert.equal(safeText('File: /Users/test/a.pdf', '/Users/test'), 'File: ~/a.pdf');
  assert.equal(safeText('[safe](https://example.test)', '/Users/test'), '[safe] (https://example.test)');
  assert.equal(safeText('  - LinkedIn: got "https://linkedin.example.test/alex"\n  - Readback: Email: got "a@example.test"', '/Users/test'), '- LinkedIn: the page changed the value\n  - Readback: Email: the page changed the value');
});

test('long text becomes messages under the Discord limit, with no lost text', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const parts = splitMessage(lines.join('\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 2000));
  assert.equal(parts.join('\n'), lines.join('\n'));

  const long = splitMessage('y'.repeat(4500));
  assert.deepEqual(long.map(part => part.length), [2000, 2000, 500]);
  assert.deepEqual(splitMessage('  \n '), []);
});

test('only http and https URLs start a job', () => {
  assert.equal(parseJobUrl(' https://jobs.example.test/1 '), 'https://jobs.example.test/1');
  assert.equal(parseJobUrl('https://jobs.example.test/1?gh_jid=7&utm_source=x#/apply'), 'https://jobs.example.test/1?gh_jid=7#/apply');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) assert.equal(parseJobUrl(bad), null);
});

test('other users and shared servers get no answer and start nothing', async () => {
  const { started, runJob } = heldJobs();
  const { remote, sent } = fixture(runJob);
  const fromStranger = command('apply', { url: 'https://jobs.example.test/1' }, STRANGER);
  const inServer = command('apply', { url: 'https://jobs.example.test/2' }, OWNER, '333333333333333333');
  await remote.onCommand(fromStranger);
  await remote.onCommand(inServer);
  await remote.onCommand(command('cancel', {}, STRANGER));
  await remote.onMessage(message('hello', STRANGER));
  await remote.onMessage(message('hello', OWNER, '333333333333333333'));
  assert.deepEqual(fromStranger.replies, []);
  assert.deepEqual(inServer.replies, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(started, []);
});

test('a stranger cannot answer a question or cancel a job', async () => {
  let answer = null;
  const { remote, text } = fixture(async (job, { io }) => { answer = await io.ask('Your answer: '); });
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('Your answer'));
  await remote.onMessage(message('stranger text', STRANGER));
  await remote.onCommand(command('cancel', {}, STRANGER));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(answer, null);
  await remote.onMessage(message('owner text'));
  await until(() => answer === 'owner text');
});

test('jobs run one at a time, and a second job waits and says so', async () => {
  const { started, runJob } = heldJobs();
  const { remote, text } = fixture(runJob);
  assert.match(await apply(remote, 'https://jobs.example.test/1'), /Job 1 is accepted/);
  await until(() => started.length === 1);
  assert.match(await apply(remote, 'https://jobs.example.test/2'), /Job 2 waits in the queue\. Jobs before it: 1/);
  assert.match(await apply(remote, 'https://jobs.example.test/1'), /Job 1 already has this URL/);
  assert.match(await apply(remote, 'file:///etc/passwd'), /starts with http/);
  assert.equal(started.length, 1);

  started[0].onStage('Filling the form');
  const shown = await statusOf(remote);
  assert.match(shown, /Job 1: Filling the form\./);
  assert.match(shown, /In the queue:\nJob 2: https:\/\/jobs\.example\.test\/2/);

  started[0].resolve();
  await until(() => started.length === 2);
  assert.equal(started[1].job.id, 2);
  started[1].resolve();
  await until(() => text().includes('Job 2 starts'));
  await until(async () => /No job runs\.\nThe queue is empty\./.test(await statusOf(remote)));
});

test('cancel removes a job from the queue or stops the current job', async () => {
  const { started, runJob } = heldJobs();
  const { remote, text } = fixture(runJob);
  assert.equal(await cancel(remote), 'No job runs.');
  await apply(remote, 'https://jobs.example.test/1');
  await apply(remote, 'https://jobs.example.test/2');
  await apply(remote, 'https://jobs.example.test/3');
  await until(() => started.length === 1);
  assert.match(await cancel(remote, 2), /Job 2 is removed/);
  assert.match(await cancel(remote, 9), /Job 9 does not run/);
  assert.match(await cancel(remote), /Job 1 stops now/);
  await until(() => started.length === 2);
  assert.equal(started[1].job.id, 3, 'the removed job does not run');
  assert.match(text(), /Job 1 is canceled\. The agent did not submit it\./);
  started[1].resolve();
});

test('cancel stops a job that waits for an answer', async () => {
  let rejected = null;
  const { remote, text } = fixture(async (job, { io }) => {
    await io.ask('Your answer: ').catch(error => { rejected = error; throw error; });
  });
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('Your answer'));
  assert.match(await statusOf(remote), /It waits for your answer: Your answer:/);
  await cancel(remote);
  await until(() => rejected);
  await until(() => text().includes('Job 1 is canceled'));
  await remote.onMessage(message('late reply'));
  await until(() => text().includes('No question waits'));
});

test('cancel is refused at the submission step', async () => {
  const { started, runJob } = heldJobs();
  const { remote } = fixture(runJob);
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => started.length === 1);
  started[0].onStage(STAGE_SUBMITTING);
  assert.match(await cancel(remote), /cannot be canceled/);
  assert.equal(started[0].signal.aborted, false);
  started[0].resolve();
});

test('an error message says if the agent could have clicked the submit button', async () => {
  const { remote, text } = fixture(async (job, { onStage }) => {
    if (job.id === 2) onStage(STAGE_SUBMITTING);
    throw new Error('Page crashed\nCall log: secret details');
  });
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('Job 1: Stopped'));
  assert.match(text(), /Job 1: Stopped with an error\. The agent did not submit it\. Page crashed/);
  await apply(remote, 'https://jobs.example.test/2');
  await until(() => text().includes('Job 2: Stopped'));
  assert.match(text(), /Job 2: Stopped with an error\. The agent may have clicked the submit button/);
  assert.doesNotMatch(text(), /Call log/, 'only the first line of an error goes to Discord');
});

test('a URL that the agent applied with does not start again', async () => {
  const applied = 'https://jobs.example.test/earlier-run';
  const outcomes = { 1: { clicked: true, result: 'SUBMITTED' }, 2: { clicked: false, result: 'NOT SUBMITTED.' } };
  const logs = [];
  let runs = 0;
  const remote = createRemote({
    ownerId: OWNER, flushMs: 1, log: line => logs.push(line), send: async () => {}, wasApplied: url => url === applied,
    runJob: async job => { runs++; return outcomes[job.id]; },
  });
  await apply(remote, 'https://jobs.example.test/1?utm_source=mail');
  await until(async () => /Last result: Job 1: SUBMITTED/.test(await statusOf(remote)), 'the result in the status');
  assert.ok(logs.includes('Job 1: SUBMITTED'), 'this computer also shows the result');
  assert.match(await apply(remote, 'https://jobs.example.test/1'), /already applied/);
  assert.match(await apply(remote, 'https://jobs.example.test/1?utm_medium=phone'), /already applied/);
  assert.match(await apply(remote, applied), /already applied/);
  assert.equal(runs, 1);
  await apply(remote, 'https://jobs.example.test/not-ready');
  await until(() => runs === 2);
  await until(async () => /No job runs/.test(await statusOf(remote)));
  assert.match(await apply(remote, 'https://jobs.example.test/not-ready'), /is accepted/, 'a form that the agent did not submit can run again');
});

test('a mistyped command or an earlier message is not an answer', async () => {
  let answer = null;
  const sent = [];
  const remote = createRemote({
    ownerId: OWNER, flushMs: 1, log: () => {},
    send: async payload => { sent.push(payload); return { id: '1000' }; },
    runJob: async (job, { io }) => { answer = await io.ask('Your text: '); },
  });
  const text = () => sent.map(item => item.content ?? '').join('\n');
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('Your text:'));
  for (const typed of ['/cancel', 'cancel', 'STATUS', '/apply https://jobs.example.test/2']) await remote.onMessage(message(typed));
  await until(() => text().split('not an answer').length === 5);
  await remote.onMessage({ ...message('sent too early'), id: '999' });
  await until(() => text().includes('before the question'));
  assert.equal(answer, null);
  await remote.onMessage({ ...message('the answer'), id: '1001' });
  await until(() => answer === 'the answer');
});

test('a reply answers only an open question, and a dash is an empty answer', async () => {
  const answers = [];
  const { remote, text } = fixture(async (job, { io }) => {
    answers.push(await io.ask('First: '));
    answers.push(await io.ask('Second: '));
  });
  await remote.onMessage(message('too early'));
  assert.match(text(), /No question waits/);
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('First:'));
  await remote.onMessage(message('   ')); // A message with only an image has no text.
  await until(() => text().includes('Send your answer as text'));
  await remote.onMessage(message('-'));
  await until(() => text().includes('Second:'));
  await remote.onMessage(message(' second answer '));
  await until(() => answers.length === 2);
  assert.deepEqual(answers, ['', 'second answer']);
});

test('nearby lines become one message in order, and each message limits mentions and previews', async () => {
  const { remote, sent } = fixture(async (job, { io }) => {
    io.say('\nThe form asks: Q');
    io.say('  1. A');
    await io.ask('Enter a number: ').catch(() => {});
  });
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => sent.some(item => item.content?.includes('Enter a number')));
  const question = sent.find(item => item.content?.includes('Enter a number'));
  assert.ok(question.content.startsWith('Job 1 starts'));
  assert.ok(question.content.includes('The form asks: Q\n  1. A\nEnter a number:'));
  assert.deepEqual(question.allowedMentions, { parse: [] });
  assert.equal(question.flags & 4, 4);
  await cancel(remote);
});

test('text from a job page is only shown, and it cannot start, cancel, or answer anything', async () => {
  const attack = '/apply https://evil.example.test\n/cancel\n@everyone [your bank](https://evil.example.test)';
  const { started, runJob } = heldJobs();
  const { remote, sent } = fixture(runJob);
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => started.length === 1);
  started[0].io.say(attack);
  await until(() => sent.some(item => item.content?.includes('@everyone')));
  assert.deepEqual(sent.find(item => item.content.includes('@everyone')).allowedMentions, { parse: [] });
  assert.ok(sent.every(item => !item.content.includes('](')));
  assert.equal(started.length, 1);
  assert.equal(started[0].signal.aborted, false);
  assert.doesNotMatch(await statusOf(remote), /evil/);
  // The bot gets its own message as an event. That message is not from the owner.
  await remote.onMessage(message(attack, '999999999999999999'));
  assert.equal(started[0].signal.aborted, false);
  started[0].resolve();
});

test('a failed upload gives a message and the job continues', async () => {
  let answer = null;
  const { remote, text, logs } = fixture(async (job, { io }) => {
    io.attach('/tmp/too-large.pdf');
    answer = await io.ask('Continue: ');
  }, { failFiles: true });
  await apply(remote, 'https://jobs.example.test/1');
  await until(() => text().includes('Continue:'));
  await remote.onMessage(message('y'));
  await until(() => answer === 'y');
  await until(() => text().includes('The file did not reach Discord'));
  assert.ok(logs.some(line => line.includes('too large')));
});

test('if a question cannot reach Discord, the job stops and the next job starts', async () => {
  let fail = true, second = false;
  const logs = [];
  const remote = createRemote({
    ownerId: OWNER,
    flushMs: 1,
    log: (...items) => logs.push(items.join(' ')),
    send: async () => { if (fail) throw new Error('Network down'); },
    runJob: async (job, { io }) => {
      if (job.id === 1) await io.ask('Question: ');
      else second = true;
    },
  });
  await apply(remote, 'https://jobs.example.test/1');
  await apply(remote, 'https://jobs.example.test/2');
  await until(() => second, 'the next job');
  fail = false;
  assert.ok(logs.some(line => /Job 1 stopped/.test(line)));
});

test('the configuration comes from the file, and the token leaves the environment', () => {
  const file = path.join(root, 'env-file');
  fs.writeFileSync(file, `DISCORD_BOT_TOKEN=fictional-token\nDISCORD_OWNER_ID=${OWNER}\nANTHROPIC_API_KEY=fictional-key\n`);
  const env = { DISCORD_BOT_TOKEN: 'from-shell', PATH: '/bin' };
  const config = loadConfig(env, file);
  assert.equal(config.token, 'from-shell', 'a value in the shell has priority');
  assert.equal(config.ownerId, OWNER);
  assert.equal(config.modelEnv.ANTHROPIC_API_KEY, 'fictional-key');
  assert.equal(config.modelEnv.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.DISCORD_BOT_TOKEN, undefined, 'Chrome and the tailoring tool must not get it');

  assert.throws(() => loadConfig({}, path.join(root, 'no-file')), /DISCORD_BOT_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: 'x', DISCORD_OWNER_ID: 'nick' }, path.join(root, 'no-file')), /DISCORD_OWNER_ID/);
  const error = (() => { try { loadConfig({ DISCORD_BOT_TOKEN: 'secret-value' }, path.join(root, 'no-file')); } catch (e) { return e; } })();
  assert.doesNotMatch(error.message, /secret-value/);
});

test('the core modules load and work with no Discord module', () => {
  const sources = path.resolve('src');
  for (const file of fs.readdirSync(sources).filter(name => name !== 'discord.mjs')) {
    assert.doesNotMatch(fs.readFileSync(path.join(sources, file), 'utf8'), /discord/i, `${file} must not need Discord`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(sources, 'discord.mjs'), 'utf8'), /^import .*discord\.js/m, 'the package loads only when the bot starts');
});

test('without a token, the bot stops before it connects, and it prints no secret', () => {
  const cwd = fs.mkdtempSync(path.join(root, 'no-token-'));
  const env = { PATH: process.env.PATH, DISCORD_OWNER_ID: OWNER };
  const result = spawnSync(process.execPath, [path.resolve('src/discord.mjs')], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set DISCORD_BOT_TOKEN/);
});

// The real package, with no network connection.
const discord = await import('discord.js').catch(() => null);

test('the commands have the expected form for direct messages', { skip: !discord }, () => {
  const data = commandData(discord);
  assert.deepEqual(data.map(item => item.name), ['apply', 'status', 'cancel']);
  for (const item of data) {
    assert.deepEqual(item.contexts, [discord.InteractionContextType.BotDM]);
    assert.deepEqual(item.integration_types, [discord.ApplicationIntegrationType.GuildInstall]);
  }
  assert.equal(data[0].options[0].name, 'url');
  assert.equal(data[0].options[0].required, true);
  assert.equal(data[2].options[0].required, false);
});

test('the real client gives a direct message from an uncached channel and a command to the bot code', { skip: !discord }, async () => {
  const client = createClient(discord);
  assert.deepEqual(client.options.intents.toArray(), ['DirectMessages']);
  const { started, runJob } = heldJobs();
  const { remote, text } = fixture(async (job, context) => {
    const answer = await context.io.ask('Your answer: ');
    await runJob(job, context).catch(() => {});
    return answer;
  });
  const seen = [];
  client.on(discord.Events.MessageCreate, item => { seen.push(item); remote.onMessage(item); });
  const interactions = [];
  client.on(discord.Events.InteractionCreate, item => {
    interactions.push(item);
    item.reply = async () => {};
    remote.onCommand(item);
  });
  const user = { id: OWNER, username: 'alex', discriminator: '0', avatar: null, global_name: null };

  client.actions.InteractionCreate.handle({
    id: '1', application_id: '2', type: 2, token: 'fictional', version: 1, channel_id: '4', user,
    channel: { id: '4', type: 1 }, context: 1, authorizing_integration_owners: {}, entitlements: [],
    data: { id: '5', name: 'apply', type: 1, options: [{ name: 'url', type: 3, value: 'https://jobs.example.test/1' }] },
  });
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].isChatInputCommand(), true);
  await until(() => text().includes('Your answer'));

  client.actions.MessageCreate.handle({
    id: '6', channel_id: '4', author: user, content: 'answer text', timestamp: new Date().toISOString(), edited_timestamp: null,
    tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
  });
  assert.equal(seen.length, 1, 'with no partial, Discord.js drops this event');
  assert.equal(seen[0].content, 'answer text');
  assert.equal(seen[0].guildId, null);
  await until(() => started.length === 1);
  started[0].resolve();
  await client.destroy();
});

// The full flow in Chrome. The form records each submission on the local server.
function formServer(html) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') server.posts++;
    res.setHeader('Content-Type', 'text/html');
    res.end(req.method === 'POST' ? '<h1>Thank you for applying</h1>' : html);
  });
  server.posts = 0;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}
const FORM = `<title>Backend Intern at Acme</title><h1>Backend Intern</h1><form method="post">
  <label for="fn">First Name</label><input id="fn" name="fn" required>
  <label for="em">Email</label><input id="em" name="em" required>
  <label for="ph">Phone</label><input id="ph" name="ph">
  <label for="cv">Resume</label><input id="cv" name="cv" type="file">
  <label for="why">Why this job?</label><textarea id="why" name="why" required></textarea>
  <label for="visa">What type of sponsorship will you require? /cancel</label><select id="visa" name="visa" required><option value=""></option><option>H-1B</option><option>Other</option></select>
  <button type="submit">Submit application</button>
</form>`;
const fakeProvider = {
  name: 'fake',
  completeJSON: async ({ system, user }) => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (system.includes('one resume')) return { data: { resume_id: null, tailor_recommended: true, reason: 'The policy applies.', company: 'Acme', role: 'Backend' }, usage };
    const { fields, applicant_feedback: feedback } = JSON.parse(user);
    return { data: { answers: fields.map(field => ({ id: field.id, value: feedback ? 'Second draft.' : 'First draft.' })) }, usage };
  },
};
const fakeClaudeOnPath = dir => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(process.argv[3].match(/final PDF to (.*)\\. Keep/)[1], '%PDF-1.7 fictional');
console.log('Changed the summary. Examine the second bullet.');`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  return () => { process.env.PATH = before; };
};
function writeProfile(folder, extra = {}) {
  const general = path.join(folder, 'general', 'SWE');
  fs.mkdirSync(general, { recursive: true });
  fs.mkdirSync(path.join(folder, 'targeted'), { recursive: true });
  fs.writeFileSync(path.join(general, 'Alex_Rivera_SWE.pdf'), '%PDF-1.7 fictional');
  const file = path.join(folder, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({
    first_name: 'Alex', last_name: 'Rivera', email: 'alex.rivera@example.test', phone: '2125550142', auto_submit: true,
    resume_library: { language: 'any', tailor_policy: 'Tailor for Acme.', tailor: { skill: 'resume-skill' }, roots: [{ dir: path.join(folder, 'general'), kind: 'general' }, { dir: path.join(folder, 'targeted'), kind: 'targeted' }] },
    ...extra,
  }));
  return file;
}

test('each stop of the flow reaches Discord and waits, and the summary arrives', async () => {
  const folder = fs.mkdtempSync(path.join(root, 'flow-'));
  const restore = fakeClaudeOnPath(path.join(folder, 'bin'));
  const { server, url } = await formServer(FORM);
  const applicationsFile = path.join(folder, 'applications.csv');
  const profilePath = writeProfile(folder);
  const { remote, sent, text } = fixture(jobRunner({ profilePath, provider: fakeProvider, headless: true, applicationsFile }));
  const reply = async (prompt, answer) => {
    await until(() => text().split(prompt).length > (reply.seen[prompt] ?? 0) + 1, prompt);
    reply.seen[prompt] = (reply.seen[prompt] ?? 0) + 1;
    await remote.onMessage(message(answer));
  };
  reply.seen = {};
  try {
    await apply(remote, url);

    await reply('a resume id, p for a path', 'A'); // A phone writes the first letter as a capital.
    assert.match(text(), /This job needs a tailored resume \(Acme, Backend\)/);
    assert.match(text(), /Examine the second bullet/, 'the tailoring notes arrive');
    const file = sent.find(item => item.files)?.files[0];
    assert.match(file, /Alex_Rivera_Acme_Backend\.pdf$/, 'the tailored PDF arrives');
    assert.ok(!text().includes(os.homedir()), 'the home folder is not sent');

    await reply('[a]ccept, [e]dit', 'x'); // A wrong letter does not skip the draft.
    await until(() => text().includes('Enter a, e, r, or s.'));
    await reply('[a]ccept, [e]dit', 'r');
    await reply('Your feedback:', 'Shorter.');
    await until(() => text().includes('Draft: Second draft.'));
    await reply('[a]ccept, [e]dit', 'a');

    await reply('Enter a number, or send - to answer on the form', '1');
    await until(() => text().includes('SUBMITTED'));
    await until(() => text().includes('Examine these answers'));
    assert.equal(server.posts, 1);
    assert.match(text(), /What type of sponsorship will you require\? \/cancel = H-1B \(from you\)/);
    assert.match(fs.readFileSync(applicationsFile, 'utf8'), /Acme,Backend/);
    assert.ok(!/alex\.rivera@example\.test|2125550142/.test(text()), 'the profile values do not reach Discord');
    await until(async () => /No job runs/.test(await statusOf(remote)), 'the job to end');
    assert.doesNotMatch(text(), /is canceled/, 'a /cancel in a job page is only text');
  } finally {
    restore();
    server.close();
  }
});

test('a cancel during a question closes the browser, and nothing is submitted', async () => {
  const folder = fs.mkdtempSync(path.join(root, 'cancel-'));
  const { server, url } = await formServer(FORM);
  const profilePath = writeProfile(folder, { resume_library: undefined });
  const { remote, text } = fixture(jobRunner({ profilePath, headless: true, applicationsFile: path.join(folder, 'applications.csv') }));
  try {
    await apply(remote, url);
    await until(() => text().includes('The form asks'));
    assert.match(await cancel(remote), /Job 1 stops now/);
    await until(() => text().includes('Job 1 is canceled'));
    assert.equal(server.posts, 0);
    assert.equal(fs.existsSync(path.join(folder, 'applications.csv')), false);
    await until(async () => /No job runs/.test(await statusOf(remote)));
  } finally {
    server.close();
  }
});

test('a cancel during tailoring stops the tool', async () => {
  const folder = fs.mkdtempSync(path.join(root, 'cancel-tailor-'));
  const bin = path.join(folder, 'bin');
  fs.mkdirSync(bin);
  const pidFile = path.join(folder, 'tool.pid');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 60000);`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  const { server, url } = await formServer(FORM);
  const { remote, text } = fixture(jobRunner({ profilePath: writeProfile(folder), provider: fakeProvider, headless: true, applicationsFile: path.join(folder, 'applications.csv') }));
  try {
    await apply(remote, url);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), 'the tool to start');
    await cancel(remote);
    await until(() => text().includes('Job 1 is canceled'));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the tool to stop');
    assert.ok(!/Recommended:/.test(text()), 'after a cancel, the resume question does not arrive');
    assert.equal(server.posts, 0);
  } finally {
    process.env.PATH = before;
    server.close();
  }
});

test('a verification code tells the user to go to the computer, and the run waits', async () => {
  const folder = fs.mkdtempSync(path.join(root, 'code-'));
  const { server, url } = await formServer(`<form id="f"><label for="fn">First Name</label><input id="fn" required><button type="submit">Submit application</button></form>
    <script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); const p = document.createElement('p'); p.textContent = 'Enter the verification code from your email'; document.body.append(p); setTimeout(() => { document.body.innerHTML = '<h2>Your application has been submitted</h2>'; }, 1500); });</script>`);
  const profilePath = writeProfile(folder, { resume_library: undefined });
  const { remote, text } = fixture(jobRunner({ profilePath, headless: true, canWait: true, applicationsFile: path.join(folder, 'applications.csv') }));
  try {
    await apply(remote, url);
    await until(() => text().includes('verification code'));
    assert.match(text(), /Complete it in Chrome on the computer that runs the agent/);
    assert.match(await cancel(remote), /cannot be canceled/);
    await until(() => text().includes('SUBMITTED'));
  } finally {
    server.close();
  }
});

test('a form that is not ready stays open, the summary says so, and the next job starts', async () => {
  const folder = fs.mkdtempSync(path.join(root, 'open-'));
  const { server, url } = await formServer('<form method="post"><label for="q">Unknown question</label><input id="q" required><button type="submit">Submit application</button></form>');
  const profilePath = writeProfile(folder, { resume_library: undefined });
  const closed = [];
  const runner = jobRunner({ profilePath, headless: false, canWait: false, applicationsFile: path.join(folder, 'applications.csv') });
  const { remote, text } = fixture(async (job, context) => {
    if (job.id === 2) return;
    // The test uses a headless browser, and it must not leave Chrome open. The other values are the same as on a computer.
    const real = await import('playwright-core');
    const launch = real.chromium.launch;
    real.chromium.launch = options => launch.call(real.chromium, { ...options, headless: true }).then(browser => { closed.push(browser); return browser; });
    try { await runner(job, context); } finally { real.chromium.launch = launch; }
  });
  try {
    await apply(remote, url);
    await apply(remote, `${url}second`);
    await until(() => text().includes('Enter your answer, or send -'));
    await remote.onMessage(message('-'));
    await until(() => text().includes('NOT SUBMITTED'));
    await until(() => text().includes('The form stays open in Chrome'));
    await until(() => text().includes('Job 2 starts'));
    assert.equal(closed[0].isConnected(), true, 'the form stays open for review');
    assert.equal(server.posts, 0);
    assert.match(text(), /Unknown question/);
  } finally {
    for (const browser of closed) await browser.close();
    server.close();
  }
});
