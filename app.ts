// app.ts — the forge's HTTP surface: git smart HTTP (upload-pack protocol v2 + v0 advertisement,
// receive-pack v0), the REST v3 API under /api/v3, GraphQL at /api/graphql and MCP at /mcp, all
// over the one in-memory store in forge.ts. main.ts owns the lifecycle; this file is the server.
//
// Discipline the suite checks everywhere: unknown routes answer 404 with a JSON {message} body,
// malformed JSON answers 400, every REST reply is application/json with a non-empty
// X-GitHub-Request-Id, and no request — however malformed — may take the process down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  HttpError,
  VIEWER,
  DEFAULT_BRANCH,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './forge.ts';
import {
  PKT_FLUSH,
  Store,
  ZERO_OID,
  commitClosure,
  decodePktLines,
  isAncestor,
  isOid,
  listCommits,
  objectClosure,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
  type PktPacket,
} from './gitstore.ts';
import { executeGraphql } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** A deterministic, always non-empty request id (no wall clock, no randomness: replays must match). */
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The bearer-token check: the trial's token when one is configured, else any presented token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header);
  if (!match) return false;
  return EXPECTED_TOKEN === '' || match[1] === EXPECTED_TOKEN;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 256 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; an empty body reads as {}, malformed JSON is a 400. */
function parseJsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// --------------------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

/** Slice a list by ?page / ?per_page and build GitHub's Link header (absolute, same-origin). */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): Page<T> {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const linkFor = (targetPage: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `<http://${host}${url.pathname}?${params.toString()}>`;
  };
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`${linkFor(page + 1)}; rel="next"`);
    links.push(`${linkFor(lastPage)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${linkFor(1)}; rel="first"`);
    links.push(`${linkFor(page - 1)}; rel="prev"`);
  }
  return { items: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// --------------------------------------------------------------------------- REST v3

function labelNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const names: string[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
  }
  return names;
}

function sortIssues(issues: IssueRec[], url: URL): IssueRec[] {
  const direction = url.searchParams.get('direction') ?? 'desc';
  const sorted = [...issues];
  sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return sorted;
}

function sortPulls(pulls: PullRec[], url: URL): PullRec[] {
  const direction = url.searchParams.get('direction') ?? 'desc';
  const sorted = [...pulls];
  sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return sorted;
}

async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = url.pathname.replace(/^\/api\/v3\/?/, '');
  const segments = rest === '' ? [] : rest.split('/').map(safeDecode);

  const body = (): Record<string, unknown> => parseJsonBody(rawBody);

  // Root and meta.
  if (segments.length === 0 && method === 'GET') {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', github_hostname: 'forge.invalid', pages: false, importer: false });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, forge.userView());
    return;
  }

  // The viewer's repositories.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const page = paginate(req, url, forge.listRepos());
      sendJson(res, 200, page.items.map((repo) => forge.repoView(repo)), page.headers);
      return;
    }
    if (method === 'POST') {
      const input = body();
      const repo = forge.createRepo({
        name: String(input.name ?? ''),
        description: typeof input.description === 'string' ? input.description : '',
        isPrivate: input.private === true,
        autoInit: input.auto_init === true,
      });
      sendJson(res, 201, forge.repoView(repo));
      return;
    }
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    const repo = forge.repo(segments[1]!, segments[2]!);
    const tail = segments.slice(3);
    await handleRepoRest(forge, req, res, url, repo, tail, method, body);
    return;
  }

  throw new HttpError(404, 'Not Found');
}

