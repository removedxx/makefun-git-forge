// graphql.ts — a small GraphQL engine (lexer, parser, executor) plus the GitHub-flavoured schema
// the suite's documents use: viewer, repository with issue/pull-request connections and cursor
// pagination, node() by opaque global id, the five mutations, and __type introspection. It is not
// a general GraphQL server; it executes exactly the document shapes gh and github-mcp-server send
// (named operations, variables, aliases, inline and named fragments, input objects, batching).

import { Forge, HttpError, VIEWER, globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec } from './forge.ts';

// --------------------------------------------------------------------------- lexer / parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: FieldNode[] | null;
  /** Set only on the synthetic '__inlineFragment' node: the fragment's type condition. */
  typeCondition?: string | null;
}

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: FieldNode[];
}

interface FragmentNode {
  typeCondition: string | null;
  selectionSet: FieldNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
    } else if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
    } else if ('{}()[]:@$=!|'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
    } else if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
      } else {
        let cursor = index + 1;
        let value = '';
        while (cursor < source.length && source[cursor] !== '"') {
          if (source[cursor] === '\\') {
            const escaped = source[cursor + 1]!;
            value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
            cursor += 2;
          } else {
            value += source[cursor];
            cursor += 1;
          }
        }
        if (cursor >= source.length) throw new Error('unterminated string');
        tokens.push({ kind: 'string', value });
        index = cursor + 1;
      }
    } else if (/[0-9-]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[0-9.eE+-]/.test(source[cursor]!)) cursor += 1;
      tokens.push({ kind: 'number', value: source.slice(index, cursor) });
      index = cursor;
    } else if (/[_A-Za-z]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[_0-9A-Za-z]/.test(source[cursor]!)) cursor += 1;
      tokens.push({ kind: 'name', value: source.slice(index, cursor) });
      index = cursor;
    } else {
      throw new Error(`unexpected character ${JSON.stringify(char)}`);
    }
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;

  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.position]!;
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.position]!;
    this.position += 1;
    return token;
  }

  private expect(kind: string, value?: string): string {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, found ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expect('name');
        this.expect('name', 'on');
        const typeCondition = this.expect('name');
        this.parseDirectives();
        fragments.set(fragmentName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      this.expect('name');
      this.expect('punct', ':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.parseDirectives();
    }
    this.expect('punct', ')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.atPunct('!')) this.next();
  }

  private parseDirectives(): FieldNode['directives'] {
    const directives: FieldNode['directives'] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expect('name');
      const args = this.atPunct('(') ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): FieldNode['args'] {
    const args: FieldNode['args'] = [];
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      const name = this.expect('name');
      this.expect('punct', ':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect('punct', ')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'var', name: this.expect('name') };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'lit', value: token.value };
    }
    if (token.kind === 'number') {
      this.next();
      return { kind: 'lit', value: token.value.includes('.') || token.value.includes('e') || token.value.includes('E') ? Number.parseFloat(token.value) : Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'lit', value: true };
      if (token.value === 'false') return { kind: 'lit', value: false };
      if (token.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: token.value }; // an enum literal reads as its name
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expect('name');
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('punct', '{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) fields.push(this.parseSelection());
    this.expect('punct', '}');
    return fields;
  }

  private parseSelection(): FieldNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name');
        const directives = this.parseDirectives();
        return {
          alias: null,
          name: '__inlineFragment',
          args: [],
          directives,
          selectionSet: this.parseSelectionSet(),
          typeCondition,
        };
      }
      const name = this.expect('name');
      const directives = this.parseDirectives();
      return { alias: null, name: `__fragment:${name}`, args: [], directives, selectionSet: null };
    }
    let name = this.expect('name');
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expect('name');
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, directives, selectionSet };
  }
}

// --------------------------------------------------------------------------- execution

const INTERNAL = Symbol('graphql-internal');

interface View {
  __type: string;
  [INTERNAL]: unknown;
}

function view(type: string, internal: unknown): View {
  return { __type: type, [INTERNAL]: internal };
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: string[] }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'lit':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx.variables);
  return out;
}

