# Job Agent

Job Agent helps you apply for jobs. It selects a resume for each job and fills the application form. You review the form and submit it.

## Application flow

![Application flow](docs/flowchart/application-flow.png)

1. The agent selects a job from a personalized job list.
2. The agent examines the job and decides if the job needs a special resume.
3. The agent uses a resume from the general resume library, or it makes a special resume with a resume skill.
4. The agent fills the form with the selected resume.
5. The agent uses saved answers for known questions. For a new question, the agent writes a draft and you approve it.
6. The agent saves new answers in the applicant data.
7. You submit the application.

## Architecture

The agent has three layers. Playwright is a library that operates a browser. A CAPTCHA is a test that identifies a human user.

![Architecture](docs/flowchart/architecture.png)

| Part | Function |
| --- | --- |
| Playwright | Opens the page, reads the fields, writes the values, and reads the values again. |
| Rule engine | Matches fields to applicant data, checks model output, and compares the page values with the expected values. |
| Model | Writes candidate values for fields that have no rule, and writes drafts for open questions. |
| User | Completes each CAPTCHA, approves drafts, and submits the application. |

The agent keeps each site password in the macOS Keychain. It gets verification codes from a dedicated mailbox. Rules do these two tasks, and the model cannot read passwords or email.

## Status

| Part | Status |
| --- | --- |
| Rule engine and Playwright form fill | Available |
| Readback of page values | Available |
| Login and verification codes | Planned |
| Model for fields that have no rule | Planned |
| Job list and resume selection | Planned |

## Run the form fill

Prerequisites:

- Node.js
- Google Chrome

Procedure:

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Copy the example profile:

   ```bash
   cp examples/profile.example.json profile.local.json
   ```

3. Enter your data in `profile.local.json`.

4. Fill a form:

   ```bash
   node src/fill.mjs "<form-url>" profile.local.json path/to/resume.pdf
   ```

5. Examine the report in the terminal. The report shows the filled fields and the fields that you must complete.

6. Complete the form in Chrome and submit it.

7. Close Chrome.

## Documents

- [Editable flowcharts](docs/flowchart/): Open the `.excalidraw` files at [excalidraw.com](https://excalidraw.com).
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
