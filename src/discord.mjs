// Optional module. Starts applications from Discord direct messages. The agent still runs on this computer.
// To remove this function, delete this file and test/discord.test.mjs, then remove discord.js from package.json.
// Only the configured Discord user can give commands. Text from a job page is shown as data, and it cannot start an action.
// Usage: node src/discord.mjs [profile.json] [--model] [--no-submit]
import fs from 'fs';
import os from 'os';
import { pathToFileURL } from 'url';
import { parseEnv } from 'util';
import { APPLICATIONS_FILE } from './applications.mjs';
import { applyToJob, STAGE_SUBMITTING } from './apply.mjs';
import { NEVER_SAVED } from './clarify.mjs';
import { createProvider } from './providers.mjs';
import { formatReport } from './summary.mjs';

const MAX_MESSAGE = 2000; // The Discord limit for one message.
const SKIP_WORD = '-'; // Discord does not send an empty message, so this word means that the user presses Enter.
const SUPPRESS_EMBEDS = 1 << 2; // Discord does not fetch previews of links from a job page.
const MESSAGE_OPTIONS = { flags: SUPPRESS_EMBEDS, allowedMentions: { parse: [] } };
const HIDDEN_LINE = '[hidden: this line names a password or a social security number]';
const SSN_VALUE = /\b\d{3}-\d{2}-\d{4}\b/;
// A command that Discord did not recognize arrives as a normal message. It must not go on the form as an answer.
const TYPED_COMMAND = /^\/?(cancel|status)$|^\/apply\b/i;
const NOT_CLICKED = new Set(['form_not_ready', 'no_submit_button']);
const firstLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 300);

function hideSecrets(line) {
  if (!NEVER_SAVED.test(line) && !SSN_VALUE.test(line)) return line;
  const at = line.indexOf(' = ');
  return at > 0 ? `${line.slice(0, at)} = [hidden]` : HIDDEN_LINE;
}

// Discord stores each message, so this function is the last check before text leaves the computer.
export function safeText(text, home = os.homedir()) {
  return text.split('\n').map(hideSecrets).join('\n')
    .replace(/: got ".*"$/gm, ': the page changed the value') // A failed readback shows a profile value.
    .replaceAll(home, '~')
    .replaceAll('](', '] (') // A job page must not show one link text and open a different address.
    .trim();
}

