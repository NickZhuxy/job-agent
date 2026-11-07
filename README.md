# Job Agent

[English](README.md) | [简体中文](README.zh-CN.md)

Job Agent helps you apply for jobs. It selects a resume for each job and fills the application form. As an option, it can make a tailored resume. By default, you review the form and submit it. You can also set the agent to sign and submit it.

## Application flow

![Application flow](docs/flowchart/application-flow.en.png)

1. The agent selects a job from a personalized job list.
2. The agent examines the job and decides if the job needs a tailored resume.
3. The agent selects a resume from your library. If you enable tailoring, it can run a resume skill to make a tailored resume.
4. The agent uploads the resume after you approve it, then fills the form.
5. The agent uses saved answers for known questions. For a new question, the agent writes a draft and you approve it.
6. The agent saves new answers in the applicant data.
7. You submit the application, or the agent submits it if you enable this function.

## Architecture

The agent has three layers. Playwright is a library that operates a browser. A CAPTCHA is a test that identifies a human user.

![Architecture](docs/flowchart/architecture.en.png)

| Part | Function |
| --- | --- |
| Playwright | Opens the page, reads the fields, writes the values, and reads the values again. |
| Rule engine | Matches fields to applicant data, checks model output, and compares the page values with the expected values. |
| Model | Selects a resume, starts tailoring, writes candidate values for fields that have no rule, and writes drafts for open questions. |
| User | Completes each CAPTCHA, approves resumes and drafts, answers follow-up questions, and submits the application. |

The login design keeps each site password in the macOS Keychain and gets verification codes from a dedicated mailbox. Rules do these two tasks, and the model cannot read passwords or email.

## Status

| Part | Status |
| --- | --- |
| Rule engine and Playwright form fill | Available |
| Automatic signature and submission | Available. Tested on local forms only. |
| Legal and demographic answers, and saved follow-up answers | Available. Tested on local forms only. |
| Readback of page values | Available |
| Setup from questions and documents | Available. Tested with `claude-sonnet-5-5` and fictional documents. |
| Model for fields that have no rule | Available. Tested with `claude-sonnet-5-5` on one real form. The OpenAI-compatible option is tested with a local test server only. |
| Resume selection and upload | Available. Selection is tested with `claude-sonnet-5-5`. Upload is tested on local forms only. |
| Automatic tailoring (optional) | Available for Claude Code only. Tested with one real job page. |
| Discord remote control (optional) | Available. Tested with fake Discord objects and local forms only. |
| Login and verification codes | Planned |
| Job list and tracker | Planned |

## Get started

Prerequisites:

- Node.js
- Google Chrome

Procedure:

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Start the setup:

   ```bash
   node src/setup.mjs
   ```

3. Answer the questions in the terminal.

4. Fill a form:

   ```bash
   node src/fill.mjs "<form-url>"
   ```

5. Examine the report in the terminal. The report shows the filled fields and the fields that you must complete.

6. Complete the form in Chrome and submit it.

7. Close Chrome.

## Enter your data

You do not need to edit a file. The setup collects your data in two ways:

- **Documents:** Enter the path of a resume or a folder. The setup reads PDF, Word (`.docx`), text, and Markdown files. In a folder, it reads the files at the top level only.
- **Questions:** The setup asks for each value that it did not find.

Each value from a document is a suggestion. You can accept it, change it, or clear it.

Without a model, the setup finds only your email, phone, LinkedIn, and GitHub in the documents. With a model, it finds more values. It shows the file names and asks for your approval before it sends text to the model.

The setup always asks you directly about work authorization, sponsorship, visa type, and demographic questions. It does not take these answers from a document.

### Add your undergraduate degree

The setup collects your current school only. To give your undergraduate degree, add this key to `profile.local.json`. Use the option text of the form:

```json
"undergraduate": {
  "school": "State University",
  "degree": "Bachelor's Degree",
  "discipline": "Computer Science",
  "disciplines": ["Mathematics", "Computer Science"],
  "edu_start_month": "August",
  "edu_start_year": "2019",
  "grad_month": "May",
  "grad_year": "2023"
}
```

The agent uses these values in two conditions:

