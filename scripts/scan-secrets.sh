#!/usr/bin/env bash
# scans the repository for content that must never be published.
#
# Usage:
#   bash scripts/scan-secrets.sh              # scan working tree (tracked + untracked, ignoring .gitignore)
#   bash scripts/scan-secrets.sh --staged     # scan staged files only (use in pre-commit)
#   bash scripts/scan-secrets.sh --history    # additionally scan every commit in history
#   bash scripts/scan-secrets.sh --all        # --staged is skipped; working tree + history
#
# Exit codes:
#   0  no findings
#   1  findings present
#   2  usage / environment error
#
# Adding a legitimate exception: extend ALLOW_PATTERNS below with a narrow regex.
# Never widen a pattern just to silence a real value -- replace the value with a placeholder.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

MODE_WORKTREE=1
MODE_STAGED=0
MODE_HISTORY=0

for arg in "$@"; do
  case "$arg" in
    --staged)  MODE_WORKTREE=0; MODE_STAGED=1 ;;
    --history) MODE_HISTORY=1 ;;
    --all)     MODE_HISTORY=1 ;;
    --worktree) MODE_WORKTREE=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# What counts as sensitive
# ---------------------------------------------------------------------------

# Each entry: "label|regex"
PATTERNS=(
  # IPv4 address (any). Public and private alike: the repo must not carry either.
  'ipv4|([0-9]{1,3}\.){3}[0-9]{1,3}'
  # Absolute user home paths from any of the three big platforms.
  'homepath|/home/[a-z_][a-z0-9_.-]*|/Users/[A-Za-z][A-Za-z0-9_.-]*|[A-Za-z]:\\\\Users\\\\'
  # Email address.
  'email|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  # Credential assignment (JSON / TOML / shell / dotenv shapes).
  'credassign|(api[_-]?key|apikey|token|secret|password|passwd)[\"'"'"']?[[:space:]]*[:=][[:space:]]*[^ $<{\"'"'"'`]'
  # Long opaque token: API keys, hashes, base64 blobs.
  # Deliberately excludes '/' and '-' so that file paths, slugs and comment
  # rules do not match; a token must be one unbroken run of token characters
  # bounded by non-token characters on both sides.
  'longtoken|(^|[^A-Za-z0-9_+=])[A-Za-z0-9_+=]{32,}([^A-Za-z0-9_+=]|$)'
  # Private key blocks.
  'privkey|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  # Domain-like string (hostnames, public URLs, tunnels).
  'domain|[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(com|cn|net|org|io|dev|xyz|top|vip|cc|me|app|cloud)\b'
)

# Narrow, explicitly-public exceptions. Each entry: "label|regex"
ALLOW_PATTERNS=(
  'loopback|(^|[^0-9])127\.0\.0\.1([^0-9]|$)|(^|[^0-9])0\.0\.0\.0([^0-9]|$)'
  'public-hosts|(^|[^a-z0-9.-])(github\.com|gitlab\.com|npmjs\.com|nodejs\.org|example\.com|agentskills\.io|opensource\.org|mit\.edu)([^a-z0-9.-]|$)'
  'placeholders|<[^<>[:space:]]+>|\$\{[A-Za-z_][A-Za-z0-9_]*\}|xxxx+|your-|your_'
)

ALLOW_RE="$(printf '%s\n' "${ALLOW_PATTERNS[@]}" | cut -d'|' -f2- | paste -sd'|' -)"

# Path-scoped exemptions. Some files exist precisely to spell out the shapes we
# forbid (this scanner, the contribution rules, the engineering contract), so a
# hit inside them is expected. Keep this list short and path-anchored.
ALLOW_PATH_RE='CONTRIBUTING\.md$|scan-secrets\.sh$|SPEC\.md$'

BINARY_EXT_RE='\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|zst|xz|so|dylib|dll|exe|woff2?|ttf|otf|mp[34]|mov)$'

tmp_hits="$(mktemp)"
tmp_files="$(mktemp)"
trap 'rm -f "$tmp_hits" "$tmp_files"' EXIT

# ---------------------------------------------------------------------------
# Collect target files
# ---------------------------------------------------------------------------

