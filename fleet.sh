#!/usr/bin/env bash
# All of agent-fleet-coordinator: read it before you run it. Everything it keeps is in .fleet/ next to this file.
#
# A team lead runs a small chat server on their machine and creates one account per colleague.
# A colleague's AI agent waits for the lead's orders, and only acts on what the server says the lead wrote.
#
# It talks to the server with curl and jq. Free text only ever comes in on stdin,
# and access tokens never go on a command line, where other programs on the machine could read them.
set -u
umask 077

ROOT=$(cd "$(dirname "$0")" && pwd)
DIR=$ROOT/.fleet
STATE=$DIR/state.json
IMAGE=ghcr.io/matrix-construct/tuwunel:v1.9.4
CONTAINER=agent-fleet-coordinator
LOCAL=http://127.0.0.1:8008
# Long enough for a 30 s sync, so that a dead connection cannot block for ever.
MAX_SECONDS=40
MAX_ORDER=50000
STATUS=000
BODY=

mkdir -p "$DIR"

die() {
    printf 'fleet: %s\n' "$*" >&2
    exit 1
}

field() { jq -r --arg key "$1" '.[$key] // empty' "$STATE"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
uri() { printf '%s' "$1" | jq -sRr @uri; }
engine() { if command -v docker >/dev/null; then docker "$@"; else podman "$@"; fi; }

valid_name() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]]; }

valid_host() {
    local rest=$1. label last=
    [ "${#1}" -le 253 ] || return 1
    [[ $1 =~ ^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$ ]] || return 1
    while [ -n "$rest" ]; do
        label=${rest%%.*}
        rest=${rest#*.}
        case $label in -* | *-) return 1 ;; esac
        last=$label
    done
    [ "$last" != localhost ] && [[ $last =~ [a-z-] ]]
}

# api METHOD PATH [curl arguments]: sets STATUS and BODY. STATUS is 000 when the server could not be reached.
api() {
    local method=$1 path=$2 out
    shift 2
    if ! out=$(curl -sS -m "$MAX_SECONDS" -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "$(field access_token)") -H 'Content-Type: application/json' -w '\n%{http_code}' "$@" "https://$(field host)$path" 2>/dev/null); then
        STATUS=000
        BODY=
        return 0
    fi
    STATUS=${out##*$'\n'}
    BODY=${out%$'\n'*}
}

remember() { # remember KEY VALUE
    jq --arg key "$1" --arg value "$2" '. + {($key): $value}' "$STATE" >"$STATE.new" && mv "$STATE.new" "$STATE"
}

first_cursor() { # Where to start reading from, so that what came before is skipped.
    api GET "/_matrix/client/v3/sync?timeout=0&filter=$(uri '{"room":{"timeline":{"limit":1}}}')"
    [ "$STATUS" = 200 ] || die "could not read the fleet (HTTP $STATUS)"
    jq -r .next_batch <<<"$BODY" >"$DIR/cursor"
    cp "$DIR/cursor" "$DIR/reports_cursor"
}

# ---- Joining ----

join_room() { # join_room NAME KEY: joins that room, checks who created it, and stores its ID under KEY.
    local room
    api GET "/_matrix/client/v3/directory/room/$(uri "#$1:$(field host)")"
    [ "$STATUS" != 404 ] || die "this fleet is not ready yet: its lead has not created it"
    [ "$STATUS" = 200 ] || die "could not read the fleet (HTTP $STATUS)"
    room=$(jq -r .room_id <<<"$BODY")
    api POST "/_matrix/client/v3/join/$(uri "$room")" -d '{}'
    [ "$STATUS" = 200 ] || die "could not join the fleet (HTTP $STATUS)"
    api GET "/_matrix/client/v3/rooms/$(uri "$room")/state"
    [ "$STATUS" = 200 ] || die "could not read the fleet (HTTP $STATUS)"
    [ "$(jq -r '.[] | select(.type == "m.room.create") | .sender' <<<"$BODY")" = "$(field lead)" ] || die "this fleet's rooms were not created by its lead, so it cannot be trusted"
    remember "$2" "$room"
}

