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
if rg -q --pcre2 \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'sk-[A-Za-z0-9_-]{40,}' \
  -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{20,}' \
  -e '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' \
  -- "${files[@]}"; then
  echo 'Secret scan failed: possible credential pattern found' >&2
  exit 1
fi
echo "Secret scan passed: ${#files[@]} files checked"