export function splitMessage(text, limit = MAX_MESSAGE) {
  const parts = [];
  let part = '';
  for (let line of text.split('\n')) {
    while (line.length > limit) {
      if (part) parts.push(part);
      part = '';
      parts.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const next = part ? `${part}\n${line}` : line;
    if (next.length > limit) { parts.push(part); part = line; } else part = next;
  }
  parts.push(part);
  return parts.filter(item => item.trim());
}

// Tracking values do not make a different job, so they do not get past the check for a repeated URL.
export function parseJobUrl(input) {
  try {
    const url = new URL(String(input).trim());
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// One job runs at a time. send(payload) writes to the direct message of the owner.
// runJob(job, { io, signal, onStage }) does the work, must stop when signal aborts, and returns { clicked, result }.
// wasApplied(url) finds the applications from earlier runs.
export function createRemote({ ownerId, send, runJob, wasApplied = () => false, flushMs = 300, log = console.error }) {
  const queue = [];
  const clickedUrls = new Set();
  let nextId = 1, active = null, waiting = null, lastResult = null;
  let chain = Promise.resolve(), lines = [], timer = null;

  const reportError = error => log(`A message did not reach Discord: ${firstLine(error)}`);
  const enqueue = payload => {
    const sent = chain.then(() => send({ ...MESSAGE_OPTIONS, ...payload }));
    chain = sent.catch(() => {});
    return sent;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    const text = safeText(lines.join('\n'));
    lines = [];
    return Promise.all(splitMessage(text).map(content => enqueue({ content })));
  };
  // Nearby lines go in one message, so that a list of options does not become many messages.
  const say = text => {
    lines.push(text);
    timer ??= setTimeout(() => flush().catch(reportError), flushMs);
  };
  const attach = file => {
    flush().catch(reportError);
    enqueue({ files: [file] }).catch(error => {
      reportError(error);
      say(`The file did not reach Discord: ${firstLine(error)} The file stays on this computer.`);
    });
  };

  function jobIo(job, signal) {
    return {
      skipHint: `send ${SKIP_WORD}`,
      say: text => { if (!signal.aborted) say(text); },
      attach: file => { if (!signal.aborted) attach(file); },
      async ask(question) {
        signal.throwIfAborted();
        lines.push(question);
        const sent = await flush();
        signal.throwIfAborted();
        job.question = question.trim();
        return new Promise((resolve, reject) => { waiting = { resolve, reject, afterId: sent.at(-1)?.id }; });
      },
    };
  }

  async function runOne(job) {
    const { signal } = job.controller;
    job.stage = 'Starting';
    say(`Job ${job.id} starts: ${job.url}`);
    let outcome;
    try {
      outcome = await runJob(job, { io: jobIo(job, signal), signal, onStage: stage => { job.stage = stage; } });
    } catch (error) {
      if (signal.aborted) {
        outcome = { result: 'Canceled. The agent did not submit it.' };
        say(`Job ${job.id} is canceled. The agent did not submit it.`);
      } else {
        const atSubmit = job.stage === STAGE_SUBMITTING;
        log(`Job ${job.id} stopped:`, error);
        outcome = { clicked: atSubmit, result: `Stopped with an error. ${atSubmit ? 'The agent may have clicked the submit button. Look for a confirmation from the employer before you apply again.' : 'The agent did not submit it.'}` };
        say(`Job ${job.id}: ${outcome.result} ${firstLine(error)}`);
      }
    }
    if (outcome?.clicked) clickedUrls.add(job.url);
    // The summary can fail to reach Discord, so /status and this computer also keep the result.
    lastResult = `Job ${job.id}: ${outcome?.result ?? 'Ended.'}`;
    log(lastResult);
    waiting = null;
    await flush().catch(reportError);
  }

  async function pump() {
    if (active || !queue.length) return;
    active = queue.shift();
    await runOne(active);
    active = null;
    pump();
  }

  function addJob(input) {
    const url = parseJobUrl(input);
    if (!url) return 'Enter a full URL that starts with http or https.';
    const same = [active, ...queue].find(job => job?.url === url);
    if (same) return `Job ${same.id} already has this URL.`;
    if (clickedUrls.has(url) || wasApplied(url)) return 'The agent already applied with this URL. To apply again, use the terminal on the computer.';
    const before = (active ? 1 : 0) + queue.length;
    const job = { id: nextId++, url, stage: 'In the queue', question: null, controller: new AbortController() };
    queue.push(job);
    return before ? `Job ${job.id} waits in the queue. Jobs before it: ${before}.` : `Job ${job.id} is accepted.`;
  }

  function status() {
    const out = [];
    if (active) {
      out.push(`Job ${active.id}: ${active.stage}.`, active.url);
      if (active.question) out.push(`It waits for your answer: ${active.question}`);
    } else out.push('No job runs.');
    if (queue.length) out.push('', 'In the queue:', ...queue.map(job => `Job ${job.id}: ${job.url}`));
    else out.push('The queue is empty.');
    if (lastResult) out.push('', `Last result: ${lastResult}`);
    return out.join('\n');
  }

  function cancel(id) {
    const queued = queue.findIndex(job => job.id === id);
    if (queued >= 0) {
      queue.splice(queued, 1);
      return `Job ${id} is removed from the queue.`;
    }
    if (!active) return 'No job runs.';
    if (id !== null && id !== active.id) return `Job ${id} does not run and is not in the queue.`;
    if (active.stage === STAGE_SUBMITTING) return `Job ${active.id} can be at the submission step now, so it cannot be canceled.`;
    if (!active.controller.signal.aborted) {
      active.controller.abort(new Error('Canceled'));
      waiting?.reject(active.controller.signal.reason);
      waiting = null;
    }
    return `Job ${active.id} stops now.`;
  }

  return {
    async onCommand(interaction) {
      if (!interaction.isChatInputCommand() || interaction.user.id !== ownerId || interaction.guildId) return;
      const answer = {
        apply: () => addJob(interaction.options.getString('url', true)),
        status,
        cancel: () => cancel(interaction.options.getInteger('job')),
      }[interaction.commandName]?.();
      if (!answer) return;
      await interaction.reply({ ...MESSAGE_OPTIONS, content: safeText(answer).slice(0, MAX_MESSAGE) }).catch(reportError);
      pump();
    },
    async onMessage(message) {
      if (message.author?.id !== ownerId || message.guildId) return;
      const text = message.content?.trim();
      if (!waiting) { await enqueue({ content: 'No question waits for an answer. Use /apply, /status, or /cancel.' }).catch(reportError); return; }
      if (!text) { await enqueue({ content: 'Send your answer as text.' }).catch(reportError); return; }
      if (TYPED_COMMAND.test(text)) { await enqueue({ content: 'This message is not an answer. Select the command from the Discord command list.' }).catch(reportError); return; }
      if (waiting.afterId && message.id && BigInt(message.id) <= BigInt(waiting.afterId)) { await enqueue({ content: 'You sent that message before the question. Answer the question again.' }).catch(reportError); return; }
      const { resolve } = waiting;
      waiting = null;
      active.question = null;
      resolve(text === SKIP_WORD ? '' : text);
    },
  };
}

// Connects a job from the queue to the application flow.
export function jobRunner({ profilePath, provider, noSubmit, headless = false, ...options }) {
  return async (job, { io, signal, onStage }) => {
    const { report, browser } = await applyToJob({ url: job.url, profilePath, provider, noSubmit, headless, io, signal, onStage, ...options });
    io.say(formatReport(report));
    if (headless || report.submission?.submitted) await browser.close();
    else io.say('The form stays open in Chrome on this computer. If the bot stops, Chrome closes.');
    return { clicked: Boolean(report.submission) && !NOT_CLICKED.has(report.submission.why), result: formatReport(report).split('\n')[0] };
  };
}

// A bot gets the text of a direct message with no privileged intent. An uncached direct message channel needs the partial.
export function createClient({ Client, GatewayIntentBits, Partials }) {
  return new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel], allowedMentions: { parse: [] } });
}