enter_fleet() { # Reads the invitation from stdin, hidden, so that it stays out of the shell's history.
    local code invitation host lead name
    printf 'Paste your invitation and press Enter: ' >&2
    IFS= read -rs code || die "no invitation"
    printf '\n' >&2
    invitation=$(printf '%s' "$code" | base64 -d 2>/dev/null)
    host=$(jq -r '.host // empty' <<<"$invitation" 2>/dev/null)
    lead=$(jq -r '.lead // empty' <<<"$invitation" 2>/dev/null)
    name=${lead#@}
    name=${name%%:*}
    valid_host "$host" && valid_name "$name" && [ "$name" = "$(lower "$name")" ] && [ "$lead" = "@$name:$host" ] &&
        jq -e '.token | type == "string" and test("^[A-Za-z0-9._~+/=-]+$")' <<<"$invitation" >/dev/null 2>&1 || die "this is not a valid invitation"

    jq '{host, lead, access_token: .token}' <<<"$invitation" >"$STATE"
    # An invitation that did not work leaves nothing behind, so that it can be pasted again.
    trap 'rm -f "$STATE"' EXIT
    api GET /_matrix/client/v3/account/whoami
    [ "$STATUS" != 000 ] || die "cannot reach the fleet at $host: it may be off"
    [ "$STATUS" = 200 ] || die "the fleet refused this invitation (HTTP $STATUS)"
    remember user "$(jq -r .user_id <<<"$BODY")"
    join_room fleet-orders orders_room
    join_room fleet-reports reports_room
    trap - EXIT
}

join_fleet() {
    local tool=${1:-} mode=${2:-ask} prompt flags=()
    case $tool:$mode in
        claude:ask) flags=(--permission-mode manual) ;;
        claude:auto) flags=(--permission-mode auto) ;;
        claude:skip) flags=(--dangerously-skip-permissions) ;;
        codex:ask) flags=(-c background_terminal_max_timeout=86400000) ;;
        codex:auto) flags=(--approve-for-me -c background_terminal_max_timeout=86400000) ;;
        codex:skip) flags=(--dangerously-bypass-approvals-and-sandbox -c background_terminal_max_timeout=86400000) ;;
        *) die "usage: fleet.sh join claude|codex [ask|auto|skip]" ;;
    esac
    command -v "$tool" >/dev/null || die "$tool is not installed"
    [ -f "$STATE" ] || enter_fleet
    # Orders given while this session was closed are not carried out.
    first_cursor
    prompt=$(<"$ROOT/AGENT.md")
    prompt=${prompt//\{\{LEAD\}\}/"$(field lead)"}
    prompt=${prompt//\{\{FLEET\}\}/"$ROOT/fleet.sh"}
    printf 'You are %s. Your agent starts here, in %s, and takes orders from %s only. Close it to leave.\n' "$(field user)" "$PWD" "$(field lead)"
    exec "$tool" "${flags[@]}" "$prompt"
}

# ---- Waiting ----

# What makes something an order. The chat server sets the top-level sender, so a message cannot forge it.
ORDER_PROGRAM='[(.rooms.join[$room].timeline.events // [])[]
    | select(.type == "m.room.message" and .sender == $boss and .content.msgtype == "m.text" and (.content.body | type == "string" and length > 0))
    | select(.content["m.relates_to"].rel_type != "m.replace")
    | select(.content["m.mentions"].room == true or any(.content["m.mentions"].user_ids[]?; . == $me))]
    | .[] | "--- order \(.event_id) from \(.sender) ---\n\(.content.body)"'

REPORT_PROGRAM='[(.rooms.join[$room].timeline.events // [])[]
    | select(.type == "m.room.message" and .content.msgtype == "m.text" and (.content.body | type == "string" and length > 0))
    | select(.content["m.relates_to"].rel_type != "m.replace")]
    | .[] | "--- report from \(.sender | ltrimstr("@") | split(":")[0]) ---\n\(.content.body)"'

# listen ROOM CURSOR PROGRAM: blocks until PROGRAM finds something new in ROOM, prints it, and remembers where it stopped.
# ponytail: a sync returns at most 100 events, so whoever is away for more than 100 messages can miss the oldest; follow prev_batch if that happens.
listen() {
    local room=$1 cursor=$2 program=$3 filter found pause=1 parent=$PPID
    filter=$(jq -nc --arg room "$room" '{room: {rooms: [$room], timeline: {limit: 100}}}')
    # Once the session that started this is gone, nothing is left running.
    while kill -0 "$parent" 2>/dev/null; do
        api GET "/_matrix/client/v3/sync?timeout=30000&since=$(uri "$(cat "$cursor")")&filter=$(uri "$filter")"
        case $STATUS in
            200) pause=1 ;;
            000 | 429 | 5*)
                sleep "$pause"
                pause=$((pause < 30 ? pause * 2 : 30))
                continue
                ;;
            *) die "the fleet refused to answer (HTTP $STATUS): ask your lead for a new invitation" ;;
        esac
        found=$(jq -r --arg room "$room" --arg boss "$(field lead)" --arg me "$(field user)" "$program" <<<"$BODY")
        [ -z "$found" ] || printf '%s\n' "$found"
        jq -r .next_batch <<<"$BODY" >"$cursor"
        [ -z "$found" ] || return 0
    done
}

