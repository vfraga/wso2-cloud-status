#!/bin/sh
# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

# Paging, recovery message and heartbeat for the scheduled external check
# (.github/workflows/synthetic.yml). One message when a failure episode
# starts, one when it ends, nothing while it lasts; a failing run pages again
# while no run of the episode has delivered its page.
#
#   scripts/ops/synthetic-notify.sh run pass|fail
#   scripts/ops/synthetic-notify.sh decide pass|fail [PREVIOUS...]
#
# decide prints page, recover or quiet. PREVIOUS are the earlier scheduled
# runs, newest first: each is the run's conclusion as GitHub reports it, with
# ":paged" added when that run recorded that its failure episode has paged.
# The first success, failure, timed_out or startup_failure counts, and
# cancelled or skipped runs are passed over. "unknown" means the lookup
# failed: a failing check then pages (a repeated message beats a missed one)
# and a passing check sends nothing.
#
#   result  previous run          action
#   fail    passed or none        page: a failure episode starts
#   fail    failed, :paged        quiet: this episode has paged
#   fail    failed, not :paged    page: no page of this episode was delivered
#   fail    unknown               page
#   pass    failed                recover: the episode is over
#   pass    anything else         quiet
#
# run looks the previous runs up with the GitHub CLI (permission actions:
# read), acts on the decision, and fetches the heartbeat URL after a passing
# check. A failing run marks the episode as paged when the webhook accepted
# its page, or when the previous run carried the mark: it writes paged=true
# to GITHUB_OUTPUT and the file PAGED_FILE, and the workflow uploads that
# file as the artifact synthetic-paged, which the next run looks for. The
# workflow step that calls it must not change the run's conclusion
# (continue-on-error), because the next run reads that conclusion as this
# check's result.
#
# Webhook and heartbeat calls are retried 3 times, RETRY_DELAY_SECONDS apart
# (default 5), within 60 seconds.
#
# Environment for run:
#   PAGING_WEBHOOK   URL that receives {"text": "..."} by POST; unset: the
#                    message is only printed and nothing is marked
#   HEARTBEAT_URL    URL fetched with GET after a passing check, for a
#                    heartbeat monitor that alerts when the pings stop
#   STATUS_BASE_URL  the address that was checked, for the message
#   CHECK_OUTPUT     file with the check's output; its FAIL lines go in the
#                    page, without "<" and ">" (Google Chat reads <users/all>
#                    as a mention of everyone and <url|text> as a link)
#   RUN_URL          link to this run, for the message
#   RUNBOOK_URL      link to the runbook section, for the message
#   WORKFLOW         workflow file to read earlier runs of; default synthetic.yml
#   CURRENT_RUN_ID   this run's id, never counted as a previous run
#   PAGED_FILE       file to write when the episode is marked as paged
#   GH_TOKEN, GH_REPO  for the GitHub CLI
# Exits 0 when every call it made succeeded, 1 when a webhook or heartbeat
# call failed, 2 on a usage error. Needs curl and jq; run also needs gh.
set -u

mark_artifact=synthetic-paged

usage() {
  echo "synthetic-notify: $1" >&2
  echo "usage: $0 run pass|fail  |  $0 decide pass|fail [PREVIOUS...]" >&2
  exit 2
}

decide() {
  result=$1
  shift
  previous=none
  for run in "$@"; do
    case $run in
      success) previous=pass ;;
      failure:paged | timed_out:paged | startup_failure:paged) previous=paged ;;
      failure | timed_out | startup_failure) previous=fail ;;
      unknown) previous=unknown ;;
      *) continue ;;
    esac
    break
  done
  case $result:$previous in
    fail:paged) echo quiet ;;
    fail:*) echo page ;;
    pass:fail | pass:paged) echo recover ;;
    *) echo quiet ;;
  esac
}

