#!/usr/bin/env bash
set -euo pipefail

# Scan the future clean clone's tracked files plus current nonignored worktree files.
# Arguments allow a controlled file to exercise the scanner in tests.
if (( $# > 0 )); then
  files=("$@")
else
  mapfile -d '' files < <(git ls-files -z --cached --others --exclude-standard)
fi
if (( ${#files[@]} == 0 )); then
  echo 'Secret scan: no files to scan' >&2
  exit 1
fi
for file in "${files[@]}"; do
  if [[ "$file" == .env || "$file" == .env.* && "$file" != .env.example ]]; then
    echo 'Secret scan failed: environment file is included' >&2
    exit 1
  fi
done
pattern='AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{40,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
# A missing tool must fail the scan, never pass it: exit 1 means clean, anything above is an error.
if command -v rg >/dev/null; then
  scan=(rg -q --pcre2 -e "$pattern" --)
else
  scan=(grep -qsP -e "$pattern" --)
fi
status=0
"${scan[@]}" "${files[@]}" || status=$?
if (( status == 0 )); then
  echo 'Secret scan failed: possible credential pattern found' >&2
  exit 1
elif (( status > 1 )); then
  echo 'Secret scan failed: scanner could not run' >&2
  exit 2
fi
echo "Secret scan passed: ${#files[@]} files checked"
