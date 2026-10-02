#!/usr/bin/env python3
"""Single source of truth for the story -> tier -> stream assignment.

  stories.py matrix <PRD.md>   -> STORY-MATRIX.md skeleton (all stories)
  stories.py plan <PRD.md>     -> the per-stream assignment tables for QA-PLAN.md
  stories.py check <PRD.md>    -> verify every PRD story is assigned exactly once and on both platforms

Depth per platform: D = full depth (every acceptance bullet, evidence per bullet), S = smoke (main path + one
screenshot), N/A = impossible on that platform (reason in NOTES). P0 stories are D on both platforms.
"""
import re
import sys

LANES = {
    "L1": "Onboarding, sign-in, accounts, security, engine lifecycle, deep links",
    "L2": "Feeds, post detail and threads, compose, write status",
    "L3": "Engagement, profiles, explore, safety",
    "L4": "Notifications, messages, settings, accessibility, testnet read-only pass",
}

# Tier A = EXECUTION section 7 exit-matrix rows (A1..A15). B = core-risk depth. C = data/write flows.
# D = secondary. E = accessibility / regression / static (the edge battery E-xx is listed separately).
A_ROWS = {
    "A1": ("Signed-out browse: welcome, feed, thread, profile, explore", "both variants"),
    "A2": ("Sign in: key exchange (responder), key entry WIF + hex, key registration, restore, switch account, sign out", "devnet (+ testnet key entry, read-only)"),
    "A3": ("EULA gate; Lockdown screen", "devnet (Lockdown: physical iPhone only)"),
    "A4": ("Home: For You, Following, Top, pill, pull-to-refresh, infinite scroll", "both"),
    "A5": ("Thread: replies, removed and deleted stubs, engagements", "both"),
    "A6": ("Compose: post, reply, quote, 10-part thread, mentions, hashtags, NSFW, counter, drafts, check again / retry", "devnet"),
    "A7": ("Engagement: like, repost, bookmark + Bookmarks, share, delete own", "devnet"),
    "A8": ("Profiles: tabs, follow, lists, edit (DashPay + extension)", "both (edit: devnet)"),
    "A9": ("Explore: search users/hashtags/posts, trending, Top, Creators, hashtag page", "both"),
    "A10": ("Notifications: filters, mark-visible-read, badge, toggles", "devnet"),
    "A11": ("Messages: DM v5 1:1 + groups (devnet); legacy 1:1 read (testnet)", "both"),
    "A12": ("Safety: block / unblock / list, report, NSFW modes, media gate, removed stubs", "devnet"),
    "A13": ("Settings: account, notifications, privacy, appearance, about, terms, diagnostics", "both"),
    "A14": ("Deep links: cold and warm (light only)", "both"),
    "A15": ("Engine resilience: renderer kill recovers; background flush; offline -> online (light only)", "devnet"),
}

# id: (lane, tier, a_row or "", ios_depth, android_depth, note)
S = {}
def add(ids, lane, tier, row="", ios="D", android="D", note=""):
    for i in ids.split():
        assert i not in S, i
        S[i] = (lane, tier, row, ios, android, note)

# ---------------- L1 ----------------
add("AUTH-01 AUTH-02", "L1", "A", "A1")
add("AUTH-03 AUTH-04 AUTH-06 AUTH-08 AUTH-10 AUTH-11", "L1", "A", "A2",
    note="key exchange via bin/wallet-respond (QR path; release builds show no dash-key: text)")
add("AUTH-09", "L1", "A", "A3")
add("NET-06", "L1", "A", "A3", ios="D", android="N/A",
    note="iOS only. Needs Lockdown Mode (physical iPhone + TestFlight); the release build has no simulate switch -> BLOCKED(env) on simulator unless a device is provided")
add("NET-11 POST-07", "L1", "A", "A14", note="cold + warm; https links expected unresolved until OQ-8 association files ship")
add("NET-04", "L1", "A", "A15", note="qa engine-kill; 3 kills in 2 min -> 'Couldn't connect'")
add("AUTH-05 AUTH-07 AUTH-12 AUTH-14", "L1", "B")
add("NET-01 NET-09", "L1", "B")
add("SET-08", "L1", "A", "A13", note="Copy diagnostics: iOS clipboard-get; Android read the screen with ui-text")
add("SET-01 SET-02 SET-06 SET-07", "L1", "A", "A13")
add("NET-07 NET-08", "L1", "D")
add("NET-10", "L1", "D", ios="S", android="D", note="only reachable if sakura refuses a write as out of date; else BLOCKED(no trigger)")
add("AUTH-15", "L1", "D", ios="D", android="S")
add("AUTH-13", "L1", "E", ios="S", android="S", note="assert App Connect is ABSENT everywhere (flag off)")

