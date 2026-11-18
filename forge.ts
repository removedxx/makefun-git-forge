// forge.ts — the forge's domain model: the one account, its repositories, and every operation the
// REST, git, GraphQL and MCP surfaces share. All state is in memory; all timestamps derive from
// MAKEFUN_TRIAL_NOW plus a monotonic sequence, so two identical trials see identical bytes (the
// harness replays a trial and compares the export byte for byte — no wall clock may leak in).

import {
  Store,
  ZERO_OID,
  buildCommit,
  commitClosure,
  flattenTree,
  isAncestor,
  listCommits,
  mergeBase,
  oidOf,
  parseCommit,
  parseTree,
  subtreeAt,
  writeTreePath,
  type GitObject,
} from './gitstore.ts';

/** The trial's one account: the bearer token names this login, and every repo lives under it. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

/** An error with an HTTP status, thrown by domain operations and rendered by the HTTP layer. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
  updatedSeq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  seq: number;
  updatedSeq: number;
}

export class RepoRec {
  readonly store = new Store();
  readonly refs = new Map<string, string>(); // 'refs/heads/main' -> commit oid
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly labels = new Map<string, LabelRec>(); // by exact name
  nextNumber = 1; // issues and pull requests share one numbering counter, as on GitHub

  readonly id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  readonly seq: number;

  constructor(id: number, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.seq = seq;
  }

  get fullName(): string {
    return `${VIEWER.login}/${this.name}`;
  }

  tipOf(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  headTip(): string | null {
    return this.tipOf(DEFAULT_BRANCH);
  }
}

/** A line-based diff summary between two file contents. */
export function diffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop the shared prefix/suffix first; the LCS then only spans the changed middle.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  if (oldMid.length === 0) return { additions: newMid.length, deletions: 0 };
  if (newMid.length === 0) return { additions: 0, deletions: oldMid.length };
  if (oldMid.length * newMid.length > 1_000_000) return { additions: newMid.length, deletions: oldMid.length };
  const dp = new Array<number>(newMid.length + 1).fill(0);
  for (let i = oldMid.length - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = newMid.length - 1; j >= 0; j -= 1) {
      const saved = dp[j]!;
      if (oldMid[i] === newMid[j]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j + 1]!);
      diagonal = saved;
    }
  }
  const common = dp[0]!;
  return { additions: newMid.length - common, deletions: oldMid.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** The file-level diff between two trees (by oid), paths sorted. */
export function diffTrees(store: Store, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree !== null ? flattenTree(store, fromTree) : new Map<string, { oid: string; mode: string }>();
  const to = toTree !== null ? flattenTree(store, toTree) : new Map<string, { oid: string; mode: string }>();
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before ? (store.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (store.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = before && after ? diffCounts(oldText, newText) : { additions: after ? newText.split('\n').length : 0, deletions: before ? oldText.split('\n').length : 0 };
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.oid ?? null,
    });
  }
  return changes;
}

/**
 * A three-way tree merge at file granularity: for each path, the side that changed it relative to
 * the base wins; both sides changing it differently is a conflict. Returns the merged tree oid.
 */
