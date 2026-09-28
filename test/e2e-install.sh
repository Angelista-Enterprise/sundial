#!/bin/zsh
# End-to-end install test: install → first run (boot smoke, auth fence, record) → uninstall.
#
# Runs against a test folder, a test LaunchAgent label and test ports, so it can
# never touch a real install:
#   SUNDIAL_HOME=$HOME/.sundial-test  SUNDIAL_LABEL=dev.sundial.test  ports 3180 / 8867 / 9323
# No native helpers are started (no macOS permission prompts appear).
#
#   zsh test/e2e-install.sh            # runs Sundial.app, like a real install
#   E2E_NO_LAUNCHD=1 zsh test/e2e-install.sh   # CI: runs start.sh directly
set -u
REPO=${0:A:h:h}
export SUNDIAL_HOME=${SUNDIAL_HOME:-$HOME/.sundial-test} SUNDIAL_LABEL=dev.sundial.test
export SUNDIAL_WEB_PORT=3180 SUNDIAL_PHONE_PORT=8867 SUNDIAL_CHROME_PORT=9323
B=http://127.0.0.1:$SUNDIAL_WEB_PORT
t0=$(date +%s); ts(){ echo "[+$(( $(date +%s) - t0 ))s] $*"; }
fail=0
check(){ local want=$1; shift; local got=$(curl -s -o /dev/null -w '%{http_code}' "$@"); if [ "$got" = "$want" ]; then echo "  ok   $got  ${@: -1}"; else echo "  FAIL got $got want $want  ${@: -1}"; fail=1; fi; }
cd $REPO

ts "install"
if [ "${E2E_NO_LAUNCHD:-0}" = 1 ]; then
  node bin/sundial install --no-open --no-sidecars --no-launchagent || exit 1
  zsh $SUNDIAL_HOME/start.sh > $SUNDIAL_HOME/logs/sundial.log 2>&1 &
  SERVER=$!
  for i in {1..120}; do curl -s -o /dev/null $B/ && break; sleep 1; done
else
  node bin/sundial install --no-open --no-sidecars || exit 1
fi

ts "first run"
C=$(mktemp)
check 401 $B/
check 401 $B/gnomon/today
check 403 -H 'Host: evil.example' $B/gnomon/today
TOK=$(grep -o "$B/?token=[A-Za-z0-9_-]*" $SUNDIAL_HOME/logs/sundial.log | tail -1)
check 303 -c $C "$TOK"
check 200 -b $C $B/
check 200 -b $C $B/setup
check 200 -b $C $B/gnomon/setup
check 200 -b $C $B/gnomon/today
check 403 -b $C -X POST -H 'Origin: https://evil.example' -d '{}' $B/gnomon/api/settings
sleep 15
N=$(sqlite3 -readonly $SUNDIAL_HOME/sundial.db 'select count(*) from signals')
if [ "$N" -gt 0 ]; then echo "  ok   the record holds $N signals"; else echo "  FAIL nothing recorded"; fail=1; fi
rm -f $C
if codesign --verify --strict $SUNDIAL_HOME/Sundial.app 2>/dev/null; then echo "  ok   Sundial.app signature is valid"; else echo "  FAIL Sundial.app signature"; fail=1; fi
if [ "${E2E_NO_LAUNCHD:-0}" != 1 ]; then
  if kill -0 "$(cat $SUNDIAL_HOME/.daemon/app.pid 2>/dev/null)" 2>/dev/null; then echo "  ok   the app is running"; else echo "  FAIL the app is not running"; fail=1; fi
fi

ts "uninstall"
[ -n "${SERVER:-}" ] && kill $SERVER 2>/dev/null
node bin/sundial uninstall --yes || fail=1
sleep 2
if [ -e $SUNDIAL_HOME ]; then echo "  FAIL folder still there"; fail=1; else echo "  ok   folder gone"; fi
if [ -e ~/Library/LaunchAgents/$SUNDIAL_LABEL.plist ]; then echo "  FAIL plist still there"; fail=1; else echo "  ok   no plist"; fi
if pgrep -f "$SUNDIAL_HOME/Sundial.app" >/dev/null; then echo "  FAIL the app still runs"; fail=1; else echo "  ok   nothing left running"; fi
ts "done, fail=$fail"
exit $fail
