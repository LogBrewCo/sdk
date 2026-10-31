#!/usr/bin/env bash
# Public guard: stop non-public content before it reaches public history.
# Keep this file identical in every public LogBrew repository.
#
# Usage:
#   public-guard.sh range BASE HEAD [LABEL=FILE ...]  scan commits, messages, paths
#   public-guard.sh text LABEL=FILE ...               scan text such as release notes
#   public-guard.sh commit-msg MESSAGE_FILE           Git commit-msg hook
#   public-guard.sh pre-push REMOTE [URL] < refs      Git pre-push hook
#   public-guard.sh github                            GitHub Actions entry point
#   public-guard.sh github-text                       issue, pull request, and comment events
#   public-guard.sh install [TERMS_FILE]              enable the local Git hooks
#
# Every scan also blocks tracked Markdown other than READMEs, licenses,
# changelogs, security and contributing guides, and published skill files.
#
# The project term list comes from PUBLIC_GUARD_TERMS (content),
# PUBLIC_GUARD_TERMS_FILE, or `git config logbrew.publicGuardTermsFile`.
# Each line is: CATEGORY<TAB>PATTERN[<TAB>only:REPO,...|except:REPO,...].
# PATTERN is a word that also matches across case changes and up to two
# separator characters between letters, `=TEXT` for exact text, or `re:RE2`.
# An except: entry REPO@DIR/ allows the term only in file content under DIR/
# in REPO. Commit messages, file paths, and other text are still scanned.
# Exit status: 0 clean, 1 blocked, 2 guard failure.
set -euo pipefail

readonly gitleaks_version="8.30.1"
guard_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly guard_dir

fail() {
  printf 'public-guard: %s\n' "$1" >&2
  exit 2
}

tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
work="$(mktemp -d "${tmp_root%/}/public-guard.XXXXXX")"
# A run that stops early marks the pull request status as an error, not pending.
finish() {
  if [[ -n "${GUARD_HEAD_SHA:-}" && "${status_final:-0}" != 1 ]]; then
    github_status error "Guard stopped early; rerun the job" || true
  fi
  rm -rf "$work"
}
trap finish EXIT
mkdir "$work/text" "$work/ignore"

gitleaks_binary() {
  local asset digest cache archive
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset=linux_x64 digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    Linux-aarch64 | Linux-arm64) asset=linux_arm64 digest=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    Darwin-arm64) asset=darwin_arm64 digest=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    Darwin-x86_64) asset=darwin_x64 digest=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
    *) fail "unsupported platform for gitleaks" ;;
  esac
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/logbrew-public-guard"
  archive="$cache/gitleaks_${gitleaks_version}_$asset.tar.gz"
  mkdir -p "$cache"
  if [[ ! -f "$archive" ]]; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$archive.partial" \
      "https://github.com/gitleaks/gitleaks/releases/download/v$gitleaks_version/gitleaks_${gitleaks_version}_$asset.tar.gz" ||
      fail "gitleaks download failed"
    mv "$archive.partial" "$archive"
  fi
  # Verify the pinned digest on every run, not only after download.
  if ! printf '%s  %s\n' "$digest" "$archive" | shasum -a 256 -c - >/dev/null 2>&1; then
    rm -f "$archive"
    fail "gitleaks archive digest mismatch"
  fi
  tar -xzf "$archive" -C "$work" gitleaks
  printf '%s\n' "$work/gitleaks"
}

# The scanned checkout's origin names the repository, so a release job that
# checks out another repository applies that repository's term scope.
repository_name() {
  local origin
  origin="$(git remote get-url origin 2>/dev/null || true)"
  origin="${origin%.git}"
  origin="${origin##*[/:]}"
  printf '%s\n' "${origin:-${GITHUB_REPOSITORY##*/}}"
}

load_terms() {
  local file
  if [[ -n "${PUBLIC_GUARD_TERMS:-}" ]]; then
    printf '%s\n' "$PUBLIC_GUARD_TERMS"
    return
  fi
  file="${PUBLIC_GUARD_TERMS_FILE:-$(git config --get logbrew.publicGuardTermsFile || true)}"
  if [[ -n "$file" ]]; then
    [[ -f "$file" ]] || fail "project term list file is missing"
    cat "$file"
  fi
}

