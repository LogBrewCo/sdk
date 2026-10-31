#!/usr/bin/env bash
# Seeded checks for scripts/public-guard.sh. Every sample is built at run time
# and the project term is random, so this file never holds a real term.
set -euo pipefail

guard_source="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
work="$(mktemp -d "${tmp_root%/}/public-guard-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failures=0

random_word() { printf 'zq%s' "$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"; }
term="$(random_word)"
only_term="$(random_word)"
except_term="$(random_word)"
dir_term="$(random_word)"
other_dir_term="$(random_word)"
upper_term="$(printf '%s' "$term" | tr '[:lower:]' '[:upper:]')"
split_term="${term:0:4}-${term:4:3}_${term:7}"
# Build UTF-8 bytes from numbers: the scanner decodes escape sequences in files.
utf8() { printf '%b' "$(printf '\\0%03o' "$@")"; }
zw_term="${term:0:5}$(utf8 226 128 139)${term:5}"
terms="$(printf 'infrastructure\t%s\nstorage\t=exact.%s\ncost\tre:(?i)\\bfee-%s\\b\nprivate-repo\t%s\tonly:other-repo\ninternal-plan\t%s\texcept:sample\n' \
  "$term" "$term" "$term" "$only_term" "$except_term")"
terms+="$(printf '\nproduct\t%s\texcept:other-repo,sample@bench.v2/\nproduct\t%s\texcept:other-repo@bench.v2/\n' \
  "$dir_term" "$other_dir_term")"

repo="$work/sample"
git init -q --bare -b main "$work/sample.git"
git init -q -b main "$repo"
git -C "$repo" config user.name "Guard Test"
git -C "$repo" config user.email "guard@example.com"
git -C "$repo" config commit.gpgsign false
git -C "$repo" remote add origin "$work/sample.git"
mkdir "$repo/scripts"
cp "$guard_source/public-guard.sh" "$guard_source/public-guard.toml" "$repo/scripts/"
printf 'public\n' >"$repo/README.md"
git -C "$repo" add -A
git -C "$repo" commit -q -m "chore: base"
git -C "$repo" push -q origin main
base="$(git -C "$repo" rev-parse HEAD)"

run_guard() {
  (cd "$repo" && PUBLIC_GUARD_TERMS="$terms" bash scripts/public-guard.sh "$@") >"$work/out" 2>&1
}

