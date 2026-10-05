/** Import form (paste or CSV) and job list, shared by the House and Admin pages. */
import { api } from '../lib/api';
import { h } from '../lib/dom';
import { formatDate } from '../lib/format';
import { attempt, notify } from '../lib/page';
import type { Job } from '../lib/types';

const MAX_CSV_BYTES = 2_000_000;

export function importForm(houseId: number | null, onQueued: (jobId: number) => void): HTMLElement {
  const text = h('textarea', {
    placeholder: 'One YouTube link per line (up to 500)',
    'aria-label': 'YouTube links',
  });
  const file = h('input', {
    type: 'file',
    accept: '.csv,text/csv',
    'aria-label': 'Google Takeout CSV',
  });
  const scope = houseId === null ? {} : { houseId };

  return h(
    'div',
    {},
    h(
      'form',
      {
        on: {
          submit: (event) => {
            event.preventDefault();
            if (!text.value.trim()) return;
            void attempt(async () => {
              const { jobId } = await api<{ jobId: number }>('POST', '/api/imports/paste', {
                text: text.value,
                ...scope,
              });
              text.value = '';
              onQueued(jobId);
            });
          },
        },
      },
      text,
      h('p', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'Add links')),
    ),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            const chosen = file.files?.[0];
            if (!chosen) return;
            if (chosen.size > MAX_CSV_BYTES) {
              notify('That file is larger than 2 MB.', 'error');
              return;
            }
            void attempt(async () => {
              const csv = await chosen.text();
              const { jobId } = await api<{ jobId: number }>('POST', '/api/imports/csv', {
                csv,
                ...scope,
              });
              file.value = '';
              onQueued(jobId);
            });
          },
        },
      },
      h('label', {}, 'Takeout CSV ', file),
      h('button', { type: 'submit' }, 'Upload CSV'),
    ),
  );
}

function describe(job: Job): string {
  if (job.status === 'failed') return job.error ?? 'Failed';
  if (job.status !== 'succeeded' || !job.result)
    return job.status === 'running' ? 'Running…' : 'Waiting…';
  const r = job.result;
  const parts: string[] = [];
  for (const [key, label] of [
    ['added', 'added'],
    ['duplicates', 'already there'],
    ['alreadyShared', 'already shared'],
    ['invalidCount', 'not recognised'],
    ['unavailable', 'unavailable'],
    ['videos', 'checked'],
    ['ok', 'updated'],
  ] as const) {
    const value = r[key];
    if (typeof value === 'number' && value > 0) parts.push(`${value} ${label}`);
  }
  return parts.join(', ') || 'Done';
}

const JOB_LABELS: Record<string, string> = {
  paste_import: 'Pasted links',
  csv_import: 'CSV import',
  playlist_sync: 'Playlist sync',
  metadata_refresh: 'Fetch titles',
  apply_rules: 'Apply rules',
};

export function jobList(jobs: Job[]): HTMLElement {
  if (!jobs.length) return h('p', { class: 'muted' }, 'No imports yet.');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['#', 'What', 'Status', 'Result', 'When'].map((t) => h('th', { scope: 'col' }, t)),
        ),
      ),
      h(
        'tbody',
        {},
        ...jobs.map((job) =>
          h(
            'tr',
            {},
            h('td', {}, String(job.id)),
            h('td', {}, JOB_LABELS[job.type] ?? job.type),
            h('td', { class: `status-${job.status}` }, job.status),
            h('td', {}, describe(job)),
            h('td', {}, formatDate(job.finishedAt ?? job.createdAt)),
          ),
        ),
      ),
    ),
  );
}