# Turn one term into an RE2 pattern. Words of 6 or more letters match inside
# longer identifiers; shorter words need non-alphanumeric neighbors.
term_regex() {
  local term="$1" letters regex="" index
  case "$term" in
    re:*) printf '%s\n' "${term#re:}" ;;
    =*) printf '(?i)%s\n' "$(printf '%s' "${term#=}" | sed 's/[][\.^$*+?(){}|/]/\\&/g')" ;;
    *)
      letters="$(printf '%s' "$term" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
      [[ -n "$letters" ]] || return 1
      for ((index = 0; index < ${#letters}; index++)); do
        ((index > 0)) && regex+='[^a-z0-9\n]{0,2}'
        regex+="${letters:index:1}"
      done
      if ((${#letters} < 6)); then
        regex="(?:^|[^a-z0-9])$regex(?:[^a-z0-9]|\$)"
      fi
      printf '(?i)%s\n' "$regex"
      ;;
  esac
}

build_config() {
  local config="$work/config.toml" repo terms count=0 category pattern scope regex items item skip paths
  cp "$guard_dir/public-guard.toml" "$config"
  repo="$(repository_name)"
  terms="$(load_terms)"
  if [[ -z "$terms" ]]; then
    [[ "${PUBLIC_GUARD_REQUIRE_TERMS:-0}" != "1" ]] || fail "project term list is required but unavailable"
    printf 'public-guard: project term list unavailable; generic rules only\n' >&2
  fi
  while IFS=$'\t' read -r category pattern scope || [[ -n "$category" ]]; do
    [[ -z "$category" || "$category" == \#* ]] && continue
    [[ "$category" =~ ^[a-z][a-z-]*$ && -n "$pattern" ]] || fail "project term list has a malformed line"
    paths=""
    case "$scope" in
      "") ;;
      only:*) [[ ",${scope#only:}," == *",$repo,"* ]] || continue ;;
      except:*)
        skip=0
        IFS=, read -ra items <<<"${scope#except:}"
        for item in "${items[@]}"; do
          [[ "$item" =~ ^[a-z0-9-]+(@([a-z0-9_-][a-z0-9._-]*/)+)?$ ]] || fail "project term list has a malformed scope"
          item="${item//./\\.}"
          case "$item" in
            "$repo") skip=1 ;;
            "$repo@"*) paths+="${paths:+, }'''^${item#*@}'''" ;;
          esac
        done
        ((skip == 0)) || continue
        ;;
      *) fail "project term list has a malformed scope" ;;
    esac
    regex="$(term_regex "$pattern")" || fail "project term list has an empty term"
    [[ "$regex" != *"'''"* ]] || fail "project term list has an unsupported pattern"
    count=$((count + 1))
    printf '\n[[rules]]\nid = "%s.term%d"\ndescription = "Project term"\nregex = '"'''%s'''"'\n' \
      "$category" "$count" "$regex" >>"$config"
    [[ -z "$paths" ]] || printf '[[rules.allowlists]]\npaths = [%s]\n' "$paths" >>"$config"
  done <<<"$terms"
  printf '%s\n' "$count" >"$work/term-count"
  printf '%s\n' "$config"
}

# Print each finding as category and location, never the matched text.
run_gitleaks() {
  local mode="$1" status=0
  shift
  "$gitleaks" "$mode" "$@" --config "$config" --no-banner --redact=100 \
    --ignore-gitleaks-allow --gitleaks-ignore-path "$work/ignore" --log-level error \
    --exit-code 3 --timeout 300 --report-format template \
    --report-template "$work/report.tmpl" --report-path "$work/report-$mode.txt" \
    2>"$work/gitleaks.log" || status=$?
  case "$status" in
    0) ;;
    3) cat "$work/report-$mode.txt" >>"$work/findings" ;;
    *)
      if [[ "${PUBLIC_GUARD_DEBUG:-0}" == "1" && -z "${CI:-}" ]]; then cat "$work/gitleaks.log" >&2; fi
      fail "gitleaks failed to run ($mode)"
      ;;
  esac
}