async function handleRepoRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
  body: () => Record<string, unknown>,
): Promise<void> {
  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, forge.repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      const input = body();
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.name === 'string' && input.name !== repo.name) {
        if (forge.repos.has(input.name)) throw new HttpError(422, 'Repository name already exists');
        forge.repos.delete(repo.name);
        (repo as { name: string }).name = input.name;
        forge.repos.set(repo.name, repo);
      }
      sendJson(res, 200, forge.repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Contents: everything after /contents/ is the repo-relative path (slashes kept).
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = url.searchParams.get('ref');
      const found = forge.contentsAt(repo, path, ref);
      if (found === null) throw new HttpError(404, 'Not Found');
      if (found.kind === 'file') {
        const blob = repo.store.get(found.oid);
        sendJson(res, 200, {
          name: path.split('/').pop() ?? path,
          path,
          sha: found.oid,
          size: found.size,
          type: 'file',
          encoding: 'base64',
          content: blob ? blob.data.toString('base64') : '',
        });
        return;
      }
      const tree = repo.store.get(found.treeOid);
      const entries = tree && tree.type === 'tree' ? parseTree(tree.data) : [];
      sendJson(
        res,
        200,
        entries.map((entry) => ({
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' || entry.mode === '040000' ? 0 : (repo.store.get(entry.oid)?.data.length ?? 0),
          type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
        })),
      );
      return;
    }
    if (method === 'PUT') {
      const input = body();
      if (typeof input.message !== 'string' || typeof input.content !== 'string') {
        throw new HttpError(422, 'message and content are required');
      }
      const result = forge.putContents(repo, path, {
        content: Buffer.from(input.content, 'base64'),
        message: input.message,
        branch: typeof input.branch === 'string' ? input.branch : undefined,
        sha: typeof input.sha === 'string' ? input.sha : undefined,
      });
      sendJson(
        res,
        result.created ? 201 : 200,
        {
          content: { name: path.split('/').pop() ?? path, path, sha: result.blob, size: Buffer.from(input.content, 'base64').length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commit, message: input.message },
        },
      );
      return;
    }
    if (method === 'DELETE') {
      const input = body();
      if (typeof input.message !== 'string' || typeof input.sha !== 'string') throw new HttpError(422, 'message and sha are required');
      const result = forge.deleteContents(repo, path, {
        message: input.message,
        branch: typeof input.branch === 'string' ? input.branch : undefined,
        sha: input.sha,
      });
      sendJson(res, 200, { content: null, commit: { sha: result.commit, message: input.message } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Git data: refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'POST') {
        const input = body();
        const ref = String(input.ref ?? '');
        const sha = String(input.sha ?? '');
        if (!ref.startsWith('refs/')) throw new HttpError(422, 'ref must start with refs/');
        const target = isOid(sha) ? forge.peelToCommit(repo, sha) : null;
        if (target === null && repo.store.get(sha)?.type !== 'tag') throw new HttpError(422, 'Invalid sha');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'GET') {
        sendJson(
          res,
          200,
          [...repo.refs.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } })),
        );
        return;
      }
    } else if (method === 'GET') {
      const ref = tail.slice(2).join('/');
      const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { ref: ref.startsWith('refs/') ? ref : `refs/${ref}`, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const name = tail.slice(1).join('/');
      const sha = repo.tipOf(name);
      if (sha === null) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { name, commit: { sha }, protected: false });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Commits.
  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      const tip = shaParam !== null && shaParam !== '' ? forge.resolveCommit(repo, shaParam) : repo.headTip();
      if (tip === null) throw new HttpError(404, 'Not Found');
      const all = listCommits(repo.store, tip).map((oid) => forge.commitView(repo, oid)).filter((entry) => entry !== null);
      const page = paginate(req, url, all);
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const commit = forge.commitView(repo, tail[1]!);
      if (commit === null) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, commit);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((label) => forge.labelView(label)));
        return;
      }
      if (method === 'POST') {
        const input = body();
        const label = forge.createLabel(repo, {
          name: String(input.name ?? ''),
          color: typeof input.color === 'string' ? input.color : undefined,
          description: typeof input.description === 'string' ? input.description : undefined,
        });
        sendJson(res, 201, forge.labelView(label));
        return;
      }
    }
    if (tail.length === 2 && method === 'GET') {
      const label = repo.labels.get(tail[1]!);
      if (!label) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, forge.labelView(label));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Issues.
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const page = paginate(req, url, sortIssues(issues, url));
        sendJson(res, 200, page.items.map((issue) => forge.issueView(repo, issue)), page.headers);
        return;
      }
      if (method === 'POST') {
        const input = body();
        const issue = forge.createIssue(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          labels: labelNames(input.labels),
        });
        sendJson(res, 201, forge.issueView(repo, issue));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number(tail[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (!issue) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, forge.issueView(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const input = body();
        if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.labels !== undefined) {
          const names = labelNames(input.labels);
          for (const name of names) if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist in this repository`);
          issue.labels = names;
        }
        issue.updatedSeq = forge.tick();
        sendJson(res, 200, forge.issueView(repo, issue));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => forge.commentView(repo, comment)));
        return;
      }
      if (method === 'POST') {
        const input = body();
        if (typeof input.body !== 'string' || input.body === '') throw new HttpError(422, 'body is required');
        const comment = forge.addComment(repo, issue, input.body);
        sendJson(res, 201, forge.commentView(repo, comment));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'labels' && method === 'POST') {
      if (!issue) throw new HttpError(404, 'Not Found');
      const input = body();
      const names = labelNames(input.labels ?? input);
      for (const name of names) if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist in this repository`);
      for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
      issue.updatedSeq = forge.tick();
      sendJson(res, 200, issue.labels.map((name) => forge.labelView(repo.labels.get(name)!)));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        const page = paginate(req, url, sortPulls(pulls, url));
        sendJson(res, 200, page.items.map((pull) => forge.pullView(repo, pull)), page.headers);
        return;
      }
      if (method === 'POST') {
        const input = body();
        const pull = forge.createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.head ?? ''),
          base: String(input.base ?? DEFAULT_BRANCH),
        });
        sendJson(res, 201, forge.pullView(repo, pull));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    const number = Number(tail[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (!pull) throw new HttpError(404, 'Not Found');
    if (tail.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, forge.pullView(repo, pull));
        return;
      }
      if (method === 'PATCH') {
        const input = body();
        if (input.state === 'closed' || input.state === 'open') {
          if (!(pull.merged && input.state === 'open')) pull.state = input.state;
        }
        if (typeof input.title === 'string') pull.title = input.title;
        if (typeof input.body === 'string') pull.body = input.body;
        pull.updatedSeq = forge.tick();
        sendJson(res, 200, forge.pullView(repo, pull));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const files = forge.pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: file.sha,
      }));
      const page = paginate(req, url, files);
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const input = body();
      const methodName = typeof input.merge_method === 'string' ? input.merge_method : 'squash';
      const result = forge.mergePull(repo, pull, methodName);
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

