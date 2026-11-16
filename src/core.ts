/**
 * The analysis badgR runs, independent of where it runs: the command line hands it an analyzer over files
 * on disk with the full signature database, the web page one over files in memory with the package data
 * it loaded. Nothing in here touches the file system or the network.
 */
import { Identifier } from '@eagleoutice/flowr/dataflow/environments/identifier';
import { VertexType } from '@eagleoutice/flowr/dataflow/graph/vertex';
import { Dataflow } from '@eagleoutice/flowr/dataflow/graph/df-helper';
import { SlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';
import { ArgProp, CallProp } from '@eagleoutice/flowr/dataflow/environments/built-in-props';
import type { BuiltInIndex } from '@eagleoutice/flowr/dataflow/environments/query-fn-props';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';
import { type CapabilitySpec, type Policy, lintRulesOf } from './policy-core';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import { type Finding, type LintResult, type LintSummary, type QuickFix, type TierResult, assignTier } from './tiers';

/** the packages of base R: a call into them is the app's own call, never one "inside a package" */
export const BaseRPackages: ReadonlySet<string> = new Set([
	'base', 'stats', 'utils', 'methods', 'graphics', 'grDevices', 'datasets', 'tools', 'parallel',
	'compiler', 'grid', 'splines', 'stats4', 'tcltk'
]);

/** the R files badgR analyzes */
export const RFilePattern = /\.(R|r|Rmd|rmd|qmd)$/;

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
}

export type ProgressListener = (p: Progress) => void;

/**
 * The functions a package function calls, transitively, by name, or `undefined` when the package or the
 * function is unknown. The command line asks the signature database, the web page its package data.
 */
export type CalleesOf = (pkg: string, fn: string) => Iterable<string> | undefined;

export interface Report {
	readonly tool:          'badgR'
	readonly toolVersion:   string
	readonly flowrVersion:  string
	readonly sigdb:         { readonly tag?: string, readonly present: boolean, readonly scope?: string }
	readonly policy:        { readonly name: string, readonly hash: string, readonly source: string }
	readonly target:        string
	readonly files:         readonly string[]
	readonly generatedAt:   string
	readonly analyzed:      boolean
	readonly error?:        string
	readonly tier:          TierResult
	readonly findings:      readonly Finding[]
	readonly lint:          readonly LintSummary[]
	/** calls into packages the signature data did not know, so badgR could not look inside them */
	readonly unresolvedPackages: readonly string[]
	/** what badgR asked flowR, in order: the request as flowR takes it, how long it took, and how much came back */
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
	return capabilityOf(compile(policy), idx, name, undefined) !== undefined;
}

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

/** one step badgR asked flowR for */
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
/** how long a linting worker may take to read the code before its rules count as not run */
const MaxReadSeconds = 900;

export function lintInWorkers(spawn: () => LintEndpoint, limitSeconds: number): { runner: LintRunner, stop: () => void } {
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
				readTimer = setTimeout(() => resolve('timeout'), MaxReadSeconds * 1000);
			})]);
			clearTimeout(readTimer);
			if(ready === 'timeout' || ready.type !== 'lint-ready') {
				w.terminate();
				const error = ready === 'timeout' ? `the linting worker did not read the code within ${MaxReadSeconds} s`
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
	const trusted = policy.trusted.map(r => new RegExp(r));
	const qualified = Dataflow.qualifyAll(df.graph, true);

	interface Candidate { id: NodeId, call: string, cap: CompiledCapability, via: 'direct' | 'package', through?: string, contract?: Finding['contract'], tags: string[] }
	/* what flowR itself states of a function: its semantic tags, the reason a capability fits it */
	const tagsOf = (name: string, ns: string | undefined) => [...((ns === undefined ? undefined : idx.get(Identifier.make(name, ns))) ?? idx.get(Identifier.make(name)))?.tags ?? []].map(String);
	let lookups = 0;
	const candidates: Candidate[] = [];
	const transitiveCache = new Map<string, { cap: CompiledCapability, through: string } | null>();
	const unresolved = new Set<string>();
	const calls = [...df.graph.vertices(true)].filter(([, v]) => v.tag === VertexType.FunctionCall);
	progress({ phase: 'sinks', message: `looking for sinks among ${calls.length} calls`, done: 0, total: calls.length });
	await breathe();

	let n = 0;
	for(const [id, v] of calls) {
		if(++n % 2000 === 0) {
			progress({ phase: 'sinks', message: `looking for sinks among ${calls.length} calls`, done: n, total: calls.length });
			await breathe();
		}
		if(Dataflow.isQuoted(id, df.graph)) {
			continue;
		}
		const q = qualified.get(id);
		const name = q !== undefined ? String(Identifier.getName(q)) : String(Identifier.getName((v as { name: Parameters<typeof Identifier.getName>[0] }).name));
		const ns = q !== undefined ? Identifier.getNamespace(q) as string | undefined : undefined;
		const call = ns === undefined ? name : `${ns}::${name}`;
		const direct = capabilityOf(caps, idx, name, ns);
		if(direct !== undefined) {
			candidates.push({ id, call, cap: direct, via: 'direct', tags: tagsOf(name, ns) });
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
				const cap = capabilityOf(caps, idx, String(callee), undefined);
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
	progress({ phase: 'sinks', message: `${candidates.length} sink call(s) among ${calls.length} calls`, done: calls.length, total: calls.length });
	queries.push({ type: 'signature-database', request: { type: 'callees', functions: lookups }, ms: 0,
		result: `${lookups} package function(s) looked up for what they call inside their package${unresolved.size > 0 ? `, no data for ${[...unresolved].join(', ')}` : ''}` });

	/* where the values of the candidate calls come from, in batches, so progress can tell how far the tracing is */
	const sources = new Map<NodeId, InputSource[]>();
	if(candidates.length > 0) {
		const crit = candidates.map(c => SlicingCriterion.fromId(c.id));
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
			part.forEach((c, i) => sources.set(candidates[at + i].id, results[c] ?? [{ id: candidates[at + i].id, types: ['unknown'] }]));
			at += part.length;
			const own = (Date.now() - tracing) / at * (crit.length - at);
			const bound = lintBound();
			progress({ phase: 'origins', message, done: at, total: crit.length, etaMs: Math.max(own, bound ?? 0) });
			await breathe();
			/* about four updates a second: bigger batches when the calls trace fast */
			batch = Math.max(1, Math.min(64, Math.round(part.length * 250 / Math.max(1, ms))));
		}
	}

	const findings: Finding[] = candidates.map(c => {
		const node = df.graph.idMap?.get(c.id);
		const range = node?.info?.fullRange ?? node?.location;
		const types = [...new Set((sources.get(c.id) ?? []).flatMap(s => s.types.length > 0 ? s.types : ['unknown']))].sort();
		return {
			id:         String(c.id),
			file:       node?.info?.file,
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
				done: lintDone.size, total: rules.length, etaMs: lintBound() });
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