report() {
  local id location commit category line
  if [[ ! -s "$work/findings" ]]; then
    printf 'public-guard: clean (%s project terms)\n' "$(cat "$work/term-count")"
    return 0
  fi
  printf 'public-guard: blocked non-public content. Remove it from every listed commit or text, then push again.\n' >&2
  sort -u "$work/findings" | while IFS='|' read -r id location commit; do
    category="${id%%.*}"
    [[ "$id" == *.* ]] || category="access-key ($id)"
    case "$location" in
      "$work/text/changed-paths.txt:"*) line="changed file path #${location##*:}" ;;
      "$work/text/commit-"*) line="${location#"$work/text/commit-"}" && line="commit message ${line:0:12} line ${location##*:}" ;;
      "$work/text/"*) line="${location#"$work/text/"}" && line="${line%%.txt:*} line ${location##*:}" ;;
      *) line="$location" ;;
    esac
    [[ -n "$commit" ]] && line+=" in commit ${commit:0:12}"
    printf '  %s: %s\n' "$category" "$line" >&2
  done
  return 1
}

add_text() {
  local label="${1%%=*}" file="${1#*=}"
  [[ "$1" == *=* && "$label" =~ ^[a-z][a-z0-9-]*$ && -f "$file" ]] || fail "text input must be LABEL=FILE"
  cp "$file" "$work/text/$label.txt"
}

# Tracked Markdown is limited to user documentation: READMEs, licenses,
# changelogs, security and contributing guides, and published skill files.
check_markdown() {
  local paths allowed='(^|/)(README|LICENSE|CHANGELOG|SECURITY|CONTRIBUTING)\.md$|^plugins/[^/]+/skills/[^/]+/(SKILL\.md|references/[^/]+\.md)$'
  if [[ -n "${1:-}" ]]; then
    paths="$(git ls-tree -r --name-only "$1")" || fail "cannot list the tree"
  else
    paths="$(git ls-files)" || fail "cannot list the index"
  fi
  { grep -iE '\.(md|markdown)$' <<<"$paths" || true; } | { grep -vE "$allowed" || true; } |
    while IFS= read -r path; do printf 'markdown.1|%s|\n' "$path"; done >>"$work/findings"
}

scan_range() {
  local base="$1" head="$2" sha
  shift 2
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || fail "base commit is unavailable"
  git rev-parse --verify --quiet "$head^{commit}" >/dev/null || fail "head commit is unavailable"
  for sha in $(git rev-list "$base..$head"); do
    git log -1 --format=%B "$sha" >"$work/text/commit-$sha.txt"
  done
  git log --format= --name-only --no-renames "$base..$head" | sort -u | sed '/^$/d' >"$work/text/changed-paths.txt"
  for item in "$@"; do add_text "$item"; done
  [[ -n "$(git rev-list -1 "$base..$head")" ]] && run_gitleaks git --log-opts="$base..$head" .
  run_gitleaks dir "$work/text"
  check_markdown "$head"
}

github_status() {
  local state="$1" description="$2"
  [[ -n "${GUARD_HEAD_SHA:-}" ]] || return 0
  gh api --silent -X POST "repos/$GITHUB_REPOSITORY/statuses/$GUARD_HEAD_SHA" \
    -f state="$state" -f context="Public guard" -f description="$description" \
    -f target_url="${GITHUB_SERVER_URL:?}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:?}" || {
    printf 'public-guard: could not set the commit status\n' >&2
    return 1
  }
}

