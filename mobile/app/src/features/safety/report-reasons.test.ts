import { readFileSync } from 'fs';
import { join } from 'path';

import {
  LEGACY_REASON_MAX,
  OTHER_REASON_CODE,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_STATUSES,
  reportIsValid,
  reportReasonLabel,
  reportReasonsUpTo,
  reportStatusLabel,
} from './report-reasons';

/** lib/reports.ts can't be imported here (it pulls in the SDK helpers), so its source is read. */
const source = readFileSync(join(__dirname, '../../../../../lib/reports.ts'), 'utf8');

const entries = (block: string) =>
  [...block.matchAll(/\{\s*code:\s*(\d+)(?: as const)?,\s*label:\s*'([^']+)',\s*hint:\s*'([^']+)'\s*\}/g)].map((m) => ({
    code: Number(m[1]),
    label: m[2],
    hint: m[3],
  }));

const section = (name: string) => {
  const start = source.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  // The array ends at its own `]` (`])`, or `].map(` where its entries are frozen): not at a later array's.
  const ends = ['])', '].map('].map((marker) => source.indexOf(marker, start)).filter((index) => index >= 0);
  return source.slice(start, Math.min(...ends));
};

describe('report reasons', () => {
  it('match lib/reports.ts code for code (the codes are stored on chain)', () => {
    expect(REPORT_REASONS).toEqual(entries(section('REPORT_REASONS')));
    expect(REPORT_STATUSES).toEqual(entries(section('REPORT_STATUSES')).map(({ code, label }) => ({ code, label })));
    expect(source).toContain(`OTHER_REASON_CODE = ${OTHER_REASON_CODE}`);
    expect(source).toContain(`REPORT_NOTE_MAX_LENGTH = ${REPORT_NOTE_MAX_LENGTH}`);
  });

  it('validates as reportInputProblem does', () => {
    expect(reportIsValid(null, '')).toBe(false);
    expect(reportIsValid(42, '')).toBe(false);
    expect(reportIsValid(0, '')).toBe(true);
    expect(reportIsValid(OTHER_REASON_CODE, '   ')).toBe(false);
    expect(reportIsValid(OTHER_REASON_CODE, 'A scam link')).toBe(true);
    expect(reportIsValid(1, 'x'.repeat(REPORT_NOTE_MAX_LENGTH))).toBe(true);
    expect(reportIsValid(1, 'x'.repeat(REPORT_NOTE_MAX_LENGTH + 1))).toBe(false);
  });

  it('offers reason 9 only to a contract that accepts it, and always by email', () => {
    expect(reportIsValid(9, '')).toBe(true);
    expect(reportIsValid(9, '', 9)).toBe(true);
    expect(reportIsValid(9, '', LEGACY_REASON_MAX)).toBe(false);
    expect(reportReasonsUpTo(LEGACY_REASON_MAX).map((reason) => reason.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(reportReasonsUpTo().map((reason) => reason.code)).toContain(9);
  });

  it('labels known and unknown codes', () => {
    expect(reportReasonLabel(2)).toBe('Hate');
    expect(reportReasonLabel(99)).toBe('Reason 99');
    expect(reportStatusLabel(2)).toBe('Content removed');
    expect(reportStatusLabel(9)).toBe('Status 9');
  });

  it('says "hidden", not "removed", where the moderators hide and never delete (social v18)', () => {
    expect(reportStatusLabel(2, true)).toBe('Content hidden');
    // The other codes read the same on both cuts, and lib\'s HIDE_REPORT_STATUSES spells the same labels.
    expect(reportStatusLabel(1, true)).toBe('No action taken');
    expect(reportStatusLabel(3, true)).toBe('Author actioned');
    expect(source).toContain("label: 'Content hidden'");
  });
});
