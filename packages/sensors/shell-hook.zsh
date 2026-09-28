# Sundial interactive shell hook (zsh and bash).
#
# Source this from ~/.zshrc (or ~/.bashrc):
#
#     [ -f ~/.sundial/shell-hook.zsh ] && source ~/.sundial/shell-hook.zsh
#
# It appends one JSON line per command to ~/.sundial/.daemon/shell-events.jsonl,
# which the shell sensor reads in preference to history-file parsing.
#
# Why this exists at all: a history file records the command text and nothing
# else — no working directory, no exit code, no duration — and only flushes
# when the shell exits. So "what did I run in this project" and "did that
# fail?" were unanswerable from the fallback path. Every field below is one the
# history file cannot give.
#
# The hook is deliberately dumb: it writes a line and returns. It runs before
# and after EVERY command you type, so anything slow or clever here is felt on
# every prompt.

SUNDIAL_HOOK_FILE="${SUNDIAL_HOOK_FILE:-${SUNDIAL_HOME:-$HOME/.sundial}/.daemon/shell-events.jsonl}"

# Escape a value for embedding in a JSON string: backslash first (or it would
# double-escape the quotes it adds), then quotes, then literal newlines.
__sundial_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  printf '%s' "$s"
}

# Epoch milliseconds, or empty when this platform cannot give them cheaply.
# macOS ships BSD date, which has no `%N` — `date +%s%3N` yields a literal
# trailing "3N" there, so it is never used. zsh's EPOCHREALTIME is the portable
# win; bash on macOS simply records no duration rather than a wrong one.
__sundial_now_ms() {
  if [ -n "${ZSH_VERSION:-}" ]; then
    zmodload zsh/datetime 2>/dev/null
    [ -n "${EPOCHREALTIME:-}" ] && printf '%.0f' $((EPOCHREALTIME * 1000)) && return
  fi
  local n=$(date +%s%N 2>/dev/null)
  case "$n" in
    *N|'') printf '' ;;
    *) printf '%s' $((n / 1000000)) ;;
  esac
}

__sundial_preexec() {
  __GNOMON_CMD=$1
  __GNOMON_START=$(__sundial_now_ms)
}

__sundial_precmd() {
  local exit_code=$?
  [ -z "${__GNOMON_CMD:-}" ] && return 0

  local dir="${SUNDIAL_HOOK_FILE%/*}"
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || { __GNOMON_CMD=; return 0; }

  local ms=''
  if [ -n "${__GNOMON_START:-}" ]; then
    local now=$(__sundial_now_ms)
    [ -n "$now" ] && ms=$((now - __GNOMON_START))
  fi

  local ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)
  local cmd=$(__sundial_json_escape "$__GNOMON_CMD")
  local cwd=$(__sundial_json_escape "$PWD")

  # umask 077 so the file is 0600 from creation — it holds every command run on
  # this machine, and repairing the mode after the fact leaves a window open.
  local line="{\"c\":\"$cmd\",\"d\":\"$cwd\",\"e\":$exit_code,\"t\":\"$ts\""
  [ -n "$ms" ] && line="$line,\"m\":$ms"
  line="$line}"
  (umask 077; printf '%s\n' "$line" >> "$SUNDIAL_HOOK_FILE") 2>/dev/null

  __GNOMON_CMD=
  __GNOMON_START=
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec __sundial_preexec
  add-zsh-hook precmd __sundial_precmd
elif [ -n "${BASH_VERSION:-}" ]; then
  # bash has no preexec; the DEBUG trap is the conventional stand-in. It fires
  # per simple command, so the guard keeps one record per prompt line.
  __sundial_bash_debug() {
    [ -n "${COMP_LINE:-}" ] && return
    [ -z "${__GNOMON_CMD:-}" ] && __sundial_preexec "$BASH_COMMAND"
  }
  trap '__sundial_bash_debug' DEBUG
  PROMPT_COMMAND="__sundial_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
