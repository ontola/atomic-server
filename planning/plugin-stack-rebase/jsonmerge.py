#!/usr/bin/env python3
"""Merge JSON arrays of named test cases: ours, plus entries of theirs whose
`name` is in neither ours nor base. Usage: jsonmerge.py ours theirs base"""
import json, sys
ours, theirs = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
try: base = json.load(open(sys.argv[3]))
except Exception: base = []
seen = {e.get("name") for e in ours + base}
extra = [e for e in theirs if e.get("name") not in seen]
print(json.dumps(ours + extra, indent=2, ensure_ascii=False))
sys.stderr.write(f"appended {len(extra)}\n")
