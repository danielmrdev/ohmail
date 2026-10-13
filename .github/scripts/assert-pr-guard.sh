#!/usr/bin/env bash
# assert-pr-guard.sh — the workflows, their tools and the publish line arrive only with a publish.
#
#   bash .github/scripts/assert-pr-guard.sh <base sha> <head sha> <pull request json>
#
# A pull request whose head is a `publish/<utc>-<sha12>` branch of THIS repository is a publish: a
# batch of changes from the development repository, admitted as it is. Any other pull request is
# refused when it (a) changes `.github/` or `scripts/`, the workflows and the tools they run, or
# (b) carries a `Monorepo-Commit:` line in a commit message, its title or its description. That line
# is written by the publishing tool alone, and the merge message is the description.
#
# It reads git objects and JSON and compares strings; nothing from the pull request is run.
set -euo pipefail

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

head_repo=$(jq -r '.head.repo.full_name // "a deleted fork"' "$json")
head_ref=$(jq -r '.head.ref // ""' "$json")
if [ "$head_repo" = "$repo" ] && [[ "$head_ref" =~ ^publish/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]]; then
  say "guard: ADMITTED — $head_repo:$head_ref is a publish"
  exit 0
fi

refusals=0
# (a) the change, as the pull request shows it: the merge base to the head.
mb=$(git merge-base "$base" "$head") || fail "no merge base between $base and $head"
machinery=$(git diff --name-only --no-renames "$mb" "$head" -- .github scripts) || fail "the change $mb..$head could not be listed"
if [ -n "$machinery" ]; then
  refusals=$((refusals + 1))
  say "guard: ✗ this pull request changes the workflows or the tools they run:"
  while IFS= read -r p; do say "    $p"; done <<< "$machinery"
  say "  Those files change with a publish from the development repository. Please leave them out,"
  say "  and describe the change you need in an issue or in this pull request; a maintainer carries it."
fi

# (b) a Monorepo-Commit line, in any spelling, anywhere a merge message or a reader could take it.
# Each text is captured first and searched from a here-string: under pipefail a producer piped into
# `grep -q` can die of SIGPIPE at the first match and report the match as a miss.
line_re='monorepo[-_ ]?commit[[:space:]]*:'
carries() { grep -qiE "$line_re" <<< "${1//$'\r'/}"; }
where="" text=""
commits=$(git rev-list "$base..$head") || fail "the commits $base..$head could not be listed"
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
  say "  That line is written only by the publishing tool, which resumes from it. Remove it: amend the"
  say "  commit message (git commit --amend, or git rebase -i), edit the title or the description, and push."
fi

if [ "$refusals" -gt 0 ]; then
  say "guard: REFUSED — $head_repo:${head_ref:-?}, $refusals reason(s) above"
  exit 1
fi
say "guard: ADMITTED — $head_repo:${head_ref:-?} changes neither .github/ nor scripts/ and carries no Monorepo-Commit: line"
