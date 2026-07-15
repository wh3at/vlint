#!/bin/sh
# Release validator for vlint.
#
# Two modes share one pinned Ubuntu 24.04 x64 guest image and one cleanup trap:
#
#   validate.sh                       U1 feasibility gate (default).
#                                     Exercises the compiled Playwright install/
#                                     cache/launch seam with a test-only probe.
#
#   validate.sh release <archive> \   U6 release gate. Validates the production
#       <checksum> <fixture> <deb> \   tarball, Ubuntu package, tag-fixed installer,
#       <installer>                  and SHA256SUMS against the compiled CLI.
#
# Both modes build the same image, run everything inside disposable guests as a
# non-root user, and tear down all host state (image + temp dirs) on exit.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IMAGE="vlint-u1-feasibility:local"
BASE_IMAGE="ubuntu@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf"
TMP=$(mktemp -d)
HOME_OK="$TMP/home-ok"
HOME_EMPTY="$TMP/home-empty"
HOME_INTERRUPTED="$TMP/home-interrupted"
WORK="$TMP/work"
mkdir -p "$HOME_OK" "$HOME_EMPTY" "$HOME_INTERRUPTED" "$WORK"
chmod 0777 "$HOME_OK" "$HOME_EMPTY" "$HOME_INTERRUPTED" "$WORK"
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