function directiveAllows(field: FieldNode, ctx: ExecContext): boolean {
  for (const directive of field.directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = evalValue(arg.value, ctx.variables);
    if (directive.name === 'include' && args.if === false) return false;
    if (directive.name === 'skip' && args.if === true) return false;
  }
  return true;
}

type Resolver = (source: View, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function connection(items: readonly unknown[], args: Record<string, unknown>): View {
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
  const payload = {
    nodes: slice,
    edges: slice.map((node, offset) => view('Edge', { node, cursor: cursorOf(start + offset) })),
    pageInfo: view('PageInfo', {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    }),
    totalCount: items.length,
  };
  return view('Connection', payload);
}

// --------------------------------------------------------------------------- schema views

function userView(): View {
  return view('User', { login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, databaseId: VIEWER.id });
}

function repoView(forge: Forge, repo: RepoRec): View {
  void forge;
  return view('Repository', repo);
}

function issueView(repo: RepoRec, issue: IssueRec): View {
  return view('Issue', { repo, issue });
}

function pullView(repo: RepoRec, pull: PullRec): View {
  return view('PullRequest', { repo, pull });
}

function commentView(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; seq: number }): View {
  return view('IssueComment', { repo, issue, comment });
}

function findIssueByGlobalId(forge: Forge, key: string): { repo: RepoRec; issue: IssueRec } | null {
  const [repoIdText, numberText] = key.split(':');
  const repo = forge.reposById.get(Number(repoIdText));
  if (!repo) return null;
  const issue = repo.issues.get(Number(numberText));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(forge: Forge, key: string): { repo: RepoRec; pull: PullRec } | null {
  const [repoIdText, numberText] = key.split(':');
  const repo = forge.reposById.get(Number(repoIdText));
  if (!repo) return null;
  const pull = repo.pulls.get(Number(numberText));
  return pull ? { repo, pull } : null;
}

function nodeById(forge: Forge, id: string): View | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  switch (parsed.type) {
    case 'Repository': {
      const repo = forge.reposById.get(Number(parsed.key));
      return repo ? repoView(forge, repo) : null;
    }
    case 'Issue': {
      const found = findIssueByGlobalId(forge, parsed.key);
      return found ? issueView(found.repo, found.issue) : null;
    }
    case 'PullRequest': {
      const found = findPullByGlobalId(forge, parsed.key);
      return found ? pullView(found.repo, found.pull) : null;
    }
    case 'IssueComment': {
      for (const repo of forge.repos.values()) {
        for (const issue of repo.issues.values()) {
          const comment = issue.comments.find((candidate) => candidate.id === Number(parsed.key));
          if (comment) return commentView(repo, issue, comment);
        }
      }
      return null;
    }
    case 'User':
      return userView();
    default:
      return null;
  }
}

// --------------------------------------------------------------------------- introspection

