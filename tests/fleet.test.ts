// fleet.sh itself, run for real against a fake chat server: what runs on a colleague's machine is what is tested.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FLEET_HOST, HELPER, LEAD, ORDERS, REPORTS, SECRET, fakeFleet } from "./helpers.ts";

type Fleet = Awaited<ReturnType<typeof fakeFleet>>;

const ORDERS_ROOM = "!room1";
const REPORTS_ROOM = "!room2";
const JOIN = ["join", "claude"];
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const encode = (value: unknown) => `${Buffer.from(JSON.stringify(value)).toString("base64")}\n`;
const message = (body: string, extra: object = {}) => ({ "msgtype": "m.text", body, "m.mentions": { room: true }, ...extra });
const from = (body: string, extra?: object) => ({ sender: LEAD, content: message(body, extra) });
const lastEvent = (fleet: Fleet) => fleet.matrix.events.at(-1) as { roomId: string; event: { sender: string; content: Record<string, unknown> }};

function invitation(fleet: Fleet, user = HELPER) {
    return encode({ host: FLEET_HOST, lead: LEAD, token: fleet.matrix.account(user) });
}

async function readyFleet() {
    const fleet = await fakeFleet();

    fleet.matrix.addRoom(ORDERS, LEAD);
    fleet.matrix.addRoom(REPORTS, LEAD);

    return fleet;
}

async function joined() {
    const fleet = await readyFleet();

    expect((await fleet.run(JOIN, invitation(fleet))).status).toBe(0);

    return fleet;
}

async function started() {
    const fleet = await fakeFleet();

    mkdirSync(dirname(fleet.file("server-secret")), { recursive: true, mode: 0o700 });
    writeFileSync(fleet.file("server-secret"), `${SECRET}`);
    expect((await fleet.run(["start", "Boss"])).status).toBe(0);

    return fleet;
}

