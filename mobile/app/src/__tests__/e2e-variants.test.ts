/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import { VARIANTS } from '../variants';

/**
 * mobile/e2e/run.sh picks the installed app's id and URL scheme from its own
 * `--variant` table. It must name every variant the app builds (MARCH-6: the
 * staging release variant was missing, so the documented build could not run
 * the smoke suite) and agree with src/variants.ts on each one.
 */
const RUN_SH = path.join(__dirname, '../../../e2e/run.sh');

function runShVariants(): Record<string, { applicationId: string; scheme: string }> {
  const table: Record<string, { applicationId: string; scheme: string }> = {};
  const line = /^\s+([a-z-]+)\) app_id=(\S+); scheme=(\S+) ;;$/gm;
  for (const [, variant, applicationId, scheme] of fs.readFileSync(RUN_SH, 'utf8').matchAll(line)) {
    table[variant] = { applicationId, scheme };
  }
  return table;
}

describe('mobile/e2e/run.sh variants', () => {
  const table = runShVariants();

  it('names every variant the app builds, and no other', () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(VARIANTS).sort());
  });

  it.each(Object.entries(VARIANTS))('%s uses the variant table application id and scheme', (variant, entry) => {
    expect(table[variant]).toEqual({ applicationId: entry.applicationId, scheme: entry.scheme });
  });

  it('lists every variant in its usage text and its error message', () => {
    const script = fs.readFileSync(RUN_SH, 'utf8');
    const names = Object.keys(VARIANTS).sort();
    const usage = /^#\s+--variant ([a-z|-]+)\s/m.exec(script)?.[1].split('|') ?? [];
    expect(usage.sort()).toEqual(names);
    const error = /--variant must be ([a-z, -]+)"/.exec(script)?.[1].split(/, | or /) ?? [];
    expect(error.sort()).toEqual(names);
  });
});
