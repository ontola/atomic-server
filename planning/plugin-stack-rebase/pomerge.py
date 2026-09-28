#!/usr/bin/env python3
"""Merge two .po files: keep `ours` verbatim, append entries from `theirs`
whose (msgctxt, msgid) `ours` lacks. Obsolete (#~) entries in theirs are
ignored. Entries already in base (removed or kept by ours) are not re-added.
Usage: pomerge.py ours theirs [base] > out"""
import re, sys

def blocks(text):
    return [b for b in re.split(r"\n\s*\n", text.strip("\n")) if b.strip()]

def key(block):
    lines = [l for l in block.splitlines() if not l.startswith("#")]
    if not lines:
        return None
    ctx, mid, cur = [], [], None
    for l in lines:
        if l.startswith("msgctxt "):
            cur = ctx; cur.append(l[8:])
        elif l.startswith("msgid "):
            cur = mid; cur.append(l[6:])
        elif l.startswith("msgid_plural") or l.startswith("msgstr"):
            cur = None
        elif l.startswith('"') and cur is not None:
            cur.append(l)
    if not mid:
        return None
    return ("".join(ctx), "".join(mid))

ours = open(sys.argv[1]).read()
theirs = open(sys.argv[2]).read()
base = open(sys.argv[3]).read() if len(sys.argv) > 3 else ""
have = {key(b) for b in blocks(ours)} | {key(b) for b in blocks(base)}
extra = []
for b in blocks(theirs):
    k = key(b)
    if k is None or k in have or k == ("", '""'):
        continue
    if all(l.startswith("#~") or l.startswith("#") for l in b.splitlines()):
        continue
    have.add(k)
    extra.append(b)
out = ours.rstrip("\n") + "\n"
for b in extra:
    out += "\n" + b + "\n"
sys.stdout.write(out)
sys.stderr.write(f"appended {len(extra)} entries\n")