# Never check out or execute pull request content. The base branch provides
# this script; the pull request is fetched only as Git objects to read.
github_main() {
  local event="${GITHUB_EVENT_PATH:?}" base head fetched
  case "${GITHUB_EVENT_NAME:?}" in
    pull_request_target)
      GUARD_HEAD_SHA="$(jq -r .pull_request.head.sha "$event")"
      github_status pending "Scanning for non-public content"
      git fetch --quiet --no-tags origin "+refs/pull/$(jq -r .pull_request.number "$event")/head:refs/public-guard/head"
      fetched="$(git rev-parse refs/public-guard/head)"
      if [[ "$fetched" != "$GUARD_HEAD_SHA" ]]; then
        printf 'public-guard: pull request head moved; the newer event scans it\n' >&2
        status_final=1
        return 0
      fi
      git fetch --quiet --no-tags origin "+refs/heads/$(jq -r .pull_request.base.ref "$event"):refs/public-guard/base"
      base="$(git merge-base refs/public-guard/base "$fetched")"
      jq -j '.pull_request.title // ""' "$event" >"$work/pr-title"
      jq -j '.pull_request.body // ""' "$event" >"$work/pr-body"
      jq -j '.pull_request.head.ref // ""' "$event" >"$work/branch-name"
      scan_range "$base" "$fetched" pr-title="$work/pr-title" pr-body="$work/pr-body" \
        branch-name="$work/branch-name"
      ;;
    push)
      base="$(jq -r .before "$event")"
      head="$(jq -r .after "$event")"
      [[ "$base" =~ ^0+$ ]] && base="$(git rev-list --max-parents=0 "$head" | tail -n 1)"
      scan_range "$base" "$head"
      ;;
    *) fail "unsupported event" ;;
  esac
  if report; then
    github_status success "No non-public content found"
    status_final=1
  else
    github_status failure "Non-public content found; see details"
    status_final=1
    return 1
  fi
}

# Issue, pull request, and comment text from GitHub events. Only text the
# event added or changed is scanned. A comment with a finding is hidden as
# off-topic. An issue or pull request title or body with a finding gets its
# text from before the edit back, or a removal notice when that text is
# missing or also has a finding. The run then fails with one error line that
# names the link and the finding categories, never the matched text.
github_text() {
  local event="${GITHUB_EVENT_PATH:?}" subject field scanned=0 categories action
  case "${GITHUB_EVENT_NAME:?}" in
    issues) subject=issue ;;
    pull_request_target) subject=pull_request ;;
    issue_comment | pull_request_review_comment) subject=comment ;;
    *) fail "unsupported event" ;;
  esac
  for field in title body; do
    [[ "$subject" == comment && "$field" == title ]] && continue
    if [[ "$(jq -r .action "$event")" == edited ]] &&
      ! jq -e --arg f "$field" '.changes // {} | has($f)' "$event" >/dev/null; then
      continue
    fi
    jq -j --arg s "$subject" --arg f "$field" '.[$s][$f] // ""' "$event" >"$work/text/$field.txt"
    scanned=1
  done
  ((scanned == 0)) || run_gitleaks dir "$work/text"
  report && return 0
  categories="$(awk -F'|' '{c = $1; if (c ~ /\./) sub(/\..*/, "", c); else c = "access-key"; print c}' \
    "$work/findings" | sort -u | paste -sd, - | sed 's/,/, /g')"
  if [[ "$subject" == comment ]]; then
    action="hid the comment"
    gh api graphql -f id="$(jq -r .comment.node_id "$event")" \
      -f query="mutation(\$id: ID!) { minimizeComment(input: {subjectId: \$id, classifier: OFF_TOPIC}) { minimizedComment { isMinimized } } }" \
      --jq .data.minimizeComment.minimizedComment.isMinimized | grep -qx true || action="could not hide the comment"
  else
    action="$(revert_text "$event" "$subject")" || action="could not change the text"
  fi
  printf '::error title=Public text check::Found %s in %s; %s.\n' "$categories" \
    "$(jq -r --arg s "$subject" '.[$s].html_url' "$event")" "$action"
  return 1
}

