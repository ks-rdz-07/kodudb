#!/usr/bin/env bash
# Locks down the GitHub repository. Idempotent: run it again after making the repo public, because
# rulesets, secret scanning, CodeQL and private vulnerability reporting need a public repo on the free plan.
# Usage: scripts/harden-repo.sh [owner/repo]
set -u
REPO="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# Required approvals on main. 0 while there is a single maintainer (GitHub never lets you approve your own PR);
# set APPROVALS=1 when a second maintainer joins:  APPROVALS=1 scripts/harden-repo.sh
APPROVALS="${APPROVALS:-0}"
if [ "$APPROVALS" -gt 0 ]; then CODEOWNER=true; else CODEOWNER=false; fi
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
no() { printf '  \033[33mSKIP\033[0m %s  (%s)\n' "$1" "$2"; }
try() { local what="$1"; shift; if out=$("$@" 2>&1); then ok "$what"; else no "$what" "$(echo "$out" | tr -d '\n' | grep -o '"message":"[^"]*"' | head -1)"; fi; }

PRIVATE=$(gh api "repos/$REPO" --jq .private)
echo "Hardening $REPO (private=$PRIVATE)"

echo "Merge settings"
try "squash-only merges, auto-merge, delete merged branches, sign-off on web commits" \
  gh api -X PATCH "repos/$REPO" -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true -F allow_update_branch=true \
  -F web_commit_signoff_required=true -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY

echo "Security features"
try "Dependabot alerts"            gh api -X PUT "repos/$REPO/vulnerability-alerts"
try "Dependabot security updates"  gh api -X PUT "repos/$REPO/automated-security-fixes"
try "Private vulnerability reporting" gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
try "Secret scanning + push protection" gh api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"},
  "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

echo "GitHub Actions"
# Read-only token by default. Approving PRs is allowed only so the Dependabot job can approve patch updates.
try "workflow token read-only by default" gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
try "fork PRs from external contributors need approval before workflows run" \
  gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors

echo "Labels"
for l in "automerge:0e8a16:Maintainer approved: merge when checks pass" "beta:fbca04:Beta feedback" \
         "security:d93f0b:Security related" "good first issue:7057ff:Good for newcomers" \
         "help wanted:008672:Extra attention is needed" "enhancement:a2eeef:Improvement to an existing feature" \
         "feature:1d76db:New feature" "bug:d73a4a:Something is not working" "quality:c5def5:Code quality, tests, tooling"; do
  IFS=: read -r name color desc <<<"$l"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null 2>&1 && ok "label $name"
done

echo "Ruleset: protect main"
CHECKS='{"context":"API tests"},{"context":"Console tests and build"},{"context":"End-to-end tests"},
{"context":"Rust dependency audit (cargo-audit)"},{"context":"Console dependency audit (npm audit)"},
{"context":"Secret scan (gitleaks)"},{"context":"Malware & binary check (ClamAV)"}'
if [ "$PRIVATE" = "false" ]; then  # these jobs only run on public repos
  CHECKS="$CHECKS"',{"context":"CodeQL (javascript-typescript)"},{"context":"CodeQL (rust)"},{"context":"CodeQL (actions)"}'
fi
RULESET=$(cat <<JSON
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request"}],
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": $APPROVALS,
      "require_code_owner_review": $CODEOWNER,
      "dismiss_stale_reviews_on_push": true,
      "require_last_push_approval": $CODEOWNER,
      "required_review_thread_resolution": true,
      "allowed_merge_methods": ["squash"]}},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [$CHECKS]}}
  ]
}
JSON
)
ID=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="Protect main") | .id' 2>/dev/null)
if [ -n "$ID" ]; then
  try "update ruleset 'Protect main'" gh api -X PUT "repos/$REPO/rulesets/$ID" --input - <<<"$RULESET"
else
  try "create ruleset 'Protect main'" gh api -X POST "repos/$REPO/rulesets" --input - <<<"$RULESET"
fi
echo "Done. Admins may bypass review only through a pull request (never by pushing to main)."