# send ROOM MENTIONS: sends stdin as one message.
send() {
    local out length
    out=$(mktemp "$DIR/outgoing.XXXXXX")
    jq -Rs --argjson mentions "$2" '{msgtype: "m.text", body: ., "m.mentions": $mentions}' >"$out"
    length=$(jq '.body | length' "$out")
    if [ "$length" -eq 0 ] || [ "$length" -gt "$MAX_ORDER" ]; then
        rm -f "$out"
        die "the text is empty or too long ($length characters, at most $MAX_ORDER)"
    fi
    api PUT "/_matrix/client/v3/rooms/$(uri "$1")/send/m.room.message/$(date +%s)-$$-$RANDOM" --data-binary "@$out"
    rm -f "$out"
    [ "$STATUS" = 200 ] || die "the fleet did not accept the message (HTTP $STATUS)"
}

# ---- The lead's commands ----

# Registration stays closed: accounts only exist because the lead made them, so the accounts are the whitelist.
# new_account NAME: sets BODY to the server's answer, which holds the access token. The password is never used again.
# ponytail: openssl takes the server secret on its command line for an instant, on the lead's machine only; at worst a local user creates an account.
new_account() {
    local nonce password mac out
    nonce=$(curl -fsS -m 10 "$LOCAL/_synapse/admin/v1/register" 2>/dev/null | jq -r .nonce)
    [ -n "$nonce" ] || die "the fleet's server is not running on this machine: run fleet.sh start"
    password=$(openssl rand -hex 32)
    mac=$(printf '%s\0%s\0%s\0notadmin' "$nonce" "$1" "$password" | openssl dgst -sha1 -hmac "$(cat "$DIR/server-secret")" -r | cut -d' ' -f1)
    out=$(jq -nc --arg nonce "$nonce" --arg name "$1" --arg password "$password" --arg mac "$mac" '{nonce: $nonce, username: $name, password: $password, admin: false, mac: $mac}' |
        curl -sS -m "$MAX_SECONDS" -X POST -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "$LOCAL/_synapse/admin/v1/register" 2>/dev/null) || die "the fleet's server did not answer"
    STATUS=${out##*$'\n'}
    BODY=${out%$'\n'*}
    [ "$STATUS" = 200 ] || die "could not create the account $1: $(jq -r .error <<<"$BODY")"
}

create_room() { # create_room NAME KEY POWER_LEVELS
    local body
    body=$(jq -nc --arg name "$1" --argjson power "$3" '{room_alias_name: $name, preset: "public_chat", power_level_content_override: $power}')
    api POST /_matrix/client/v3/createRoom --data-binary "$body"
    [ "$STATUS" = 200 ] || die "could not create the fleet (HTTP $STATUS)"
    remember "$2" "$(jq -r .room_id <<<"$BODY")"
}

run_server() { # run_server HOST. No federation, no passwords, no sign-ups: an account made by new_account is the only way in.
    engine start "$CONTAINER" >/dev/null 2>&1 && return 0
    engine run -d --name "$CONTAINER" --restart unless-stopped --stop-timeout 1800 -p 127.0.0.1:8008:8008 \
        -v "$CONTAINER:/var/lib/tuwunel" -v "$DIR/server-secret:/run/server-secret:ro,Z" \
        -e "TUWUNEL_SERVER_NAME=$1" -e TUWUNEL_DATABASE_PATH=/var/lib/tuwunel -e TUWUNEL_ADDRESS=0.0.0.0 -e TUWUNEL_PORT=8008 \
        -e TUWUNEL_ALLOW_FEDERATION=false -e TUWUNEL_ALLOW_REGISTRATION=false -e TUWUNEL_LOGIN_WITH_PASSWORD=false -e TUWUNEL_GRANT_ADMIN_TO_FIRST_USER=false \
        -e TUWUNEL_REGISTRATION_SHARED_SECRET_FILE=/run/server-secret "$IMAGE" >/dev/null || die "could not start the server"
}

start() {
    local host tries=0
    command -v tailscale >/dev/null || die "tailscale is needed, so that your colleagues can reach this machine"
    command -v openssl >/dev/null || die "openssl is needed"
    command -v docker >/dev/null || command -v podman >/dev/null || die "docker or podman is needed"
    [ -f "$STATE" ] || { [ $# -eq 1 ] && valid_name "$1"; } || die "usage: fleet.sh start YOUR_NAME"
    host=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
    valid_host "$host" || die "tailscale is not connected"

    [ -f "$DIR/server-secret" ] || openssl rand -hex 32 >"$DIR/server-secret"
    run_server "$host"
    tailscale funnel --bg 8008 || die "tailscale could not open the tunnel"
    until curl -fsS -m 5 "https://$host/_matrix/client/versions" >/dev/null 2>&1; do
        tries=$((tries + 1))
        [ "$tries" -lt 60 ] || die "the server did not come up: see the logs of the $CONTAINER container"
        sleep 2
    done

    if [ ! -f "$STATE" ]; then
        new_account "$(lower "$1")"
        jq --arg host "$host" --arg lead "@$(lower "$1"):$host" '{host: $host, lead: $lead, user: $lead, access_token}' <<<"$BODY" >"$STATE"
    fi
    [ -n "$(field orders_room)" ] || create_room fleet-orders orders_room '{"events_default":100,"state_default":100,"invite":100,"kick":100,"ban":100,"redact":100}'
    [ -n "$(field reports_room)" ] || create_room fleet-reports reports_room '{}'
    [ -f "$DIR/cursor" ] || first_cursor
    printf 'The fleet is up at https://%s. Add someone with: fleet.sh add NAME\n' "$host"
}

stop() {
    engine stop "$CONTAINER" >/dev/null
    tailscale funnel --https=443 off
}

add() {
    [ $# -eq 1 ] && valid_name "$1" || die "usage: fleet.sh add NAME"
    new_account "$(lower "$1")"
    printf 'Send this invitation to %s privately, it is their access and cannot be shown again.\nThey clone this repository, read fleet.sh and AGENT.md, go to their project and run: path/to/fleet.sh join claude\n\n' "$1"
    jq -c --arg host "$(field host)" --arg lead "$(field lead)" '{host: $host, lead: $lead, token: .access_token}' <<<"$BODY" | base64 | tr -d '\n'
    printf '\n'
}

order() {
    local name mentions='{"room":true}' host
    host=$(field host)
    for name in "$@"; do valid_name "$name" || die "not a valid name: $name"; done
    if [ $# -gt 0 ]; then
        mentions=$(for name in "$@"; do printf '@%s:%s\n' "$(lower "$name")" "$host"; done | jq -Rnc '{user_ids: [inputs]}')
    fi
    send "$(field orders_room)" "$mentions"
}

who() {
    api GET "/_matrix/client/v3/rooms/$(uri "$(field orders_room)")/joined_members"
    [ "$STATUS" = 200 ] || die "could not read the fleet (HTTP $STATUS)"
    jq -r --arg boss "$(field lead)" '.joined | keys[] | select(. != $boss) | ltrimstr("@") | split(":")[0]' <<<"$BODY"
}

# ponytail: the account stays, banned from both rooms, so the name cannot be used again; deactivate it if names run out.
remove() {
    [ $# -eq 1 ] && valid_name "$1" || die "usage: fleet.sh remove NAME"
    local key body
    body=$(jq -nc --arg user "@$(lower "$1"):$(field host)" '{user_id: $user, reason: "Removed by the lead"}')
    for key in orders_room reports_room; do
        api POST "/_matrix/client/v3/rooms/$(uri "$(field "$key")")/ban" --data-binary "$body"
        [ "$STATUS" = 200 ] || die "could not remove $1 (HTTP $STATUS)"
    done
}

USAGE='usage: fleet.sh join claude|codex [ask|auto|skip] | wait | report | start YOUR_NAME | stop | add NAME | order [NAME...] | who | reports | remove NAME'
command=${1:-}
[ $# -eq 0 ] || shift
case $command in
    start | stop | join) ;;
    wait | report | add | order | who | reports | remove) [ -f "$STATE" ] || die "this machine is not in a fleet yet" ;;
    *) die "$USAGE" ;;
esac
case $command in
    add | order | who | reports | remove) [ "$(field user)" = "$(field lead)" ] || die "only the fleet's lead can do that" ;;
esac
case $command in
    start) start "$@" ;;
    stop) stop ;;
    join) join_fleet "$@" ;;
    wait) listen "$(field orders_room)" "$DIR/cursor" "$ORDER_PROGRAM" ;;
    report) send "$(field reports_room)" '{}' ;;
    add) add "$@" ;;
    order) order "$@" ;;
    who) who ;;
    reports) listen "$(field reports_room)" "$DIR/reports_cursor" "$REPORT_PROGRAM" ;;
    remove) remove "$@" ;;
esac
