# QA report: <stream> (<lane area>)

- **Agent / stream:** <stream id> · **Device:** <name, udid/serial, OS> · **Theme:** <light|dark>
- **Build:** `builds/<sha8>` (<ref>, sha <full sha>, build number <n>) · variants used: devnet / testnet
- **Personas:** <idx @handle (identity id)> · **Window:** <start – end, local time>
- **Totals:** <n> stories run · <n> PASS · <n> PASS+ · <n> FAIL · <n> BLOCKED · <n> screenshots · <n> videos

## Summary table

| Test (story / row / edge) | Platform depth | Verdict (PASS / PASS+ / FAIL / BLOCKED / N/A) | Key evidence | One-line finding |
| --- | --- | --- | --- | --- |
| AUTH-08 | D | PASS | `evidence/L1i/AUTH-08/04-identity-found.png` | Identity found in 6 s; terms gate shown |

## Exit-matrix cells covered (Tier A)

| Row | Theme | Verdict | Evidence |
| --- | --- | --- | --- |
| A6 | dark | PASS+ | `evidence/L2i/A6/` |

## Per-test detail

### <ID> <title>

- Variant, signed-in persona, start state
- Steps executed (numbered, wall-clock timestamps)
- Observations (log lines quoted verbatim with timestamp and file; diagnostics excerpts)
- Assertions: each acceptance bullet of the PRD story → actual vs expected (copy compared with UX_SPEC §5)
- Screenshots / videos / ui-text: paths (say "FLAG_SECURE: ui-text evidence" where screenshots are black by design)
- Resources: memory samples around the test (from `memory.csv`), launch/boot timings, crash/exit info
- Verdict + reasoning

## Defects found

| ID | Sev | Title | Platform / variant / theme | Repro steps | Evidence | Suspected area / file:line | Mobile-only or shared with web? | Reproduced twice? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-<stream>-001 | S2 | | | 1. … 2. … | | | | |

## Global rules observed (G-1..G-16)

| Rule | Screens checked | Result | Evidence |
| --- | --- | --- | --- |

## Secrets check (E-25)

Output of `grep -rcF -f $QA_PERSONAS/<key file> $QA_EVIDENCE/<stream> | grep -v ':0$'` (must be empty): `<path to .txt>`

## Environment problems (not product defects)

| ID | Problem | Impact | Workaround |
| --- | --- | --- | --- |
| ENV-<stream>-01 | | | |

## Harness notes for the brief

<things the next wave should know: commands that misbehaved, ids that differ from the brief, timing>

## Not run / blocked, with reason
