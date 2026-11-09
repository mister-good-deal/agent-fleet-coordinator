// A stand-in for the lead's server, and the real fleet.sh run against it.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export const FLEET_HOST = "fleet.example.org";
export const LEAD = `@boss:${FLEET_HOST}`;
export const HELPER = `@helper:${FLEET_HOST}`;
export const ORDERS = `#fleet-orders:${FLEET_HOST}`;
export const REPORTS = `#fleet-reports:${FLEET_HOST}`;
export const SECRET = "the-server-secret";

const FLEET_URL = `https://${FLEET_HOST}`;
const LOCAL_URL = "http://127.0.0.1:8008";
const MAX_EVENT_BYTES = 65535;
const NONCE = "nonce-1";

type Reply = { status: number; body: unknown };
type Room = { creator: string; members: Set<string>; banned: Set<string>; settings: unknown };

const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (status: number, errcode: string): Reply => ({ status, body: { errcode, error: errcode }});

// What it was asked is kept, and any call can be made to fail once.
class FakeMatrix {
    readonly requests: { method: string; path: string; body: string }[] = [];
    readonly rooms = new Map<string, Room>();
    readonly events: { roomId: string; event: object }[] = [];
    readonly failures: { match: RegExp; status: number }[] = [];
    readonly accounts = new Map<string, string>();
    private readonly aliases = new Map<string, string>();

    account(user: string) {
        const token = `tok-${user.slice(1).split(":")[0] ?? ""}`;

        this.accounts.set(token, user);

        return token;
    }

    addRoom(alias: string, creator: string, settings: unknown = {}) {
        const id = `!room${this.rooms.size + 1}`;

        this.rooms.set(id, { creator, members: new Set([creator]), banned: new Set(), settings });
        this.aliases.set(alias, id);

        return id;
    }

    addEvent(roomId: string, event: object) {
        const event_id = `$event${this.events.length}`;

        this.events.push({ roomId, event: { event_id, type: "m.room.message", ...event }});

        return event_id;
    }

    answer(method: string, target: string, body: string, authorization?: string): Reply {
        const { pathname, searchParams } = new URL(target, FLEET_URL);
        const failure = this.failures.find(({ match }) => match.test(pathname));

        this.requests.push({ method, path: decodeURIComponent(target), body });

        if (failure) {
            this.failures.splice(this.failures.indexOf(failure), 1);

            return refused(failure.status, "M_TEST");
        }
        if (pathname === "/_matrix/client/versions") return ok({ versions: [] });
        if (pathname === "/_synapse/admin/v1/register") return method === "GET" ? ok({ nonce: NONCE }) : this.register(body);

        const user = this.accounts.get(authorization?.replace("Bearer ", "") ?? "");

        if (!user) return refused(401, "M_UNKNOWN_TOKEN");

        return this.clientCall(user, pathname.split("/").slice(4).map(decodeURIComponent), searchParams, body);
    }

    private register(body: string): Reply {
        const { nonce, username, password, admin, mac } = JSON.parse(body) as Record<string, string>;
        const expected = createHmac("sha1", SECRET).update(`${nonce}\0${username}\0${password}\0notadmin`).digest("hex");

        if (nonce !== NONCE || admin || mac !== expected) return refused(403, "M_FORBIDDEN");

        const user = `@${username ?? ""}:${FLEET_HOST}`;

        if ([...this.accounts.values()].includes(user)) return { status: 400, body: { errcode: "M_USER_IN_USE", error: "User ID is not available" }};

        return ok({ user_id: user, access_token: this.account(user) });
    }

    private clientCall(user: string, segments: string[], query: URLSearchParams, body: string): Reply {
        const [resource, second = "", third = ""] = segments;

        if (resource === "account") return ok({ user_id: user });
        if (resource === "directory") return this.aliases.has(third) ? ok({ room_id: this.aliases.get(third) }) : refused(404, "M_NOT_FOUND");
        if (resource === "createRoom") return this.createRoom(user, body);
        if (resource === "sync") return this.sync(query.get("since") ?? "s0");

        const room = this.rooms.get(second);

        if (!room) return refused(404, "M_NOT_FOUND");
        if (resource === "join") return this.join(user, room, second);

        return this.roomCall(user, room, second, third, body);
    }

    private createRoom(user: string, body: string) {
        const settings = JSON.parse(body) as { room_alias_name: string };
        const alias = `#${settings.room_alias_name}:${FLEET_HOST}`;

        return this.aliases.has(alias) ? refused(400, "M_ROOM_IN_USE") : ok({ room_id: this.addRoom(alias, user, settings) });
    }