const TYPE_TABLE: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt', 'isViewer'] },
  RepositoryOwner: { kind: 'OBJECT', fields: ['id', 'login', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
      'description', 'isPrivate', 'isFork', 'isArchived', 'url', 'createdAt', 'updatedAt', 'pushedAt',
      'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'author', 'repository',
      'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'viewerCanUpdate',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
      'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'author',
      'repository', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'isDraft', 'url', 'additions', 'deletions',
    ],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  Permission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeView(name: string): View | null {
  const entry = TYPE_TABLE[name];
  if (!entry) return null;
  return view('__Type', {
    name,
    kind: entry.kind,
    fields: (entry.fields ?? []).map((fieldName) => view('__Field', { name: fieldName })),
    enumValues: (entry.enumValues ?? []).map((valueName) => view('__EnumValue', { name: valueName })),
  });
}

// --------------------------------------------------------------------------- resolvers

const prop =
  (key: string): Resolver =>
  (source) =>
    (source[INTERNAL] as Record<string, unknown>)[key];

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userView(),
    repository: (source, args, ctx) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      if (args.owner !== VIEWER.login) return null;
      const repo = ctx.forge.repos.get(args.name);
      return repo ? repoView(ctx.forge, repo) : null;
    },
    node: (source, args, ctx) => (typeof args.id === 'string' ? nodeById(ctx.forge, args.id) : null),
    nodes: (source, args, ctx) => (Array.isArray(args.ids) ? args.ids.map((id) => (typeof id === 'string' ? nodeById(ctx.forge, id) : null)) : []),
    user: (source, args) => (args.login === VIEWER.login ? userView() : null),
    __type: (source, args) => (typeof args.name === 'string' ? typeView(args.name) : null),
    __schema: () =>
      view('__Schema', {
        queryType: view('__Type', { name: 'Query', kind: 'OBJECT', fields: [], enumValues: [] }),
        mutationType: view('__Type', { name: 'Mutation', kind: 'OBJECT', fields: [], enumValues: [] }),
        types: Object.keys(TYPE_TABLE).map((name) => typeView(name)),
      }),
  },
  User: {
    id: () => globalId('User', String(VIEWER.id)),
    databaseId: prop('databaseId'),
    login: prop('login'),
    name: prop('name'),
    email: prop('email'),
    url: () => 'https://forge.invalid/adaiversen',
    isViewer: () => true,
    createdAt: (source, args, ctx) => ctx.forge.isoOf(0),
    updatedAt: (source, args, ctx) => ctx.forge.isoOf(0),
  },
  Repository: {
    id: (source) => globalId('Repository', String((source[INTERNAL] as RepoRec).id)),
    databaseId: (source) => (source[INTERNAL] as RepoRec).id,
    name: (source) => (source[INTERNAL] as RepoRec).name,
    nameWithOwner: (source) => (source[INTERNAL] as RepoRec).fullName,
    description: (source) => (source[INTERNAL] as RepoRec).description,
    isPrivate: (source) => (source[INTERNAL] as RepoRec).isPrivate,
    isFork: () => false,
    isArchived: () => false,
    owner: () => userView(),
    url: (source) => `https://forge.invalid/${(source[INTERNAL] as RepoRec).fullName}`,
    createdAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as RepoRec).seq),
    updatedAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as RepoRec).seq),
    pushedAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as RepoRec).seq),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    stargazerCount: () => 0,
    forkCount: () => 0,
    primaryLanguage: () => null,
    licenseInfo: () => null,
    defaultBranchRef: (source, args, ctx) => {
      const repo = source[INTERNAL] as RepoRec;
      void ctx;
      return repo.headTip() !== null ? view('Ref', { name: 'main', prefix: 'refs/heads/' }) : null;
    },
    issue: (source, args) => {
      const repo = source[INTERNAL] as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? issueView(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = source[INTERNAL] as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return connection(issues.map((issue) => issueView(repo, issue)), args);
    },
    pullRequest: (source, args) => {
      const repo = source[INTERNAL] as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? pullView(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = source[INTERNAL] as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null && states.length > 0) {
        pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      pulls.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return connection(pulls.map((pull) => pullView(repo, pull)), args);
    },
  },
  Issue: {
    id: (source) => {
      const { repo, issue } = source[INTERNAL] as { repo: RepoRec; issue: IssueRec };
      return globalId('Issue', `${repo.id}:${issue.number}`);
    },
    databaseId: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.id,
    number: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.number,
    title: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.title,
    body: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.body,
    state: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.state.toUpperCase(),
    closed: (source) => (source[INTERNAL] as { issue: IssueRec }).issue.state === 'closed',
    author: () => userView(),
    repository: (source, args, ctx) => repoView(ctx.forge, (source[INTERNAL] as { repo: RepoRec }).repo),
    createdAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { issue: IssueRec }).issue.seq),
    updatedAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { issue: IssueRec }).issue.updatedSeq),
    closedAt: (source, args, ctx) => {
      const { issue } = source[INTERNAL] as { issue: IssueRec };
      return issue.state === 'closed' ? ctx.forge.isoOf(issue.updatedSeq) : null;
    },
    url: (source) => {
      const { repo, issue } = source[INTERNAL] as { repo: RepoRec; issue: IssueRec };
      return `https://forge.invalid/${repo.fullName}/issues/${issue.number}`;
    },
    viewerCanUpdate: () => true,
    labels: (source, args) => {
      const { repo, issue } = source[INTERNAL] as { repo: RepoRec; issue: IssueRec };
      const labels = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => view('Label', { name: label!.name, color: label!.color, description: label!.description, id: label!.id }));
      return connection(labels, args);
    },
    comments: (source, args) => {
      const { repo, issue } = source[INTERNAL] as { repo: RepoRec; issue: IssueRec };
      return connection(issue.comments.map((comment) => commentView(repo, issue, comment)), args);
    },
  },
  PullRequest: {
    id: (source) => {
      const { repo, pull } = source[INTERNAL] as { repo: RepoRec; pull: PullRec };
      return globalId('PullRequest', `${repo.id}:${pull.number}`);
    },
    databaseId: (source) => (source[INTERNAL] as { pull: PullRec }).pull.id,
    number: (source) => (source[INTERNAL] as { pull: PullRec }).pull.number,
    title: (source) => (source[INTERNAL] as { pull: PullRec }).pull.title,
    body: (source) => (source[INTERNAL] as { pull: PullRec }).pull.body,
    state: (source) => {
      const { pull } = source[INTERNAL] as { pull: PullRec };
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source[INTERNAL] as { pull: PullRec }).pull.merged,
    mergedAt: (source, args, ctx) => {
      const { pull } = source[INTERNAL] as { pull: PullRec };
      return pull.mergedSeq !== null ? ctx.forge.isoOf(pull.mergedSeq) : null;
    },
    mergeCommit: (source) => {
      const { pull } = source[INTERNAL] as { pull: PullRec };
      return pull.mergeCommitSha !== null ? view('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    headRefName: (source) => (source[INTERNAL] as { pull: PullRec }).pull.headRef,
    baseRefName: (source) => (source[INTERNAL] as { pull: PullRec }).pull.baseRef,
    headRefOid: (source) => {
      const { repo, pull } = source[INTERNAL] as { repo: RepoRec; pull: PullRec };
      return repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
    },
    baseRefOid: (source) => {
      const { repo, pull } = source[INTERNAL] as { repo: RepoRec; pull: PullRec };
      return repo.tipOf(pull.baseRef);
    },
    mergeable: (source, args, ctx) => ctx.forge.mergeableState((source[INTERNAL] as { repo: RepoRec }).repo, (source[INTERNAL] as { pull: PullRec }).pull),
    author: () => userView(),
    repository: (source, args, ctx) => repoView(ctx.forge, (source[INTERNAL] as { repo: RepoRec }).repo),
    createdAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { pull: PullRec }).pull.seq),
    updatedAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { pull: PullRec }).pull.updatedSeq),
    closedAt: (source, args, ctx) => {
      const { pull } = source[INTERNAL] as { pull: PullRec };
      return pull.state === 'closed' ? ctx.forge.isoOf(pull.updatedSeq) : null;
    },
    closed: (source) => (source[INTERNAL] as { pull: PullRec }).pull.state === 'closed',
    isDraft: () => false,
    url: (source) => {
      const { repo, pull } = source[INTERNAL] as { repo: RepoRec; pull: PullRec };
      return `https://forge.invalid/${repo.fullName}/pull/${pull.number}`;
    },
    additions: (source, args, ctx) => ctx.forge.pullFiles((source[INTERNAL] as { repo: RepoRec }).repo, (source[INTERNAL] as { pull: PullRec }).pull).reduce((sum, file) => sum + file.additions, 0),
    deletions: (source, args, ctx) => ctx.forge.pullFiles((source[INTERNAL] as { repo: RepoRec }).repo, (source[INTERNAL] as { pull: PullRec }).pull).reduce((sum, file) => sum + file.deletions, 0),
    files: (source, args, ctx) => {
      const { repo, pull } = source[INTERNAL] as { repo: RepoRec; pull: PullRec };
      const files = ctx.forge.pullFiles(repo, pull).map((file) =>
        view('PullRequestFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
      );
      return connection(files, args);
    },
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', String((source[INTERNAL] as { comment: { id: number } }).comment.id)),
    databaseId: (source) => (source[INTERNAL] as { comment: { id: number } }).comment.id,
    body: (source) => (source[INTERNAL] as { comment: { body: string } }).comment.body,
    author: () => userView(),
    createdAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { comment: { seq: number } }).comment.seq),
    updatedAt: (source, args, ctx) => ctx.forge.isoOf((source[INTERNAL] as { comment: { seq: number } }).comment.seq),
    url: (source) => {
      const { repo, comment } = source[INTERNAL] as { repo: RepoRec; comment: { id: number } };
      return `https://forge.invalid/${repo.fullName}/issues#issuecomment-${comment.id}`;
    },
  },
  Label: { id: (source) => globalId('Label', String((source[INTERNAL] as { id: number }).id)), name: prop('name'), color: prop('color'), description: prop('description') },
  Ref: { id: () => globalId('Ref', 'refs/heads/main'), name: prop('name'), prefix: prop('prefix') },
  Commit: { id: (source) => globalId('Commit', (source[INTERNAL] as { oid: string }).oid), oid: prop('oid'), message: () => '' },
  PullRequestFile: { path: prop('path'), additions: prop('additions'), deletions: prop('deletions'), changeType: prop('changeType') },
  PageInfo: { hasNextPage: prop('hasNextPage'), hasPreviousPage: prop('hasPreviousPage'), startCursor: prop('startCursor'), endCursor: prop('endCursor') },
  Connection: { nodes: prop('nodes'), edges: prop('edges'), pageInfo: prop('pageInfo'), totalCount: prop('totalCount') },
  Edge: { node: prop('node'), cursor: prop('cursor') },
  __Type: { name: prop('name'), kind: prop('kind'), fields: prop('fields'), enumValues: prop('enumValues') },
  __Field: { name: prop('name') },
  __EnumValue: { name: prop('name') },
  __Schema: { queryType: prop('queryType'), mutationType: prop('mutationType'), types: prop('types'), subscriptionType: () => null },
  CreateIssuePayload: { issue: prop('issue') },
  CloseIssuePayload: { issue: prop('issue') },
  CreatePullRequestPayload: { pullRequest: prop('pullRequest') },
  MergePullRequestPayload: { pullRequest: prop('pullRequest') },
  AddCommentPayload: { commentEdge: prop('commentEdge'), subject: prop('subject') },
};