# Print what reverting did. Fields with a finding take their text from before
# the edit when it exists and is clean, otherwise a removal notice.
revert_text() {
  local event="$1" subject="$2" field fields=() patch='{}' notice=0 path=issues
  mv "$work/findings" "$work/findings.current"
  : >"$work/findings"
  rm -f "$work/text/"*
  for field in title body; do
    grep -qF "|$work/text/$field.txt:" "$work/findings.current" || continue
    fields+=("$field")
    if jq -e --arg f "$field" '.changes // {} | .[$f] // {} | has("from")' "$event" >/dev/null; then
      jq -j --arg f "$field" '.changes[$f].from // ""' "$event" >"$work/text/$field.txt"
    fi
  done
  [[ -z "$(ls -A "$work/text")" ]] || run_gitleaks dir "$work/text"
  for field in "${fields[@]}"; do
    if [[ -f "$work/text/$field.txt" ]] && ! grep -qF "|$work/text/$field.txt:" "$work/findings"; then
      patch="$(jq -c --arg f "$field" --rawfile v "$work/text/$field.txt" '.[$f] = $v' <<<"$patch")"
    else
      notice=1
      patch="$(jq -c --arg f "$field" '.[$f] = (if $f == "title" then "Title removed by the public content check"
        else "This text was removed by the public content check." end)' <<<"$patch")"
    fi
  done
  mv "$work/findings.current" "$work/findings"
  [[ "$subject" == issue ]] || path=pulls
  gh api --silent -X PATCH "repos/${GITHUB_REPOSITORY:?}/$path/$(jq -r --arg s "$subject" '.[$s].number' "$event")" \
    --input - <<<"$patch" || return 1
  if ((notice == 1)); then printf 'replaced the text with a removal notice\n'; else printf 'put back the earlier text\n'; fi
}

pre_push() {
  local remote="${1:-origin}" _local_ref local_sha remote_ref remote_sha base
  local zero="0000000000000000000000000000000000000000"
  while read -r _local_ref local_sha remote_ref remote_sha; do
    [[ "$local_sha" == "$zero" ]] && continue
    if [[ "$remote_sha" != "$zero" ]] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
      base="$remote_sha"
    else
      base="$(git merge-base "refs/remotes/$remote/HEAD" "$local_sha" 2>/dev/null ||
        git merge-base "refs/remotes/$remote/main" "$local_sha" 2>/dev/null)" ||
        fail "cannot find the remote base; fetch $remote first"
    fi
    printf '%s' "${remote_ref#refs/heads/}" >"$work/branch-name"
    rm -f "$work/text/"*
    scan_range "$base" "$local_sha" branch-name="$work/branch-name"
  done
  report
}

install_hooks() {
  local terms_file="${1:-}"
  git config --local hook.logbrew-public-guard-message.event commit-msg
  git config --local hook.logbrew-public-guard-message.command "bash scripts/public-guard.sh commit-msg"
  git config --local hook.logbrew-public-guard-push.event pre-push
  git config --local hook.logbrew-public-guard-push.command "bash scripts/public-guard.sh pre-push"
  if [[ -n "$terms_file" ]]; then
    [[ -f "$terms_file" ]] || fail "project term list file is missing"
    git config --local logbrew.publicGuardTermsFile "$(cd "$(dirname "$terms_file")" && pwd)/$(basename "$terms_file")"
  fi
  git hook list commit-msg 2>/dev/null | grep -q 'logbrew-public-guard-message' ||
    fail "this Git does not run configured hooks; use Git 2.54 or later"
  printf 'public-guard: commit-msg and pre-push hooks enabled\n'
}

cd "$(git rev-parse --show-toplevel)"
command="${1:-}"
[[ $# -gt 0 ]] && shift
case "$command" in
  install)
    install_hooks "$@"
    exit 0
    ;;
  range | text | commit-msg | pre-push | github | github-text) ;;
  *) fail "unknown command; see the usage comment in this script" ;;
esac

printf '{{ range . }}{{ .RuleID }}|{{ .File }}:{{ .StartLine }}|{{ .Commit }}\n{{ end }}' >"$work/report.tmpl"
: >"$work/findings"
gitleaks="$(gitleaks_binary)"
config="$(build_config)"

case "$command" in
  range)
    [[ $# -ge 2 ]] || fail "range needs BASE and HEAD"
    scan_range "$@"
    report
    ;;
  text)
    [[ $# -ge 1 ]] || fail "text needs at least one LABEL=FILE"
    for item in "$@"; do add_text "$item"; done
    run_gitleaks dir "$work/text"
    report
    ;;
  commit-msg)
    [[ $# -ge 1 ]] || fail "commit-msg needs the message file"
    git stripspace --strip-comments <"$1" >"$work/text/new-commit-message.txt"
    run_gitleaks git --staged --pre-commit .
    run_gitleaks dir "$work/text"
    check_markdown
    report
    ;;
  pre-push) pre_push "$@" ;;
  github) github_main ;;
  github-text) github_text ;;
  *) fail "unknown command" ;;
esac