    private sync(since: string) {
        const join: Record<string, { timeline: { events: object[] }}> = {};

        for (const { roomId, event } of this.events.slice(Number(since.slice(1)))) {
            (join[roomId] ??= { timeline: { events: [] }}).timeline.events.push(event);
        }

        return ok({ next_batch: `s${this.events.length}`, rooms: { join }});
    }

    private join(user: string, room: Room, id: string) {
        if (room.banned.has(user)) return refused(403, "M_FORBIDDEN");

        room.members.add(user);

        return ok({ room_id: id });
    }

    private roomCall(user: string, room: Room, id: string, action: string, body: string): Reply {
        if (action === "state") return ok([{ type: "m.room.create", state_key: "", sender: room.creator }]);
        if (action === "joined_members") return ok({ joined: Object.fromEntries([...room.members].map(member => [member, {}])) });
        if (action === "send") {
            if (Buffer.byteLength(body) > MAX_EVENT_BYTES) return refused(413, "M_TOO_LARGE");

            return ok({ event_id: this.addEvent(id, { sender: user, content: JSON.parse(body) as object }) });
        }
        if (action === "ban") {
            const { user_id } = JSON.parse(body) as { user_id: string };

            room.members.delete(user_id);
            room.banned.add(user_id);

            return ok({});
        }

        return refused(404, "M_UNRECOGNIZED");
    }
}

async function listen(matrix: FakeMatrix) {
    const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on("end", () => {
            const reply = matrix.answer(request.method ?? "", request.url ?? "", body, request.headers.authorization);

            response.writeHead(reply.status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(reply.body));
        });
    });

    await new Promise<void>(resolve => {
        server.listen(0, "127.0.0.1", resolve);
    });

    return server;
}

type FleetRun = { status: number | null; stdout: string; stderr: string };

// Not spawnSync: the fake server runs in this process and has to answer while the script runs.
const runFleet = (script: string, args: string[], input: string, env: NodeJS.ProcessEnv) => new Promise<FleetRun>(resolve => {
    const child = spawn("bash", [script, ...args], { env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    child.on("close", status => {
        resolve({ status, stdout, stderr });
    });
    // A script that refuses before reading what it was given is not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
});

const CURL_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
public=${FLEET_URL}
local=${LOCAL_URL}
args=()
for arg in "$@"; do arg="\${arg//$public/$FAKE_MATRIX}"; args+=("\${arg//$local/$FAKE_MATRIX}"); done
exec "$REAL_CURL" "\${args[@]}"
`;
const RECORDING_STUB = `#!/bin/bash
printf '%s\\n' "$(basename "$0") $*" >> "$TOOLS"
`;
const DOCKER_STUB = `${RECORDING_STUB}[ "$1" != start ]
`;
const TAILSCALE_STUB = `${RECORDING_STUB}[ "$1" != status ] || printf '{"Self":{"DNSName":"${FLEET_HOST}."}}'
`;
const AGENT_STUB = `#!/bin/bash
printf '%s\\n' "$PWD" "$0" > "$AGENT"
printf '%s\\n' "$@" >> "$AGENT"
`;

// The real fleet.sh and a fake server, with a stub curl that sends the script's requests there and records its arguments. Removed when the test ends.
export async function fakeFleet() {
    const matrix = new FakeMatrix();
    const server = await listen(matrix);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-fleet-")));
    const client = join(dir, "client");
    const bin = join(dir, "bin");
    const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), body);
        chmodSync(join(bin, name), 0o755);
    };

    onTestFinished(() => {
        server.closeAllConnections();
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });
    mkdirSync(client);
    mkdirSync(bin);
    for (const name of ["fleet.sh", "AGENT.md"]) copyFileSync(new URL(`../${name}`, import.meta.url), join(client, name));
    stub("curl", CURL_STUB);
    stub("docker", DOCKER_STUB);
    stub("tailscale", TAILSCALE_STUB);
    for (const name of ["claude", "codex"]) stub(name, AGENT_STUB);

    const paths = { CALLS: join(dir, "curl.log"), TOOLS: join(dir, "tools.log"), AGENT: join(dir, "agent.log") };
    const env = {
        ...process.env,
        ...paths,
        BASH_ENV: "",
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        REAL_CURL: spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim(),
        FAKE_MATRIX: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    };
    const log = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const run = (args: string[], input = "", extra: Record<string, string> = {}) => runFleet(join(client, "fleet.sh"), args, input, { ...env, ...extra });
    const file = (name: string) => join(client, ".fleet", name);
    const state = () => JSON.parse(readFileSync(file("state.json"), "utf8")) as Record<string, string>;

    return {
        matrix,
        run,
        file,
        state,
        env,
        bin,
        script: join(client, "fleet.sh"),
        curlCalls: () => log(paths.CALLS),
        toolCalls: () => log(paths.TOOLS),
        agentCall: () => log(paths.AGENT)
    };
}