# ---------------- L2 ----------------
add("FEED-01 FEED-02 FEED-04 FEED-05 FEED-06 FEED-07", "L2", "A", "A4")
add("POST-02 POST-04 POST-06", "L2", "A", "A5")
add("POST-05", "L2", "A", "A5", note="dev only; needs a deleted root: L2 deletes its own root after replies")
add("POST-01", "L2", "A", "A1")
add("COMP-01 COMP-02 COMP-03 COMP-04 COMP-05 COMP-06 COMP-07 COMP-08 COMP-09 COMP-10", "L2", "A", "A6",
    note="Unicode/emoji/RTL typing only on iOS (Maestro inputText is ASCII-only on Android)")
add("COMP-11 FEED-11 NET-03 NET-05", "L2", "B", note="NET-03/NET-05 fault injection: Android `qa network stall`; iOS BLOCKED(env) for the offline/stall parts")
add("NET-02", "L2", "A", "A15", ios="N/A", android="D",
    note="iOS Simulator cannot go offline per device (host network) -> BLOCKED(env) on iOS")
add("FEED-08 FEED-09 FEED-12 POST-03", "L2", "C")
add("POST-08 POST-09", "L2", "D", note="needs a private post / poll on sakura; search corpus first")
add("POST-10 COMP-12", "L2", "C", ios="D", android="S")
add("FEED-03", "L2", "D", ios="S", android="D")
add("FEED-10", "L2", "D", ios="D", android="S", note="testnet build only (v2): read-only, change feed language and observe")
add("COMP-13", "L2", "D", ios="S", android="D")

# ---------------- L3 ----------------
add("ENG-01 ENG-02 ENG-03 ENG-04 ENG-05 ENG-06", "L3", "A", "A7")
add("PROF-01", "L3", "A", "A1")
add("PROF-02 PROF-03 PROF-04 PROF-07 PROF-08", "L3", "A", "A8")
add("PROF-06", "L3", "A", "A8", note="testnet (v2): form, counters and validation only; NEVER tap Save on testnet")
add("EXPL-01", "L3", "A", "A1")
add("EXPL-02 EXPL-03 EXPL-04 EXPL-05 EXPL-07", "L3", "A", "A9")
add("SAFE-01 SAFE-02 SAFE-03 SAFE-04 SAFE-06 SAFE-07", "L3", "A", "A12",
    note="SAFE-04: sakura has a seated team (E1); if it refuses, assert the 'elects its moderation team' path")
add("ENG-07 ENG-08", "L3", "B")
add("PROF-09 PROF-11 PROF-13 SAFE-08", "L3", "C")
add("SAFE-05", "L3", "C", ios="D", android="S", note="testnet build: mail composer / copied address (no mail app on simulators -> copy path)")
add("SAFE-09", "L3", "C", ios="S", android="S", note="needs a banned persona; likely BLOCKED(no fixture)")
add("PROF-05", "L3", "D")
add("PROF-10 PROF-12 EXPL-06", "L3", "D", ios="D", android="S")
add("EXPL-08 SAFE-10", "L3", "D", ios="S", android="D")

# ---------------- L4 ----------------
add("NOTIF-01 NOTIF-02 NOTIF-03 NOTIF-04 NOTIF-05", "L4", "A", "A10", note="L4i and L4a generate each other's notifications (96 <-> 97)")
add("DM-01 DM-03 DM-04 DM-05 DM-06 DM-07", "L4", "A", "A11", note="1:1 between 96 (L4i) and 97 (L4a); group with 96+97+98")
add("DM-11", "L4", "A", "A11", note="testnet (v3) legacy read: needs a signed-in testnet identity with DMs -> likely BLOCKED(no fixture); verify gating (no New group / Group info)")
add("SET-03 SET-04 SET-05", "L4", "A", "A13")
add("DM-14", "L4", "A", "A15", note="kill right after 'Sent'; relaunch; nothing lost")
add("DM-02 DM-08 DM-10", "L4", "B", note="DM-02 uses persona-key --purpose encryption (key-entry users)")
add("NOTIF-08 DM-13", "L4", "C")
add("DM-09 DM-12", "L4", "C", ios="D", android="S")
add("NOTIF-09", "L4", "D")
add("NOTIF-06 NOTIF-07", "L4", "D", ios="D", android="S", note="v11 / windowed: devnet runs v11")
add("SET-09", "L4", "D")
add("A11Y-01 A11Y-02 A11Y-03 A11Y-04 A11Y-05 A11Y-07 A11Y-08", "L4", "E",
    note="A11Y-02: TalkBack on Android; iOS Simulator has no VoiceOver -> label audit with ui-text")