const MUTATIONS: Record<string, (ctx: ExecContext, input: Record<string, unknown>) => View> = {
  createIssue: (ctx, input) => {
    const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
    const repo = parsed?.type === 'Repository' ? ctx.forge.reposById.get(Number(parsed.key)) : undefined;
    if (!repo) throw new Error('repository not found for createIssue');
    const issue = ctx.forge.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
    return view('CreateIssuePayload', { issue: issueView(repo, issue) });
  },
  closeIssue: (ctx, input) => {
    const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
    const found = parsed?.type === 'Issue' ? findIssueByGlobalId(ctx.forge, parsed.key) : null;
    if (!found) throw new Error('issue not found for closeIssue');
    found.issue.state = 'closed';
    found.issue.updatedSeq = ctx.forge.tick();
    return view('CloseIssuePayload', { issue: issueView(found.repo, found.issue) });
  },
  createPullRequest: (ctx, input) => {
    const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
    const repo = parsed?.type === 'Repository' ? ctx.forge.reposById.get(Number(parsed.key)) : undefined;
    if (!repo) throw new Error('repository not found for createPullRequest');
    const pull = ctx.forge.createPull(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    return view('CreatePullRequestPayload', { pullRequest: pullView(repo, pull) });
  },
  mergePullRequest: (ctx, input) => {
    const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
    const found = parsed?.type === 'PullRequest' ? findPullByGlobalId(ctx.forge, parsed.key) : null;
    if (!found) throw new Error('pull request not found for mergePullRequest');
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
    ctx.forge.mergePull(found.repo, found.pull, method);
    return view('MergePullRequestPayload', { pullRequest: pullView(found.repo, found.pull) });
  },
  addComment: (ctx, input) => {
    const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
    const found = parsed?.type === 'Issue' ? findIssueByGlobalId(ctx.forge, parsed.key) : null;
    if (!found) throw new Error('subject not found for addComment');
    const comment = ctx.forge.addComment(found.repo, found.issue, String(input.body ?? ''));
    const node = commentView(found.repo, found.issue, comment);
    return view('AddCommentPayload', { commentEdge: view('Edge', { node, cursor: '' }), subject: issueView(found.repo, found.issue) });
  },
};

RESOLVERS.Mutation = Object.fromEntries(
  Object.entries(MUTATIONS).map(([name, run]) => [
    name,
    (source: View, args: Record<string, unknown>, ctx: ExecContext) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      return run(ctx, input);
    },
  ]),
);

