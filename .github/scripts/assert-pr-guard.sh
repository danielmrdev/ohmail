#!/usr/bin/env bash
# assert-pr-guard.sh — the workflows, their tools and the gate change only on a maintainer branch of
# this repository.
#
#   bash .github/scripts/assert-pr-guard.sh <base sha> <head sha> <pull request json>
#
# Every pull request is refused when (c) a file of a font kind is in its tree, or any commit it would
# merge adds or changes one. A maintainer's `publish/<utc>-<sha12>` branch is otherwise admitted as it
# is. Any other pull request is refused when (a) it changes `.github/`, `scripts/` or `.gate/` and is
# not a maintainer's `pr/<name>` branch (a name of letters, digits, `.`, `_` and `-`), or (b) it carries
# a `Monorepo-Commit:` line in a commit message, its title or its description (the merge message is the
# description). A maintainer's branch is a branch of THIS repository, which only write access can push
# (a MEMBER association alone is membership of the organization, not write access), whose pull request a
# person opened (`user.type` User, never an app's Bot) as OWNER, MEMBER or COLLABORATOR; a field the
# pull request lacks counts as none. Rule (c) reads names: a font renamed `.bin` is not seen.
#
# It reads git objects and JSON and compares strings; nothing from the pull request is run.
set -euo pipefail
export LC_ALL=C

say() { printf '%s\n' "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
fail() { say "guard: $*"; exit 2; }

[ $# -eq 3 ] || fail "usage: assert-pr-guard.sh <base sha> <head sha> <pull request json>"
base=$1 head=$2 json=$3
repo=${GUARD_REPO:-${GITHUB_REPOSITORY:-}}
[ -n "$repo" ] || fail "no repository named (GITHUB_REPOSITORY)"
[ -f "$json" ] || fail "no pull request at $json"
jq -e 'type == "object"' "$json" > /dev/null 2>&1 || fail "the pull request at $json is not a JSON object"
git cat-file -e "$base^{commit}" 2>/dev/null || fail "the base $base is not a commit here"
git cat-file -e "$head^{commit}" 2>/dev/null || fail "the head $head is not a commit here"

head_repo=$(jq -r '.head.repo.full_name // "a deleted fork"' "$json") || fail "the head's repository could not be read"
head_ref=$(jq -r '.head.ref // ""' "$json") || fail "the head's branch could not be read"
opener=$(jq -r '.user.type // "none"' "$json") || fail "the opener could not be read"
association=$(jq -r '.author_association // "NONE"' "$json") || fail "the opener's association could not be read"
maintainer=no
if [ "$head_repo" = "$repo" ] && [ "$opener" = "User" ]; then
  case "$association" in OWNER | MEMBER | COLLABORATOR) maintainer=yes ;; esac
fi
who="$head_repo:${head_ref:-?}"

commits=$(git rev-list "$base..$head") || fail "the commits $base..$head could not be listed"

refusals=0
# (c) before any admission. The head's TREE: a rename cannot carry a font past it, and one already on the
# base refuses every pull request until it is removed. And every commit in base..head, which a merge keeps
# in the history even when a later commit deletes the file: the paths each adds or changes, a merge's
# against each parent. git quotes an unusual name, so the closing quote may follow the extension.
font_re='\.(ttf|otf|ttc|woff2?|eot|pfa|pfb|dfont)"?$'
tree=$(git ls-tree -r --name-only "$head") || fail "the tree of $head could not be listed"
fonts=$(grep -iE "$font_re" <<< "$tree") || [ $? -eq 1 ] || fail "the tree of $head could not be searched"
history=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  paths=$(git diff-tree -r -m --root --no-commit-id --name-only --no-renames --diff-filter=d "$c") || fail "the change of $c could not be listed"
  hits=$(grep -iE "$font_re" <<< "$paths") || [ $? -eq 1 ] || fail "the change of $c could not be searched"
  while IFS= read -r p; do
    if [ -n "$p" ] && ! grep -qxF -- "$p" <<< "$fonts"; then history="$history$p, in commit ${c:0:12}"$'\n'; fi
  done <<< "$hits"
done <<< "$commits"
history=$(sort -u <<< "${history%$'\n'}")
if [ -n "$fonts" ] || [ -n "$history" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ this pull request carries a file of a font kind:"
  if [ -n "$fonts" ]; then while IFS= read -r p; do say "    $p"; done <<< "$fonts"; fi
  if [ -n "$history" ]; then while IFS= read -r p; do say "    $p"; done <<< "$history"; fi
  say "  This repository distributes no Font Software (COPYRIGHT says why); a maintainer admits a kind in"
  say "  a separate pull request first."
  if [ -n "$history" ]; then
    say "  A merge keeps every commit's files in the history, so deleting one later does not remove it: take"
    say "  it out of the commit that adds it (git rebase -i) and push."
  fi
fi

# A maintainer's publish is admitted as it is, (c) apart.
if [ "$maintainer" = yes ] && [[ "$head_ref" =~ ^publish/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; then
  if [ "$refusals" -eq 0 ]; then say "guard: ADMITTED — $who is a publish"; exit 0; fi
  say "guard: REFUSED — $who, $refusals reason(s) above"
  exit 1
fi
door=no
if [ "$maintainer" = yes ] && [[ "$head_ref" =~ ^pr/[A-Za-z0-9._-]+$ ]]; then door=yes; fi

# (a) the change, as the pull request shows it: the merge base to the head. A maintainer's pr/ branch may make it.
machinery=""
if [ "$door" = no ]; then
  mb=$(git merge-base "$base" "$head") || fail "no merge base between $base and $head"
  machinery=$(git diff --name-only --no-renames "$mb" "$head" -- .github scripts .gate) || fail "the change $mb..$head could not be listed"
fi
if [ -n "$machinery" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ this pull request changes the workflows, the tools they run or the push gate's baseline:"
  while IFS= read -r p; do say "    $p"; done <<< "$machinery"
  say "  Those files change only on a maintainer branch of this repository. Please leave them out, and"
  say "  describe the change you need in an issue or in this pull request; a maintainer carries it."
fi

# (b) a Monorepo-Commit line, in any spelling, anywhere a merge message or a reader could take it.
# Each text is captured first and searched from a here-string: under pipefail a producer piped into
# `grep -q` can die of SIGPIPE at the first match and report the match as a miss.
line_re='monorepo[-_ ]?commit[[:space:]]*:'
carries() { grep -qiE "$line_re" <<< "${1//$'\r'/}"; }
where="" text=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  text=$(git log -1 --format=%B "$c") || fail "the message of $c could not be read"
  if carries "$text"; then where="$where commit ${c:0:12},"; fi
done <<< "$commits"
text=$(jq -r '.title // ""' "$json"); if carries "$text"; then where="$where the title,"; fi
text=$(jq -r '.body // ""' "$json"); if carries "$text"; then where="$where the description,"; fi
if [ -n "$where" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ a Monorepo-Commit: line in${where%,}."
  say "  That line belongs to the repository's publishing history, and only a maintainer's publish branch"
  say "  carries it. Remove it: amend the commit message (git commit --amend, or git rebase -i), edit the"
  say "  title or the description, and push."
fi

if [ "$refusals" -gt 0 ]; then
  say "guard: REFUSED — $who, $refusals reason(s) above"
  exit 1
fi
what="changes none of .github/, scripts/ and .gate/"
if [ "$door" = yes ]; then what="is a maintainer branch of this repository"; fi
say "guard: ADMITTED — $who $what, and carries no Monorepo-Commit: line and no file of a font kind"
