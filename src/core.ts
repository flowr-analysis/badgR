/**
 * The analysis badger runs, independent of where it runs: the command line hands it an analyzer over files
 * on disk with the full signature database, the web page one over files in memory with the package data
 * it loaded. Nothing in here touches the file system or the network.
 */
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import { DfgVertex, VertexType } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { BuiltInProcName } from '@eagleoutice/flowr/dataflow/environments/built-in-proc-name';
import { Dataflow } from '@eagleoutice/flowr/dataflow/graph/df-helper';
import { SlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';
import { ArgProp, CallProp } from '@eagleoutice/flowr/dataflow/environments/built-in-props';
import type { BuiltInIndex } from '@eagleoutice/flowr/dataflow/environments/query-fn-props';
import { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { DfEdge, EdgeType } from '@eagleoutice/flowr/dataflow/graph/edge';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';
import { type CapabilitySpec, type FileRoleName, type Policy, FileRoles, lintRulesOf } from './policy-core';
import type { FileRole } from '@eagleoutice/flowr/project/context/flowr-file';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { type Finding, type LintResult, type LintSummary, type QuickFix, type TierResult, assignTier } from './tiers';

/** the packages of base R: a call into them is the app's own call, never one "inside a package" */
export const BaseRPackages: ReadonlySet<string> = new Set([
	'base', 'stats', 'utils', 'methods', 'graphics', 'grDevices', 'datasets', 'tools', 'parallel',
	'compiler', 'grid', 'splines', 'stats4', 'tcltk'
]);

/** the R files badger analyzes, `.Rprofile` (run at startup) included */
export const RFilePattern = /(\.(R|r|Rmd|rmd|qmd)|(^|\/)\.Rprofile)$/;

/** the files of a package or project flowR reads besides the code: what it imports, exports, and is */
export const MetaFilePattern = /(^|\/)(DESCRIPTION|NAMESPACE)$/;

/** where an analysis is, for progress output */
export type Phase = 'files' | 'dataflow' | 'sinks' | 'origins' | 'lint' | 'tier' | 'done';

export interface Progress {
	readonly phase:   Phase
	/** what is happening, one short line */
	readonly message: string
	/** for steps that count, how far they are */
	readonly done?:   number
	readonly total?:  number
	/** about how long the whole analysis still takes, from when this was sent, in milliseconds */
	readonly etaMs?:  number
	/** about how long the current phase still takes, from when this was sent, in milliseconds */
	readonly phaseEtaMs?: number
}

export type ProgressListener = (p: Progress) => void;

/**
 * The functions a package function calls, transitively, by name, or `undefined` when the package or the
 * function is unknown. The command line asks the signature database, the web page its package data.
 */
export type CalleesOf = (pkg: string, fn: string) => Iterable<string> | undefined;

/** `pkg::fn` (or `pkg:::fn`) split into its parts, or `undefined` for a plain name */
export function splitQualified(name: string): { ns: string, fn: string } | undefined {
	const m = /^([A-Za-z][\w.]*):::?(.+)$/.exec(name);
	return m === null ? undefined : { ns: m[1], fn: m[2] };
}

/**
 * The callees of a package function across packages: the signature data lists a call into another package
 * as `pkg::fn` and stops there, so `readr::write_csv` would hide what `vroom::vroom_write` does. This follows
 * such calls (not into base R or functions the policy trusts, at most `depth` packages deep), so the sinks
 * of the other package count too.
 */
export function acrossPackages(direct: CalleesOf, trusted: (call: string) => boolean = () => false, depth = 6): CalleesOf {
	const cache = new Map<string, readonly string[] | undefined>();
	return (pkg, fn) => {
		const key = `${pkg}::${fn}`;
		if(cache.has(key)) {
			return cache.get(key);
		}
		const first = direct(pkg, fn);
		if(first === undefined) {
			cache.set(key, undefined);
			return undefined;
		}
		const out = new Set<string>();
		const followed = new Set<string>([key]);
		const queue: [string, number][] = [...first].map(c => [String(c), 0]);
		for(let next = queue.shift(); next !== undefined; next = queue.shift()) {
			const [c, d] = next;
			out.add(c);
			const q = splitQualified(c);
			const k = q === undefined ? undefined : `${q.ns}::${q.fn}`;
			if(q === undefined || k === undefined || d >= depth || followed.has(k) || BaseRPackages.has(q.ns) || trusted(k)) {
				continue;
			}
			followed.add(k);
			for(const x of direct(q.ns, q.fn) ?? []) {
				if(!out.has(String(x))) {
					queue.push([String(x), d + 1]);
				}
			}
		}
		const res = [...out];
		cache.set(key, res);
		return res;
	};
}

export interface Report {
	readonly tool:          'badger'
	readonly toolVersion:   string
	readonly flowrVersion:  string
	readonly sigdb:         { readonly tag?: string, readonly present: boolean, readonly scope?: string }
	/** `modified`: the policy is not badger's default policy, so the tier means what that policy says */
	readonly policy:        { readonly name: string, readonly hash: string, readonly source: string, readonly modified?: boolean }
	readonly target:        string
	readonly files:         readonly string[]
	readonly generatedAt:   string
	readonly analyzed:      boolean
	readonly error?:        string
	readonly tier:          TierResult
	readonly findings:      readonly Finding[]
	readonly lint:          readonly LintSummary[]
	/** calls into packages the signature data did not know, so badger could not look inside them */
	readonly unresolvedPackages: readonly string[]
	/** what badger asked flowR, in order: the request as flowR takes it, how long it took, and how much came back */
	readonly queries?:           readonly FlowrQueryRecord[]
	/** set only on a report shown while the analysis still runs: the linting rules not done yet, in the order they run (the first is running); until they are done, the tier is provisional */
	readonly pending?:           readonly string[]
	readonly ms:            number
}

function bitsOf<E extends Record<string, string | number>>(names: readonly string[], e: E, what: string): number {
	let bits = 0;
	for(const n of names) {
		const key = Object.keys(e).find(k => k.toLowerCase() === n.toLowerCase().replace(/[-_]/g, ''));
		if(key === undefined || typeof e[key] !== 'number') {
			throw new Error(`unknown ${what} ${n}`);
		}
		bits |= e[key] as number;
	}
	return bits;
}

interface CompiledCapability {
	readonly name:       string
	readonly spec:       CapabilitySpec
	readonly tags:       ReadonlySet<string>
	readonly callProps:  number
	readonly unlessCall: number
	readonly unlessArg:  number
	readonly functions:  readonly RegExp[]
	readonly exclude:    readonly RegExp[]
}

function compile(policy: Policy): CompiledCapability[] {
	return Object.entries(policy.capabilities).map(([name, spec]) => ({
		name, spec,
		tags:       new Set(spec.tags ?? []),
		callProps:  bitsOf(spec.callProps ?? [], CallProp, 'call property'),
		unlessCall: bitsOf(spec.unlessCallProps ?? [], CallProp, 'call property'),
		unlessArg:  bitsOf(spec.unlessArgProps ?? [], ArgProp, 'argument property'),
		functions:  (spec.functions ?? []).map(r => new RegExp(r)),
		exclude:    (spec.exclude ?? []).map(r => new RegExp(r))
	}));
}

/** a pattern with `::` is matched against `pkg::fn`, any other against `fn` */
function nameMatches(re: RegExp, name: string, qualified: string | undefined): boolean {
	return re.source.includes('::') ? qualified !== undefined && re.test(qualified) : re.test(name);
}

/** the first capability of the policy that the function `name` (in `ns`, if known) has, by name and by what flowR states of it */
function capabilityOf(caps: readonly CompiledCapability[], idx: BuiltInIndex, name: string, ns: string | undefined): CompiledCapability | undefined {
	const qualified = ns === undefined ? undefined : `${ns}::${name}`;
	const entry = (ns === undefined ? undefined : idx.get(Identifier.make(name, ns))) ?? idx.get(Identifier.make(name));
	const tags = new Set<string>(entry?.tags ?? []);
	const props = entry?.props ?? 0;
	const argProps = (entry?.sig ?? []).reduce((acc, [, p]) => acc | p, 0);
	for(const c of caps) {
		if(c.exclude.some(r => nameMatches(r, name, qualified))) {
			continue;
		}
		const byName = c.functions.some(r => nameMatches(r, name, qualified));
		const byTag = [...c.tags].some(t => tags.has(t));
		const byProp = c.callProps !== 0 && (props & c.callProps) !== 0;
		if(!byName && !byTag && !byProp) {
			continue;
		}
		/* the exceptions only narrow what flowR states, a function the policy lists by name keeps its capability */
		if(!byName && ((props & c.unlessCall) !== 0 || (argProps & c.unlessArg) !== 0)) {
			continue;
		}
		return c;
	}
	return undefined;
}

/**
 * Whether the policy could give `name` a capability at all: the names a package's callees are reduced to
 * when the web page's package data is generated. Sound for the policy it is generated with.
 */
export function mayHaveCapability(policy: Policy, idx: BuiltInIndex, name: string): boolean {
	const q = splitQualified(name);
	return capabilityOf(compile(policy), idx, q?.fn ?? name, q?.ns) !== undefined;
}

/** a callee written as a string or in backticks behind `::` (`base::"system"`) is the function of that name */
function unquoted(name: string): string {
	const m = /^(["'`])(.*)\1$/s.exec(name);
	return m === null ? name : m[2];
}

/** data sets of base R's `datasets` package: data, no functions */
const BaseDataSets: ReadonlySet<string> = new Set([
	'mtcars', 'iris', 'airquality', 'ToothGrowth', 'PlantGrowth', 'faithful', 'cars', 'CO2', 'ChickWeight', 'chickwts', 'women',
	'trees', 'USArrests', 'precip', 'quakes', 'esoph', 'warpbreaks', 'sleep', 'swiss', 'attitude', 'stackloss', 'InsectSprays',
	'Titanic', 'airmiles', 'AirPassengers', 'anscombe', 'beaver1', 'beaver2', 'BOD', 'Formaldehyde', 'infert', 'LifeCycleSavings',
	'longley', 'morley', 'Orange', 'OrchardSprays', 'pressure', 'rock', 'state.x77', 'USJudgeRatings', 'Puromycin', 'Loblolly', 'npk'
]);

/** replacement functions after which a function is no longer the definition flowR resolved its calls to */
const Rewrites: ReadonlySet<string> = new Set(['base::body<-', 'base::formals<-', 'base::environment<-', 'body<-', 'formals<-', 'environment<-']);

function originsOf(policy: Policy, types: readonly string[]): string[] {
	const out = new Set<string>();
	for(const t of types) {
		const cls = Object.entries(policy.origins).find(([, ts]) => ts.includes(t))?.[0];
		out.add(cls ?? policy.fallbackOrigin);
	}
	return [...out].sort();
}

interface InputSource { readonly id: NodeId, readonly types: readonly string[] }

export interface CoreResult {
	readonly findings:           Finding[]
	readonly lint:               LintSummary[]
	readonly unresolvedPackages: string[]
	readonly queries:            FlowrQueryRecord[]
}

/** one step badger asked flowR for */
export interface FlowrQueryRecord {
	/** the query type (`input-sources`, `linter`), or `dataflow` and `signature-database` for the steps that are no query */
	readonly type:    string
	/** the request as flowR's query API takes it, so it can be run again in flowR's REPL or playground */
	readonly request: unknown
	readonly ms:      number
	/** what came back, in words */
	readonly result:  string
}

/**
 * Runs linting rules somewhere they can be stopped, a rule over the time limit then counts as not run.
 * It is started before the dataflow graph is built, so the rules run alongside the rest of the analysis.
 * `started` is told when a rule starts, `done` when it ends; it resolves once all are done.
 */
export type LintRunner = (rules: readonly string[], started: (rule: string) => void, done: (r: { summary: LintSummary, query?: FlowrQueryRecord }) => void) => Promise<void>;

/** what a linting worker answers: ready once it has read the code, then one result per rule it is sent */
export type LintMessage =
	| { readonly type: 'lint-ready' }
	| { readonly type: 'lint-failed', readonly error: string }
	| { readonly type: 'lint-done', readonly summary: LintSummary, readonly query?: FlowrQueryRecord };

/** a worker (of the browser or of node) that reads the code once and then runs the rules it is sent, one at a time */
export interface LintEndpoint {
	/** its next answer, or why it failed */
	next(): Promise<LintMessage>
	run(rule: string): void
	terminate(): void
}

/**
 * Runs the linting rules in workers, as flowR's rules run without a break and only a worker can be stopped.
 * A rule over the time limit stops its worker and counts as not run; the next rules go to a fresh worker,
 * which reads the code again. Reading the code does not count against a rule's limit.
 */
export function lintInWorkers(spawn: () => LintEndpoint, limitSeconds: number, readSeconds: number): { runner: LintRunner, stop: () => void } {
	let current: LintEndpoint | undefined;
	let stopped = false;
	const failed = (rule: string, error: string) => ({ summary: { rule, ...ruleDocs(rule), count: 0, results: [], error } });
	const runner: LintRunner = async(rules, started, done) => {
		const queue = [...rules];
		while(queue.length > 0 && !stopped) {
			let w: LintEndpoint;
			try {
				w = current = spawn();
			} catch(e) {
				for(const rule of queue.splice(0)) {
					done(failed(rule, `no linting worker: ${e instanceof Error ? e.message : String(e)}`));
				}
				break;
			}
			let readTimer: ReturnType<typeof setTimeout> | undefined;
			const ready = await Promise.race([w.next(), new Promise<'timeout'>(resolve => {
				readTimer = setTimeout(() => resolve('timeout'), readSeconds * 1000);
			})]);
			clearTimeout(readTimer);
			if(ready === 'timeout' || ready.type !== 'lint-ready') {
				w.terminate();
				const error = ready === 'timeout' ? `the linting worker did not read the code within ${readSeconds} s (lintReadTimeout in the policy)`
					: ready.type === 'lint-failed' ? ready.error : 'the linting worker did not start';
				for(const rule of queue.splice(0)) {
					done(failed(rule, error));
				}
				break;
			}
			while(queue.length > 0 && !stopped) {
				const rule = queue[0];
				started(rule);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const answer = w.next();
				w.run(rule);
				const res = await Promise.race([answer, new Promise<'timeout'>(resolve => {
					timer = setTimeout(() => resolve('timeout'), limitSeconds * 1000);
				})]);
				clearTimeout(timer);
				queue.shift();
				if(res === 'timeout' || res.type !== 'lint-done') {
					w.terminate();
					done(failed(rule, res === 'timeout' ? `stopped after ${limitSeconds} s, the time limit of a linting rule (lintTimeout in the policy)`
						: res.type === 'lint-failed' ? res.error : 'no result'));
					break;
				}
				done({ summary: res.summary, query: res.query });
			}
		}
		current?.terminate();
	};
	return { runner, stop: () => {
		stopped = true;
		current?.terminate();
	} };
}

/** told of the result so far: the findings are final, the linting rules in `pending` still run */
export type PartialListener = (r: CoreResult & { readonly pending: readonly string[] }) => void;

/** yields to the event loop, so a page can repaint its progress between the steps */
const breathe = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Finds the capability calls of everything the analyzer was given, traces their values, and runs the linting rules. */
export async function analyzeWith(analyzer: FlowrAnalyzer, policy: Policy, calleesOf: CalleesOf, progress: ProgressListener = () => {}, onPartial?: PartialListener, lintRunner?: LintRunner): Promise<CoreResult> {
	const trustedCall = policy.trusted.map(r => new RegExp(r));
	calleesOf = acrossPackages(calleesOf, c => trustedCall.some(r => r.test(c)));
	const rules = lintRulesOf(policy);
	const lintDone = new Map<string, LintSummary>();
	const lintQueries: FlowrQueryRecord[] = [];
	let lintCurrent: { rule: string, at: number } | undefined;
	let onLintChange: () => void = () => {};
	const lintWork = lintRunner?.(rules, rule => {
		lintCurrent = { rule, at: Date.now() };
	}, ({ summary, query }) => {
		lintDone.set(summary.rule, summary);
		if(query !== undefined) {
			lintQueries.push(query);
		}
		onLintChange();
	});
	/* the rules not done yet need at most their time limit each; reading the code again after a stopped rule comes on top, so this is an estimate, not a bound */
	const lintBound = () => {
		if(lintRunner === undefined) {
			return undefined;
		}
		const left = rules.filter(r => !lintDone.has(r));
		const running = lintCurrent !== undefined && left.includes(lintCurrent.rule) ? lintCurrent : undefined;
		return left.length * policy.lintTimeout * 1000 - (running ? Math.min(policy.lintTimeout * 1000, Date.now() - running.at) : 0);
	};
	progress({ phase: 'dataflow', message: 'parsing and building the dataflow graph' });
	await breathe();
	const queries: FlowrQueryRecord[] = [];
	let t0 = Date.now();
	const df = await analyzer.dataflow();
	queries.push({ type: 'dataflow', request: { type: 'dataflow' }, ms: Date.now() - t0, result: `a dataflow graph of ${[...df.graph.vertices(true)].length} vertices` });
	const ctx = analyzer.inspectContext();
	const idx = ctx.env.builtInIndex;
	const caps = compile(policy);
	const dynamicCap = caps.find(c => c.spec.dynamic);
	const trusted = policy.trusted.map(r => new RegExp(r));
	const allowed = policy.allow.map(r => new RegExp(r));
	/* what each file is for, from flowR's file roles; a file without one is a plain source */
	const roleByPath = new Map<string, FileRoleName>();
	for(const role of [...FileRoles].reverse()) {
		for(const f of (ctx.files.getFilesByRole(role as FileRole) ?? []) as readonly { path(): string }[]) {
			roleByPath.set(String(f.path()), role);
		}
	}
	const qualified = Dataflow.qualifyAll(df.graph, true);

	/* `trace`: more vertices whose values count, the callee of a call flowR could not resolve */
	interface Candidate { id: NodeId, call: string, cap: CompiledCapability, via: 'direct' | 'package', through?: string, contract?: Finding['contract'], tags: string[], trace?: readonly NodeId[], late?: readonly NodeId[], lateAlways?: boolean }
	/*
	 * the calls that define the value a callee reads, by qualified name: for a variable, the calls it is defined by
	 * (not the assignment itself), for a call, that call; `undefined` for a definition that is no call (a parameter, a value)
	 */
	const nameOfCall = (c: NodeId): string => {
		const q = qualified.get(c);
		const cv = df.graph.getVertex(c) as { name?: Parameters<typeof Identifier.getName>[0] } | undefined;
		const nm = unquoted(q !== undefined ? String(Identifier.getName(q)) : String(cv?.name === undefined ? '' : Identifier.getName(cv.name)));
		const cns = q !== undefined ? Identifier.getNamespace(q) as string | undefined : undefined;
		return cns === undefined ? nm : `${cns}::${nm}`;
	};
	const argumentsOf = (c: NodeId): NodeId[] => [...df.graph.outgoingEdges(c) ?? []]
		.filter(([t, e]) => DfEdge.includesType(e, EdgeType.Argument) && !NodeId.isBuiltIn(t)).map(([t]) => t);
	type Definer = { id: NodeId, name: string } | undefined;
	const definersOf = (r: NodeId): Definer[] => {
		const rv = df.graph.getVertex(r);
		if(rv?.tag === VertexType.FunctionCall) {
			return [{ id: r, name: nameOfCall(r) }];
		}
		if(rv?.tag !== VertexType.VariableDefinition) {
			return [undefined];
		}
		const out: Definer[] = [];
		for(const [t, e] of df.graph.outgoingEdges(r) ?? []) {
			if(!DfEdge.includesType(e, EdgeType.DefinedBy)) {
				continue;
			}
			const tv = df.graph.getVertex(t);
			if(tv?.tag === VertexType.FunctionCall) {
				if(DfgVertex.hasOrigin(tv, BuiltInProcName.Pipe)) {
					/* `x <- a |> f()`: the value is the one of the call the pipe ends in */
					const ends = [...df.graph.outgoingEdges(t) ?? []].filter(([u, ue]) => DfEdge.includesType(ue, EdgeType.Returns) && !NodeId.isBuiltIn(u));
					out.push(...ends.length > 0 ? ends.map(([u]) => ({ id: u, name: nameOfCall(u) })) : [undefined]);
				} else if(!DfgVertex.hasOrigin(tv, BuiltInProcName.Assignment)) {
					out.push({ id: t, name: nameOfCall(t) });
				}
			} else {
				out.push(undefined);
			}
		}
		return out.length === 0 ? [undefined] : out;
	};
	/* what flowR itself states of a function: its semantic tags, the reason a capability fits it */
	const tagsOf = (name: string, ns: string | undefined) => [...((ns === undefined ? undefined : idx.get(Identifier.make(name, ns))) ?? idx.get(Identifier.make(name)))?.tags ?? []].map(String);
	/* the name a call vertex has, `pkg::fn` when flowR qualified it */
	const callName = (c: NodeId): { name: string, ns: string | undefined } => {
		const q = qualified.get(c);
		const cv = df.graph.getVertex(c) as { name?: Parameters<typeof Identifier.getName>[0] } | undefined;
		const name = unquoted(q !== undefined ? String(Identifier.getName(q)) : cv?.name === undefined ? '' : String(Identifier.getName(cv.name)));
		return { name, ns: q !== undefined ? Identifier.getNamespace(q) as string | undefined : undefined };
	};
	/*
	 * a quoted call is no call, unless the code it is part of runs: its quoting call (`future(...)`, `delayedAssign`),
	 * or a call its value reaches (`eval(quote(...))`, `e <- quote(...); trace(f, e)`), is a dangerous call
	 */
	const UsesEdge = EdgeType.Reads | EdgeType.Argument | EdgeType.Returns | EdgeType.DefinedBy;
	const runsCache = new Map<NodeId, boolean>();
	const severeCall = (c: NodeId): boolean => {
		if(df.graph.getVertex(c)?.tag !== VertexType.FunctionCall) {
			return false;
		}
		const { name, ns } = callName(c);
		const cap = capabilityOf(caps, idx, name, ns);
		return cap !== undefined && cap.spec.class === 'severe' && !cap.spec.dynamic;
	};
	const quotedButRuns = (id: NodeId): boolean => {
		const quoters = [...df.graph.edgesTo(id)].filter(([s, e]) => DfEdge.includesType(e, EdgeType.NonStandardEvaluation) && !NodeId.isBuiltIn(s)).map(([s]) => s);
		return quoters.some(qu => {
			const hit = runsCache.get(qu);
			if(hit !== undefined) {
				return hit;
			}
			let runs = false;
			const seen = new Set<NodeId>([qu]);
			let front: NodeId[] = [qu];
			for(let depth = 0; depth < 6 && !runs && front.length > 0 && seen.size < 500; depth++) {
				const next: NodeId[] = [];
				for(const x of front) {
					if(severeCall(x)) {
						runs = true;
						break;
					}
					for(const [u, e] of df.graph.edgesTo(x)) {
						if(DfEdge.includesType(e, UsesEdge) && !NodeId.isBuiltIn(u) && !seen.has(u)) {
							seen.add(u);
							next.push(u);
						}
					}
				}
				front = next;
			}
			runsCache.set(qu, runs);
			return runs;
		});
	};
	/*
	 * code evaluated in data: `with(data, expr)`, `within(data, expr)`, `eval(expr, envir)`. A call in `expr` whose name the
	 * data defines calls what the data holds (`with(list(f = system), f(x))`); when badger cannot tell the data's names,
	 * a call flowR resolved to nothing could be any of them
	 */
	interface Mask { readonly names: ReadonlyMap<string, NodeId | undefined> | 'any', readonly data: NodeId }
	const masks = new Map<NodeId, Mask[]>();
	{
		type Arg = { name?: { content?: string }, value?: { info: { id: NodeId }, type: string, content?: unknown, lexeme?: string } } | '<>';
		const DataCalls = new Set(['list', 'c', 'data.frame', 'list2env', 'as.environment', 'tibble', 'data.table', 'as.list']);
		const dataNames = (value: NonNullable<Exclude<Arg, '<>'>['value']>, hops = 0): Mask['names'] => {
			const vid = value.info.id;
			const vv = df.graph.getVertex(vid);
			if(vv?.tag === VertexType.FunctionCall) {
				const { name } = callName(vid);
				const node = df.graph.idMap?.get(vid) as { arguments?: readonly Arg[] } | undefined;
				if(!DataCalls.has(name) || node?.arguments === undefined) {
					return 'any';
				}
				const out = new Map<string, NodeId | undefined>();
				for(const a of node.arguments) {
					if(a === '<>') {
						continue;
					}
					if(a.name?.content === undefined) {
						/* an unnamed list or environment in the data: its names are not known here */
						if(a.value !== undefined && a.value.type !== 'RNumber' && a.value.type !== 'RString' && a.value.type !== 'RLogical') {
							return 'any';
						}
						continue;
					}
					out.set(unquoted(a.name.content), a.value?.info.id);
				}
				return out;
			}
			if(vv?.tag === VertexType.Use && hops < 3) {
				/* a variable: what it is defined by */
				const names = new Map<string, NodeId | undefined>();
				let found = false;
				for(const [d, e] of df.graph.outgoingEdges(vid) ?? []) {
					if(!DfEdge.includesType(e, EdgeType.Reads) || NodeId.isBuiltIn(d)) {
						continue;
					}
					for(const [t, e2] of df.graph.outgoingEdges(d) ?? []) {
						if(!DfEdge.includesType(e2, EdgeType.DefinedBy) || NodeId.isBuiltIn(t)) {
							continue;
						}
						const tn = df.graph.idMap?.get(t) as Exclude<Arg, '<>'>['value'] | undefined;
						if(tn === undefined || (df.graph.getVertex(t)?.tag === VertexType.FunctionCall && DfgVertex.hasOrigin(df.graph.getVertex(t) as never, BuiltInProcName.Assignment))) {
							continue;
						}
						const sub = dataNames(tn, hops + 1);
						if(sub === 'any') {
							return 'any';
						}
						found = true;
						for(const [k, v] of sub) {
							names.set(k, v);
						}
					}
				}
				/* a data set of base R (`mtcars`) holds no functions and no outside values */
				const reads = [...df.graph.outgoingEdges(vid) ?? []].filter(([, e]) => DfEdge.includesType(e, EdgeType.Reads));
				if(!found && (reads.length > 0 ? reads.every(([d]) => NodeId.isBuiltIn(d)) : BaseDataSets.has(String(value.lexeme)))) {
					return new Map();
				}
				return found ? names : 'any';
			}
			if(value.type === 'RNumber' || value.type === 'RString' || value.type === 'RLogical') {
				return new Map();
			}
			return 'any';
		};
		const Masking: Record<string, { data: string, at: number }> = {
			'with': { data: 'data', at: 0 }, 'within': { data: 'data', at: 0 }, 'transform': { data: '_data', at: 0 }, 'subset': { data: 'x', at: 0 },
			'eval': { data: 'envir', at: 1 }, 'evalq': { data: 'envir', at: 1 }, 'local': { data: 'envir', at: 1 }, 'substitute': { data: 'env', at: 1 }
		};
		/* of these, only the code argument is masked, not the others */
		const CodeArg: Record<string, string> = { eval: 'expr', evalq: 'expr', local: 'expr', substitute: 'expr' };
		for(const [cid, cv] of df.graph.vertices(true)) {
			if(cv.tag !== VertexType.FunctionCall) {
				continue;
			}
			const { name, ns } = callName(cid);
			const m = Object.hasOwn(Masking, name) && (ns === undefined || ns === 'base') ? Masking[name] : undefined;
			const node = df.graph.idMap?.get(cid) as { arguments?: readonly Arg[] } | undefined;
			if(m === undefined || node?.arguments === undefined) {
				continue;
			}
			const args = node.arguments;
			const named = args.findIndex(a => a !== '<>' && a.name?.content === m.data);
			let pos = -1;
			for(let i = 0, k = 0; i < args.length; i++) {
				const a = args[i];
				if(a !== '<>' && a.name?.content !== undefined) {
					continue;
				}
				if(k++ === m.at) {
					pos = i;
					break;
				}
			}
			const at = named >= 0 ? named : pos;
			const data = at < 0 ? undefined : args[at];
			if(data === undefined || data === '<>' || data.value === undefined) {
				continue;
			}
			const mask: Mask = { names: dataNames(data.value), data: data.value.info.id };
			for(const [i, a] of args.entries()) {
				if(i === at || a === '<>' || a.value === undefined || (Object.hasOwn(CodeArg, name) && a.name?.content !== undefined && a.name.content !== CodeArg[name])) {
					continue;
				}
				for(const sub of RNode.collectAllIds(a.value as never)) {
					masks.set(sub, [...masks.get(sub) ?? [], mask]);
				}
			}
		}
	}
	let lookups = 0;
	const candidates: Candidate[] = [];
	const transitiveCache = new Map<string, { cap: CompiledCapability, through: string } | null>();
	const unresolved = new Set<string>();
	/*
	 * where a function value goes: `Negate(system)(x)`, `Reduce(function(f, x) f(x), xs, system)`, `purrr::walk(x, ~system(.x))`,
	 * `C <- R6Class(...); C$new(x)$run()`. The call that is handed the function (past `list(...)` and `c(...)`), and the
	 * values it may be called with: the arguments of that call, of a call of its result, and of calls on the variable it is
	 * stored in (`n <- Negate(system); n(x)`, `C$new(x)`)
	 */
	type AstNode = { type: string, lexeme?: string, info: { id: NodeId, parent?: NodeId }, calledFunction?: AstNode, functionName?: AstNode, named?: boolean, accessed?: AstNode, operator?: string, lhs?: AstNode, rhs?: AstNode };
	const ast = (i: NodeId | undefined) => i === undefined ? undefined : df.graph.idMap?.get(i) as AstNode | undefined;
	const Containers = new Set(['list', 'c', 'alist', 'pairlist']);
	const handedTo = (node: AstNode): NodeId | undefined => {
		let cur: AstNode | undefined = node;
		for(let hops = 0; cur !== undefined && hops < 8; hops++) {
			const parent = ast(cur.info.parent);
			if(parent?.type !== 'RArgument') {
				return undefined;
			}
			const call = ast(parent.info.parent);
			if(call?.type !== 'RFunctionCall') {
				return undefined;
			}
			if(!Containers.has(callName(call.info.id).name)) {
				return call.info.id;
			}
			cur = call;
		}
		return undefined;
	};
	/* the variable a callee expression starts with: `C` of `C$new(x)$run` */
	const calleeRoot = (call: AstNode): AstNode | undefined => {
		let cur = call.named ? undefined : call.calledFunction;
		for(let hops = 0; cur !== undefined && hops < 16; hops++) {
			if(cur.type === 'RSymbol') {
				return cur;
			}
			cur = cur.type === 'RAccess' ? cur.accessed : cur.type === 'RFunctionCall' ? (cur.named ? cur.functionName : cur.calledFunction) : undefined;
		}
		return undefined;
	};
	/* `tags$p(...)`: a callee that is only member accesses of a variable the code does not define, an object of an attached package */
	const packageObject = (call: AstNode): boolean => {
		let cur = call.named ? undefined : call.calledFunction;
		if(cur?.type !== 'RAccess') {
			return false;
		}
		for(let hops = 0; cur !== undefined && hops < 16; hops++) {
			if(cur.type === 'RSymbol') {
				return ![...df.graph.outgoingEdges(cur.info.id) ?? []].some(([t, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(t))
					&& !(cur.lexeme === 'session' || cur.lexeme === 'input' || cur.lexeme === 'output' || cur.lexeme === 'self' || cur.lexeme === 'private' || cur.lexeme === 'super');
			}
			cur = cur.type === 'RAccess' ? cur.accessed : undefined;
		}
		return false;
	};
	/* the calls whose callee starts with a variable, by the definition it reads */
	const callsOnDefinition = new Map<NodeId, NodeId[]>();
	for(const [cid, cv] of df.graph.vertices(true)) {
		if(cv.tag !== VertexType.FunctionCall) {
			continue;
		}
		const node = ast(cid);
		const root = node === undefined ? undefined : node.named ? node.functionName : calleeRoot(node);
		if(root === undefined) {
			continue;
		}
		const reads = [...df.graph.outgoingEdges(root.info.id) ?? []].filter(([, e]) => DfEdge.includesType(e, EdgeType.Reads)).map(([t]) => t);
		/* a named call reads the definition itself */
		for(const [t, e] of node?.named ? df.graph.outgoingEdges(cid) ?? [] : []) {
			if(DfEdge.includesType(e, EdgeType.Reads) && DfEdge.doesNotIncludeType(e, EdgeType.Argument)) {
				reads.push(t);
			}
		}
		for(const t of reads) {
			if(!NodeId.isBuiltIn(t)) {
				callsOnDefinition.set(t, [...callsOnDefinition.get(t) ?? [], cid]);
			}
		}
	}
	/* as criteria of `input-sources`: a call stands for the values it is given */
	const valuesHandedWith = (c: NodeId, depth = 0): NodeId[] => {
		const out = new Set<NodeId>([c]);
		const node = ast(c);
		/* `do.call(Negate(system), list(x))`: the result is handed on in turn */
		const next = node === undefined || depth >= 3 ? undefined : handedTo(node);
		if(next !== undefined) {
			valuesHandedWith(next, depth + 1).forEach(x => out.add(x));
		}
		const parent = ast(node?.info.parent);
		/* `Negate(system)(x)` */
		if(parent?.type === 'RFunctionCall' && !parent.named && parent.calledFunction?.info.id === c) {
			out.add(parent.info.id);
		}
		/* `n <- Negate(system); n(x)`, `C <- R6Class(...); C$new(x)$run()` */
		for(const [d, e] of df.graph.edgesTo(c)) {
			if(DfEdge.includesType(e, EdgeType.DefinedBy) && df.graph.getVertex(d)?.tag === VertexType.VariableDefinition) {
				for(const u of callsOnDefinition.get(d) ?? []) {
					out.add(u);
				}
			}
		}
		return [...out];
	};
	/* the call an anonymous function or formula around `id` is handed to (`function(x) system(x)` in `Vectorize(...)`) */
	const lambdaHandedTo = (id: NodeId): NodeId | undefined => {
		for(let cur = ast(id), hops = 0; cur !== undefined && hops < 64; cur = ast(cur.info.parent), hops++) {
			const isFormula = cur.info.id !== id && (cur.type === 'RUnaryOp' || cur.type === 'RBinaryOp') && cur.lexeme === '~';
			if(cur.type === 'RFunctionDefinition' || isFormula) {
				return handedTo(cur);
			}
		}
		return undefined;
	};
	/*
	 * the values a definition can end in, through `if`, `{`, `(`, `switch`, `local`, and `return`: `f <- if (c) function(x) 1 else get(x)` ends
	 * in a function definition and in a call of `get`. The calls among them (but trusted ones) compute the function.
	 */
	const Passing = new Set(['if', '{', '(', 'switch', 'local', 'invisible', 'return']);
	/*
	 * calls that make a function of the code's own functions: base R's wrappers of a function they are given
	 * (`Negate(is.null)`, `Vectorize(function(x, y) x + y)`), and functions of the code that return only function
	 * definitions (`compose <- function(f, g) function(x) g(f(x))`). A wrapper of a computed function is computed.
	 */
	const Wrappers = new Set(['Negate', 'Vectorize']);
	/*
	 * what a function of the code may return: a function definition, or a Shiny module (`moduleServer(id, function(...) reactive(...))`),
	 * whose value is what its own function returns: function definitions and calls of trusted reactives
	 */
	const madeExit = (x: NodeId, depth: number): NodeId[] | undefined => {
		const xv = df.graph.getVertex(x);
		if(xv?.tag === VertexType.FunctionDefinition) {
			return [x];
		}
		/* a variable: what it is defined by (`r <- reactive(...); r`) */
		if(xv?.tag === VertexType.Use && depth <= 3) {
			const out: NodeId[] = [];
			const reads = [...df.graph.outgoingEdges(x) ?? []].filter(([u, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(u)).map(([u]) => u);
			const defs = reads.flatMap(u => definersOf(u));
			if(defs.length === 0 || defs.some(d => d === undefined)) {
				return undefined;
			}
			for(const d of defs) {
				if(d !== undefined && !trusted.some(r => r.test(d.name))) {
					const more = madeExit(d.id, depth + 1);
					if(more === undefined) {
						return undefined;
					}
					out.push(...more);
				}
			}
			return out;
		}
		if(xv?.tag !== VertexType.FunctionCall || depth > 3) {
			return undefined;
		}
		const nm = callName(x);
		if(!['moduleServer', 'callModule'].includes(nm.name) || !trusted.some(r => r.test(nm.ns === undefined ? nm.name : `${nm.ns}::${nm.name}`))) {
			return undefined;
		}
		const args = ((ast(x) as { arguments?: readonly ({ name?: { content?: string }, value?: AstNode } | '<>')[] } | undefined)?.arguments ?? []).filter(a => a !== '<>') as { name?: { content?: string }, value?: AstNode }[];
		const fnArg = args.find(a => (a.name?.content === 'module' || a.name === undefined) && a.value?.type === 'RFunctionDefinition');
		const fv = fnArg === undefined ? undefined : df.graph.getVertex(fnArg.value!.info.id) as { exitPoints?: readonly { nodeId: NodeId }[] } | undefined;
		if(fv?.exitPoints === undefined || fv.exitPoints.length === 0) {
			return undefined;
		}
		const out: NodeId[] = [];
		for(const e of fv.exitPoints) {
			const ev = df.graph.getVertex(e.nodeId);
			if(ev?.tag === VertexType.FunctionCall) {
				const en = callName(e.nodeId);
				if(trusted.some(r => r.test(en.ns === undefined ? en.name : `${en.ns}::${en.name}`))) {
					continue;
				}
			}
			const more = madeExit(e.nodeId, depth + 1);
			if(more === undefined) {
				return undefined;
			}
			out.push(...more);
		}
		return out;
	};
	/* the function definitions such a call makes, `undefined` when it may make another function */
	const madeFunctions = (c: NodeId, depth = 0): NodeId[] | undefined => {
		if(depth > 4 || df.graph.getVertex(c)?.tag !== VertexType.FunctionCall) {
			return undefined;
		}
		const nm = callName(c);
		if(Wrappers.has(nm.name) && (nm.ns === undefined || nm.ns === 'base')) {
			const first = (ast(c) as { arguments?: readonly ({ value?: AstNode } | '<>')[] } | undefined)?.arguments?.[0];
			const fn = first === undefined || first === '<>' ? undefined : first.value;
			if(fn?.type === 'RFunctionDefinition') {
				return [fn.info.id];
			}
			if(fn?.type !== 'RSymbol') {
				return undefined;
			}
			/* a function of base R, or a variable defined only by function definitions */
			const out: NodeId[] = [];
			for(const [t, e] of df.graph.outgoingEdges(fn.info.id) ?? []) {
				if(!DfEdge.includesType(e, EdgeType.Reads) || NodeId.isBuiltIn(t)) {
					continue;
				}
				for(const [d, de] of df.graph.outgoingEdges(t) ?? []) {
					if(!DfEdge.includesType(de, EdgeType.DefinedBy) || NodeId.isBuiltIn(d)) {
						continue;
					}
					const dv = df.graph.getVertex(d);
					if(dv?.tag === VertexType.FunctionDefinition) {
						out.push(d);
					} else if(dv?.tag === VertexType.FunctionCall && !DfgVertex.hasOrigin(dv as never, BuiltInProcName.Assignment)) {
						const more = madeFunctions(d, depth + 1);
						if(more === undefined) {
							return undefined;
						}
						out.push(...more);
					}
				}
			}
			const reads = [...df.graph.outgoingEdges(fn.info.id) ?? []].filter(([, e]) => DfEdge.includesType(e, EdgeType.Reads));
			return reads.length > 0 && (out.length > 0 || reads.every(([t]) => NodeId.isBuiltIn(t))) ? out : undefined;
		}
		const targets = [...df.graph.outgoingEdges(c) ?? []].filter(([, e]) => DfEdge.includesType(e, EdgeType.Calls)).map(([t]) => t);
		const out: NodeId[] = [];
		for(const t of targets) {
			const fv = NodeId.isBuiltIn(t) ? undefined : df.graph.getVertex(t) as { tag: string, exitPoints?: readonly { nodeId: NodeId }[] } | undefined;
			const exits = fv?.tag === VertexType.FunctionDefinition ? fv.exitPoints ?? [] : [];
			if(exits.length === 0) {
				return undefined;
			}
			for(const x of exits) {
				const made = madeExit(x.nodeId, depth);
				if(made === undefined) {
					return undefined;
				}
				out.push(...made);
			}
		}
		return targets.length > 0 ? out : undefined;
	};
	/* the calls of each function definition such a call made: what its own calls are handed */
	const madeCalledBy = new Map<NodeId, NodeId[]>();
	const knownFunction = (c: NodeId, by?: NodeId): boolean => {
		const made = madeFunctions(c);
		if(made !== undefined && by !== undefined) {
			for(const f of made) {
				madeCalledBy.set(f, [...madeCalledBy.get(f) ?? [], by]);
			}
		}
		return made !== undefined;
	};
	const computedEnds = (d: NodeId): NodeId[] => {
		const out: NodeId[] = [];
		const seen = new Set<NodeId>();
		const walk = (x: NodeId, depth: number) => {
			if(seen.has(x) || depth > 8 || df.graph.getVertex(x)?.tag !== VertexType.FunctionCall) {
				return;
			}
			seen.add(x);
			const nm = callName(x);
			if(!Passing.has(nm.name)) {
				const qn = nm.ns === undefined ? nm.name : `${nm.ns}::${nm.name}`;
				/* `get("sum")`, `match.fun("mean")`: the name is written right there, and flowR resolves it */
				const lookup = ['get', 'get0', 'match.fun', 'getFunction'].includes(nm.name) && (nm.ns === undefined || nm.ns === 'base' || nm.ns === 'methods');
				const first = lookup ? (ast(x) as { arguments?: readonly ({ value?: AstNode } | '<>')[] } | undefined)?.arguments?.[0] : undefined;
				if(first !== undefined && first !== '<>' && first.value?.type === 'RString') {
					return;
				}
				if(!trusted.some(r => r.test(qn)) && !knownFunction(x)) {
					out.push(x);
				}
				return;
			}
			for(const [t, e] of df.graph.outgoingEdges(x) ?? []) {
				if(DfEdge.includesType(e, EdgeType.Returns) && !NodeId.isBuiltIn(t)) {
					walk(t, depth + 1);
				}
			}
		};
		walk(d, 0);
		return out;
	};
	/*
	 * `C <- R6::R6Class(...); C$new()$add(2)`, `o <- C$new(); o$add(2)`: methods of an R6 class whose members are all
	 * function definitions or constants are functions of the code (a member that holds another value is not)
	 */
	const R6Members = new Set(['public', 'private', 'active', 'methods']);
	const pureR6 = (c: NodeId): boolean => {
		const cn = callName(c);
		/* a reference class (`setRefClass`) is alike: its `fields` name types, its `methods` are functions */
		if(cn.name !== 'R6Class' && !(cn.name === 'setRefClass' && (cn.ns === undefined || cn.ns === 'methods'))) {
			return false;
		}
		const node = df.graph.idMap?.get(c) as { arguments?: readonly ({ name?: { content?: string }, value?: AstNode & { arguments?: readonly unknown[] } } | '<>')[] } | undefined;
		for(const a of node?.arguments ?? []) {
			if(a === '<>' || a.value === undefined || a.name?.content === undefined || !R6Members.has(a.name.content)) {
				continue;
			}
			if(a.value.type !== 'RFunctionCall' || callName(a.value.info.id).name !== 'list') {
				return false;
			}
			for(const m of (a.value.arguments ?? []) as readonly ({ value?: AstNode } | '<>')[]) {
				const t = m === '<>' ? undefined : m.value?.type;
				if(t !== undefined && t !== 'RFunctionDefinition' && t !== 'RNumber' && t !== 'RString' && t !== 'RLogical' && !(t === 'RSymbol' && m !== '<>' && m.value?.lexeme === 'NULL')) {
					return false;
				}
			}
		}
		return true;
	};
	const r6Rooted = (c: NodeId, depth = 0): boolean => {
		const node = ast(c);
		const root = node === undefined || node.named ? undefined : calleeRoot(node);
		if(root === undefined || depth > 4) {
			return false;
		}
		const vars = [...df.graph.outgoingEdges(root.info.id) ?? []].filter(([t, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(t)).map(([t]) => t);
		/* `C$set("public", "f", system)`, `A$methods(f = system)` add members after the fact */
		if(vars.some(t => (callsOnDefinition.get(t) ?? []).some(u => /\$\s*(set|methods)$/.test(String(ast(u)?.lexeme ?? ''))))) {
			return false;
		}
		const defs = vars.flatMap(t => definersOf(t));
		return defs.length > 0 && defs.every(d => d !== undefined && (pureR6(d.id) || r6Rooted(d.id, depth + 1)));
	};
	/*
	 * a parameter every call of its function in the code hands a function of the code or a trusted package's value
	 * (`modServer("a", x)` with `x <- reactive(...)`): calling it calls those
	 */
	const fedByTrusted = (r: NodeId, by: NodeId, depth = 0, seen = new Set<NodeId>()): boolean => {
		if(depth > 4 || seen.has(r)) {
			return false;
		}
		seen.add(r);
		const targets = [...df.graph.outgoingEdges(r) ?? []].filter(([t, e]) => DfEdge.includesType(e, EdgeType.DefinedByOnCall) && !NodeId.isBuiltIn(t)).map(([t]) => t);
		const value = (t: NodeId): boolean => {
			const tv = df.graph.getVertex(t);
			if(tv?.tag === VertexType.FunctionCall) {
				return trusted.some(re => re.test(nameOfCall(t))) || knownFunction(t, by);
			}
			if(tv?.tag === VertexType.FunctionDefinition) {
				return true;
			}
			const reads = [...df.graph.outgoingEdges(t) ?? []].filter(([u, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(u)).map(([u]) => u);
			return reads.length > 0 && reads.every(u => {
				if(df.graph.getVertex(u)?.tag !== VertexType.VariableDefinition) {
					return false;
				}
				if([...df.graph.outgoingEdges(u) ?? []].some(([, e]) => DfEdge.includesType(e, EdgeType.DefinedByOnCall))) {
					return fedByTrusted(u, by, depth + 1, seen);
				}
				const ds = definersOf(u);
				return ds.length > 0 && ds.every(d => d !== undefined && (trusted.some(re => re.test(d.name)) || knownFunction(d.id, by)));
			});
		};
		return targets.length > 0 && targets.every(value);
	};
	const calls = [...df.graph.vertices(true)].filter(([, v]) => v.tag === VertexType.FunctionCall);
	progress({ phase: 'sinks', message: `looking for sinks among ${calls.length} calls`, done: 0, total: calls.length });
	await breathe();

	let n = 0;
	for(const [id, v] of calls) {
		if(++n % 2000 === 0) {
			progress({ phase: 'sinks', message: `looking for sinks among ${calls.length} calls`, done: n, total: calls.length });
			await breathe();
		}
		if(Dataflow.isQuoted(id, df.graph) && !quotedButRuns(id)) {
			continue;
		}
		const q = qualified.get(id);
		const name = unquoted(q !== undefined ? String(Identifier.getName(q)) : String(Identifier.getName((v as { name: Parameters<typeof Identifier.getName>[0] }).name)));
		const ns = q !== undefined ? Identifier.getNamespace(q) as string | undefined : undefined;
		const call = ns === undefined ? name : `${ns}::${name}`;
		/* flowR models `Negate`, `Vectorize`, and `setClass` with a dispatch call of S7 that is not in the code: no call of the code */
		if(name === 'S7_dispatch' && /-s7-/.test(String(id))) {
			continue;
		}
		/* what flowR resolved the callee to: built-in or package functions, and function definitions of the code */
		const builtins: { name: string, ns: string | undefined }[] = [];
		let closures = 0;
		const calleeReads: NodeId[] = [];
		const self0 = ast(id) as { named?: boolean } | undefined;
		for(const [target, e] of df.graph.outgoingEdges(id) ?? []) {
			if(DfEdge.includesType(e, EdgeType.Calls)) {
				if(NodeId.isBuiltIn(target)) {
					const pf = NodeId.toPkgFn(target);
					builtins.push(pf ? { name: pf[1], ns: pf[0] } : { name: String(NodeId.fromBuiltIn(target)), ns: undefined });
				} else {
					closures++;
				}
			} else if(DfEdge.includesType(e, EdgeType.Reads) && DfEdge.doesNotIncludeType(e, EdgeType.Argument) && !NodeId.isBuiltIn(target)) {
				/* a call by name reads a variable definition: flowR links `optim(1, function(x) x^2)` to the values its function argument uses */
				if(self0?.named === true && df.graph.getVertex(target)?.tag !== VertexType.VariableDefinition) {
					continue;
				}
				calleeReads.push(target);
			}
		}
		/* a call evaluated in data that may define its name: it calls what the data holds */
		if(dynamicCap !== undefined) {
			const nothing = builtins.length === 0 && closures === 0 && calleeReads.length === 0 && ns === undefined;
			const hits = (masks.get(id) ?? []).filter(m => m.names === 'any' ? nothing : m.names.has(name));
			if(hits.length > 0) {
				const held = hits.flatMap(m => m.names === 'any' ? [] : [m.names.get(name)]).filter(x => x !== undefined);
				candidates.push({ id, call: name, cap: dynamicCap, via: 'direct', tags: [], trace: [...calleeReads, ...held, ...hits.map(m => m.data)] });
				continue;
			}
		}
		/* the call by its name, and each function flowR resolved its callee to (`l$f()` with `l <- list(f = system)`) */
		let direct: { cap: CompiledCapability, name: string, ns: string | undefined, call: string } | undefined;
		for(const t of [{ name, ns }, ...builtins.filter(b => b.name !== name)]) {
			const tc = t.ns === undefined ? t.name : `${t.ns}::${t.name}`;
			if(allowed.some(r => r.test(tc))) {
				continue;
			}
			const cap = capabilityOf(caps, idx, t.name, t.ns);
			if(cap !== undefined && (direct === undefined || caps.indexOf(cap) < caps.indexOf(direct.cap))) {
				direct = { cap, ...t, call: tc };
			}
		}
		/* a function that has a capability only with a certain argument: `cat(x, file = path)` */
		if(direct === undefined) {
			const node = ast(id) as (AstNode & { arguments?: readonly ({ name?: { content?: string } } | '<>')[] }) | undefined;
			const given = (node?.arguments ?? []).flatMap(a => a === '<>' || a.name?.content === undefined ? [] : [a.name.content]);
			for(const c of given.length === 0 ? [] : caps) {
				const hit = Object.entries(c.spec.withArgument ?? {}).some(([arg, res]) =>
					/* R matches a named argument by its prefix */
					given.some(g => arg.startsWith(g)) && res.some(r => nameMatches(new RegExp(r), name, ns === undefined ? undefined : call)));
				if(hit) {
					direct = { cap: c, name, ns, call };
					break;
				}
			}
		}
		/*
		 * `eval(quote(1 + 2))`: the code it runs is written right there, and its calls are looked at as calls (see
		 * `quotedButRuns`), so the eval itself is no finding; not with an environment, which may change what the names mean
		 */
		if(direct !== undefined && (name === 'eval' || name === 'evalq') && (ns === undefined || ns === 'base')) {
			const node = ast(id) as (AstNode & { arguments?: readonly ({ name?: { content?: string }, value?: AstNode } | '<>')[] }) | undefined;
			const args = node?.arguments ?? [];
			const only = args.length === 1 && args[0] !== '<>' ? args[0] : undefined;
			const code = only !== undefined && (only.name === undefined || only.name.content === 'expr') ? only.value : undefined;
			const literal = name === 'evalq' ? code !== undefined
				: code?.type === 'RFunctionCall' && ['quote', 'expression'].includes(callName(code.info.id).name);
			if(literal) {
				continue;
			}
		}
		if(direct !== undefined) {
			/* a call evaluated in data may read its values from the data: they count too */
			const data = (masks.get(id) ?? []).filter(m => m.names === 'any' || m.names.size > 0).map(m => m.data);
			/* a function handed on as a value (`Negate(system)`, `sapply(x, FUN = system)`) runs with what the call it is handed to gets */
			const self = ast(id);
			const to = self?.type === 'RSymbol' ? handedTo(self) : undefined;
			const trace = [...data, ...to === undefined ? [] : valuesHandedWith(to)];
			candidates.push({ id, call: direct.call, cap: direct.cap, via: 'direct', tags: tagsOf(direct.name, direct.ns), ...trace.length > 0 ? { trace } : {} });
			continue;
		}
		/*
		 * a callee flowR resolved to nothing: a computed value (`get(x)()`, `mget(...)[[1]]()`) or a variable that
		 * holds no function of the code; a plain name it does not know is a package function, looked up below.
		 * A function whose body, formals, or environment the code replaces is no longer the one flowR resolved.
		 */
		if(dynamicCap !== undefined) {
			const defs = calleeReads.flatMap(r => definersOf(r));
			const rewrites = defs.filter(d => d !== undefined && Rewrites.has(d.name)) as { id: NodeId, name: string }[];
			const rewritten = rewrites.length > 0;
			const own = ast(id);
			const unresolved = builtins.length === 0 && closures === 0 && ((v as { origin: unknown }).origin === 'unnamed' || calleeReads.length > 0)
				&& !(own !== undefined && packageObject(own) && (masks.get(id) ?? []).length === 0);
			/* the value of a trusted package function (`d <- shiny::reactive(...); d()`) runs the code's own expression */
			const fromTrusted = defs.length > 0 && defs.every(d => d !== undefined && (trusted.some(r => r.test(d.name)) || knownFunction(d.id, id))) || r6Rooted(id)
				|| calleeReads.length > 0 && calleeReads.every(r => fedByTrusted(r, id));
			/* a callee flowR resolved on one path, but computed on another (`f <- if (c) function(x) 1 else get(x)`) */
			const partly = !unresolved && calleeReads.some(r => df.graph.getVertex(r)?.tag === VertexType.VariableDefinition
				&& definersOf(r).some(d => d !== undefined && !Rewrites.has(d.name) && computedEnds(d.id).length > 0));
			if(rewritten || partly || unresolved && !fromTrusted) {
				const node = df.graph.idMap?.get(id);
				const callee = String(node?.lexeme ?? name);
				if(!allowed.some(r => r.test(callee))) {
					/* a replaced body is a language object: what its parts are built of */
					const parts = rewrites.flatMap(w => argumentsOf(w.id)).flatMap(a => [a, ...argumentsOf(a)]);
					candidates.push({ id, call: callee, cap: dynamicCap, via: 'direct', tags: [], trace: [...calleeReads, ...parts] });
				}
				continue;
			}
		}
		if(builtins.length === 0 && closures === 0 && ((v as { origin: unknown }).origin === 'unnamed' || calleeReads.length > 0)) {
			continue;
		}
		if(allowed.some(r => r.test(call))) {
			continue;
		}
		/* a function of a package: does anything it calls, transitively, have a capability? */
		if(ns === undefined || BaseRPackages.has(ns) || trusted.some(r => r.test(call))) {
			continue;
		}
		let hit = transitiveCache.get(call);
		if(hit === undefined) {
			hit = null;
			const callees = calleesOf(ns, name);
			lookups++;
			if(callees === undefined) {
				unresolved.add(ns);
			}
			for(const callee of callees ?? []) {
				/* a callee in another package comes as `pkg::fn` */
				const q = splitQualified(String(callee));
				const cap = capabilityOf(caps, idx, q?.fn ?? String(callee), q?.ns);
				if(cap !== undefined && (hit === null || caps.indexOf(cap) < caps.indexOf(hit.cap))) {
					hit = { cap, through: String(callee) };
				}
			}
			transitiveCache.set(call, hit);
		}
		if(hit !== null) {
			const sig = ctx.deps.signatures().functionOf(Identifier.make(name, ns))?.signature;
			candidates.push({ id, call, cap: hit.cap, via: 'package', through: hit.through, contract: contractOf(sig), tags: tagsOf(hit.through, undefined) });
		}
	}
	/* a function with a capability handed on as a value (`Negate(system)`, `Reduce(f, xs, system)`): the call it is handed to has it */
	for(const [uid, uv] of df.graph.vertices(true)) {
		if(uv.tag !== VertexType.Use || Dataflow.isQuoted(uid, df.graph) && !quotedButRuns(uid)) {
			continue;
		}
		for(const [t, e] of df.graph.outgoingEdges(uid) ?? []) {
			if(!DfEdge.includesType(e, EdgeType.Reads) || !NodeId.isBuiltIn(t)) {
				continue;
			}
			const pf = NodeId.toPkgFn(t);
			const fn = pf ? { name: pf[1], ns: pf[0] as string | undefined } : { name: String(NodeId.fromBuiltIn(t)), ns: undefined };
			const fc = fn.ns === undefined ? fn.name : `${fn.ns}::${fn.name}`;
			const cap = allowed.some(r => r.test(fc)) ? undefined : capabilityOf(caps, idx, fn.name, fn.ns);
			const node = ast(uid);
			const to = cap === undefined || cap.spec.dynamic || node === undefined ? undefined : handedTo(node);
			if(cap === undefined || to === undefined) {
				continue;
			}
			candidates.push({ id: to, call: `${callName(to).name}(${node?.lexeme ?? fn.name})`, cap, via: 'direct', tags: tagsOf(fn.name, fn.ns), trace: valuesHandedWith(to) });
		}
	}
	/* a call inside an anonymous function handed to another call can get the values that call is given */
	for(const c of candidates) {
		const to = lambdaHandedTo(c.id);
		const late = new Set(to === undefined ? [] : valuesHandedWith(to));
		/* and a call inside a function that a wrapper or a function factory made (`v <- Vectorize(function(x) system(x)); v(y)`) */
		for(let cur = ast(c.id), hops = 0; cur !== undefined && hops < 64; cur = ast(cur.info.parent), hops++) {
			(madeCalledBy.get(cur.info.id) ?? []).forEach(x => late.add(x));
		}
		if(late.size > 0) {
			c.late = [...late];
			/* a method of a class reads its fields as free names (`c` of `system(c)` looks like base's `c()`): always count what the class is given */
			c.lateAlways = to !== undefined && ['R6Class', 'setRefClass'].includes(callName(to).name);
		}
	}
	progress({ phase: 'sinks', message: `${candidates.length} sink call(s) among ${calls.length} calls`, done: calls.length, total: calls.length });
	queries.push({ type: 'signature-database', request: { type: 'callees', functions: lookups }, ms: 0,
		result: `${lookups} package function(s) looked up for what they call inside their package${unresolved.size > 0 ? `, no data for ${[...unresolved].join(', ')}` : ''}` });

	/* where the values of the candidate calls come from, in batches, so progress can tell how far the tracing is */
	const sources = new Map<NodeId, InputSource[]>();
	if(candidates.length > 0) {
		/* a call's own vertex, and for a call flowR could not resolve, the vertices its callee reads */
		const owner: NodeId[] = [];
		const crit: ReturnType<typeof SlicingCriterion.fromId>[] = [];
		for(const c of candidates) {
			for(const t of [c.id, ...c.trace ?? []]) {
				owner.push(c.id);
				crit.push(SlicingCriterion.fromId(t));
			}
		}
		const message = `tracing the values of ${crit.length} sink call(s)`;
		progress({ phase: 'origins', message, done: 0, total: crit.length });
		await breathe();
		let batch = 4;
		const tracing = Date.now();
		for(let at = 0; at < crit.length;) {
			const part = crit.slice(at, at + batch);
			t0 = Date.now();
			const res = await analyzer.query([{ type: 'input-sources', criterion: part }]);
			const ms = Date.now() - t0;
			queries.push({ type: 'input-sources', request: { type: 'input-sources', criterion: part }, ms, result: `the value sources of ${part.length} call(s)` });
			const results = (res['input-sources'] as { results: Record<string, InputSource[]> }).results;
			/* a call flowR returned nothing for has values of unknown source, not none */
			part.forEach((c, i) => {
				const o = owner[at + i];
				sources.set(o, [...sources.get(o) ?? [], ...results[c] ?? [{ id: o, types: ['unknown'] }]]);
			});
			at += part.length;
			const own = (Date.now() - tracing) / at * (crit.length - at);
			const bound = lintBound();
			progress({ phase: 'origins', message, done: at, total: crit.length, etaMs: Math.max(own, bound ?? 0), phaseEtaMs: own });
			await breathe();
			/* about four updates a second: bigger batches when the calls trace fast */
			batch = Math.max(1, Math.min(64, Math.round(part.length * 250 / Math.max(1, ms))));
		}
		/*
		 * a value of the enclosing scope (a global read in a closure) is, where the closure is called, what the
		 * definitions active there hold: flowR links the read to them, trace those too (a few levels of closures)
		 */
		/* the values a lambda is handed, for its calls whose values are parameters or of unknown source */
		{
			const want = candidates.filter(c => c.late !== undefined && c.late.length > 0 && (c.lateAlways === true || (sources.get(c.id) ?? []).some(x => x.types.some(t => t === 'param' || t === 'unknown' || t === 'scope'))));
			const part = [...new Set(want.flatMap(c => c.late ?? []))].map(t => SlicingCriterion.fromId(t));
			if(part.length > 0) {
				t0 = Date.now();
				const res = await analyzer.query([{ type: 'input-sources', criterion: part }]);
				queries.push({ type: 'input-sources', request: { type: 'input-sources', criterion: part }, ms: Date.now() - t0, result: `the value sources of ${part.length} value(s) handed to anonymous functions` });
				const results = (res['input-sources'] as { results: Record<string, InputSource[]> }).results;
				for(const c of want) {
					sources.set(c.id, [...sources.get(c.id) ?? [], ...(c.late ?? []).flatMap(t => results[SlicingCriterion.fromId(t)] ?? [{ id: t, types: ['unknown'] }])]);
				}
			}
		}
		const traced = new Set<NodeId>();
		const dynamicIds = new Set(candidates.filter(c => c.cap === dynamicCap).map(c => c.id));
		/*
		 * a call that returns a value of unknown source (`isolate(input$x)`, `r()` with `r <- reactive(input$x)`) may return
		 * what it is given: its arguments, the call that made the function it calls, and what calls of that function
		 * store in it (`v(input$x)` with `v <- reactiveVal()`)
		 */
		/* what the function the call calls returns, and what a Shiny module returns */
		const exitsOf = (fnId: NodeId) => ((df.graph.getVertex(fnId) as { exitPoints?: readonly { nodeId: NodeId }[] } | undefined)?.exitPoints ?? []).map(x => x.nodeId);
		const expand = (x: NodeId, depth: number, out: Set<NodeId>) => {
			if(depth > 3 || df.graph.getVertex(x)?.tag !== VertexType.FunctionCall) {
				return;
			}
			const more: NodeId[] = [];
			for(const [t, e] of df.graph.outgoingEdges(x) ?? []) {
				if(NodeId.isBuiltIn(t)) {
					continue;
				}
				if(DfEdge.includesType(e, EdgeType.Calls) && df.graph.getVertex(t)?.tag === VertexType.FunctionDefinition) {
					more.push(...exitsOf(t));
				} else if(DfEdge.includesType(e, EdgeType.Returns) && DfEdge.doesNotIncludeType(e, EdgeType.Argument)) {
					more.push(t);
				}
			}
			if(['moduleServer', 'callModule'].includes(callName(x).name)) {
				for(const a of ((ast(x) as { arguments?: readonly ({ value?: AstNode } | '<>')[] } | undefined)?.arguments ?? [])) {
					if(a !== '<>' && a.value?.type === 'RFunctionDefinition') {
						more.push(...exitsOf(a.value.info.id));
					}
				}
			}
			for(const m of more) {
				if(!out.has(m)) {
					out.add(m);
					expand(m, depth + 1, out);
				}
			}
		};
		const expandCall = (x: NodeId): NodeId[] => {
			const o = new Set<NodeId>();
			expand(x, 0, o);
			return [...o];
		};
		/* the calls that define the variable an argument reads (`modServer("a", r)` with `r <- reactive(...)`) */
		const valueDefinitions = (t: NodeId): NodeId[] => df.graph.getVertex(t)?.tag !== VertexType.Use ? []
			: [...df.graph.outgoingEdges(t) ?? []].filter(([u, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(u)).flatMap(([u]) => definersOf(u)).flatMap(d => d === undefined ? [] : [d.id]);
		const inputsOfCall = (c: NodeId): NodeId[] => {
			const out = new Set<NodeId>([c]);
			expandCall(c).forEach(x => out.add(x));
			/* `l$f()`, `l[["f"]]()`: what the variable `l` holds */
			const cnode = ast(c);
			const root = cnode === undefined || cnode.named ? undefined : calleeRoot(cnode);
			for(const [r, e] of root === undefined ? [] : df.graph.outgoingEdges(root.info.id) ?? []) {
				if(DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(r)) {
					for(const d of definersOf(r)) {
						if(d !== undefined) {
							out.add(d.id);
						}
					}
				}
			}
			for(const [r, e] of df.graph.outgoingEdges(c) ?? []) {
				if(!DfEdge.includesType(e, EdgeType.Reads) || DfEdge.includesType(e, EdgeType.Argument) || NodeId.isBuiltIn(r)) {
					continue;
				}
				for(const d of definersOf(r)) {
					if(d !== undefined) {
						out.add(d.id);
						expandCall(d.id).forEach(x => out.add(x));
					}
				}
				/* a parameter is what the calls of its function hand it */
				for(const [a, ae] of df.graph.outgoingEdges(r) ?? []) {
					if(DfEdge.includesType(ae, EdgeType.DefinedByOnCall) && !NodeId.isBuiltIn(a)) {
						out.add(a);
						valueDefinitions(a).forEach(x => [x, ...expandCall(x)].forEach(y => out.add(y)));
					}
				}
				/* the other calls of the same function, with the values they hand it */
				if(df.graph.getVertex(r)?.tag === VertexType.VariableDefinition) {
					for(const [u, ue] of df.graph.edgesTo(r)) {
						if(u !== c && DfEdge.includesType(ue, EdgeType.Reads) && df.graph.getVertex(u)?.tag === VertexType.FunctionCall) {
							out.add(u);
						}
					}
				}
			}
			return [...out];
		};
		for(let round = 0; round < 24; round++) {
			const want = new Map<NodeId, NodeId[]>();
			for(const [owner, list] of sources) {
				/* a call of unknown callee has the origins of the callee, not of what the callee returns: only its own sources are followed */
				const dynamicOwner = dynamicIds.has(owner);
				for(const src of list) {
					/* a parameter is, where its function is called, what that call hands it (`g(get(x))` for `g <- function(f) f(1)`) */
					const scope = src.types.includes('scope') || src.types.includes('param');
					const call = !scope && src.types.includes('unknown') && df.graph.getVertex(src.id)?.tag === VertexType.FunctionCall;
					/* a variable of unknown value (`l <- list(r = r)`): the calls that define what it reads */
					const use = !scope && !call && !dynamicOwner && src.types.includes('unknown') && df.graph.getVertex(src.id)?.tag === VertexType.Use;
					if(!scope && !call && !use || traced.has(src.id)) {
						continue;
					}
					traced.add(src.id);
					/* a call of a parameter (`cmd()`): what the calls of its function hand the parameter */
					const handed = (r: NodeId) => [...df.graph.outgoingEdges(r) ?? []].filter(([t, e]) => DfEdge.includesType(e, EdgeType.DefinedByOnCall) && !NodeId.isBuiltIn(t)).flatMap(([t]) => [t, ...valueDefinitions(t).flatMap(x => [x, ...expandCall(x)])]);
					const defs = scope ? [...df.graph.outgoingEdges(src.id) ?? []]
						.filter(([t, e]) => DfEdge.includesType(e, EdgeType.DefinedByOnCall) && !NodeId.isBuiltIn(t)).map(([t]) => t)
						.concat(!dynamicOwner && df.graph.getVertex(src.id)?.tag === VertexType.FunctionCall
							? [...df.graph.outgoingEdges(src.id) ?? []].filter(([t, e]) => DfEdge.includesType(e, EdgeType.Reads) && !NodeId.isBuiltIn(t)).flatMap(([t]) => handed(t)) : [])
						: use ? valueDefinitions(src.id).flatMap(x => [x, ...expandCall(x)]) : inputsOfCall(src.id);
					if(defs.length > 0) {
						want.set(src.id, defs);
					}
				}
			}
			if(want.size === 0) {
				break;
			}
			const part = [...new Set([...want.values()].flat())].map(t => SlicingCriterion.fromId(t));
			t0 = Date.now();
			const res = await analyzer.query([{ type: 'input-sources', criterion: part }]);
			queries.push({ type: 'input-sources', request: { type: 'input-sources', criterion: part }, ms: Date.now() - t0, result: `the value sources of ${part.length} definition(s) that closures read` });
			const results = (res['input-sources'] as { results: Record<string, InputSource[]> }).results;
			for(const [o, list] of sources) {
				const more = list.flatMap(src => (want.get(src.id) ?? []).flatMap(t => results[SlicingCriterion.fromId(t)] ?? [{ id: t, types: ['unknown'] }]));
				if(more.length > 0) {
					sources.set(o, [...list, ...more]);
				}
			}
		}
	}

	const all: Finding[] = candidates.map(c => {
		const node = df.graph.idMap?.get(c.id);
		const range = node?.info?.fullRange ?? node?.location;
		const types = [...new Set((sources.get(c.id) ?? []).flatMap(s => s.types.length > 0 ? s.types : ['unknown']))].sort();
		return {
			id:         String(c.id),
			file:       node?.info?.file,
			role:       roleOf(node?.info?.file, roleByPath),
			loc:        range ? [range[0], range[1], range[2], range[3]] as const : undefined,
			call:       c.call,
			capability: c.cap.name,
			class:      c.cap.spec.class,
			via:        c.via,
			through:    c.through,
			origins:    originsOf(policy, types),
			inputTypes: types,
			tags:       c.tags,
			contract:   c.contract
		};
	});
	/* a capability can leave out calls whose values all come from origins it names (a call without any traced value stays) */
	const findings = all.filter(f => {
		const unless = policy.capabilities[f.capability]?.unlessOrigins;
		return unless === undefined || f.origins.length === 0 || !f.origins.every(o => unless.includes(o));
	});

	const unresolvedPackages = [...unresolved].sort();
	const inOrder = () => rules.flatMap(r => lintDone.get(r) ?? []);
	const partial = () => onPartial?.({ findings, lint: inOrder(), unresolvedPackages, queries: [...queries, ...lintQueries], pending: rules.filter(r => !lintDone.has(r)) });
	let lint: LintSummary[];
	if(lintWork === undefined) {
		lint = await runLint(analyzer, rules, progress, queries, done => onPartial?.({ findings, lint: done, unresolvedPackages, queries: [...queries], pending: rules.slice(done.length) }));
	} else {
		/* the rules ran alongside: report what is done and wait for the rest */
		const tell = () => {
			const left = rules.filter(r => !lintDone.has(r));
			const running = lintCurrent !== undefined && left.includes(lintCurrent.rule) ? lintCurrent.rule : left[0];
			progress({ phase: 'lint', message: left.length === 0 ? `${rules.length} linting rule(s) done` : `linting rule ${running}`,
				done: lintDone.size, total: rules.length, etaMs: lintBound(), phaseEtaMs: lintBound() });
		};
		onLintChange = () => {
			tell();
			partial();
		};
		tell();
		partial();
		await lintWork;
		onLintChange = () => {};
		lint = inOrder();
		queries.push(...lintQueries);
	}
	return { findings, lint, unresolvedPackages, queries };
}

/**
 * What a file is for: flowR's role, except that `inst/doc` holds the built vignettes (their code is copied
 * there by `R CMD build`), so it counts as a vignette, not as installed code. A file without a role is a source.
 */
export function roleOf(file: string | undefined, roleByPath: ReadonlyMap<string, FileRoleName>): FileRoleName {
	if(file !== undefined && /(^|[\\/])inst[\\/]doc[\\/]/.test(file)) {
		return 'vignette';
	}
	return roleByPath.get(file ?? '') ?? 'source';
}

/** Assigns the tier and wraps everything into a report. */
export function finishReport(policy: Policy, base: Omit<Report, 'analyzed' | 'tier' | 'findings' | 'lint' | 'unresolvedPackages' | 'error' | 'ms'>, start: number, result: CoreResult | { error: string }): Report {
	if('error' in result) {
		return { ...base, analyzed: false, error: result.error, tier: assignTier(policy, [], [], false), findings: [], lint: [], unresolvedPackages: [], queries: [], ms: Date.now() - start };
	}
	return { ...base, analyzed: true, tier: assignTier(policy, result.findings, result.lint), ...result, ms: Date.now() - start };
}

function contractOf(sig: readonly { name: string, props: number }[] | undefined): Finding['contract'] {
	if(sig === undefined) {
		return undefined;
	}
	const named = (bit: number) => sig.filter(p => (p.props & bit) !== 0).map(p => String(p.name));
	return { injectable: named(ArgProp.Injectable), resource: named(ArgProp.Resource), written: named(ArgProp.Written) };
}

async function runLint(analyzer: FlowrAnalyzer, rules: readonly string[], progress: ProgressListener, queries: FlowrQueryRecord[], partial: (done: LintSummary[]) => void): Promise<LintSummary[]> {
	const out: LintSummary[] = [];
	for(const [i, rule] of rules.entries()) {
		partial([...out]);
		progress({ phase: 'lint', message: `linting rule ${rule}`, done: i, total: rules.length });
		await breathe();
		const { summary, query } = await lintRule(analyzer, rule);
		out.push(summary);
		if(query !== undefined) {
			queries.push(query);
		}
	}
	progress({ phase: 'lint', message: `${rules.length} linting rule(s) done`, done: rules.length, total: rules.length });
	return out;
}

/** runs one linting rule of flowR */
export async function lintRule(analyzer: FlowrAnalyzer, rule: string): Promise<{ summary: LintSummary, query?: FlowrQueryRecord }> {
	try {
		const t1 = Date.now();
		const res = await analyzer.query([{ type: 'linter', rules: [rule as never] }]);
		const byRule = (res.linter as { results: Record<string, { results?: Record<string, unknown>[], error?: unknown }> }).results;
		const r = byRule[rule];
		const query: FlowrQueryRecord = { type: 'linter', request: { type: 'linter', rules: [rule] }, ms: Date.now() - t1, result: `${r?.results?.length ?? 0} result(s) of ${rule}` };
		if(r === undefined || r.error !== undefined || r.results === undefined) {
			return { query, summary: { rule, ...ruleDocs(rule), count: 0, results: [], error: r?.error === undefined ? 'no result' : String((r.error as Error)?.message ?? r.error) } };
		}
		return { query, summary: { rule, ...ruleDocs(rule), count: r.results.length, results: r.results.map(x => lintResult(rule, x)) } };
	} catch(e) {
		return { summary: { rule, ...ruleDocs(rule), count: 0, results: [], error: e instanceof Error ? e.message : String(e) } };
	}
}

/* the wiki pages of flowR's linting rules, `[Linting-Rule]-<page>`; rules without a page link the overview */
const WikiPages = new Set([
	'Absolute-File-Paths', 'Bogus-Return', 'Call-Arguments', 'Call-Contracts', 'Class-String-Comparison', 'Code-Clones',
	'Compiled-Code', 'Dataframe-Access-Validation', 'Dead-Code', 'Dependency-Declaration', 'Deprecated-Functions',
	'Description-Metadata', 'Documentation-Mismatch', 'File-Path-Validity', 'Foreign-Function-Calls',
	'Global-Environment-Modification', 'Interactive-Functions', 'Namespace-Access', 'Namespace-Tampering',
	'Naming-Convention', 'Network-Functions', 'No-Leaked-Credentials', 'Non-Ascii-Code', 'Overwritten-File',
	'Package-Data', 'Package-Hooks', 'Package-Metafiles', 'Package-Runtime', 'Package-Structure', 'Problematic-Inputs',
	'Process-State-In-Session', 'Rd-Files', 'Roxygen-Arguments', 'S3-Method-Consistency', 'Secret-Exfiltration',
	'Seeded-Randomness', 'Software-Has-License', 'Software-Has-Tests', 'Stop-Call', 'Syntactically-Valid',
	'True-False-Abbreviation', 'Unclosed-Connection', 'Undefined-Symbol', 'Unescaped-Arguments', 'Unused-Definitions',
	'Unused-Import', 'Useless-Loop'
]);
const Wiki = 'https://github.com/flowr-analysis/flowr/wiki/';

export function ruleDocs(rule: string): { title?: string, about?: string, docs: string } {
	const info = (LintingRules as Record<string, { info?: { name?: string, description?: string } }>)[rule]?.info;
	const title = info?.name;
	const page = (s: string) => s.split(/[\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
	const hit = [page(rule), title ? page(title) : '', title ? page(title) + 's' : ''].find(p => WikiPages.has(p))
		?? (rule === 'stop-with-call-arg' ? 'Stop-Call' : undefined);
	return { title, about: info?.description, docs: hit ? `${Wiki}%5BLinting-Rule%5D-${hit}` : `${Wiki}Linter` };
}

type Range4 = readonly [number, number, number, number];
function range(loc: unknown): { loc?: Range4, file?: string } {
	if(!Array.isArray(loc) || loc.length < 4 || loc.slice(0, 4).some(n => typeof n !== 'number')) {
		return {};
	}
	return { loc: [loc[0], loc[1], loc[2], loc[3]], file: typeof loc[4] === 'string' ? loc[4] : undefined };
}

function lintResult(rule: string, x: Record<string, unknown>): LintResult {
	const fixes = (Array.isArray(x.quickFix) ? x.quickFix as Record<string, unknown>[] : []).flatMap((q): QuickFix[] => {
		const at = range(q.loc);
		/* an invalid location would cut somewhere else; such a fix is left out */
		if(at.loc === undefined || at.loc[0] <= 0) {
			return [];
		}
		return [{ description: String(q.description ?? q.type), loc: at.loc, file: at.file, replacement: q.type === 'replace' ? String(q.replacement) : undefined }];
	});
	return { certainty: x.certainty as string | undefined, ...range(x.loc), message: pretty(rule, x), ...(fixes.length > 0 ? { quickFix: fixes } : {}) };
}

/** flowR's own short text for a result, without the location (the report shows it), else the shared fields */
function pretty(rule: string, x: Record<string, unknown>): string {
	try {
		const print = (LintingRules as Record<string, { prettyPrint?: Record<string, (r: unknown, m: unknown) => string> }>)[rule]?.prettyPrint?.query;
		const text = print?.(x, {});
		if(typeof text === 'string' && text.length > 0) {
			return text.replace(/\s+at\s+\S*\d+(\.\d+)?(\s*-\s*\S*\d+(\.\d+)?)?\s*$/, '');
		}
	} catch{ /* a rule that needs its metadata: fall back */ }
	return summarize(x);
}

/** a short text for one linting result, from the fields the rules share */
function summarize(x: Record<string, unknown>): string {
	const parts: string[] = [];
	for(const k of ['kind', 'name', 'function', 'call', 'secret', 'sink', 'message', 'what', 'by']) {
		const v = x[k];
		if(typeof v === 'string' && v.length > 0) {
			parts.push(`${k}: ${v}`);
		}
	}
	return parts.length > 0 ? parts.join(', ') : JSON.stringify(x, (k, v) => k === 'quickFix' ? undefined : v).slice(0, 200);
}
