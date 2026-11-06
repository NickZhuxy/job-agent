// Keeps a CSV record of submitted applications. Simplify's Job Tracker can import this file.
// Simplify maps each column during the import. It needs a company and a position title on each row.
import fs from 'fs';

export const APPLICATIONS_FILE = 'applications.local.csv';
const HEADER = ['Company', 'Position Title', 'Status', 'Posting Link', 'Notes'];

// Text from a job page must not run as a formula if the file opens in a spreadsheet.
function cell(value) {
  const text = String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const line = values => `${values.map(cell).join(',')}\n`;

// page: { title, heading } read from the job page before the submission.
export function describeJob({ title = '', heading = '' }, selection) {
  const named = selection?.role || '';
  const moreExact = named && heading.toLowerCase().includes(named.toLowerCase());
  return {
    company: selection?.company || title.match(/\bat\s+(.+)$/)?.[1]?.trim() || '',
    role: moreExact || !named ? heading : named,
  };
}

// A problem with this file must not hide that the application went to the employer.
export function recordApplication(file, { company, role, url, resume, date = new Date().toLocaleDateString('en-CA') }) {
  try {
    const isNew = !fs.existsSync(file) || fs.statSync(file).size === 0;
    const notes = `Applied ${date}.${resume ? ` Resume: ${resume}` : ''}`;
    fs.appendFileSync(file, `${isNew ? line(HEADER) : ''}${line([company, role, 'Applied', url, notes])}`, { mode: 0o600 });
    return { file };
  } catch (error) {
    return { error: error.message };
  }
}