// A global command is the only type that Discord shows in a direct message.
export function commandData({ SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType }) {
  const command = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description)
    .setContexts(InteractionContextType.BotDM).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  return [
    command('apply', 'Apply for one job').addStringOption(option => option.setName('url').setDescription('URL of the application form').setRequired(true)),
    command('status', 'Show the current job and the queue'),
    command('cancel', 'Cancel a job that is not at the submission step').addIntegerOption(option => option.setName('job').setDescription('Job number. The default is the current job.').setMinValue(1)),
  ].map(item => item.toJSON());
}

// Chrome and the tailoring tool get the environment of this process, so the token must not stay in it.
export function loadConfig(env = process.env, file = '.env.local') {
  const { DISCORD_BOT_TOKEN: token, DISCORD_OWNER_ID: ownerId, ...modelEnv } = { ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {}), ...env };
  delete env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error(`Set DISCORD_BOT_TOKEN in ${file}.`);
  if (!/^\d{17,20}$/.test(ownerId ?? '')) throw new Error(`Set DISCORD_OWNER_ID in ${file} to your Discord user ID.`);
  return { token, ownerId, modelEnv };
}

async function main(args) {
  const [profilePath = 'profile.local.json'] = args.filter(arg => !arg.startsWith('--'));
  const { token, ownerId, modelEnv } = loadConfig();
  if (!fs.existsSync(profilePath)) throw new Error(`${profilePath} does not exist. Run node src/setup.mjs on this computer first.`);
  const provider = args.includes('--model') ? await createProvider(modelEnv) : null;
  const discord = await import('discord.js').catch(() => { throw new Error('The discord.js package is not installed. Run npm install.'); });

  const client = createClient(discord);
  const remote = createRemote({
    ownerId,
    send: async payload => (await client.users.fetch(ownerId)).send(payload),
    runJob: jobRunner({ profilePath, provider, noSubmit: args.includes('--no-submit'), headless: process.env.HEADLESS === '1' }),
    wasApplied: url => fs.existsSync(APPLICATIONS_FILE) && fs.readFileSync(APPLICATIONS_FILE, 'utf8').includes(url),
  });
  const logError = error => console.error(firstLine(error));
  client.on(discord.Events.InteractionCreate, interaction => remote.onCommand(interaction).catch(logError));
  client.on(discord.Events.MessageCreate, message => remote.onMessage(message).catch(logError));
  client.on(discord.Events.Error, logError);
  // discord.js does not reconnect after some close codes, such as an invalid token. A bot with no connection cannot get /cancel or a reply.
  client.on(discord.Events.ShardDisconnect, event => {
    console.error(`Discord closed the connection (code ${event.code}). The bot stops. Examine the token, then start the bot again.`);
    process.exit(1);
  });
  client.once(discord.Events.ClientReady, ready => ready.application.commands.set(commandData(discord))
    .then(() => console.log('The bot is ready. Send /apply in a direct message to the bot.'))
    .catch(logError));
  await client.login(token);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(firstLine(error));
    process.exit(1);
  });
}
