# agent-fleet-coordinator

A colleague has run out of AI quota and you have plenty, or the other way round. This lets one person put their AI agent at a teammate's disposal with one command: the agent waits for orders from the team lead's own agent, and does the work on the owner's account.

It is made for a team that already trusts each other. It is not for strangers: anyone in the fleet does what the lead asks, on their own account and at their own cost.

## Read it first

[`fleet.sh`](fleet.sh) is all that runs on your machine, and [`AGENT.md`](AGENT.md) is everything your agent is told. Nothing is downloaded and run behind your back, so read both before you start.

## Join a fleet

You need `curl`, `jq`, `git`, and Claude Code or Codex, and an invitation from your lead.

```sh
git clone https://github.com/mister-good-deal/agent-fleet-coordinator
cd your-project
../agent-fleet-coordinator/fleet.sh join claude
```

Paste the invitation when asked. Your agent starts in the folder you are in and waits without using your quota. Close the session to leave.

It asks for your approval on each action, as usual. `join claude auto` or `join claude skip` hand over more; only use them if you are comfortable with an agent acting unattended on orders that are not yours. Codex has not been tested yet.

## Lead a fleet

You also need docker or podman, Tailscale and `openssl`. The server runs on your machine.

```sh
./fleet.sh start your-name      # starts the server, opens the tunnel, creates your account
./fleet.sh add alice            # prints an invitation to send to Alice privately
claude "Read COORDINATOR.md and coordinate the fleet"
```

| Command | What it does |
|---|---|
| `add NAME` | Adds someone and prints their invitation |
| `who` | Lists who has joined |
| `order [NAME...]` | Sends stdin as an order, to everyone if nobody is named |
| `reports` | Waits for reports and prints them |
| `remove NAME` | Removes someone for good |
| `start` / `stop` | Starts or stops the server and the tunnel |

To remove everything: `./fleet.sh stop`, then `docker rm -f agent-fleet-coordinator` and `docker volume rm agent-fleet-coordinator` (or `podman`), then delete `.fleet/`.

## What it does and does not protect

- **Who gives orders.** An agent only acts on messages the server says the lead wrote, in a room only the lead can write in. A colleague cannot forge one.
- **Who gets in.** Sign-ups are closed. An account exists only because the lead created it, so the accounts are the whitelist.
- **An invitation is a secret.** Whoever holds it can read the orders and write reports as that person, but cannot give orders. If one leaks, `remove` that person and add them under another name.
- **Your credentials stay yours.** Your AI and GitHub credentials never leave your machine. The server only sees chat messages.
- **Everyone in the fleet reads every order.** Never put a secret in one.
- **The server is reachable from the internet while it runs**, through Tailscale Funnel. It holds the messages and accounts, nothing else.
- **The lead is trusted completely.** That is the premise. Someone who takes over the lead's account or machine can order every agent in the fleet.

## Tests

`npm install && npm test` runs the real `fleet.sh` against a fake server. Nothing here is needed to use it.

## License

MIT
