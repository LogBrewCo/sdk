# CI sets BASH_ENV to this file, so every non-interactive bash in a job reads
# it first. When a command stops a script that runs with errexit, the script
# names that command, its file and line, and its exit status. A failed step
# then always says where it failed, even when the tool itself printed nothing.
logbrew_report_failure() {
  [[ $- != *e* ]] || printf '%s:%s: %s exited with status %s\n' "$4" "$2" "$3" "$1" >&2
}
set -o errtrace
trap 'logbrew_report_failure "$?" "$LINENO" "$BASH_COMMAND" "${BASH_SOURCE[0]:-$0}"' ERR