# ---------------------------------------------------------------------------
# U6 release gate: validate every shipped asset against the real compiled CLI.
#   $1 archive     - vlint-v<semver>-linux-x64.tar.gz
#   $2 checksum    - SHA256SUMS for archive, .deb, and installer
#   $3 fixture     - compiled single-line-tab fixture server
#   $4 deb         - vlint_<semver>_amd64.deb
#   $5 installer   - install-v<semver>.sh
# ---------------------------------------------------------------------------
run_release() {
  archive=$1
  checksum=$2
  fixture=$3
  deb=$4
  installer=$5

  if [ -z "$archive" ] || [ -z "$checksum" ] || [ -z "$fixture" ] \
    || [ -z "$deb" ] || [ -z "$installer" ]; then
    printf 'release mode requires <archive> <checksum> <fixture> <deb> <installer>\n' >&2
    exit 2
  fi

  # Resolve absolute mount sources.
  abs_archive=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")
  abs_checksum=$(CDPATH= cd -- "$(dirname -- "$checksum")" && pwd)/$(basename -- "$checksum")
  abs_fixture=$(CDPATH= cd -- "$(dirname -- "$fixture")" && pwd)/$(basename -- "$fixture")
  abs_deb=$(CDPATH= cd -- "$(dirname -- "$deb")" && pwd)/$(basename -- "$deb")
  abs_installer=$(CDPATH= cd -- "$(dirname -- "$installer")" && pwd)/$(basename -- "$installer")

  base=$(basename -- "$abs_archive")
  deb_base=$(basename -- "$abs_deb")
  installer_base=$(basename -- "$abs_installer")
  semver=${base#vlint-v}
  semver=${semver%-linux-x64.tar.gz}

  # Writable, guest-owned extraction area reused as the validated binary source.
  EXTRACT="$TMP/extract"
  mkdir -p "$EXTRACT"
  chmod 0777 "$EXTRACT"

  # Integrity + staging. Real published names preserve manifest filename binding.
  docker run --rm --user 10001:10001 \
    -e ARCHIVE_NAME="$base" \
    -e DEB_NAME="$deb_base" \
    -e INSTALLER_NAME="$installer_base" \
    -v "$abs_archive:/in/archive:ro" \
    -v "$abs_deb:/in/deb:ro" \
    -v "$abs_installer:/in/installer:ro" \
    -v "$abs_checksum:/in/SHA256SUMS:ro" \
    -v "$EXTRACT:/work" \
    "$IMAGE" sh -c '
      set -eu
      cp /in/archive "/work/$ARCHIVE_NAME"
      cp /in/deb "/work/$DEB_NAME"
      cp /in/installer "/work/$INSTALLER_NAME"
      cp /in/SHA256SUMS /work/SHA256SUMS
      cd /work
      sha256sum -c SHA256SUMS
      tar -xzf "$ARCHIVE_NAME"
      test -f vlint
      test -x vlint
      mode=$(stat -c "%a" vlint)
      test "$mode" = "755" || { echo "expected mode 0755, got $mode" >&2; exit 1; }
    '


  # Exercise the installer without network by substituting only curl transport.
  INSTALL_HOME="$TMP/installer-home"
  mkdir -p "$INSTALL_HOME"
  chmod 0777 "$INSTALL_HOME"
  installer_output=$(docker run --rm --network none --user 10001:10001 \
    -e HOME=/home/vlint \
    -e VLINT_INSTALL_DIR=bin \
    -e ARCHIVE_NAME="$base" \
    -v "$abs_archive:/in/archive:ro" \
    -v "$abs_checksum:/in/SHA256SUMS:ro" \
    -v "$abs_installer:/in/installer:ro" \
    -v "$INSTALL_HOME:/work" \
    -w /work \
    "$IMAGE" sh -c '
      set -eu
      mkdir -p /work/fake-bin
      cat > /work/fake-bin/curl <<'"'"'EOF'"'"'
#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */SHA256SUMS) cp /in/SHA256SUMS "$output" ;;
  */"$ARCHIVE_NAME") cp /in/archive "$output" ;;
  *) exit 22 ;;
esac
EOF
      chmod 0755 /work/fake-bin/curl
      PATH="/work/fake-bin:$PATH" sh /in/installer
      /work/bin/vlint --version
    ')
  assert_contains "$installer_output" "vlint v$semver installed"
  assert_contains "$installer_output" "vlint $semver"

  # --- Network-enabled guest: version + idempotent browser install + force. ---
  version_output=$(docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_OK:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" /opt/release/vlint --version)
  assert_contains "$version_output" "vlint $semver"

  install_output=$(docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_OK:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" /opt/release/vlint browser install --with-deps)
  assert_contains "$install_output" 'chromium'
  assert_contains "$install_output" 'ready'

  idempotent_output=$(docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_OK:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" /opt/release/vlint browser install)
  assert_contains "$idempotent_output" 'already-present'

  force_output=$(docker run --rm --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_OK:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" /opt/release/vlint browser install --force)
  assert_contains "$force_output" 'reinstalled'

  # Exercise --with-deps where the browser libraries are demonstrably absent.
  DEPS_HOME="$TMP/deps-home"
  DEPS_PROJECT="$TMP/deps-project"
  mkdir -p "$DEPS_HOME" "$DEPS_PROJECT"
  chmod 0777 "$DEPS_HOME" "$DEPS_PROJECT"
  deps_output=$(docker run --rm --user 0 \
    -e DEBIAN_FRONTEND=noninteractive \
    -e HOME=/cache \
    -v "$DEPS_HOME:/cache" \
    -v "$DEPS_PROJECT:/project" \
    -v "$EXTRACT:/opt/release:ro" \
    -v "$abs_fixture:/opt/server:ro" \
    "$BASE_IMAGE" sh -c '
      set -eu
      if dpkg-query -W libnss3 >/dev/null 2>&1; then
        echo "expected base guest without libnss3" >&2
        exit 1
      fi
      /opt/release/vlint browser install --with-deps
      dpkg-query -W libnss3 >/dev/null
      cd /project
      /opt/release/vlint init >/dev/null
      /opt/server 4175 >/tmp/server.out & server=$!
      sleep 1
      set +e
      /opt/release/vlint check --url http://127.0.0.1:4175/ --format json
      status=$?
      set -e
      kill -TERM "$server"
      wait "$server" 2>/dev/null || true
      exit "$status"
    ')
  assert_contains "$deps_output" 'chromium'
  assert_contains "$deps_output" 'ready'
  assert_contains "$deps_output" '"schemaVersion":3'
  assert_contains "$deps_output" '"status":"clean"'
  assert_contains "$deps_output" 'macbook-air-13-m5'
  assert_contains "$deps_output" 'iphone-17'

  # Validate the documented .deb quick start in an otherwise vanilla Ubuntu
  # guest. A missing Depends entry must fail apt install, setup, or browser launch.
  DEB_HOME="$TMP/deb-home"
  SETUP_PROJECT="$TMP/setup-project"
  mkdir -p "$DEB_HOME" "$SETUP_PROJECT"
  chmod 0777 "$DEB_HOME" "$SETUP_PROJECT"
  deb_setup_output=$(docker run --rm --user 0 \
    -e DEBIAN_FRONTEND=noninteractive \
    -e HOME=/cache \
    -v "$DEB_HOME:/cache" \
    -v "$SETUP_PROJECT:/project" \
    -v "$abs_deb:/tmp/vlint.deb:ro" \
    -v "$abs_fixture:/opt/server:ro" \
    "$BASE_IMAGE" sh -c '
      set -eu
      apt-get update >/dev/null
      apt-get install -y /tmp/vlint.deb >/dev/null
      test "$(dpkg-deb -f /tmp/vlint.deb Package)" = "vlint"
      test "$(dpkg-deb -f /tmp/vlint.deb Architecture)" = "amd64"
      cd /project
      vlint setup
      vlint setup
      /opt/server 4174 >/tmp/server.out & server=$!
      sleep 1
      set +e
      vlint check --url http://127.0.0.1:4174/ --format json
      status=$?
      set -e
      kill -TERM "$server"
      wait "$server" 2>/dev/null || true
      exit "$status"
    ')
  assert_contains "$deb_setup_output" 'config created'
  assert_contains "$deb_setup_output" 'config already-present'
  assert_contains "$deb_setup_output" '"schemaVersion":3'
  assert_contains "$deb_setup_output" '"status":"clean"'
  assert_contains "$deb_setup_output" 'macbook-air-13-m5'
  assert_contains "$deb_setup_output" 'iphone-17'

  # Network-disabled guest: the cache created solely by setup drives a clean check.
  check_output=$(docker run --rm --network none --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$DEB_HOME:/home/vlint" \
    -v "$SETUP_PROJECT:/project:ro" \
    -v "$EXTRACT:/opt/release:ro" \
    -v "$abs_fixture:/opt/server:ro" \
    -w /project \
    "$IMAGE" sh -c '
      set +e
      /opt/server 4173 >/tmp/server.out & server=$!
      sleep 1
      /opt/release/vlint check --url http://127.0.0.1:4173/ --format json
      json_status=$?
      /opt/release/vlint check --url http://127.0.0.1:4173/ --format terminal
      term_status=$?
      kill -TERM "$server"
      wait "$server" 2>/dev/null || true
      for file in /proc/[0-9]*/comm; do
        name=$(cat "$file" 2>/dev/null || true)
        case "$name" in chrome|chromium|headless_shell) echo "orphan browser: $name" >&2; exit 1;; esac
      done
      test "$json_status" -eq 0
      test "$term_status" -eq 0
      exit 0
    ')
  assert_contains "$check_output" '"schemaVersion":3'
  assert_contains "$check_output" '"status":"clean"'
  assert_contains "$check_output" 'macbook-air-13-m5'
  assert_contains "$check_output" 'iphone-17'

  # --- No browser + no network: check must NOT auto-install; typed failure. ---
  set +e
  missing_check_output=$(docker run --rm --network none --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_EMPTY:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" sh -c '
      set -eu
      mkdir /tmp/project
      cd /tmp/project
      /opt/release/vlint init >/dev/null
      /opt/release/vlint check --url http://127.0.0.1:4173/ --format json
    ' 2>&1)
  missing_check_status=$?
  set -e
  assert_status "$missing_check_status" 2
  assert_contains "$missing_check_output" 'browser-missing'

  set +e
  offline_install_output=$(timeout 60 docker run --rm --network none --user 10001:10001 \
    -e HOME=/home/vlint \
    -v "$HOME_EMPTY:/home/vlint" \
    -v "$EXTRACT:/opt/release:ro" \
    "$IMAGE" /opt/release/vlint browser install 2>&1)
  offline_install_status=$?
  set -e
  assert_status "$offline_install_status" 2
  assert_contains "$offline_install_output" 'browser-install-failed'

  printf 'U6 release validation gate passed (%s)\n' "$semver"
}

build_guest_image

case "${1:-feasibility}" in
  feasibility)
    run_feasibility
    ;;
  release)
    shift
    run_release "$@"
    ;;
  *)
    printf 'usage: %s [feasibility | release <archive> <checksum> <fixture> <deb> <installer>]\n' "$0" >&2
    exit 2
    ;;
esac