expect() {
  local name="$1" want_status="$2" want_text="$3" leak="$4" status=0
  shift 4
  run_guard "$@" || status=$?
  if [[ "$status" != "$want_status" ]] || ! grep -qF -- "$want_text" "$work/out"; then
    printf 'FAIL %s: status %s, want %s and "%s"\n' "$name" "$status" "$want_status" "$want_text"
    sed 's/^/  | /' "$work/out"
    failures=$((failures + 1))
  elif [[ -n "$leak" ]] && grep -qF -- "$leak" "$work/out"; then
    printf 'FAIL %s: output repeats the matched text\n' "$name"
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

# Commit one file change and scan it as a pull request range.
expect_commit() {
  local name="$1" want_status="$2" want_text="$3" leak="$4" path="$5" content="$6" message="${7:-test: change}"
  git -C "$repo" checkout -q -B "case" "$base"
  mkdir -p "$repo/$(dirname "$path")"
  printf '%s\n' "$content" >"$repo/$path"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "$message"
  expect "$name" "$want_status" "$want_text" "$leak" range "$base" HEAD
}

home_path="/Us""ers/zed-$term/project"
agent_path="/home/zed/.co""dex/sessions/$term"
email="jane.roe-$term@""acmecorp-mail.com"
shared_ip="100.""101.17.$((RANDOM % 200 + 1))"
attribution="Co-Authored-""By: Cla""ude <bot@example.com>"
# A fixed hash, not the random term: a term with repeated digits can fall below
# the access key entropy limit, and then the sample is not a finding.
access_key="ghp_$(printf 'public guard sample key' | git hash-object --stdin | head -c 36)"
bidi="a$(utf8 226 128 174)b"

expect_commit "project term in file" 1 "infrastructure: src/app.txt:1 in commit" "$term" src/app.txt "host $term"
expect_commit "project term in upper case" 1 "infrastructure:" "$upper_term" src/app.txt "HOST $upper_term"
expect_commit "project term split by separators" 1 "infrastructure:" "$split_term" src/app.txt "host $split_term"
expect_commit "project term split by zero-width space" 1 "infrastructure:" "" src/app.txt "host $zw_term"
expect_commit "project term inside identifier" 1 "infrastructure:" "" src/app.txt "const my${upper_term}Client = 1"
expect_commit "project term in file path" 1 "changed file path #1" "" "docs/$term.txt" "public"
expect_commit "project term in commit message" 1 "commit message" "$term" src/app.txt "public" "fix: move $term"
expect_commit "exact project term" 1 "storage:" "" src/app.txt "see exact.$term now"
expect_commit "regex project term" 1 "cost:" "" src/app.txt "fee-$term"
expect_commit "term scoped to another repository" 0 "clean" "" src/app.txt "$only_term"
expect_commit "term excluded for this repository" 0 "clean" "" src/app.txt "$except_term"
expect_commit "term excluded under a directory" 0 "clean" "" bench.v2/package.json "{\"$dir_term\": \"1.0.0\"}"
expect_commit "directory exclusion stops at the directory" 1 "product: src/app.txt:1" "$dir_term" src/app.txt "$dir_term"
expect_commit "directory exclusion is anchored at the root" 1 "product: src/bench.v2/a.txt:1" "" src/bench.v2/a.txt "$dir_term"
expect_commit "directory exclusion escapes dots" 1 "product: benchxv2/a.txt:1" "" benchxv2/a.txt "$dir_term"
expect_commit "directory exclusion skips commit messages" 1 "product: commit message" "$dir_term" bench.v2/a.txt "public" "fix: add $dir_term"
expect_commit "directory exclusion skips file paths" 1 "product: changed file path #1" "" "bench.v2/$dir_term.txt" "public"
expect_commit "directory exclusion for another repository" 1 "product: bench.v2/a.txt:1" "" bench.v2/a.txt "$other_dir_term"
expect_commit "home directory path" 1 "local-path:" "$home_path" src/app.txt "path $home_path"
expect_commit "agent session path" 1 "local-path:" "$agent_path" src/app.txt "path $agent_path"
expect_commit "email address" 1 "personal-data:" "$email" src/app.txt "contact $email"
expect_commit "shared-address network IP" 1 "private-network:" "$shared_ip" src/app.txt "dial $shared_ip:443"
expect_commit "agent attribution in message" 1 "agent-attribution: commit message" "" src/app.txt "public" "$(printf 'fix: x\n\n%s' "$attribution")"
expect_commit "access key" 1 "access-key" "$access_key" src/app.txt "key = \"$access_key\""
expect_commit "bidirectional control character" 1 "hidden-text:" "" src/app.txt "$bidi"
expect_commit "inline allow comment is ignored" 1 "infrastructure:" "" src/app.txt "host $term # gitleaks:allow"
patch_file="thread-stream@""4.2.0.patch"
expect_commit "package patch file name stays allowed" 0 "clean" "" package.json \
  "{\"patchedDependencies\": {\"thread-stream@4.2.0\": \"patches/$patch_file\"}}"
expect_commit "public placeholders stay allowed" 0 "clean" "" src/app.txt "$(printf '%s\n' \
  "/Us""ers/example/app" "user@example.com" "trace_id=0123456789abcdef0123456789abcdef" \
  "localStorage retention storage ActivityKind.Internal" "Co-authored-by: Jane Roe <jane@roe.dev>")"

expect_commit "unlisted Markdown file" 1 "markdown: docs/notes.md" "" docs/notes.md "public"
expect_commit "Markdown with another extension" 1 "markdown: notes.markdown" "" notes.markdown "public"
expect_commit "package README stays allowed" 0 "clean" "" pkg/README.md "public"
expect_commit "changelog stays allowed" 0 "clean" "" CHANGELOG.md "public"
expect_commit "published skill file stays allowed" 0 "clean" "" plugins/app/skills/use/references/cli.md "public"
git -C "$repo" checkout -q -B "case" "$base"
printf 'public\n' >"$repo/notes.md"
git -C "$repo" add notes.md
printf 'docs: add notes\n' >"$work/message"
expect "staged Markdown blocks the commit" 1 "markdown: notes.md" "" commit-msg "$work/message"
git -C "$repo" rm -q --cached notes.md && rm "$repo/notes.md"

# A removed line is not new content; history before BASE is not rescanned.
git -C "$repo" checkout -q -B "case" "$base"
printf 'host %s\n' "$term" >"$repo/old.txt"
git -C "$repo" add -A && git -C "$repo" commit -q -m "test: old"
old="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" rm -q old.txt && git -C "$repo" commit -q -m "test: remove"
expect "existing history before base is not rescanned" 0 "clean" "" range "$old" HEAD

printf 'feat: add %s\n' "$term" >"$work/title"
printf 'body without content\n' >"$work/body"
expect "pull request title" 1 "infrastructure: pr-title line 1" "$term" text pr-title="$work/title" pr-body="$work/body"
expect "guard sources pass their own rules" 0 "clean" "" text \
  guard-script="$guard_source/public-guard.sh" guard-rules="$guard_source/public-guard.toml" \
  guard-test="$guard_source/test-public-guard.sh" guard-workflow="$guard_source/../.github/workflows/public-text-guard.yml"

# The GitHub entry point reads the pull request from the event file, scans it
# as Git objects, and reports a commit status through a stub gh command.
# The stub logs its arguments and any --input body, and answers the hide
# mutation the way GitHub does.
mkdir "$work/bin"
cat >"$work/bin/gh" <<STUB
#!/usr/bin/env bash
printf '%s\\n' "\$*" >>"$work/gh.log"
if [[ "\$*" == *"--input -"* ]]; then cat >>"$work/gh.log"; fi
if [[ "\$*" == *minimizeComment* ]]; then printf 'true\\n'; fi
STUB
chmod +x "$work/bin/gh"
github_case() {
  local name="$1" want_status="$2" want_text="$3" want_state="$4" body="$5" event_sha="${6:-}"
  git -C "$repo" checkout -q -B "case" "$base"
  printf 'public\n' >"$repo/src.txt"
  git -C "$repo" add -A && git -C "$repo" commit -q -m "feat: change"
  git -C "$repo" push -q -f origin "HEAD:refs/pull/7/head"
  jq -n --arg sha "${event_sha:-$(git -C "$repo" rev-parse HEAD)}" --arg body "$body" \
    '{pull_request: {number: 7, title: "feat: change", body: $body, head: {sha: $sha, ref: "feature/change"}, base: {ref: "main"}}}' \
    >"$work/event.json"
  : >"$work/gh.log"
  PATH="$work/bin:$PATH" GITHUB_EVENT_NAME=pull_request_target GITHUB_EVENT_PATH="$work/event.json" \
    GITHUB_REPOSITORY=org/sample GITHUB_SERVER_URL=https://example.com GITHUB_RUN_ID=1 PUBLIC_GUARD_REQUIRE_TERMS=1 \
    expect "$name" "$want_status" "$want_text" "$term" github
  if [[ -n "$want_state" ]] && ! grep -q "state=$want_state" "$work/gh.log"; then
    printf 'FAIL %s: commit status %s was not reported\n' "$name" "$want_state"
    failures=$((failures + 1))
  fi
}
github_case "pull request body blocks with a failure status" 1 "pr-body line 1" failure "Adds $term support"
github_case "clean pull request gets a success status" 0 "clean" success "Adds support"
github_case "moved pull request head is left to the newer event" 0 "head moved" "" "Adds support" "$base"

# Issue, pull request, and comment events: EVENT_NAME, payload as JSON, the
# expected status and output, and text the gh calls must contain.
text_case() {
  local name="$1" event_name="$2" payload="$3" want_status="$4" want_text="$5" want_call="$6"
  printf '%s\n' "$payload" >"$work/event.json"
  : >"$work/gh.log"
  PATH="$work/bin:$PATH" GITHUB_EVENT_NAME="$event_name" GITHUB_EVENT_PATH="$work/event.json" \
    GITHUB_REPOSITORY=org/sample PUBLIC_GUARD_REQUIRE_TERMS=1 \
    expect "$name" "$want_status" "$want_text" "$term" github-text
  if { [[ -z "$want_call" ]] && [[ -s "$work/gh.log" ]]; } ||
    { [[ -n "$want_call" ]] && ! grep -qF -- "$want_call" "$work/gh.log"; }; then
    printf 'FAIL %s: gh calls miss "%s"\n' "$name" "$want_call"
    sed 's/^/  | /' "$work/gh.log"
    failures=$((failures + 1))
  elif grep -qF -- "$term" "$work/gh.log"; then
    printf 'FAIL %s: gh calls repeat the matched text\n' "$name"
    failures=$((failures + 1))
  fi
}
url=https://example.com/org/sample/issues/9
text_case "new comment with a finding is hidden" issue_comment \
  "{\"action\": \"created\", \"comment\": {\"node_id\": \"IC_9\", \"html_url\": \"$url#c1\", \"body\": \"see $term\"}}" \
  1 "Found infrastructure in $url#c1; hid the comment." "id=IC_9"
text_case "clean comment is left alone" pull_request_review_comment \
  "{\"action\": \"edited\", \"changes\": {\"body\": {\"from\": \"old\"}}, \"comment\": {\"node_id\": \"RC_9\", \"html_url\": \"$url\", \"body\": \"fine\"}}" \
  0 "clean" ""
text_case "edited issue body gets its earlier text back" issues \
  "{\"action\": \"edited\", \"changes\": {\"body\": {\"from\": \"earlier words\"}}, \"issue\": {\"number\": 9, \"html_url\": \"$url\", \"title\": \"Crash\", \"body\": \"host $term\"}}" \
  1 "Found infrastructure in $url; put back the earlier text." '{"body":"earlier words"}'
text_case "earlier text with a finding becomes a notice" issues \
  "{\"action\": \"edited\", \"changes\": {\"body\": {\"from\": \"old $term\"}}, \"issue\": {\"number\": 9, \"html_url\": \"$url\", \"title\": \"Crash\", \"body\": \"host $term\"}}" \
  1 "replaced the text with a removal notice." "repos/org/sample/issues/9"
text_case "new issue title with a finding becomes a notice" issues \
  "{\"action\": \"opened\", \"issue\": {\"number\": 9, \"html_url\": \"$url\", \"title\": \"Crash in $term\", \"body\": \"steps\"}}" \
  1 "replaced the text with a removal notice." '{"title":"Title removed by the public content check"}'
text_case "edited pull request body goes back through the pulls API" pull_request_target \
  "{\"action\": \"edited\", \"changes\": {\"body\": {\"from\": \"\"}}, \"pull_request\": {\"number\": 7, \"html_url\": \"$url\", \"title\": \"feat: x\", \"body\": \"$term\"}}" \
  1 "put back the earlier text." "repos/org/sample/pulls/7"
text_case "only the edited field is scanned" pull_request_target \
  "{\"action\": \"edited\", \"changes\": {\"title\": {\"from\": \"feat: y\"}}, \"pull_request\": {\"number\": 7, \"html_url\": \"$url\", \"title\": \"feat: x\", \"body\": \"$term\"}}" \
  0 "clean" ""

terms="" expect "missing term list falls back to generic rules" 0 "generic rules only" "" text pr-body="$work/body"
PUBLIC_GUARD_REQUIRE_TERMS=1 terms="" expect "required term list missing fails closed" 2 "required but unavailable" "" text pr-body="$work/body"
terms="$(printf 'Bad Category\t%s\n' "$term")" expect "malformed term list fails closed" 2 "malformed line" "" text pr-body="$work/body"
terms="$(printf 'product\t%s\texcept:sample@bench\n' "$term")" expect "directory scope without a slash fails closed" 2 "malformed scope" "" text pr-body="$work/body"
terms="$(printf 'product\t%s\texcept:sample@../x/\n' "$term")" expect "directory scope outside the repository fails closed" 2 "malformed scope" "" text pr-body="$work/body"

if ((failures > 0)); then
  printf '%d public guard check(s) failed\n' "$failures"
  exit 1
fi
printf 'public guard checks passed\n'