// --------------------------------------------------------------------------- field execution

function typeMatches(condition: string | null, actual: string): boolean {
  if (condition === null) return true;
  if (condition === actual) return true;
  // Interfaces the suite's fragments may name: treat them as matching their implementors.
  if (condition === 'Node' || condition === 'UniformResourceLocatable') return true;
  if (condition === 'RepositoryOwner' && actual === 'User') return true;
  if (condition === 'Actor' && actual === 'User') return true;
  return false;
}

function executeSelectionSet(ctx: ExecContext, source: View, selections: FieldNode[], path: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (!directiveAllows(field, ctx)) continue;
    if (field.name === '__inlineFragment') {
      const condition = (field as FieldNode & { typeCondition?: string }).typeCondition ?? null;
      if (typeMatches(condition, source.__type) && field.selectionSet) {
        Object.assign(out, executeSelectionSet(ctx, source, field.selectionSet, path));
      }
      continue;
    }
    if (field.name.startsWith('__fragment:')) {
      const fragment = ctx.fragments.get(field.name.slice('__fragment:'.length));
      if (fragment && typeMatches(fragment.typeCondition, source.__type)) {
        Object.assign(out, executeSelectionSet(ctx, source, fragment.selectionSet, path));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = executeField(ctx, source, field, [...path, key]);
  }
  return out;
}

function executeField(ctx: ExecContext, source: View, field: FieldNode, path: string[]): unknown {
  if (field.name === '__typename') return source.__type;
  const typeResolvers = RESOLVERS[source.__type];
  const resolver = typeResolvers?.[field.name];
  if (!resolver) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.__type}'`, path });
    return null;
  }
  let value: unknown;
  try {
    value = resolver(source, argsOf(field, ctx), ctx);
  } catch (error) {
    if (error instanceof HttpError) {
      ctx.errors.push({ message: error.message, path });
      return null;
    }
    throw error;
  }
  return completeValue(ctx, value, field, path);
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode, path: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(ctx, item, field, [...path, String(index)]));
  if (typeof value === 'object' && '__type' in value) {
    const child = value as View;
    if (!field.selectionSet) return null;
    return executeSelectionSet(ctx, child, field.selectionSet, path);
  }
  return value;
}

// --------------------------------------------------------------------------- entry point

export interface GraphqlOutcome {
  status: number;
  payload: unknown;
}

/** Execute one GraphQL request body (an object, or an array for a batch) against the forge. */
export function executeGraphql(forge: Forge, body: unknown): GraphqlOutcome {
  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, payload: executeOne(forge, body) };
}

function executeOne(forge: Forge, body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    return { errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const request = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'GraphQL query is missing' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName);
    if (!operation) return { errors: [{ message: `Operation '${request.operationName}' not found` }] };
  } else {
    operation = document.operations[0];
  }
  if (!operation) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  // Mutations resolve against the Mutation type's resolver table; queries against Query's.
  const rootView = view(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, rootView, operation.selectionSet, []);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return payload;
}