add("A11Y-06 A11Y-09", "L4", "E", ios="D", android="S")

EDGE = [
    ("E-01", "Offline browse + write attempts (G-1, NET-02), back online refreshes once", "L2a", "Android only"),
    ("E-02", "Slow network (`network slow/edge`): cold start, feed paging, compose", "L2a", ""),
    ("E-03", "DAPI unreachable while OS online (`network stall`): G-11 errors, NET-03 backoff, recovery", "L1a", ""),
    ("E-04", "Engine renderer kill during list scroll and during an in-flight write (no resend)", "L1i, L1a", ""),
    ("E-05", "3 engine kills within 2 min -> 'Couldn't connect' banner, no loop", "L1i, L1a", ""),
    ("E-06", "Account switch mid-write (98 <-> 90): write stays attributed, no stale data after switch", "L1i", ""),
    ("E-07", "App kill mid-write (post, like, follow; DM on L4): relaunch shows truth, no duplicate", "L2i, L2a, L4a", ""),
    ("E-08", "Unconfirmed write (stall right after broadcast): 'Not confirmed yet · Check again', no blind resend", "L2a", "Android only"),
    ("E-09", "Sakura quorum/DAPI errors: categorized messages, diagnostics error ring, recovery (record any outage window)", "all", "note times"),
    ("E-10", "RTL content: Arabic + Hebrew posts (typed on iOS), read on Android; mixed-direction handles", "L2i -> L2a", ""),
    ("E-11", "Limits: 1000 chars, 2000 UTF-8 bytes with emoji/ZWJ/CJK; over-limit highlight; grapheme-safe truncation", "L2i (Unicode), L2a (ASCII)", ""),
    ("E-12", "Font scale 200% / AX5 on every main screen; no clipped text; action-bar counts move to labels", "L4i, L4a", ""),
    ("E-13", "Runtime theme switch (System/Light/Dark) + both OS appearances on every main screen", "L4i, L4a", ""),
    ("E-14", "Small screen: Android `qa screen small` (720x1280) on main flows; iOS SE needs an extra simulator (open question)", "L3a", ""),
    ("E-15", "Android back + predictive back gesture on every stack, modal, sheet; no app exit surprises", "L3a, L1a", "Android only"),
    ("E-16", "Keyboard: editor growth, header/counter visible, paste with line breaks, hardware Ctrl/Cmd+Enter", "L2i, L2a", ""),
    ("E-17", "Screen reader basics: TalkBack walk (Android), label audit with ui-text (iOS)", "L4a, L4i", ""),
    ("E-18", "Reduce Motion: no springs, no heart burst, pill jumps", "L4i, L4a", ""),
    ("E-19", "Rotation request: app stays portrait (both)", "L3i, L3a", ""),
    ("E-20", "Background flush: DM v5 + drafts survive background -> kill", "L4i, L4a", ""),
    ("E-21", "Memory: 500-post scroll with `qa memory --watch` (no growth; <= 250 MB after 10 min mixed use)", "L2i, L2a", ""),
    ("E-22", "Cold start timing: cached vs fresh (M6) from Diagnostics timings + screenshots", "L1i, L1a", ""),
    ("E-23", "Reinstall: uninstall/reinstall wipes keys (iOS Keychain survives uninstall -> app must wipe)", "L1i, L1a", ""),
    ("E-24", "Deep link abuse: malformed ids, other network prefix (/testing, /devnet), sign-in/compose links refused", "L1i, L1a", ""),
    ("E-25", "Secrets: persona keys never appear in logs, diagnostics, screenshots (grep -c -F -f <keyfile>)", "L1i, L1a", ""),
    ("E-26", "Screen privacy (#645): app switcher snapshot / Recents, FLAG_SECURE screens on Android", "L1i, L1a", ""),
    ("E-27", "Testnet read-only pass: signed-out browse, gating (no Top/Creators/reports, 500-char limit, v2 profile), NO writes", "L4i, L4a", "never write"),
    ("E-28", "System locale ar/he: chrome stays LTR, content direction correct, no crash", "L3i, L3a", ""),
]