export function mergeTrees(store: Store, baseTree: string | null, oursTree: string | null, theirsTree: string | null): string | null {
  const base = baseTree !== null ? flattenTree(store, baseTree) : new Map<string, { oid: string; mode: string }>();
  const ours = oursTree !== null ? flattenTree(store, oursTree) : new Map<string, { oid: string; mode: string }>();
  const theirs = theirsTree !== null ? flattenTree(store, theirsTree) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o?.oid === t?.oid) {
      if (o) result.set(path, o);
    } else if (b?.oid === o?.oid) {
      if (t) result.set(path, t);
    } else if (b?.oid === t?.oid) {
      if (o) result.set(path, o);
    } else {
      return null; // both sides changed the same path differently
    }
  }
  // Rebuild nested trees from the flat map, deepest paths first via writeTreePath on an empty tree.
  let root: string | null = null;
  for (const path of [...result.keys()].sort()) {
    const entry = result.get(path)!;
    root = writeTreePath(store, root, path.split('/'), entry.oid, entry.mode);
  }
  if (root === null) root = store.put('tree', Buffer.alloc(0));
  return root;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>(); // key: repo name (the owner is always the viewer)
  readonly reposById = new Map<number, RepoRec>();
  private seq = 0;
  private nextRepoId = 1;
  private nextRecordId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  readonly baseTimeMs: number;

  constructor() {
    const parsed = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
    this.baseTimeMs = Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00.000Z');
  }

  /** The next deterministic sequence number (timestamps and ordering derive from it). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO timestamp for a sequence number: the trial's opening time plus one second per tick. */
  isoOf(seq: number): string {
    return new Date(this.baseTimeMs + seq * 1000).toISOString();
  }

  /** The git author/committer line for a server-made commit at a sequence number. */
  identityLine(seq: number): string {
    const unix = Math.floor(this.baseTimeMs / 1000) + seq;
    return `${VIEWER.name} <${VIEWER.email}> ${unix} +0000`;
  }

  allocRecordId(): number {
    const id = this.nextRecordId;
    this.nextRecordId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  // ------------------------------------------------------------------ repositories

  createRepo(input: { name: string; description?: string; isPrivate?: boolean; autoInit?: boolean }): RepoRec {
    const name = input.name;
    if (typeof name !== 'string' || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw new HttpError(422, 'Repository creation failed: the name is invalid');
    }
    if (this.repos.has(name)) {
      throw new HttpError(422, 'Repository creation failed: name already exists on this account');
    }
    const repo = new RepoRec(this.nextRepoId, name, input.description ?? '', input.isPrivate ?? false, this.tick());
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    if (input.autoInit) {
      const blob = repo.store.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
      const tree = writeTreePath(repo.store, null, ['README.md'], blob);
      const seq = this.tick();
      const commit = repo.store.put(
        'commit',
        buildCommit({ tree, parents: [], author: this.identityLine(seq), committer: this.identityLine(seq), message: 'Initial commit\n' }),
      );
      repo.refs.set(`refs/heads/${DEFAULT_BRANCH}`, commit);
    }
    return repo;
  }

  /** Look a repo up by owner + name; any owner but the viewer's is a 404, as is an unknown name. */
  repo(owner: string, name: string): RepoRec {
    if (owner !== VIEWER.login) throw new HttpError(404, 'Not Found');
    const repo = this.repos.get(name);
    if (!repo) throw new HttpError(404, 'Not Found');
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name);
    this.reposById.delete(repo.id);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------------ commits via the API

  /** Commit a new tree onto a branch (created from the default branch's tip when missing). */
  commitOnBranch(repo: RepoRec, branch: string, tree: string, message: string): string {
    const existing = repo.tipOf(branch);
    const parent = existing ?? (branch === DEFAULT_BRANCH ? null : repo.headTip());
    const seq = this.tick();
    const line = this.identityLine(seq);
    const commit = repo.store.put(
      'commit',
      buildCommit({ tree, parents: parent !== null ? [parent] : [], author: line, committer: line, message }),
    );
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }

  /** Resolve a ref-ish (branch name, full ref, tag name, or commit oid) to a commit oid, or null. */
  resolveCommit(repo: RepoRec, ref: string): string | null {
    if (ref === 'HEAD') return repo.headTip();
    const branchTip = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
    if (branchTip !== undefined) return branchTip;
    const tagTip = repo.refs.get(`refs/tags/${ref}`);
    if (tagTip !== undefined) return this.peelToCommit(repo, tagTip);
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.store.get(ref);
      if (object?.type === 'commit') return ref;
      if (object?.type === 'tag') return this.peelToCommit(repo, ref);
    }
    return null;
  }

  peelToCommit(repo: RepoRec, oid: string): string | null {
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

  commitTree(repo: RepoRec, commitOid: string): string | null {
    const object = repo.store.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // ------------------------------------------------------------------ contents

  /** Read a path at a ref: a file view, a directory listing, or null when absent. */
  contentsAt(repo: RepoRec, path: string, ref: string | null): { kind: 'file'; oid: string; mode: string; size: number } | { kind: 'dir'; treeOid: string } | null {
    const commitOid = ref !== null ? this.resolveCommit(repo, ref) : repo.headTip();
    if (commitOid === null) return null;
    const rootTree = this.commitTree(repo, commitOid);
    if (rootTree === null) return null;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') return { kind: 'dir', treeOid: rootTree };
    const parts = clean.split('/');
    const parentTree = subtreeAt(repo.store, rootTree, parts.slice(0, -1));
    if (parentTree === null) return null;
    const tree = repo.store.get(parentTree);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[parts.length - 1]);
    if (!entry) return null;
    if (entry.mode === '40000' || entry.mode === '040000') return { kind: 'dir', treeOid: entry.oid };
    const blob = repo.store.get(entry.oid);
    return { kind: 'file', oid: entry.oid, mode: entry.mode, size: blob?.data.length ?? 0 };
  }

  /** Create or update a file through the contents API; returns the new commit and blob oids. */
  putContents(
    repo: RepoRec,
    path: string,
    input: { content: Buffer; message: string; branch?: string; sha?: string },
  ): { commit: string; blob: string; created: boolean } {
    const branch = input.branch ?? DEFAULT_BRANCH;
    const clean = path.replace(/^\/+/, '');
    if (clean === '' || clean.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new HttpError(422, 'Invalid path');
    }
    const tip = repo.tipOf(branch) ?? (branch === DEFAULT_BRANCH ? null : repo.headTip());
    const baseTree = tip !== null ? this.commitTree(repo, tip) : null;
    const flat = baseTree !== null ? flattenTree(repo.store, baseTree) : new Map<string, { oid: string; mode: string }>();
    const existing = flat.get(clean);
    if (existing) {
      if (input.sha === undefined) throw new HttpError(422, 'sha is required when updating an existing file');
      if (input.sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current file sha');
    } else if (input.sha !== undefined) {
      throw new HttpError(422, 'sha was supplied for a file that does not exist');
    }
    const blob = repo.store.put('blob', input.content);
    const tree = writeTreePath(repo.store, baseTree, clean.split('/'), blob);
    const commit = this.commitOnBranch(repo, branch, tree, input.message);
    return { commit, blob, created: !existing };
  }

  deleteContents(repo: RepoRec, path: string, input: { message: string; branch?: string; sha: string }): { commit: string } {
    const branch = input.branch ?? DEFAULT_BRANCH;
    const clean = path.replace(/^\/+/, '');
    const tip = repo.tipOf(branch);
    if (tip === null) throw new HttpError(404, 'Not Found');
    const baseTree = this.commitTree(repo, tip);
    const flat = baseTree !== null ? flattenTree(repo.store, baseTree) : new Map<string, { oid: string; mode: string }>();
    const existing = flat.get(clean);
    if (!existing) throw new HttpError(404, 'Not Found');
    if (input.sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current file sha');
    const tree = writeTreePath(repo.store, baseTree, clean.split('/'), null);
    const commit = this.commitOnBranch(repo, branch, tree, input.message);
    return { commit };
  }

  // ------------------------------------------------------------------ labels, issues, comments

  createLabel(repo: RepoRec, input: { name: string; color?: string; description?: string }): LabelRec {
    if (typeof input.name !== 'string' || input.name === '') throw new HttpError(422, 'Label name is required');
    if (repo.labels.has(input.name)) throw new HttpError(422, 'Label already exists');
    const label: LabelRec = {
      id: this.allocLabelId(),
      name: input.name,
      color: (input.color ?? 'ededed').replace(/^#/, '').toLowerCase(),
      description: input.description ?? '',
    };
    repo.labels.set(label.name, label);
    return label;
  }

  private validateLabels(repo: RepoRec, names: readonly string[]): void {
    for (const name of names) {
      if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist in this repository`);
    }
  }

  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: readonly string[] }): IssueRec {
    if (typeof input.title !== 'string' || input.title === '') throw new HttpError(422, 'Title is required');
    const labels = input.labels ?? [];
    this.validateLabels(repo, labels);
    const seq = this.tick();
    const issue: IssueRec = {
      number: repo.nextNumber,
      id: this.allocRecordId(),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.allocCommentId(), body, seq: this.tick() };
    issue.comments.push(comment);
    issue.updatedSeq = comment.seq;
    void repo;
    return comment;
  }

  // ------------------------------------------------------------------ pull requests

  createPull(repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
    if (typeof input.title !== 'string' || input.title === '') throw new HttpError(422, 'Title is required');
    const stripLabel = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
    const head = stripLabel(input.head ?? '');
    const base = stripLabel(input.base ?? '');
    const headTip = repo.tipOf(head);
    const baseTip = repo.tipOf(base);
    if (baseTip === null) throw new HttpError(422, `Base branch "${base}" does not exist`);
    if (headTip === null) throw new HttpError(422, `Head branch "${head}" does not exist`);
    if (headTip === baseTip) throw new HttpError(422, 'No commits between base and head');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        throw new HttpError(422, 'A pull request already exists for this head and base');
      }
    }
    const seq = this.tick();
    const pull: PullRec = {
      number: repo.nextNumber,
      id: this.allocRecordId(),
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headShaAtCreate: headTip,
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The merge-base tree and head tree a PR's file diff compares. */
  pullTrees(repo: RepoRec, pull: PullRec): { baseTree: string | null; headTree: string | null } {
    const headTip = repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
    const baseTip = repo.tipOf(pull.baseRef);
    const base = baseTip !== null ? mergeBase(repo.store, baseTip, headTip) : null;
    return {
      baseTree: base !== null ? this.commitTree(repo, base) : null,
      headTree: this.commitTree(repo, headTip),
    };
  }

  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const { baseTree, headTree } = this.pullTrees(repo, pull);
    return diffTrees(repo.store, baseTree, headTree);
  }

  /** Dry-run the three-way merge: the merged tree oid, or null when the PR conflicts. */
  mergedTreeFor(repo: RepoRec, pull: PullRec): string | null {
    const headTip = repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
    const baseTip = repo.tipOf(pull.baseRef);
    if (baseTip === null) return null;
    const base = mergeBase(repo.store, baseTip, headTip);
    if (base === null) return null;
    if (base === headTip) return this.commitTree(repo, baseTip); // head already contained in base
    return mergeTrees(repo.store, this.commitTree(repo, base), this.commitTree(repo, baseTip), this.commitTree(repo, headTip));
  }

  mergeableState(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergedTreeFor(repo, pull) !== null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** Merge a PR with the squash method (or a true merge commit for method 'merge'). */
  mergePull(repo: RepoRec, pull: PullRec, method: string): { sha: string } {
    if (pull.merged) throw new HttpError(405, 'Pull Request is not mergeable: it has already been merged');
    if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable: it is closed');
    const headTip = repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
    const baseTip = repo.tipOf(pull.baseRef);
    if (baseTip === null) throw new HttpError(405, 'Pull Request is not mergeable: the base branch is gone');
    const base = mergeBase(repo.store, baseTip, headTip);
    if (base === null || base === headTip) throw new HttpError(405, 'Pull Request is not mergeable: no changes to merge');
    const mergedTree = mergeTrees(repo.store, this.commitTree(repo, base), this.commitTree(repo, baseTip), this.commitTree(repo, headTip));
    if (mergedTree === null) throw new HttpError(405, 'Pull Request is not mergeable: conflicts must be resolved first');
    const seq = this.tick();
    const line = this.identityLine(seq);
    let commit: string;
    if (method === 'merge') {
      commit = repo.store.put(
        'commit',
        buildCommit({
          tree: mergedTree,
          parents: [baseTip, headTip],
          author: line,
          committer: line,
          message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
        }),
      );
    } else {
      // squash (and the fallback for any other method): one parent, the merged tree, the PR's title.
      commit = repo.store.put(
        'commit',
        buildCommit({
          tree: mergedTree,
          parents: [baseTip],
          author: line,
          committer: line,
          message: `${pull.title} (#${pull.number})\n${pull.body ? `\n${pull.body}\n` : ''}`,
        }),
      );
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedSeq = seq;
    pull.mergeCommitSha = commit;
    pull.updatedSeq = seq;
    return { sha: commit };
  }

  // ------------------------------------------------------------------ views (REST shapes)

  userView(): Record<string, unknown> {
    return {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('User', String(VIEWER.id)),
      type: 'User',
      name: VIEWER.name,
      email: VIEWER.email,
      site_admin: false,
    };
  }

  repoView(repo: RepoRec): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: globalId('Repository', String(repo.id)),
      name: repo.name,
      full_name: repo.fullName,
      private: repo.isPrivate,
      owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      description: repo.description,
      fork: false,
      html_url: `https://forge.invalid/${repo.fullName}`,
      clone_url: `https://forge.invalid/${repo.fullName}.git`,
      created_at: this.isoOf(repo.seq),
      updated_at: this.isoOf(repo.seq),
      pushed_at: this.isoOf(repo.seq),
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      forks_count: 0,
      open_issues_count: [...repo.issues.values(), ...repo.pulls.values()].filter((entry) => entry.state === 'open').length,
      default_branch: DEFAULT_BRANCH,
      visibility: repo.isPrivate ? 'private' : 'public',
      archived: false,
      disabled: false,
    };
  }

  labelView(label: LabelRec): Record<string, unknown> {
    return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
  }

  issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: globalId('Issue', `${repo.id}:${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return label ? this.labelView(label) : { name };
      }),
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      comments: issue.comments.length,
      created_at: this.isoOf(issue.seq),
      updated_at: this.isoOf(issue.updatedSeq),
      closed_at: issue.state === 'closed' ? this.isoOf(issue.updatedSeq) : null,
      html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
    };
  }

  commentView(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: globalId('IssueComment', String(comment.id)),
      body: comment.body,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: this.isoOf(comment.seq),
      updated_at: this.isoOf(comment.seq),
      html_url: `https://forge.invalid/${repo.fullName}/issues#issuecomment-${comment.id}`,
    };
  }

  pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
    const headSha = repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
    const baseSha = repo.tipOf(pull.baseRef) ?? ZERO_OID;
    const mergeable = pull.state === 'open' ? this.mergeableState(repo, pull) === 'MERGEABLE' : null;
    return {
      id: pull.id,
      node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedSeq !== null ? this.isoOf(pull.mergedSeq) : null,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable,
      mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
      draft: false,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
      created_at: this.isoOf(pull.seq),
      updated_at: this.isoOf(pull.updatedSeq),
      closed_at: pull.state === 'closed' ? this.isoOf(pull.updatedSeq) : null,
      html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
    };
  }

  commitView(repo: RepoRec, oid: string): Record<string, unknown> | null {
    const object: GitObject | undefined = repo.store.get(oid);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const identity = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
      if (!match) return { name: '', email: '', date: this.isoOf(0) };
      return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
    };
    return {
      sha: oid,
      node_id: globalId('Commit', oid),
      commit: {
        author: identity(commit.authorLine),
        committer: identity(commit.committerLine),
        message: commit.message,
        tree: { sha: commit.tree },
        comment_count: 0,
      },
      author: commit.authorEmail === VIEWER.email ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
      committer: commit.authorEmail === VIEWER.email ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  }
}

/** GitHub-style opaque global ids: base64 of "<Type>:<key>". Stable, and never the plain number. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and key, or null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split <= 0) return null;
    return { type: decoded.slice(0, split), key: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}

export { ZERO_OID, listCommits, commitClosure, isAncestor, oidOf };
