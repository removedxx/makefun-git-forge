# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/removedxx/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/removedxx/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process — an entry for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). No git binary, no database,
no npm dependencies: the object store, packfile codec, and every protocol are implemented here on
`node:http`, `node:crypto` and `node:zlib` alone.

## Surfaces

- **Git smart HTTP** — upload-pack protocol v2 (capability advertisement, `ls-refs` with
  ref-prefix/peel/symrefs/unborn, `fetch` with side-band-64k, have-exclusion, shallow clones and
  deepen) plus the v0 advertisement fallback; receive-pack v0 with report-status, per-ref ok/ng
  lines and fast-forward-only enforcement.
- **REST v3** under `/api/v3` — repositories (CRUD, `Link`-header pagination), the contents API
  backed by real git commits (sha-checked updates, 409/422 semantics), branches, refs, commits,
  labels, issues with comments, and pull requests whose merge performs a file-level three-way
  merge and lands a squash commit on the base branch (conflicts answer 405).
- **GraphQL** at `/api/graphql` — a small purpose-built engine (operations, variables, aliases,
  fragments, batching) serving viewer/repository/issue/pull-request types, cursor-paginated
  connections, opaque global ids with `node()`, the create/close/merge mutations, and `__type`
  introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP with `server/discover` (2026-07-28) and the
  legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

All state is in memory. Every timestamp derives from `MAKEFUN_TRIAL_NOW` plus a monotonic
sequence, so a replayed trial sees byte-identical answers.

## Layout

- `main.ts` — the harness lifecycle (bind port 0, register with `$MAKEFUN_ENV_URL`, poll `/done`,
  exit 0). Unchanged from the contest starter.
- `app.ts` — the HTTP server: routing, auth, REST v3, git smart HTTP, MCP.
- `forge.ts` — the domain model: the one account, repositories, issues, pull requests, merges.
- `gitstore.ts` — the git object store, packfile read/write (ofs/ref deltas), pkt-line framing.
- `graphql.ts` — the GraphQL lexer/parser/executor and schema.

## Run it

```sh
node --experimental-strip-types main.ts
```

Requires Node 22.18+ (type stripping). In a trial the harness supplies `MAKEFUN_ENV_URL`,
`MAKEFUN_SHOP_TOKEN` (the bearer token every surface checks) and `MAKEFUN_TRIAL_NOW`.
