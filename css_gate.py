#!/usr/bin/env python3
"""CSS layout gate — run before every zip.

Two checks, both born of 26 Aug, when an edit meant for one rule matched a
different rule with a similar name and silently deleted the mobile full-bleed
bodies for four pages. The brace count stayed balanced, so nothing noticed.

1. INVARIANTS: rules the mobile layout cannot live without must be present,
   with their key declarations, inside the right media query. Not "does the
   selector exist" — "does the selector exist with THIS body".

2. DELETION BUDGET: every non-comment line removed compared with the previous
   shipped stylesheet is listed. More than a handful, or any line from the
   invariant blocks, is a stop.

Usage:  python3 css_gate.py style.css [previous_style.css]
"""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else "style.css"
prev = sys.argv[2] if len(sys.argv) > 2 else None
css = open(path, encoding="utf-8").read()
clean = re.sub(r"/\*.*?\*/", "", css, flags=re.S)

# ---- parse into (media, selector, body) ------------------------------------
rules = []
i = 0; media = None; mdepth = 0; depth = 0; buf = ""
while i < len(clean):
    ch = clean[i]
    if ch == "{":
        depth += 1
        head = buf.strip(); buf = ""
        if head.startswith("@media"):
            media = head[6:].strip(); mdepth = depth; i += 1; continue
        if head.startswith("@"):
            d = 1; i += 1
            while i < len(clean) and d:
                if clean[i] == "{": d += 1
                if clean[i] == "}": d -= 1
                i += 1
            depth -= 1; continue
        start = i + 1; d = 1; j = start
        while j < len(clean) and d:
            if clean[j] == "{": d += 1
            if clean[j] == "}": d -= 1
            j += 1
        rules.append((media, head, clean[start:j - 1]))
        i = j; depth -= 1; continue
    if ch == "}":
        depth -= 1
        if media and depth < mdepth: media = None
        i += 1; buf = ""; continue
    buf += ch; i += 1

def find(selector_fragment, media_fragment=None):
    out = []
    for m, sel, body in rules:
        if selector_fragment in re.sub(r"\s+", " ", sel):
            if media_fragment is None or (m and media_fragment in m):
                out.append((m, sel, body))
    return out

def has(body, *decls):
    b = re.sub(r"\s+", " ", body)
    return all(d in b for d in decls)

fail = False
def check(label, ok, detail=""):
    global fail
    if not ok: fail = True
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'  — ' + detail if detail else ''}")

print("=== mobile layout invariants (max-width: 640px) ===")

# The shared full-bleed rule: every page's scroller and frozen head, edge to edge.
fb = find("#view-reports .rep-wrap", "max-width: 640px")
fb = [r for r in fb if "#view-bookings .tl-head-wrap" in r[1]]
check("shared full-bleed rule exists in the phone block", len(fb) == 1)
if fb:
    m, sel, body = fb[0]
    for part in ["#view-bookings .tl-head-wrap", "#view-bookings .timeline-wrap",
                 "#view-tasks .board-head-wrap", "#view-expenses .board-head-wrap",
                 '#view-tasks [data-el="board"]', '#view-expenses [data-el="xboard"]',
                 "#view-reports .rep-head-wrap", "#view-reports .rep-wrap"]:
        check(f"  full-bleed covers {part}", part in sel)
    check("  full-bleed body: width breaks out of the page padding",
          has(body, "width: calc(100% + 2 * var(--main-pad-x", "margin-left: calc(-1 * var(--main-pad-x"))
    check("  full-bleed body: side borders and radius removed",
          has(body, "border-left: none", "border-right: none", "border-radius: 0"))

hs = find(".board-head-wrap .staff-board", "max-width: 640px")
check("frozen board head fills its strip and does not shift again",
      any(has(b, "width: 100%", "margin-left: 0") for _, _, b in hs))

tick = find(".board-tick", "max-width: 640px")
check("phone tick boxes are the thumb size (24px)", any(has(b, "width: 24px", "height: 24px") for _, _, b in tick))

ctl = [r for r in rules if r[0] and "max-width: 640px" in r[0] and "--ctl-h-mobile" in r[2]]
check("CONTROL STANDARD mobile sizes are applied", len(ctl) >= 1)

print("\n=== structural laws ===")
rw = [r for r in rules if r[0] is None and re.sub(r"\s+", " ", r[1]) == ".rep-wrap"]
check("the real .rep-wrap rule exists at top level, once", len(rw) == 1)
if rw:
    check("  it scrolls sideways only (page owns vertical)", has(rw[0][2], "overflow-x: auto", "overflow-y: visible"))
    check("  it has no height cap", "max-height" not in rw[0][2])
xb = find('#view-expenses [data-el="xboard"]')
check("expenses board scrolls sideways only", any(r[0] is None and has(r[2], "overflow-y: visible") for r in xb))
tb = find('#view-tasks [data-el="board"]')
check("tasks board scrolls sideways only", any(r[0] is None and has(r[2], "overflow-y: visible") for r in tb))
for name in [".board-head-wrap", ".tl-head-wrap", ".rep-head-wrap"]:
    r = find(name)
    check(f"{name} is sticky (frozen against the page)", any(has(b, "position: sticky") for _, _, b in r))

print("\n=== page-scoped control sizing (must be zero) ===")
bad = [(m, s) for m, s, b in rules
       if re.match(r"^\s*(#view-|\[data-view)", s) and re.search(r"\.btn\b|\.tab\b", s)
       and re.search(r"\b(height|padding|font-size)\s*:", b)]
check("no page sets its own button/tab sizes", not bad, "; ".join(s for _, s in bad))

# ---- deletion budget --------------------------------------------------------
if prev:
    print(f"\n=== deletion budget vs {prev} ===")
    old = open(prev, encoding="utf-8").read()
    strip = lambda t: [l.strip() for l in re.sub(r"/\*.*?\*/", "", t, flags=re.S).splitlines() if l.strip()]
    a, b = strip(old), strip(css)
    from collections import Counter
    removed = list((Counter(a) - Counter(b)).elements())
    added = list((Counter(b) - Counter(a)).elements())
    print(f"  removed {len(removed)} line(s), added {len(added)}")
    for l in removed[:40]:
        print("    -", l[:110])
    guarded = [l for l in removed if any(k in l for k in
               ("--main-pad-x", "#view-bookings .tl-head-wrap", "board-head-wrap", 'data-el="xboard"',
                'data-el="board"', ".board-tick", "--ctl-h-mobile", "--ctl-font-mobile"))]
    check("no line from a guarded mobile-layout rule was removed", not guarded,
          "; ".join(l[:60] for l in guarded))
    check("removals are few enough to have been read one by one", len(removed) <= 25,
          f"{len(removed)} removed — a change this size must be reviewed by eye")

print("\nRESULT:", "FAIL" if fail else "PASS")
sys.exit(1 if fail else 0)