// --------------------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS_V0 = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=makefun-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

/** The v0 ref lines for an advertisement: HEAD first (with capabilities), then refs + peeled tags. */
function v0RefLines(repo: RepoRec, caps: string): Buffer[] {
  const headRef = `refs/heads/${DEFAULT_BRANCH}`;
  const headOid = repo.refs.get(headRef);
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (headOid === undefined && refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${headRef}\n`));
    return lines;
  }
  let first = true;
  const emit = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(`${oid} ${name}\0${caps} symref=HEAD:${headRef}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  if (headOid !== undefined) emit(headOid, 'HEAD');
  for (const [ref, oid] of refs) {
    emit(oid, ref);
    const object = repo.store.get(oid);
    if (object?.type === 'tag') {
      const peeled = repoPeel(repo, oid);
      if (peeled !== null && peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

/** Peel a tag object chain to its commit (advertisements and ls-refs). */
function repoPeel(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (!target) return null;
    current = target[1]!;
  }
  return null;
}

function handleInfoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Unknown service');
  const repo = forge.repo(owner, name);
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=makefun-forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const body = Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
  sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
}

/** Split a request body into pkt-line packets plus the raw remainder after the first flush. */
function splitPackets(body: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: body.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function handleLsRefs(forge: Forge, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = forge.repo(owner, name);
  const { packets } = splitPackets(body);
  let sawCommand = false;
  let afterDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line === 'command=ls-refs') sawCommand = true;
      continue;
    }
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  if (!sawCommand) throw new HttpError(400, 'expected command=ls-refs');
  const matches = (refName: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${DEFAULT_BRANCH}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = repo.store.get(oid);
      if (object?.type === 'tag') {
        const peeled = repoPeel(repo, oid);
        if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

/** Every object reachable from roots without crossing a commit's parent edges out of `cut`. */
function closureCutAt(store: Store, roots: readonly string[], cut: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!cut.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (target) stack.push(target[1]!);
    }
  }
  return out;
}

interface FetchPlan {
  pack: Buffer;
  shallowLines: string[];
  unshallowLines: string[];
  commonHave: string | null;
}

/**
 * Plan a fetch: the objects the client lacks, honouring have-exclusion, the shallow boundary it
 * declares, and a deepen depth counted in generations from the wants (a shallow-held want still
 * counts as generation 1, so deepening extends past it exactly one generation per step).
 */
function planFetch(repo: RepoRec, wants: readonly string[], haves: readonly string[], shallowList: readonly string[], deepen: number | null): FetchPlan {
  const store = repo.store;
  const validCommits = (oids: readonly string[]): string[] => oids.filter((oid) => store.get(oid)?.type === 'commit');
  const commonHave = haves.find((oid) => store.get(oid)?.type === 'commit') ?? null;
  const shallowSet = new Set(validCommits(shallowList));
  // What the client fully holds: the haves' ancestry, but cut at the shallow boundary — a commit
  // the client declares shallow is held itself, its parents are exactly what a deepen must send.
  const haveCommitSet = new Set<string>();
  {
    const stack = validCommits(haves);
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveCommitSet.has(oid)) continue;
      haveCommitSet.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(store.get(oid)!.data).parents) stack.push(parent);
    }
  }
  const exclude = closureCutAt(store, [...haveCommitSet], shallowSet);
  for (const boundary of shallowSet) {
    for (const oid of closureCutAt(store, [boundary], new Set([boundary]))) exclude.add(oid);
  }
  // Breadth-first by generation from the wants.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  const directObjects: string[] = []; // non-commit wants (tags, trees, blobs) ride along whole
  for (const want of wants) {
    const object = store.get(want);
    if (!object) continue;
    if (object.type === 'commit') {
      if (!distance.has(want)) {
        distance.set(want, 1);
        queue.push(want);
      }
    } else if (object.type === 'tag') {
      directObjects.push(want);
      const peeled = repoPeel(repo, want);
      if (peeled !== null && !distance.has(peeled)) {
        distance.set(peeled, 1);
        queue.push(peeled);
      }
    } else {
      directObjects.push(want);
    }
  }
  const included = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const dist = distance.get(oid)!;
    if (deepen !== null && dist > deepen) continue;
    // A shallow-held commit is traversed (deepening reaches past it) but never re-sent; a fully
    // held commit stops the walk — the client already has everything below it.
    if (haveCommitSet.has(oid) && !shallowSet.has(oid)) continue;
    if (!shallowSet.has(oid) && !haveCommitSet.has(oid)) included.add(oid);
    const commit = parseCommit(store.get(oid)!.data);
    for (const parent of commit.parents) {
      if (!distance.has(parent) && store.get(parent)?.type === 'commit') {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  const packOids = new Set<string>(directObjects);
  for (const oid of included) {
    for (const member of closureCutAt(store, [oid], new Set([oid]))) packOids.add(member);
  }
  for (const oid of exclude) packOids.delete(oid);
  const typeOrder: Record<GitObject['type'], number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const objects = [...packOids]
    .map((oid) => store.get(oid))
    .filter((object): object is GitObject => object !== undefined)
    .sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
  // The shallow boundary after this fetch, from the client's point of view.
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (deepen !== null || shallowList.length > 0) {
    const held = new Set<string>([...haveCommitSet, ...shallowSet, ...included]);
    for (const oid of included) {
      const parents = parseCommit(store.get(oid)!.data).parents;
      if (parents.length > 0 && parents.some((parent) => !held.has(parent))) shallowLines.push(oid);
    }
    for (const boundary of shallowSet) {
      const parents = parseCommit(store.get(boundary)!.data).parents;
      if (parents.every((parent) => held.has(parent))) unshallowLines.push(boundary);
    }
  }
  return { pack: writePack(objects), shallowLines, unshallowLines, commonHave };
}

function handleFetchV2(forge: Forge, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = forge.repo(owner, name);
  const { packets } = splitPackets(body);
  let afterDelim = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowList: string[] = [];
  let deepen: number | null = null;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowList.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) deepen = Math.trunc(parsed);
    }
  }
  const plan = planFetch(repo, wants, haves, shallowList, deepen);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonHave !== null) {
    parts.push(pktLine(`ACK ${plan.commonHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (deepen !== null || shallowList.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, plan.pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(forge: Forge, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = forge.repo(owner, name);
  const { packets } = splitPackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '').split('\0')[0]!;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) deepen = Math.trunc(parsed);
    }
  }
  const plan = planFetch(repo, wants, haves, [], deepen);
  const parts: Buffer[] = [];
  parts.push(pktLine(plan.commonHave !== null ? `ACK ${plan.commonHave}\n` : 'NAK\n'));
  for (const packet of sidebandPackets(1, plan.pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(forge: Forge, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  // Dispatch on the first data packet: a v2 command line, an ls-refs command, or a v0 want line.
  let firstLine = '';
  try {
    const { packets } = splitPackets(body);
    for (const packet of packets) {
      if (packet.kind === 'data') {
        firstLine = packet.payload.toString('utf8').split('\n')[0]!;
        break;
      }
    }
  } catch {
    throw new HttpError(400, 'malformed pkt-line stream');
  }
  if (firstLine === 'command=ls-refs') {
    handleLsRefs(forge, res, owner, name, body);
    return;
  }
  if (firstLine === 'command=fetch') {
    handleFetchV2(forge, res, owner, name, body);
    return;
  }
  if (firstLine.startsWith('want ')) {
    handleFetchV0(forge, res, owner, name, body);
    return;
  }
  throw new HttpError(400, 'unrecognized upload-pack request');
}

function handleReceivePack(forge: Forge, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = forge.repo(owner, name);
  const { packets, rest } = splitPackets(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let sideband = false;
  let firstLine = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine) {
      firstLine = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  // The pack (absent for delete-only pushes) is stored whole before any ref is judged, as git does.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0 && rest.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      readPack(rest, repo.store);
    } catch (error) {
      unpackOk = false;
      unpackDetail = `error ${error instanceof Error ? error.message : 'corrupt pack'}`;
    }
  } else if (rest.length > 0) {
    unpackOk = false;
    unpackDetail = 'error unexpected bytes after the command list';
  }
  const headRef = `refs/heads/${DEFAULT_BRANCH}`;
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpacker error';
    } else if (command.oldOid !== current) {
      reason = command.newOid !== ZERO_OID && !isAncestor(repo.store, current, command.newOid) ? 'non-fast-forward' : 'stale info';
    } else if (command.newOid === ZERO_OID) {
      if (command.ref === headRef) reason = 'deletion of the current branch prohibited';
      else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else {
      const target = repo.store.get(command.newOid);
      if (!target) reason = 'invalid object';
      else if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') reason = 'invalid object';
      else if (command.newOid === current) ok = true;
      else if (current === ZERO_OID || isAncestor(repo.store, current, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      } else reason = 'non-fast-forward';
    }
    results.push({ ref: command.ref, ok, reason });
  }
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const out = sideband ? Buffer.concat([...sidebandPackets(1, report), PKT_FLUSH]) : report;
  sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- MCP

const MCP_SERVER_INFO = { name: 'makefun-git-forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toolResult(view: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view };
}

function callMcpTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      throw new RpcError(-32602, `Missing required argument: ${required}`);
    }
  }
  const repoOf = (): RepoRec => forge.repo(String(args.owner), String(args.repo));
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo({
          name: String(args.name),
          description: typeof args.description === 'string' ? args.description : '',
          isPrivate: args.private === true,
        });
        return toolResult(forge.repoView(repo));
      }
      case 'get_repo':
        return toolResult(forge.repoView(repoOf()));
      case 'create_issue': {
        const repo = repoOf();
        const issue = forge.createIssue(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
        return toolResult(forge.issueView(repo, issue));
      }
      case 'list_issues': {
        const repo = repoOf();
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
        issues.sort((a, b) => a.number - b.number);
        return toolResult(issues.map((issue) => forge.issueView(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = repoOf();
        const pull = forge.createPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(forge.pullView(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoOf();
        const pull = repo.pulls.get(Number(args.pull_number));
        if (!pull) throw new HttpError(404, 'Pull request not found');
        forge.mergePull(repo, pull, 'squash');
        return toolResult(forge.pullView(repo, pull));
      }
      default:
        throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof HttpError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    throw error;
  }
}

function processRpc(forge: Forge, message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const respond = (result: unknown): Record<string, unknown> | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, result };
  const respondError = (code: number, text: string): Record<string, unknown> | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } };
  try {
    switch (method) {
      case 'server/discover':
        return respond({
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return respond({ protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
      }
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: MCP_TOOLS });
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        return respond(callMcpTool(forge, toolName, toolArgs));
      }
      default:
        if (method.startsWith('notifications/')) return null;
        return respondError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) return respondError(error.code, error.message);
    return respondError(-32603, error instanceof Error ? error.message : 'Internal error');
  }
}

function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed: POST only' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => processRpc(forge, entry)).filter((entry) => entry !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = processRpc(forge, parsed);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// --------------------------------------------------------------------------- the server

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  if (path === '/mcp') {
    handleMcp(forge, req, res, await readBody(req));
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { errors: [{ message: 'GraphQL only accepts POST' }] });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const outcome = executeGraphql(forge, parsed);
    sendJson(res, outcome.status, outcome.payload);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(forge, req, res, url, await readBody(req));
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = safeDecode(gitMatch[1]!);
    // Git clients address the repository as /{owner}/{repo}.git/... — the suffix is not part of the name.
    const name = safeDecode(gitMatch[2]!).replace(/\.git$/, '');
    const service = gitMatch[3]!;
    if (service === 'info/refs' && method === 'GET') {
      handleInfoRefs(forge, req, res, url, owner, name);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(forge, res, owner, name, await readBody(req));
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(forge, res, owner, name, await readBody(req));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, req, res).catch((error: unknown) => {
      try {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof HttpError) {
          sendError(res, error.status, error.message);
        } else {
          process.stderr.write(`[forge] unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
          sendError(res, 500, 'Internal Server Error');
        }
      } catch {
        // The socket is already gone; nothing more can be said.
      }
    });
  });
  server.on('clientError', (error, socket) => {
    process.stderr.write(`[forge] client error: ${error.message}\n`);
    socket.destroy();
  });
  return server;
}