describe("join", () => {
    test("takes the invitation, joins the fleet, starts reading from now, and starts the agent", async() => {
        const fleet = await readyFleet();

        fleet.matrix.addEvent(ORDERS_ROOM, from("an order from before"));

        const { status, stdout } = await fleet.run(JOIN, invitation(fleet));

        expect(status).toBe(0);
        expect(stdout).toContain(`takes orders from ${LEAD} only`);
        expect(fleet.state()).toMatchObject({ host: FLEET_HOST, lead: LEAD, user: HELPER, orders_room: ORDERS_ROOM, reports_room: REPORTS_ROOM });
        expect(fleet.matrix.rooms.get(ORDERS_ROOM)?.members.has(HELPER)).toBe(true);
        expect(fleet.matrix.rooms.get(REPORTS_ROOM)?.members.has(HELPER)).toBe(true);
        expect(readFileSync(fleet.file("cursor"), "utf8").trim()).toBe("s1");
    });

    test("tells the agent exactly who it obeys and how, with AGENT.md and nothing else", async() => {
        const fleet = await joined();
        const agent = fleet.agentCall();

        expect(agent).toContain(`You have joined the agent fleet of ${LEAD}, my team lead, a person I trust. I, your owner, consent to you carrying out what this person asks.`);
        expect(agent).toContain(`bash "${fleet.script}" wait`);
        expect(agent).toContain(`bash "${fleet.script}" report`);
        expect(agent).not.toContain("{{");
    });

    test.each<[string, string, string[]]>([
        ["claude", "ask", ["--permission-mode", "manual"]],
        ["claude", "auto", ["--permission-mode", "auto"]],
        ["claude", "skip", ["--dangerously-skip-permissions"]],
        ["codex", "ask", ["-c", "background_terminal_max_timeout=86400000"]],
        ["codex", "auto", ["--approve-for-me", "-c", "background_terminal_max_timeout=86400000"]],
        ["codex", "skip", ["--dangerously-bypass-approvals-and-sandbox", "-c", "background_terminal_max_timeout=86400000"]]
    ])("%s in %s mode starts with the right flags", async(tool, how, flags) => {
        const fleet = await readyFleet();

        expect((await fleet.run(["join", tool, how], invitation(fleet))).status).toBe(0);

        const [, program, ...args] = fleet.agentCall().split("\n");

        expect(program?.endsWith(`/${tool}`)).toBe(true);
        expect(args.slice(0, flags.length)).toEqual(flags);
    });

    test("asks for approvals unless told otherwise", async() => {
        const fleet = await joined();

        expect(fleet.agentCall()).toContain("manual");
    });

    test.each([[["join"]], [["join", "gemini"]], [["join", "claude", "whatever"]]])("refuses %j before asking for anything", async args => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(args);

        expect(status).toBe(1);
        expect(stderr).toContain("usage");
        expect(fleet.curlCalls()).toBe("");
    });

    test("says so when the agent is not installed", async() => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(JOIN, "", { PATH: `${fleet.bin}-none:/usr/bin:/bin` });

        expect(status).toBe(1);
        expect(stderr).toContain("claude is not installed");
    });

    test("keeps what it stores readable only by its owner, and the token off every command line", async() => {
        const fleet = await joined();

        expect(mode(dirname(fleet.file("state.json")))).toBe("700");
        expect(mode(fleet.file("state.json"))).toBe("600");
        expect(mode(fleet.file("cursor"))).toBe("600");
        expect(fleet.curlCalls()).not.toBe("");
        expect(fleet.curlCalls()).not.toContain("tok-helper");
        expect(fleet.agentCall()).not.toContain("tok-helper");
    });

    test("needs the invitation only once, and skips the orders given while away", async() => {
        const fleet = await joined();

        fleet.matrix.addEvent(ORDERS_ROOM, from("while away"));
        expect((await fleet.run(JOIN, "")).status).toBe(0);
        fleet.matrix.addEvent(ORDERS_ROOM, from("now"));

        const { stdout } = await fleet.run(["wait"]);

        expect(stdout).not.toContain("while away");
        expect(stdout).toContain("now");
    });

    test("refuses a fleet whose rooms someone else created, and keeps nothing", async() => {
        const fleet = await fakeFleet();

        fleet.matrix.addRoom(ORDERS, "@squatter:fleet.example.org");
        fleet.matrix.addRoom(REPORTS, LEAD);

        const { status, stderr } = await fleet.run(JOIN, invitation(fleet));

        expect(status).toBe(1);
        expect(stderr).toContain("not created by its lead");
        expect(existsSync(fleet.file("state.json"))).toBe(false);
        expect(fleet.agentCall()).toBe("");
    });

    test("says so when the fleet does not exist yet", async() => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(JOIN, invitation(fleet));

        expect(status).toBe(1);
        expect(stderr).toContain("not ready yet");
    });

    test("does not take a server error for a fleet that does not exist", async() => {
        const fleet = await readyFleet();

        fleet.matrix.failures.push({ match: /directory/, status: 500 });

        const { status, stderr } = await fleet.run(JOIN, invitation(fleet));

        expect(status).toBe(1);
        expect(stderr).toContain("HTTP 500");
    });

    test("says so when the token is not known", async() => {
        const fleet = await readyFleet();
        const { status, stderr } = await fleet.run(JOIN, encode({ host: FLEET_HOST, lead: LEAD, token: "nope" }));

        expect(status).toBe(1);
        expect(stderr).toContain("refused this invitation");
        expect(existsSync(fleet.file("state.json"))).toBe(false);
    });

    test("says so when the server cannot be reached", async() => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(JOIN, invitation(fleet), { FAKE_MATRIX: "http://127.0.0.1:1" });

        expect(status).toBe(1);
        expect(stderr).toContain("cannot reach");
    });

    const good = { host: FLEET_HOST, lead: LEAD, token: "tok" };

    test.each<[string, string]>([
        ["nothing", "\n"],
        ["garbage", "not an invitation\n"],
        ["no token", encode({ ...good, token: undefined })],
        ["a token that could reach curl's config", encode({ ...good, token: 'a"\nurl = "https://evil.example.org' })],
        ["a lead on another server", encode({ ...good, lead: "@boss:evil.example.org" })],
        ["a lead with a capital", encode({ ...good, lead: `@Boss:${FLEET_HOST}` })],
        ["a crafted lead", encode({ ...good, lead: `@$(id):${FLEET_HOST}` })],
        ...["https://fleet.example.org", "fleet.example.org:8448", "fleet.example.org/x", "127.0.0.1", "localhost", "a.localhost", "-a.example.org", "a-.example.org", "FLEET.example.org", "a b.example.org", "$(id).example.org", ""]
            .map((host): [string, string] => [`the address ${JSON.stringify(host)}`, encode({ ...good, host, lead: `@boss:${host}` })])
    ])("refuses an invitation holding %s without contacting anything", async(_, code) => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(JOIN, code);

        expect(status).toBe(1);
        expect(stderr).toContain("not a valid invitation");
        expect(fleet.curlCalls()).toBe("");
    });
});