collect_worktree() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files -z --cached --others --exclude-standard
  else
    find . -type f -not -path './.git/*' -print0
  fi
}

collect_staged() {
  git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 2; }
  git diff --cached --name-only --diff-filter=ACMR -z
}

echo "== agent-config-bridge :: sensitive content scan =="
echo "repo: $REPO_ROOT"

TOTAL_FILES=0

scan_stream() {
  # stdin: NUL separated file list
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    case "$f" in
      *.png|*.jpg|*.jpeg|*.gif|*.webp|*.bmp|*.ico|*.pdf|*.zip|*.gz|*.tgz|*.zst|*.xz|*.so|*.dylib|*.dll|*.exe) continue ;;
    esac
    TOTAL_FILES=$((TOTAL_FILES + 1))
    printf '%s\n' "$f" >> "$tmp_files"
    for entry in "${PATTERNS[@]}"; do
      label="${entry%%|*}"
      re="${entry#*|}"
      # -a: treat as text (some config files have odd bytes); -n: line numbers
      grep -aInE -e "$re" -- "$f" 2>/dev/null | while IFS= read -r line; do
        content="${line#*:}"
        if [ -n "$ALLOW_RE" ] && printf '%s' "$content" | grep -qE -e "$ALLOW_RE"; then
          continue
        fi
        if printf '%s' "$f" | grep -qE -e "$ALLOW_PATH_RE"; then
          continue
        fi
        printf '%s|%s|%s\n' "$label" "$f" "$line" >> "$tmp_hits"
      done
    done
  done
}

if [ "$MODE_STAGED" = 1 ]; then
  echo "mode: staged files only"
  collect_staged | scan_stream
elif [ "$MODE_WORKTREE" = 1 ]; then
  echo "mode: working tree (respecting .gitignore)"
  collect_worktree | scan_stream
fi

if [ "$MODE_HISTORY" = 1 ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "mode: git history (all blobs, all refs)"
    # Every blob reachable from any ref. Deduplicated by content hash.
    git rev-list --objects --all 2>/dev/null \
      | awk '{print $1}' \
      | git cat-file --batch-check='%(objecttype) %(objectname) %(rest)' 2>/dev/null \
      | awk '$1=="blob"{print $2}' \
      | sort -u \
      | while read -r sha; do
          [ -n "$sha" ] || continue
          for entry in "${PATTERNS[@]}"; do
            label="${entry%%|*}"
            re="${entry#*|}"
            git cat-file -p "$sha" 2>/dev/null | grep -aInE -e "$re" 2>/dev/null | while IFS= read -r line; do
              content="${line#*:}"
              if [ -n "$ALLOW_RE" ] && printf '%s' "$content" | grep -qE -e "$ALLOW_RE"; then
                continue
              fi
              printf '%s|git-blob:%s|%s\n' "$label" "$sha" "$line" >> "$tmp_hits"
            done
          done
        done
  else
    echo "note: --history requested but this is not a git repository; skipped" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

echo "scanned files: $(wc -l < "$tmp_files" | tr -d ' ')"
echo

if [ -s "$tmp_hits" ]; then
  count="$(wc -l < "$tmp_hits" | tr -d ' ')"
  echo "FINDINGS: $count"
  echo
  echo "label | file | match"
  echo "-------------------"
  # Cap the display, keep full list in the artifact
  head -n 200 "$tmp_hits" | cut -c1-240
  if [ "$count" -gt 200 ]; then
    echo "... $((count - 200)) more (truncated)"
  fi
  echo
  echo "Remediation:"
  echo "  1. Replace the real value with a placeholder (<like-this> or \${VAR_NAME})."
  echo "  2. Real values belong in ~/.config/agent-config-bridge/secrets.env (outside the repo)."
  echo "  3. If the value appears in HISTORY, an amended HEAD commit is not enough --"
  echo "     rewrite history and force-push, otherwise cloners still receive it."
  echo "  4. Only broaden ALLOW_PATTERNS in scripts/scan-secrets.sh for provably public values."
  exit 1
fi

echo "OK: no sensitive content found."
exit 0
