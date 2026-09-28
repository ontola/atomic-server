#!/usr/bin/env python3
"""Resolve diff3 conflict hunks that are safe to resolve mechanically:

- base empty (both sides only added): ours, then theirs;
- every side only `import ... from '...'` statements (TS/JS): union of the
  statements per module, merging the named specifiers.

Anything else is left in place. Prints how many hunks remain per file.
Run `git checkout --conflict=diff3 -- <files>` first."""
import re, sys

HUNK = re.compile(
    r"<<<<<<< [^\n]*\n(.*?)\|\|\|\|\|\|\| [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n",
    re.S,
)
IMPORT = re.compile(r"import\s+(type\s+)?(\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+'([^']+)';\s*", re.S)


def parse_imports(text):
    """Returns [(module, type_only, [names] or default)] or None if not only imports."""
    out, pos = [], 0
    text = text.strip()
    while pos < len(text):
        m = IMPORT.match(text, pos)
        if not m:
            return None
        type_only, what, module = m.group(1), m.group(2), m.group(3)
        if what.startswith("{"):
            names = [n.strip() for n in what[1:-1].split(",") if n.strip()]
            out.append((module, bool(type_only), names))
        else:
            out.append((module, bool(type_only), what))
        pos = m.end()
    return out


def render(module, type_only, names):
    kw = "import type " if type_only else "import "
    if isinstance(names, str):
        return f"{kw}{names} from '{module}';\n"
    one = f"{kw}{{ {', '.join(names)} }} from '{module}';"
    if len(one) <= 80:
        return one + "\n"
    return kw + "{\n" + "".join(f"  {n},\n" for n in names) + f"}} from '{module}';\n"


def merge_imports(ours, base, theirs):
    o, b, t = parse_imports(ours), parse_imports(base), parse_imports(theirs)
    if o is None or t is None or (base.strip() and b is None):
        return None
    b = b or []
    order, merged = [], {}
    for module, type_only, names in o + t:
        k = (module, type_only)
        if k not in merged:
            order.append(k)
            merged[k] = names if isinstance(names, str) else []
        if not isinstance(names, str):
            for n in names:
                if n not in merged[k]:
                    merged[k].append(n)
    # names both sides dropped from the base stay dropped
    base_names = {(m, to): n for m, to, n in b}
    def has(side, k, n):
        return any((m, to) == k and (n in ns if not isinstance(ns, str) else ns == n) for m, to, ns in side)
    result = ""
    for k in order:
        names = merged[k]
        if not isinstance(names, str):
            names = [n for n in names if not (k in base_names and not isinstance(base_names[k], str)
                     and n in base_names[k] and not has(o, k, n) and not has(t, k, n))]
            if not names:
                continue
        result += render(k[0], k[1], names)
    return result


for p in sys.argv[1:]:
    s = open(p).read()
    left = 0

    def fix(m):
        global left
        ours, base, theirs = m.group(1), m.group(2), m.group(3)
        if not base.strip():
            return ours + theirs
        merged = merge_imports(ours, base, theirs)
        if merged is not None:
            return merged
        left += 1
        return m.group(0)

    s = HUNK.sub(fix, s)
    open(p, "w").write(s)
    print(f"{p}: {left} hunks left")
