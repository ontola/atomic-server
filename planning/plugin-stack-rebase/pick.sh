#!/bin/bash
# Cherry-pick the plugin PR chain onto the current HEAD, one PR at a time.
# Resumable: PRs already marked in done.txt are skipped; a pick in progress
# must be finished (git cherry-pick --continue / --skip) before rerunning.
S=/private/tmp/claude-501/-Users-michiel-gh-ontola-atomic-server--claude-worktrees-open-prs-develop-status-cda943/e4eec2cf-337f-4bac-afd3-97adbe7640df/scratchpad
W=/Users/michiel/gh/ontola/atomic-server/.claude/worktrees/plugin-stack-chain
DROP="3f4add07a d3fa5fed2 72fde507e 9788dbb41 fb53a665a 2941e6f4d"
cd $W || exit 1
touch $S/done.txt $S/picked.txt
G="git -c core.hooksPath=/dev/null"
if [ -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ]; then
  $S/autoresolve.sh || { echo "cherry-pick in progress with manual conflicts"; exit 2; }
  if git diff --cached --quiet; then $G cherry-pick --skip; else GIT_EDITOR=true $G cherry-pick --continue >/dev/null || exit 2; fi
fi
while read n head commits; do
  grep -qx "$n" $S/done.txt && continue
  [ "$n" = 1755 ] && { echo $n >> $S/done.txt; continue; }
  for c in $commits; do
    short=${c:0:9}
    case " $DROP " in *" $short "*) continue;; esac
    grep -qx "$c" $S/picked.txt && continue
    echo "#$n pick $(git log -1 --format='%h %s' $c | cut -c1-80)"
    if ! $G cherry-pick -x $c >/tmp/pick.out 2>&1; then
      if git diff --name-only --diff-filter=U | grep -q .; then
        if $S/autoresolve.sh; then
          if git diff --cached --quiet; then $G cherry-pick --skip; echo "   (empty after resolve) skipped"
          else GIT_EDITOR=true $G cherry-pick --continue >/dev/null; fi
          echo "$c" >> $S/picked.txt; continue
        fi
        echo "CONFLICT in #$n at $short:"; git diff --name-only --diff-filter=U
        echo "$c" >> $S/picked.txt
        exit 3
      fi
      if grep -q 'now empty' /tmp/pick.out; then echo "   (empty, already in develop) skipped"; $G cherry-pick --skip; echo "$c" >> $S/picked.txt; continue; fi
      cat /tmp/pick.out; exit 4
    fi
    echo "$c" >> $S/picked.txt
  done
  if git diff --name-only ORIG_BASE_$n HEAD 2>/dev/null | grep -q '\.rs$' || [ -n "$(for c in $commits; do git show --name-only --format= $c; done | grep '\.rs$')" ]; then
    echo "   cargo check…"
    if ! ATOMICSERVER_SKIP_JS_BUILD=true CARGO_TARGET_DIR=/Users/michiel/gh/ontola/atomic-server/.claude/worktrees/open-prs-develop-status-cda943/target cargo check -p atomic-server -p atomic_lib --tests --message-format short > $S/check-$n.log 2>&1; then
      echo "CHECK FAILED after #$n:"; grep -E "error" $S/check-$n.log | head -20; exit 5
    fi
  fi
  git branch -f chain/$head HEAD
  echo $n >> $S/done.txt
  echo "== #$n done at $(git rev-parse --short HEAD)"
done < $S/chain.txt
echo ALL DONE
