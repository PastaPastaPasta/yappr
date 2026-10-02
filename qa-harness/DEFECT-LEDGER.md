# Defect ledger: Yappr Mobile 1.0 agentic QA

Consolidated register, **sorted by severity** (S1 → S4), one id space (D-001…) assigned by the orchestrator at merge.
"Seen as" keeps the stream-local ids (D-L2a-003, …) and SR ids. Status: candidate · confirmed · resolved-not-a-bug ·
duplicate (of D-xxx) · shared-with-web. ENV rows (harness, emulator, network outage) are listed separately at the end and
are never product defects. Severity scale: QA-PLAN §5.

| ID | Sev | Platforms / variant / theme | Stream(s) / seen as | Title | Status + root cause (file:line) | Stories | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Static-review findings (SR-xx)

| ID | Sev (proposed) | Area | Finding (file:line) | Device verdict (REPRODUCED / PARTIAL / NOT REPRODUCED / BLOCKED) | Linked D-ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- |

## Environment problems (not product defects)

| ID | Stream | Problem | Impact on coverage | Workaround / harness note |
| --- | --- | --- | --- | --- |
