#!/bin/bash
# Resolve conflicts that are mechanical: .po catalogs (keep ours, append the
# msgids only theirs has) and append-only docs (union).
# Exits 0 when every conflicted file was resolved, 1 otherwise.
S=/private/tmp/claude-501/-Users-michiel-gh-ontola-atomic-server--claude-worktrees-open-prs-develop-status-cda943/e4eec2cf-337f-4bac-afd3-97adbe7640df/scratchpad
left=0
for f in $(git diff --name-only --diff-filter=U); do
  t=$(mktemp -d)
  case "$f" in
    *.po)
      git show :1:"$f" > $t/base 2>/dev/null || : > $t/base
      git show :2:"$f" > $t/ours; git show :3:"$f" > $t/theirs
      if python3 $S/pomerge.py $t/ours $t/theirs $t/base > $t/out 2>$t/err; then
        cp $t/out "$f"; git add "$f"; echo "   po: $f ($(cat $t/err))"
      else echo "   po FAILED: $f"; cat $t/err; left=1; fi ;;
    *CHANGELOG.md|TESTING_COVERAGE.md)
      git show :1:"$f" > $t/base 2>/dev/null || : > $t/base
      git show :2:"$f" > $t/ours; git show :3:"$f" > $t/theirs
      git merge-file --union $t/ours $t/base $t/theirs
      cp $t/ours "$f"; git add "$f"; echo "   union: $f" ;;
    testdata/*/index.json)
      git show :1:"$f" > $t/base 2>/dev/null || echo '[]' > $t/base
      git show :2:"$f" > $t/ours; git show :3:"$f" > $t/theirs
      if python3 $S/jsonmerge.py $t/ours $t/theirs $t/base > $t/out 2>$t/err; then
        cp $t/out "$f"; git add "$f"; echo "   json: $f ($(cat $t/err))"
      else echo "   json FAILED: $f"; left=1; fi ;;
    *) echo "   manual: $f"; left=1 ;;
  esac
  rm -rf $t
done
exit $left