- The form has an education section with an "Add another" button (Greenhouse). The agent adds a second entry and fills it. If a value has no exact option, the field stays empty for you, and the agent does not submit the form.
- The question contains "undergraduate" or "bachelor".

The agent does not answer a question about all schools that you attended. It asks you.

### Tell where you found the job

Set `referral` to a list of sources, for example `["LinkedIn", "Other"]`. For the question "How did you hear about this job?", the agent selects the first option that matches in this sequence:

1. The first source in your list.
2. A career website or a company website. A career fair is not a website.
3. A job board.
4. The other sources in your list.
5. An answer that you gave before for the same question.

If no option matches and the question is required, the agent asks you. The model does not answer this question.

### Questions with many answers

A required question can have many checkboxes. The agent asks you, and you enter one or more numbers. The agent keeps your answer for the same question. The model does not answer these questions.

## Legal and demographic answers

The setup saves your answers to these questions. The agent then uses these rules for each form.

| Question | Rule |
| --- | --- |
| Work authorization and sponsorship | The agent uses your yes or no answer in the regions that you enter. If a question names a different region, the agent asks you. |
| Demographic questions | If you select "decline", the agent selects the option to decline. If the form has no such option, it uses your preset answer. If you have no preset answer, it asks you. |
| "Have you worked here" | The agent compares your list of companies with the question, the URL, and the page headings. It selects "Yes" if it finds a match. Otherwise it selects "No". |

The agent asks you about follow-up questions, such as the type of visa that you will need. It saves your answer in `profile.local.json` and does not ask the same question again. It also uses the answer for a nearly identical question. The saved answers go on the form, and you examine the form before you submit it.

The profile does not store passwords or social security numbers. The model does not get these questions, demographic questions, visa questions, or questions that ask for all the schools that you attended.

## Sign and submit automatically

When the setup asks if the agent should sign and submit, enter `y`. The agent then does these steps after it fills the form:

1. It checks each required checkbox that accepts terms or certifies your data. It leaves optional checkboxes empty.
2. It types your full name in signature fields and the current date in signature date fields.
3. It examines the form. It does not submit if a required field is empty or if the page does not show an expected value.
4. It clicks the submit button one time.
5. It looks for the confirmation on the page and records the result in the report.

