#!/bin/sh
# usage: extract.sh <task-id> <name>  -> /tmp/claude/yappr-mobile/<name>.md
python3 - "/private/tmp/claude-501/-Users-pasta--t3-worktrees-yappr-t3code-1b9cd312/f2901b31-a42d-4001-976f-dfe796928b7f/tasks/$1.output" "/tmp/claude/yappr-mobile/$2.md" <<'PY'
import json,sys
last=None
for line in open(sys.argv[1]):
    try: o=json.loads(line)
    except: continue
    m=o.get('message') or {}
    if m.get('role')=='assistant':
        c=m.get('content')
        if isinstance(c,list):
            t=''.join(x.get('text','') for x in c if x.get('type')=='text')
            if t.strip(): last=t
open(sys.argv[2],'w').write(last or '')
print(sys.argv[2], len(last or ''))
PY
