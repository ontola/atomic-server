#!/usr/bin/env python3
"""Resolve every conflict hunk in the given files as ours followed by theirs."""
import re, sys
for p in sys.argv[1:]:
    s = open(p).read()
    s, n = re.subn(r"<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n",
                   lambda m: m.group(1) + m.group(2), s, flags=re.S)
    open(p, "w").write(s)
    print(f"{p}: {n} hunks kept both")