describe("wait", () => {
    test.each<[string, object]>([
        ["someone else's message", { sender: HELPER, content: message("no") }],
        ["a name that only looks like the lead's", { sender: "@boss:evil.example.org", content: message("no") }],
        ["a longer name", { sender: `@boss2:${FLEET_HOST}`, content: message("no") }],
        ["a sender forged in the content", { sender: HELPER, content: message("no", { sender: LEAD }) }],
        ["an edit", from("no", { "m.relates_to": { rel_type: "m.replace", event_id: "$x" }})],
        ["a redaction", { sender: LEAD, type: "m.room.redaction", content: { redacts: "$x" }}],
        ["a message that was redacted", { sender: LEAD, content: {}}],
        ["another kind of message", from("no", { msgtype: "m.notice" })],
        ["a message for someone else", from("no", { "m.mentions": { user_ids: [`@other:${FLEET_HOST}`] }})],
        ["a message addressed to nobody", { sender: LEAD, content: { msgtype: "m.text", body: "no" }}]
    ])("ignores %s", async(_, event) => {
        const fleet = await joined();

        fleet.matrix.addEvent(ORDERS_ROOM, event);
        fleet.matrix.addEvent(ORDERS_ROOM, from("yes"));

        const { status, stdout } = await fleet.run(["wait"]);

        expect(status).toBe(0);
        expect(stdout).toBe(`--- order $event1 from ${LEAD} ---\nyes\n`);
    });

    test("ignores what is written in another room", async() => {
        const fleet = await joined();

        fleet.matrix.addEvent(REPORTS_ROOM, from("no"));
        fleet.matrix.addEvent(ORDERS_ROOM, from("yes"));

        const { stdout } = await fleet.run(["wait"]);

        expect(stdout).not.toContain("no");
        expect(stdout).toContain("yes");
    });

    test("takes an order addressed to this agent", async() => {
        const fleet = await joined();

        fleet.matrix.addEvent(ORDERS_ROOM, from("for you", { "m.mentions": { user_ids: [HELPER] }}));
        expect((await fleet.run(["wait"])).stdout).toContain("for you");
    });

    test("gives several orders in order, and each only once", async() => {
        const fleet = await joined();

        fleet.matrix.addEvent(ORDERS_ROOM, from("first"));
        fleet.matrix.addEvent(ORDERS_ROOM, from("second"));
        expect((await fleet.run(["wait"])).stdout).toBe(`--- order $event0 from ${LEAD} ---\nfirst\n--- order $event1 from ${LEAD} ---\nsecond\n`);

        fleet.matrix.addEvent(ORDERS_ROOM, from("third"));
        expect((await fleet.run(["wait"])).stdout).toBe(`--- order $event2 from ${LEAD} ---\nthird\n`);
    });

    test("carries on through server errors and receives what was missed", async() => {
        const fleet = await joined();

        fleet.matrix.failures.push({ match: /sync/, status: 503 });
        fleet.matrix.addEvent(ORDERS_ROOM, from("after the outage"));

        const { status, stdout } = await fleet.run(["wait"]);

        expect(status).toBe(0);
        expect(stdout).toContain("after the outage");
    });

    test("stops when the server no longer knows this account", async() => {
        const fleet = await joined();

        fleet.matrix.failures.push({ match: /sync/, status: 401 });

        const { status, stderr } = await fleet.run(["wait"]);

        expect(status).toBe(1);
        expect(stderr).toContain("new invitation");
    });

    test("stops once the session that started it is gone", async() => {
        const fleet = await joined();
        const { stdout } = spawnSync("bash", ["-c", `bash ${fleet.script} wait >/dev/null 2>&1 & echo $!; sleep 0.3`], { env: fleet.env, encoding: "utf8" });
        const pid = Number(stdout);
        const running = () => {
            try {
                return process.kill(pid, 0);
            } catch {
                return false;
            }
        };

        await vi.waitFor(() => {
            expect(running()).toBe(false);
        }, { timeout: 5000, interval: 50 });
    });

    test("passes a long, multi-line text through unchanged and leaves shell syntax inert", async() => {
        const fleet = await joined();
        const text = `$(touch ${fleet.file("pwned")}) \`id\` "quoted" 'single'\n${"x".repeat(49900)}\n\nthe end`;

        fleet.matrix.addEvent(ORDERS_ROOM, from(text));

        const { stdout } = await fleet.run(["wait"]);

        expect(stdout).toBe(`--- order $event0 from ${LEAD} ---\n${text}\n`);
        expect(existsSync(fleet.file("pwned"))).toBe(false);
    });

    test("needs to be in a fleet first", async() => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(["wait"]);

        expect(status).toBe(1);
        expect(stderr).toContain("not in a fleet");
    });
});