If the page shows a CAPTCHA or asks for a verification code, you must complete it in Chrome. The agent then continues to look for the confirmation. An optional module can enter an emailed code for you. See [Enter an emailed code automatically](#enter-an-emailed-code-automatically-optional).

To fill a form and not submit it, use the `--no-submit` option:

```bash
node src/fill.mjs "<form-url>" --model --no-submit
```

At the end, the command shows a short summary: the result, the resume, and the answers to examine. To see the full report in JSON (JavaScript Object Notation), add the `--json` option.

An application that the agent submits is an application from you. Examine your profile before you enable this function.

### Import your applications to Simplify

The agent cannot write to the Simplify Job Tracker. When the agent finds the confirmation of a submission, it adds one row to `applications.local.csv` in the current folder. An application that you submit yourself does not get a row. Git ignores this file.

To import the file:

1. In the Simplify Job Tracker, select **Import CSV**.
2. Select `applications.local.csv`.
3. Map each column to the tracker field. Map `Company`, `Position Title`, `Status`, `Posting Link`, and `Notes`. The application date is in `Notes`.
4. Examine the preview. If a row does not have a company, enter the company or skip the row.
5. Complete the import.
6. Move `applications.local.csv` to the Trash. The next submission makes a new file. If you import the same rows again, you get duplicate records.

The setup saves your data in `profile.local.json`. Only your user account can read this file, and Git ignores it. To change your data, run the setup again. The setup keeps your saved answers.

If `profile.local.json` does not exist, `src/fill.mjs` starts the setup first.

## Use a model

The model completes required fields that have no rule. It gets the field labels, the field options, the first part of the page text, and the `model_context` section of your profile.

The agent does not send sensitive questions or the other profile values to the model.

Prerequisites:

- An API key, or a local model server

Procedure:

1. Set the model configuration. Use one of these two configurations:

   - Claude:

     ```bash
     export ANTHROPIC_API_KEY="<your-key>"
     ```

   - A server that uses the OpenAI chat completions API:

     ```bash
     export JOB_AGENT_PROVIDER="openai-compatible"
     export JOB_AGENT_BASE_URL="<server-url>"
     export JOB_AGENT_MODEL="<model-name>"
     export JOB_AGENT_API_KEY="<your-key>"
     ```

2. Fill a form with the `--model` option:

   ```bash
   node src/fill.mjs "<form-url>" --model
   ```

3. Examine each draft in the terminal. Accept, edit, revise, or skip the draft.

4. Complete the form in Chrome and submit it.

To use a different Claude model, set `JOB_AGENT_MODEL`. The default model is `claude-sonnet-5-5`.

The agent writes a model answer that has options only if the answer matches one option exactly. The agent saves the drafts that you approve in `profile.local.json`.

## Select a resume

The agent selects a resume from your resume folders. You do not need a special data format. Use folder and file names that describe each resume.

Prerequisites:

- A model configuration
- A folder of general resumes, with one subfolder for each category
- A folder of targeted resumes, with one subfolder for each company and role. Start each subfolder name with your name, then the company. For example: `Alex_Rivera_Acme_Backend`.

Procedure:

1. Enter the two folders when the setup asks for them.

2. Fill a form with no resume path:

   ```bash
   node src/fill.mjs "<form-url>" --model
   ```

3. Examine the recommended resume in the terminal.

4. Accept the resume, enter a resume id or a path, or skip the upload.

The agent attaches a file only after you approve it. Some forms upload the file immediately when the agent attaches it.

The model gets the file names and folder names. It does not get the local paths. It does not get the resume content, but the resume check in the next section is an exception. The agent offers a targeted resume only if the job page or URL contains the company name.

To use a specified resume, enter the profile and the resume path:

```bash
node src/fill.mjs "<form-url>" profile.local.json path/to/resume.pdf --model
```

## Accept a resume automatically (optional)

By default, you approve each resume. If you enable this function, the agent checks the recommended resume. It accepts the resume if the resume passes each check.

Prerequisites:

- The `pdfinfo` and `pdftotext` commands from Poppler, a set of PDF tools
- A model configuration

Procedure:

1. Open `profile.local.json`.

2. Add `auto_accept` to `resume_library`. Enter your own values:

   ```json
   "auto_accept": {
     "max_pages": 1,
     "must_include": ["Alex Rivera", "Expected May 2027"],
     "must_not_include": ["Old School"]
   }
   ```

3. Fill a form:

   ```bash
   node src/fill.mjs "<form-url>" --model
   ```

The agent does these checks in this sequence:

1. Rules examine the page count, the text that the resume must contain, and the words that it must not contain. They also look for a phrase of 8 or more words that occurs two times.
2. If the rules find no problem, the model reads the text of the resume. It looks for garbled text, repeated content, conflicting facts, and text that a tool left in the resume.

If a check finds a problem or cannot complete, the agent shows the problem and you decide.

If tailoring fails, the agent does not do the checks and you decide.

Limits:

- The checks do not find a claim that is false. Read each resume that you did not write.
- If you also enable automatic submission, the agent can submit a resume that you did not read.

## Tailor a resume automatically (optional)

People make tailored resumes in different ways. Some people use their own agent. Other people edit the resume in a chat window. This function shows one method as a reference: Claude Code with a resume skill. This project does not include a resume skill. You must supply your own.

If you do not use this function, all the other steps stay the same. The agent selects a resume from your folders, but it does not make a new resume for a job. To use a tailored resume that you made, enter its path when the agent shows the resumes.

When the model recommends tailoring, the agent starts your resume skill. You do not start the skill or enter a path. The agent then shows you the new resume for approval.

Prerequisites:

- [Claude Code](https://claude.com/claude-code), with a login
- A resume skill for Claude Code
- A rule that tells the agent which jobs need tailoring

Procedure:

1. Run the setup. Enter `y` when it asks if you want automatic tailoring. Then enter these items:

   - The jobs that need a tailored resume
   - The name of the resume skill
   - The folders with your source material

2. Fill a form:

   ```bash
   node src/fill.mjs "<form-url>" --model
   ```

3. Wait for the tailored resume. This can take several minutes.

4. Read the new resume and the notes in the terminal. The notes show the changes and the claims to examine.

5. Accept the resume, enter a different resume, or skip the upload.

The agent saves the PDF, its source file, `job.txt`, and `tailor.log` in a new folder in your targeted resume folder.

Limits for each run:

- The tool can write only in the new folder. An operating system sandbox applies this limit to the commands that the tool runs.
- The tool has no network access.
- The Read tool of the tool can read only the material folders and the skill folders. The LaTeX commands can read other files, so read the PDF before you accept it.
- If the sandbox is not available, the tool does not start.
- The tool does not get the API keys from the agent. It uses its own login.
- The tool stops after 15 minutes or at a cost of 5 USD. To change these limits, set `timeout_minutes` and `max_budget_usd` in `resume_library.tailor`.
- The tool uses the default model of Claude Code. To use a different model or effort level, set `model` and `effort` in `resume_library.tailor`. For example: `"model": "claude-opus-5-5", "effort": "medium"`.

If tailoring fails, the agent shows the error and recommends a resume from your library.

To remove this function from the code, delete `src/tailor.mjs` and `test/tailor.test.mjs`. The other steps do not use these files.

## Control the agent from Discord (optional)

Use this function to start an application from your phone. The agent runs on your computer, and Discord carries the messages. If you do not use this function, the other steps stay the same.

Prerequisites:

- Node.js 20.12 or later
- A completed setup. You must run `node src/setup.mjs` on the computer, because the bot does not start the setup.
- The computer stays on and has a network connection.

### Set up the bot

Do these steps one time. Do not send the token to a person or a chat. Each person who has the token can control the bot account.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications). Create an application.
2. On the **Installation** page, set **Install Link** to **None**. Save the change.
3. On the **Bot** page, clear **Public Bot**. Other people then cannot add your bot to a server.
4. On the **Bot** page, reset the token and copy it. You do not need to enable a privileged intent.
5. In Discord, create a server for yourself only. Discord shows the commands of a bot in a direct message only if you and the bot are in the same server.
6. On the **OAuth2** page, open the URL generator. Select the `bot` and `applications.commands` scopes. Select no permissions. Open the URL and add the bot to your server.
7. In Discord, enable **Developer Mode** in **Advanced** settings. Open your profile and copy your user ID.
8. Make a file with the name `.env.local` in the project folder. Git ignores this file.

   ```text
   DISCORD_BOT_TOKEN=<your-token>
   DISCORD_OWNER_ID=<your-user-id>
   ```

9. Limit the file to your user account:

   ```bash
   chmod 600 .env.local
   ```

10. Install the dependencies. This step also installs `discord.js`.

    ```bash
    npm install
    ```

### Start the bot

1. Start the bot. The `caffeinate` command stops the Mac from going to sleep while the bot runs.

   ```bash
   caffeinate -i node src/discord.mjs --model
   ```

   The command also accepts a profile path and the `--no-submit` option.

2. In Discord, open a direct message with the bot from the member list of your server.

### Use the commands

The commands operate only in the direct message.

| Command | Function |
| --- | --- |
| `/apply url:<form-url>` | Starts an application. If a job runs, the new job waits in a queue, and the bot tells you. |
| `/status` | Shows the current job, its step, the open question, and the queue. |
| `/cancel` | Stops the current job. Chrome closes for that job. Use `/cancel job:<number>` to remove a job from the queue. |

Jobs run one at a time. The bot asks each question that the terminal asks. Reply in a normal message:

- **Resume:** The bot sends the recommendation. If the agent made a tailored resume, the bot also sends the PDF and the notes. Reply with `a`, a resume id, `p`, or `s`. If you set `auto_accept` and the resume passes the check, the agent accepts the resume. The bot does not ask you and does not send the PDF.
- **Draft:** Reply with `a`, `e`, `r`, or `s`.
- **New question:** Reply with your answer or the number of an option. To complete the field later in Chrome, reply with `-`.

At the end, the bot sends the same summary as the terminal.

These steps need the computer:

- **CAPTCHA or verification code:** The bot tells you to go to the computer. The agent waits for 10 minutes, then reports that it found no confirmation. If you enable the emailed code module, the agent first tries to enter the emailed code. The code does not go to Discord.
- **Form that the agent did not submit:** The form stays open in Chrome, and the next job starts. If the bot stops, Chrome closes.

You cannot cancel a job at the submission step. The queue is in memory. If the bot stops, the queue and the current job stop.

The bot does not start a URL again if the agent clicked its submit button in this run, or if the URL is in `applications.local.csv`. To apply again, use the terminal.

### Data that goes to Discord

Discord stores the messages and the files. Discord messages do not have end-to-end encryption. This data goes to Discord:

- The job URLs, the company and role names, and the error messages
- The names of your resume files and folders, and the reason for the recommendation
- The tailored PDF and its notes. The PDF contains your contact data. The other resumes stay on the computer.
- The new questions from forms, their options, and your replies
- The model drafts and your changes
- The problems from the resume check. A problem can quote text from the resume or a value from `auto_accept`.
- The summary: the result, the resume name, the labels of the fields not filled or skipped, and the answers from you and from the model

The other values from your profile do not go to Discord. If the page changes a value, the summary names the field and does not show the value. The bot hides each line that names a password or a social security number, and each value with the format of a social security number.

The bot accepts commands and replies only from the user ID in `DISCORD_OWNER_ID`, and only in the direct message. It ignores all other users and servers. Text from a job page is data. It cannot start a command or answer a question. Chrome and the tailoring tool do not get the token.

To remove this function from the code, delete `src/discord.mjs` and `test/discord.test.mjs`, then run `npm uninstall discord.js`. The other steps do not use these files.

## Enter an emailed code automatically (optional)

Some job platforms send a verification code to your email after you click submit. This module reads that code from your Gmail mailbox and enters it in the form. It works with Greenhouse only.

The module does not solve a CAPTCHA. A CAPTCHA stays with you.

If you do not use this module, all the other steps stay the same. You enter the code in Chrome.

Prerequisites:

- [Claude Code](https://claude.com/claude-code), with a login
- The Gmail connector in your Claude account
- The application email must arrive in the Gmail mailbox of that connector. To find this mailbox, read the address in the connector settings. If you apply with a different address, forward the mail of the job platform to this mailbox.

Procedure:

1. Open `profile.local.json`.

2. Add this setting:

   ```json
   "email_code": { "enabled": true }
   ```

3. Submit one application with the `auto_submit` setting on, and stay at the computer:

   ```bash
   node src/fill.mjs "<form-url>" --model
   ```

4. Read the terminal. It tells you if the agent entered the code.

The agent waits for the code for 120 seconds. To change this time, set `wait_seconds` in `email_code`.

What the agent does when the page asks for a code:

1. It starts Claude Code, which searches for mail from the job platform that arrived after the submit click.
2. It examines the result. It rejects the result if any of these conditions is true:
   - The sender is not the job platform.
   - The mail arrived before the submit click.
   - The code does not have the format of the platform.
   - The code is not in the mail that the tool read.
3. It enters the code one time and clicks the submit button again.

If a step fails, the agent shows the reason and waits for you to complete the page in Chrome. The agent does not try a code two times.

Limits for each run:

- Email text is untrusted, because a message can contain instructions. The program, not the model, decides if a code is correct.
- The tool can use only two Gmail tools: search threads and get message. It has no tools to send, forward, label, or delete mail. It has no shell, file, or network tools.
- The tool does not get the API keys from the agent. It uses its own login.
- The agent does not save or log the code. The code is not in the report.
- Each search stops at a cost of 0.25 USD. A usual search costs approximately 0.02 USD.
- Run one application at a time. If two applications wait for a code, the agent can read the code of the other application.

To remove this function from the code, delete `src/emailcode.mjs` and `test/emailcode.test.mjs`. The other steps do not use these files. If the `email_code` setting stays in your profile, the agent shows a message and waits for you.

## Test

Run the tests:

```bash
npm test
```

## Documents

- [Editable flowcharts](docs/flowchart/): Open the `.excalidraw` files at [excalidraw.com](https://excalidraw.com). Each diagram has an English file (`.en`) and a Chinese file (`.zh`).
- [Roadmap, in Chinese](docs/roadmap.md)

## License

[MIT](LICENSE)
