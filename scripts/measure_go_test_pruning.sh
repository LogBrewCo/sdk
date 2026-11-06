#!/usr/bin/env bash
# Measures one Go package's tests so a test deletion can be proved safe.
#
# Usage: scripts/measure_go_test_pruning.sh OUTPUT_DIR SOURCE_FILE...
#
# Every SOURCE_FILE must be in the same Go package. Run the script once on the
# base commit and once on the changed commit, then compare the two outputs:
#   summary.txt         test counts, race-test wall times and their median,
#                       and statement coverage
#   covered-blocks.txt  every covered statement block of non-test code
#   mutants.txt         each mutant of SOURCE_FILE and its result: killed,
#                       survived, uncovered (no test runs its line), or skipped
#                       (it does not compile)
# A deletion is safe when covered-blocks.txt is the same and every mutant that
# was killed before is still killed.
#
# Each mutant runs only the tests whose coverage includes a changed line: a test
# that never runs a line cannot kill a mutant of that line.
# Environment: JOBS (parallel mutants, default 4), RUNS (timed runs, default 3).
set -Eeuo pipefail

mutesting_version="v0.0.0-20261002081621-9ce5f731e321"

if (($# < 2)); then
  printf 'usage: %s OUTPUT_DIR SOURCE_FILE...\n' "$0" >&2
  exit 2
fi
output_dir="$(mkdir -p "$1" && cd "$1" && pwd)"
shift
module_dir="$(cd "$(dirname "$1")" && pwd)"
targets=()
for source in "$@"; do
  if [[ "$(cd "$(dirname "$source")" && pwd)" != "$module_dir" ]]; then
    printf 'source files must share one package: %s\n' "$source" >&2
    exit 2
  fi
  targets+=("$(basename "$source")")
done
jobs="${JOBS:-4}"
runs="${RUNS:-3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$module_dir"
if [[ -f .go-version ]]; then
  GOTOOLCHAIN="go$(tr -d '[:space:]' <.go-version)"
  export GOTOOLCHAIN
fi

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }

: >"$work/times"
for run in $(seq 1 "$runs"); do
  start="$(now)"
  # Timing tests can miss their deadlines on a busy machine; the summary lists them.
  go test -race -count=1 -json ./... >"$work/run-$run.json" || true
  end="$(now)"
  awk -v a="$start" -v b="$end" 'BEGIN { printf "%.2f\n", b - a }' >>"$work/times"
done
top_tests="$(grep -c '"Action":"pass","Package":"[^"]*","Test":"[^"/]*","Elapsed"' "$work/run-1.json" || true)"
subtests="$(grep -c '"Action":"pass","Package":"[^"]*","Test":"[^"]*/[^"]*","Elapsed"' "$work/run-1.json" || true)"
timed_failures="$(cat "$work"/run-*.json | sed -n 's/.*"Action":"fail","Package":"[^"]*","Test":"\([^"/]*\)".*/\1/p' | sort -u | paste -sd ' ' -)"
median="$(sort -n "$work/times" | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2 }')"

# A test that limits its child's file size cannot pass while the child writes
# coverage data, so the coverage run lists its failures instead of stopping.
go test -count=1 -covermode=set -coverprofile="$work/cover.out" . >"$work/cover.log" 2>&1 || true
coverage_failures="$(sed -n 's/^--- FAIL: \([^ ]*\).*/\1/p' "$work/cover.log" | paste -sd ' ' -)"
statement_coverage="$(go tool cover -func="$work/cover.out" | awk '/^total:/ { print $NF }')"
awk 'NR > 1 && $NF > 0 { print $1 }' "$work/cover.out" | sort >"$output_dir/covered-blocks.txt"

# Coverage of each top-level test: "file start-line end-line test" per block.
go test -c -cover -covermode=set -o "$work/package.test" . >/dev/null
mkdir -p "$work/tests" "$work/coverdir"
: >"$work/blocks.tsv"
while IFS= read -r name; do
  [[ "$name" =~ ^(Test|Fuzz|Example) ]] || continue
  GOCOVERDIR="$work/coverdir" "$work/package.test" -test.count=1 -test.run "^$name\$" \
    -test.coverprofile="$work/tests/$name.out" >/dev/null 2>&1 || true
  [[ -f "$work/tests/$name.out" ]] || continue
  awk -v test="$name" 'NR > 1 && $NF > 0 {
    split($1, place, ":"); file = place[1]; sub(/.*\//, "", file)
    split(place[2], span, ","); split(span[1], first, "."); split(span[2], last, ".")
    print file, first[1], last[1], test
  }' "$work/tests/$name.out" >>"$work/blocks.tsv"
done < <("$work/package.test" -test.list '.')

GOBIN="$work/bin" GOFLAGS=-mod=mod go install \
  "github.com/avito-tech/go-mutesting/cmd/go-mutesting@$mutesting_version"
mkdir -p "$work/mutants"
if [[ -e report.json ]]; then
  printf 'remove report.json from %s first; go-mutesting writes it there\n' "$module_dir" >&2
  exit 2
fi
TMPDIR="$work/mutants" "$work/bin/go-mutesting" --no-exec --do-not-remove-tmp-folder . >/dev/null 2>&1 || true
rm -f report.json
mutant_dir="$(find "$work/mutants" -mindepth 1 -maxdepth 1 -type d -name 'go-mutesting-*' | head -n 1)"

# Prints "file sha256 result" for one mutant file.
judge_mutant() {
  local mutant="$1" file lines tests pattern result digest
  file="$(basename "${mutant%.*}")"
  digest="$(shasum -a 256 "$mutant" | awk '{ print $1 }')"
  lines="$(diff "$file" "$mutant" | awk '/^[0-9]/ {
    match($0, /^[0-9]+(,[0-9]+)?/); split(substr($0, 1, RLENGTH), span, ",")
    for (line = span[1]; line <= (span[2] == "" ? span[1] : span[2]); line++) print line
  }' || true)"
  tests="$(awk -v file="$file" -v lines="$lines" 'BEGIN { n = split(lines, wanted, "\n") }
    $1 == file { for (i = 1; i <= n; i++) if (wanted[i] >= $2 && wanted[i] <= $3) print $4 }' \
    "$WORK/blocks.tsv" | sort -u | paste -sd '|' -)"
  if [[ -z "$tests" ]]; then
    printf '%s %s uncovered\n' "$file" "$digest"
    return
  fi
  pattern="^($tests)\$"
  printf '{"Replace":{"%s":"%s"}}' "$PWD/$file" "$mutant" >"$mutant.overlay"
  if go test -count=1 -failfast -timeout 120s -overlay "$mutant.overlay" -run "$pattern" . >"$mutant.log" 2>&1; then
    result=survived
  elif grep -q -e '\[build failed\]' -e '\[setup failed\]' "$mutant.log"; then
    result=skipped
  else
    result=killed
  fi
  printf '%s %s %s\n' "$file" "$digest" "$result"
}
export -f judge_mutant
export WORK="$work"

for target in "${targets[@]}"; do
  find "$mutant_dir" -maxdepth 1 -type f -name "$target.[0-9]*" ! -name '*.overlay' ! -name '*.log'
done | xargs -n 1 -P "$jobs" bash -c 'judge_mutant "$1"' _ | sort >"$output_dir/mutants.txt"

{
  printf 'top-level tests: %s\nsubtests: %s\n' "$top_tests" "$subtests"
  printf 'race test wall times (s): %s\nmedian (s): %s\n' "$(paste -sd ' ' "$work/times")" "$median"
  printf 'tests that failed in a timed run: %s\n' "${timed_failures:-none}"
  printf 'tests that fail only under coverage: %s\n' "${coverage_failures:-none}"
  printf 'statement coverage: %s\ncovered blocks: %s\n' "$statement_coverage" "$(wc -l <"$output_dir/covered-blocks.txt" | tr -d ' ')"
  for result in killed survived uncovered skipped; do
    printf 'mutants %s: %s\n' "$result" "$(grep -c " $result\$" "$output_dir/mutants.txt" || true)"
  done
} >"$output_dir/summary.txt"
cat "$output_dir/summary.txt"
