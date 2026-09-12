#!/usr/bin/env bash
# test-floor.sh — suite-shrink tripwire for moltarc CI.
#
# CI runs the stable suite + ext suite with no count assertion, so deleting
# tests still greens. This floor fails loud when totals drop below last green.
#
# Floor: STABLE_FLOOR pins the last green total (173 pass, 0 fail,
# `bun run test:stable` on main 2026-09-13); EXT_FLOOR pins the ext total
# (7 pass, 0 fail, `bun test ext/` on main 2026-09-13).
# Update only on intentional add/remove: re-run that suite, read the
# "N pass" line, set the constant below to N.
set -u
set -o pipefail

STABLE_FLOOR="${GATE_STABLE_FLOOR:-173}"
EXT_FLOOR="${GATE_EXT_FLOOR:-7}"
FAILURES=0

check() { # $1 = name, $2 = suite output, $3 = floor
  PASS_N="$(printf '%s' "$2" | grep -oE '[0-9]+ pass' | grep -oE '[0-9]+' | tail -1)"
  FAIL_N="$(printf '%s' "$2" | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+' | tail -1)"
  PASS_N="${PASS_N:-?}"
  FAIL_N="${FAIL_N:-?}"
  if [ "$FAIL_N" = "0" ] && [ "$PASS_N" != "?" ] && [ "$PASS_N" -ge "$3" ]; then
    echo "PASS: $1 (${PASS_N}/${FAIL_N}, floor $3)"
  else
    echo "FAIL: $1 (${PASS_N}/${FAIL_N}, floor $3)"
    FAILURES=$((FAILURES + 1))
  fi
}

STABLE_OUT="$(bun run test:stable 2>&1)"
printf '%s\n' "$STABLE_OUT" | tail -4
check stable "$STABLE_OUT" "$STABLE_FLOOR"

EXT_OUT="$(bun test ext/ 2>&1)"
printf '%s\n' "$EXT_OUT" | tail -4
check ext "$EXT_OUT" "$EXT_FLOOR"

if [ "$FAILURES" = "0" ]; then
  echo "FLOOR: PASS"
  exit 0
else
  echo "FLOOR: FAIL ($FAILURES suite(s) below floor)"
  exit 1
fi