describe("start", () => {
    test("runs a server with no way in but the accounts made here, then a room only the lead can write in", async() => {
        const fleet = await started();
        const server = fleet.toolCalls();

        for (const part of ["-p 127.0.0.1:8008:8008", "TUWUNEL_ALLOW_FEDERATION=false", "TUWUNEL_ALLOW_REGISTRATION=false", "TUWUNEL_LOGIN_WITH_PASSWORD=false", "TUWUNEL_GRANT_ADMIN_TO_FIRST_USER=false", "TUWUNEL_REGISTRATION_SHARED_SECRET_FILE=/run/server-secret", `TUWUNEL_SERVER_NAME=${FLEET_HOST}`]) expect(server).toContain(part);
        expect(server).toMatch(/tuwunel:v\d+\.\d+\.\d+/);
        expect(server).toContain("tailscale funnel --bg 8008");
        expect(server).not.toContain(SECRET);
        expect(fleet.state()).toMatchObject({ host: FLEET_HOST, lead: LEAD, user: LEAD, orders_room: ORDERS_ROOM, reports_room: REPORTS_ROOM });
        expect(fleet.matrix.rooms.get(ORDERS_ROOM)?.settings).toMatchObject({
            room_alias_name: "fleet-orders",
            power_level_content_override: { events_default: 100, state_default: 100, invite: 100, kick: 100, ban: 100, redact: 100 }
        });
        expect(fleet.matrix.rooms.get(REPORTS_ROOM)?.settings).toMatchObject({ room_alias_name: "fleet-reports", power_level_content_override: {}});
    });

    test("makes its own secret the first time, readable only by its owner", async() => {
        const fleet = await fakeFleet();

        await fleet.run(["start", "boss"]);
        expect(readFileSync(fleet.file("server-secret"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
        expect(mode(fleet.file("server-secret"))).toBe("600");
    });

    test("a second start keeps the account and the rooms", async() => {
        const fleet = await started();
        const before = fleet.state();
        const { status } = await fleet.run(["start"]);

        expect(status).toBe(0);
        expect(fleet.state()).toEqual(before);
        expect(fleet.matrix.rooms.size).toBe(2);
    });

    test("finishes making the rooms if it was interrupted", async() => {
        const fleet = await fakeFleet();

        mkdirSync(dirname(fleet.file("server-secret")), { recursive: true, mode: 0o700 });
        writeFileSync(fleet.file("server-secret"), SECRET);
        fleet.matrix.failures.push({ match: /createRoom/, status: 500 });
        expect((await fleet.run(["start", "boss"])).status).toBe(1);
        expect((await fleet.run(["start"])).status).toBe(0);
        expect(fleet.state()).toMatchObject({ orders_room: ORDERS_ROOM, reports_room: REPORTS_ROOM });
    });

    test.each([[[]], [["a b"]], [["$(id)"]]])("needs a valid name the first time: %j", async args => {
        const fleet = await fakeFleet();
        const { status, stderr } = await fleet.run(["start", ...args]);

        expect(status).toBe(1);
        expect(stderr).toContain("usage");
        expect(fleet.toolCalls()).toBe("");
    });
});

describe("add", () => {
    const decode = (stdout: string) => JSON.parse(Buffer.from(stdout.trim().split("\n").at(-1) ?? "", "base64").toString()) as Record<string, string>;

    test("creates the account and prints an invitation that works", async() => {
        const lead = await started();
        const { status, stdout } = await lead.run(["add", "Helper"]);

        expect(status).toBe(0);
        expect(decode(stdout)).toEqual({ host: FLEET_HOST, lead: LEAD, token: "tok-helper" });
        expect([...lead.matrix.accounts.values()]).toContain(HELPER);
        expect(lead.curlCalls()).not.toContain("tok-helper");
        expect(lead.curlCalls()).not.toContain(SECRET);
    });

    test("says so when the name is taken", async() => {
        const lead = await started();

        await lead.run(["add", "helper"]);

        const { status, stderr } = await lead.run(["add", "helper"]);

        expect(status).toBe(1);
        expect(stderr).toContain("not available");
    });

    test("stops when the server refuses the secret", async() => {
        const lead = await started();

        writeFileSync(lead.file("server-secret"), "wrong");

        const { status, stderr } = await lead.run(["add", "helper"]);

        expect(status).toBe(1);
        expect(stderr).toContain("could not create the account");
    });

    test.each(["-a", "a-", "a b", "a;id", "$(id)", "x".repeat(40)])("refuses the name %j", async name => {
        const lead = await started();
        const { status } = await lead.run(["add", name]);

        expect(status).toBe(1);
        expect([...lead.matrix.accounts.values()]).toEqual([LEAD]);
    });
});

describe("the lead's commands", () => {
    test.each([["add", "someone"], ["order"], ["who"], ["reports"], ["remove", "someone"]])("%s is refused to anyone else", async(...args) => {
        const fleet = await joined();
        const sent = fleet.matrix.requests.length;
        const { status, stderr } = await fleet.run(args, "text");

        expect(status).toBe(1);
        expect(stderr).toContain("only the fleet's lead");
        expect(fleet.matrix.requests).toHaveLength(sent);
    });

    test("order addresses everyone by default", async() => {
        const fleet = await started();

        expect((await fleet.run(["order"], "do this\nthen that")).status).toBe(0);
        expect(lastEvent(fleet)).toMatchObject({ roomId: ORDERS_ROOM, event: { sender: LEAD, content: { "msgtype": "m.text", "body": "do this\nthen that", "m.mentions": { room: true }}}});
    });

    test("order addresses the people named, as the server spells them", async() => {
        const fleet = await started();

        await fleet.run(["order", "Helper", "other"], "you two");
        expect(lastEvent(fleet).event.content["m.mentions"]).toEqual({ user_ids: [HELPER, `@other:${FLEET_HOST}`] });
    });

    test("order refuses an invalid name", async() => {
        const fleet = await started();

        expect((await fleet.run(["order", "$(id)"], "text")).status).toBe(1);
        expect(fleet.matrix.events).toHaveLength(0);
    });

    test("order accepts 50,000 characters and refuses one more", async() => {
        const fleet = await started();

        expect((await fleet.run(["order"], "x".repeat(50000))).status).toBe(0);
        expect(fleet.matrix.events).toHaveLength(1);

        const { status, stderr } = await fleet.run(["order"], "x".repeat(50001));

        expect(status).toBe(1);
        expect(stderr).toContain("too long");
        expect(fleet.matrix.events).toHaveLength(1);
    });

    test("order reports the server's refusal of a text too heavy in bytes", async() => {
        const fleet = await started();
        const { status, stderr } = await fleet.run(["order"], "é".repeat(40000));

        expect(status).toBe(1);
        expect(stderr).toContain("HTTP 413");
    });

    test("who lists the others without the lead", async() => {
        const fleet = await started();

        fleet.matrix.rooms.get(ORDERS_ROOM)?.members.add(HELPER);
        expect((await fleet.run(["who"])).stdout).toBe("helper\n");
    });

    test("reports gives each message with its author and keeps its own place", async() => {
        const fleet = await started();

        fleet.matrix.addEvent(REPORTS_ROOM, { sender: HELPER, content: message("done") });
        fleet.matrix.addEvent(ORDERS_ROOM, from("an order"));
        expect((await fleet.run(["reports"])).stdout).toBe("--- report from helper ---\ndone\n");

        fleet.matrix.addEvent(REPORTS_ROOM, { sender: HELPER, content: message("again") });
        expect((await fleet.run(["reports"])).stdout).toBe("--- report from helper ---\nagain\n");
    });

    test("remove bans from both rooms, so that the person cannot come back", async() => {
        const fleet = await started();

        expect((await fleet.run(["remove", "Helper"])).status).toBe(0);

        for (const room of [ORDERS_ROOM, REPORTS_ROOM]) expect(fleet.matrix.rooms.get(room)?.banned.has(HELPER)).toBe(true);
    });

    test("remove refuses an invalid name", async() => {
        const fleet = await started();

        expect((await fleet.run(["remove", "a b"])).status).toBe(1);
    });
});

describe("report", () => {
    test("goes to the reports room under the author's name, and wait never reads that room", async() => {
        const fleet = await joined();

        expect((await fleet.run(["report"], "all done")).status).toBe(0);
        expect(lastEvent(fleet)).toMatchObject({ roomId: REPORTS_ROOM, event: { sender: HELPER, content: { body: "all done" }}});

        fleet.matrix.addEvent(ORDERS_ROOM, from("next"));
        await fleet.run(["wait"]);

        const syncs = fleet.matrix.requests.filter(({ path }) => path.includes("timeout=30000"));

        expect(syncs.length).toBeGreaterThan(0);

        for (const { path } of syncs) expect(path).toContain(`"rooms":["${ORDERS_ROOM}"]`);
    });

    test("refuses an empty text", async() => {
        const fleet = await joined();

        expect((await fleet.run(["report"], "")).status).toBe(1);
        expect(fleet.matrix.events).toHaveLength(0);
    });
});
