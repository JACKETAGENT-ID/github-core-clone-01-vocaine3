# github-core-clone-01 — vocaine (v3)

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JACKETAGENT-ID/github-core-clone-01-vocaine3/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JACKETAGENT-ID/github-core-clone-01-vocaine3/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-core clone in a single Node.js process — git smart HTTP
(upload-pack v2 + receive-pack v0), REST v3, GraphQL and MCP — built as an
entry for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

This is the v3 performance upgrade of the vocaine entry: same full feature
surface, reworked for speed — indexed in-memory store, cached serializations
on the hot read path, and plain-pack git handling with no external service
and no git binary.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`,
then serves until the env reports done.

## Layout

- `main.ts` — entry lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — HTTP routing: `/healthz`, `/meta`, REST, GraphQL, MCP, git.
- `store.ts` — in-memory store: repos, issues, pull requests, real git objects (SHA-1).
- `gitproto.ts` — pkt-lines, pack read/write, upload-pack v2/v0, receive-pack v0.
- `rest.ts` — REST v3 (`/api/v3`).
- `graphql.ts` — minimal GraphQL executor for the gh-style documents.
- `mcp.ts` — MCP JSON-RPC endpoint (`/mcp`) with the six GitHub tools.
- `httputil.ts` — shared HTTP helpers.

Node 22+ stdlib only. No dependencies, no installs.

## License

MIT — see [LICENSE](LICENSE).