# previous_runs prints the latest completed scheduled runs, newest first,
# in the form decide reads, or "unknown" when GitHub cannot be asked. Only
# the newest run that counts is looked up for the mark.
previous_runs() {
  err=$(mktemp) || {
    echo unknown
    return
  }
  if ! runs=$(gh run list --workflow "${WORKFLOW:-synthetic.yml}" --event schedule --status completed \
    --limit 20 --json databaseId,conclusion \
    --jq ".[] | select(.databaseId != ${CURRENT_RUN_ID:-0}) | \"\(.databaseId) \(.conclusion)\"" 2>"$err"); then
    echo "synthetic-notify: could not read earlier runs: $(head -n 3 "$err")" >&2
    rm -f "$err"
    echo unknown
    return
  fi
  looked=false
  printf '%s\n' "$runs" | while read -r id conclusion; do
    [ -n "$conclusion" ] || continue
    case $looked:$conclusion in
      false:failure | false:timed_out | false:startup_failure)
        looked=true
        if marks=$(gh api "repos/{owner}/{repo}/actions/runs/$id/artifacts" \
          --jq "[.artifacts[] | select(.name == \"$mark_artifact\" and (.expired | not))] | length" 2>"$err") &&
          [ "${marks:-0}" -gt 0 ] 2>/dev/null; then
          conclusion="$conclusion:paged"
        elif [ -s "$err" ]; then
          echo "synthetic-notify: could not read the artifacts of run $id, so a page counts as not delivered: $(head -n 3 "$err")" >&2
        fi
        ;;
      false:success) looked=true ;;
    esac
    echo "$conclusion"
  done
  rm -f "$err"
}

# post TEXT sends TEXT to the paging webhook; delivered says whether it
# arrived.
post() {
  delivered=false
  if [ -z "${PAGING_WEBHOOK:-}" ]; then
    echo "No paging webhook is set; nobody is notified. The message would have been:"
    printf '%s\n' "$1"
    return 0
  fi
  if jq -n --arg text "$1" '{text: $text}' |
    curl -sS --fail-with-body --max-time 15 --retry 3 --retry-all-errors --retry-delay "$retry_delay" \
      --retry-max-time 60 -X POST -H 'Content-Type: application/json' \
      --data-binary @- "$PAGING_WEBHOOK" >/dev/null; then
    echo "Paging webhook called."
    delivered=true
    return 0
  fi
  echo "synthetic-notify: the paging webhook call failed" >&2
  return 1
}

# mark records that this failure episode has paged.
mark() {
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "paged=true" >>"$GITHUB_OUTPUT"
  [ -z "${PAGED_FILE:-}" ] || printf 'The failure episode that includes run %s has paged.\n' "${CURRENT_RUN_ID:-}" >"$PAGED_FILE"
  echo "Marked this failure episode as paged ($mark_artifact)."
}

failures() {
  lines=$(grep '^FAIL' "${CHECK_OUTPUT:-/dev/null}" 2>/dev/null | head -n 5 | tr -d '<>' | cut -c 1-500)
  [ -n "$lines" ] || lines="the check did not complete; see the run log"
  printf '%s' "$lines"
}

run() {
  result=$1
  target=${STATUS_BASE_URL:-the status page}
  # Word splitting is wanted: one previous run per word.
  # shellcheck disable=SC2046
  action=$(decide "$result" $(previous_runs))
  echo "Check $result; action: $action."
  status=0
  case $action in
    page)
      if post "$(printf 'Status page synthetic check failed for %s\n%s\nRunbook: %s\nRun: %s\nNo further message while it keeps failing; one when a scheduled run passes again.' \
        "$target" "$(failures)" "${RUNBOOK_URL:-docs/operations/runbook.md#external-synthetic-check}" "${RUN_URL:-}")"; then
        [ "$delivered" = false ] || mark
      else
        status=1
      fi
      ;;
    recover)
      post "$(printf 'Status page synthetic check passed again for %s\nRun: %s' "$target" "${RUN_URL:-}")" || status=1
      ;;
    *)
      # Quiet on a failing run: the previous run carried the mark.
      [ "$result" != fail ] || mark
      ;;
  esac
  if [ "$result" = pass ] && [ -n "${HEARTBEAT_URL:-}" ]; then
    if curl -sS --fail --max-time 15 --retry 3 --retry-all-errors --retry-delay "$retry_delay" \
      --retry-max-time 60 -o /dev/null "$HEARTBEAT_URL"; then
      echo "Heartbeat sent."
    else
      echo "synthetic-notify: the heartbeat call failed" >&2
      status=1
    fi
  fi
  return "$status"
}

retry_delay=${RETRY_DELAY_SECONDS:-5}
case $retry_delay in '' | *[!0-9]*) usage "RETRY_DELAY_SECONDS must be a whole number of seconds" ;; esac

[ $# -ge 2 ] || usage "missing arguments"
mode=$1
result=$2
shift 2
case $result in pass | fail) ;; *) usage "the result must be pass or fail, got '$result'" ;; esac
case $mode in
  decide) decide "$result" "$@" ;;
  run)
    [ $# -eq 0 ] || usage "run takes only the result"
    for tool in curl jq gh; do
      command -v "$tool" >/dev/null 2>&1 || usage "$tool is required"
    done
    run "$result"
    ;;
  *) usage "unknown mode '$mode'" ;;
esac