def parse_prd(path):
    out = []
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^#### ([A-Z0-9]+-\d+) · (.+?) · (P\d) · (.+?)\s*$", line)
        if m:
            out.append(m.groups())
    return out


def stream(lane, plat):
    return lane + ("i" if plat == "ios" else "a")


def cell(lane, depth, plat):
    return "N/A" if depth == "N/A" else "%s %s" % (stream(lane, plat), depth)


def check(prd):
    ids = [p[0] for p in prd]
    missing = [i for i in ids if i not in S]
    extra = [i for i in S if i not in ids]
    errs = []
    for i, pid in enumerate(ids):
        if pid in S:
            lane, tier, row, ios, andr, note = S[pid]
            pri = prd[i][2]
            if pri == "P0" and "N/A" not in (ios, andr) and (ios != "D" or andr != "D"):
                errs.append("%s is P0 but not D on both" % pid)
            if "N/A" in (ios, andr) and not note:
                errs.append("%s N/A without note" % pid)
    return missing, extra, errs


def main():
    mode, path = sys.argv[1], sys.argv[2]
    prd = parse_prd(path)
    if mode == "check":
        missing, extra, errs = check(prd)
        print("stories in PRD: %d, assigned: %d" % (len(prd), len(S)))
        print("missing:", missing or "none")
        print("not in PRD:", extra or "none")
        print("problems:", errs or "none")
        return 1 if (missing or extra or errs) else 0
    if mode == "matrix":
        print("| # | Story | Pri | Gating | Tier | Exit row | iOS | Android | Verdict iOS | Verdict Android | Proof (evidence/...) | Defects | Notes |")
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for sid, title, pri, gating in prd:
            lane, tier, row, ios, andr, note = S[sid]
            print("| <a id=\"%s\"></a>%s | %s | %s | %s | %s | %s | %s | %s | %s | %s |  |  | %s |" % (
                sid, sid, title, pri, gating, tier, row, cell(lane, ios, "ios"), cell(lane, andr, "android"),
                "N/R" if ios != "N/A" else "N/A", "N/R" if andr != "N/A" else "N/A", note))
        return 0
    if mode == "plan":
        titles = {p[0]: p for p in prd}
        for lane in ("L1", "L2", "L3", "L4"):
            print("#### %s: %s\n" % (lane, LANES[lane]))
            print("| Tier | Story | Pri | %si | %sa | Note |" % (lane, lane))
            print("| --- | --- | --- | --- | --- | --- |")
            for sid, (ln, tier, row, ios, andr, note) in sorted(S.items(), key=lambda kv: ("ABCDE".index(kv[1][1]), kv[0])):
                if ln != lane:
                    continue
                print("| %s%s | %s %s | %s | %s | %s | %s |" % (
                    tier, (" (" + row + ")") if row else "", sid, titles[sid][1], titles[sid][2], ios, andr, note))
            print()
        print("#### Exit-matrix rows (Tier A)\n")
        print("| Row | Scenario | Variants | Stories | Owner lane |")
        print("| --- | --- | --- | --- | --- |")
        for r, (desc, var) in A_ROWS.items():
            ids = [k for k, v in S.items() if v[2] == r]
            lanes = sorted({S[k][0] for k in ids})
            print("| %s | %s | %s | %s | %s |" % (r, desc, var, ", ".join(sorted(ids)), ", ".join(lanes)))
        print("\n#### Edge battery (Tier E, not stories)\n")
        print("| ID | Case | Stream(s) | Note |")
        print("| --- | --- | --- | --- |")
        for e in EDGE:
            print("| %s | %s | %s | %s |" % e)
        counts = {}
        for sid, (ln, tier, row, ios, andr, note) in S.items():
            for plat, d in (("i", ios), ("a", andr)):
                key = ln + plat
                c = counts.setdefault(key, {"D": 0, "S": 0, "N/A": 0})
                c[d] += 1
        print("\n#### Load per stream (stories at depth D / smoke S)\n")
        print("| Stream | D | S | N/A |")
        print("| --- | --- | --- | --- |")
        for k in sorted(counts):
            print("| %s | %d | %d | %d |" % (k, counts[k]["D"], counts[k]["S"], counts[k]["N/A"]))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
