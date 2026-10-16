#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "${1:-feasibility}" = release ]; then
  shift
  test "$#" = 3
  ARCHIVE=$(realpath "$1")
  CHECKSUM=$(realpath "$2")
  INSTALLER=$(realpath "$3")
  (cd "$(dirname "$CHECKSUM")" && sha256sum -c "$(basename "$CHECKSUM")")
  cd "$ROOT"
  mkdir -p dist
  tar -xzf "$ARCHIVE" -O vlint >dist/vlint-linux-x64
  chmod 0755 dist/vlint-linux-x64
  export VLINT_RELEASE_ARCHIVE="$ARCHIVE" VLINT_RELEASE_INSTALLER="$INSTALLER" VLINT_INSTALLER_CONTAINER_ACCEPTANCE=1
  exec bun test tests/acceptance/installer-container-59.test.ts
fi
IMAGE="vlint-u1-feasibility:local"
BASE_IMAGE="ubuntu@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf"
TMP=$(mktemp -d)
HOME_OK="$TMP/home-ok"
HOME_EMPTY="$TMP/home-empty"
HOME_HELP="$TMP/home-help"
HOME_INTERRUPTED="$TMP/home-interrupted"
WORK="$TMP/work"
mkdir -p "$HOME_OK" "$HOME_EMPTY" "$HOME_HELP" "$HOME_INTERRUPTED" "$WORK"
chmod 0777 "$HOME_OK" "$HOME_EMPTY" "$HOME_HELP" "$HOME_INTERRUPTED" "$WORK"
cleanup() {
  docker run --rm --user 0 -v "$TMP:/cleanup" "$IMAGE" sh -c \
    'rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*' >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

assert_contains() {
  value=$1
  expected=$2
  case "$value" in
    *"$expected"*) ;;
    *) printf 'expected %s in output: %s\n' "$expected" "$value" >&2; exit 1 ;;
  esac
}

assert_status() {
  actual=$1
  expected=$2
  if [ "$actual" != "$expected" ]; then
    printf 'expected exit status %s got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

build_guest_image() {
  docker build --platform linux/amd64 -f "$ROOT/tests/release/Containerfile" -t "$IMAGE" "$ROOT"
}

# ---------------------------------------------------------------------------
# U1 feasibility gate (unchanged behavior).
# ---------------------------------------------------------------------------
run_feasibility() {
run_probe() {
  home=$1
  shift
  docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$home:/home/vlint" \
    -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
    "$IMAGE" /opt/probe "$@"
}

install_output=$(run_probe "$HOME_OK" install)
assert_contains "$install_output" '"ok":true'
assert_contains "$install_output" '"revision":"1228"'

idempotent_output=$(run_probe "$HOME_OK" install)
assert_contains "$idempotent_output" '"ok":true'

# A damaged executable must not be accepted and --force must restore it.
docker run --rm --user 10001:10001 -e HOME=/home/vlint \
  -v "$HOME_OK:/home/vlint" "$IMAGE" sh -c \
  'rm -f "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/headless_shell "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell'
force_output=$(run_probe "$HOME_OK" install --force)
assert_contains "$force_output" '"ok":true'

# Compile flags must prevent project-local Bun configuration from changing behavior.
printf 'PLAYWRIGHT_BROWSERS_PATH=/poison\n' >"$WORK/.env"
printf 'preload = ["/does/not/exist.ts"]\n' >"$WORK/bunfig.toml"
autoload_output=$(docker run --rm --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_OK:/home/vlint" \
  -v "$WORK:/work" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  "$IMAGE" /opt/probe install)
assert_contains "$autoload_output" '"ok":true'

for variable in PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_DOWNLOAD_HOST PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST; do
  set +e
  override_output=$(docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint -e "$variable=https://invalid.example" \
    -v "$HOME_OK:/home/vlint" \
    -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
    "$IMAGE" /opt/probe install 2>&1)
  override_status=$?
  set -e
  test "$override_status" -ne 0
  if test "$variable" = PLAYWRIGHT_BROWSERS_PATH; then
    assert_contains "$override_output" 'browser-cache-override-unsupported'
  else
    assert_contains "$override_output" 'browser-download-host-override-unsupported'
  fi
done

# A separate, network-disabled process must launch from only the persisted cache.
check_output=$(docker run --rm --network none --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_OK:/home/vlint" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  -v "$ROOT/dist/vlint-fixture-server:/opt/server:ro" \
  "$IMAGE" sh -c '
    /opt/server 4173 >/tmp/server.out & server=$!
    sleep 1
    /opt/probe check http://127.0.0.1:4173/
    status=$?
    kill -TERM "$server"
    wait "$server"
    for file in /proc/[0-9]*/comm; do
      name=$(cat "$file" 2>/dev/null || true)
      case "$name" in chrome|chromium|headless_shell) echo "orphan browser: $name" >&2; exit 1;; esac
    done
    exit "$status"
  ')
assert_contains "$check_output" '"value":"compiled-playwright-ok"'

# Empty cache plus no network is a bounded failure and cannot become a valid cache.
set +e
empty_output=$(timeout 120 docker run --rm --network none --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_EMPTY:/home/vlint" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  "$IMAGE" /opt/probe install 2>&1)
empty_status=$?
set -e
test "$empty_status" -ne 0
assert_contains "$empty_output" 'browser-install-failed'

set +e
missing_output=$(docker run --rm --network none --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_EMPTY:/home/vlint" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  "$IMAGE" /opt/probe check http://127.0.0.1:4173/ 2>&1)
missing_status=$?
set -e
test "$missing_status" -ne 0
assert_contains "$missing_output" 'browser-launch-failed'

# Interrupting a fresh install must leave no cache accepted by a later offline check.
set +e
timeout 30 docker run --rm --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_INTERRUPTED:/home/vlint" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  "$IMAGE" sh -c '/opt/probe install & probe=$!; sleep 1; kill -TERM "$probe"; wait "$probe"' >/dev/null 2>&1
set -e
set +e
interrupted_output=$(docker run --rm --network none --user 10001:10001 \
  -e HOME=/home/vlint \
  -v "$HOME_INTERRUPTED:/home/vlint" \
  -v "$ROOT/dist/vlint-playwright-feasibility:/opt/probe:ro" \
  "$IMAGE" /opt/probe check http://127.0.0.1:4173/ 2>&1)
interrupted_status=$?
set -e
test "$interrupted_status" -ne 0
assert_contains "$interrupted_output" 'browser-launch-failed'

printf 'U1 compiled Playwright feasibility gate passed\n'
}

build_guest_image
run_feasibility
