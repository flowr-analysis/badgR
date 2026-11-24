/**
 * The analysis of the web page, in a worker so the page stays responsive. It runs flowR on the files the
 * page hands it, entirely in this browser: the only requests it makes are for the package data of the
 * packages the project uses, from the same site the page came from.
 */
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { FlowrAnalyzerPackageVersionsSigDbPlugin, SigDbPluginName } from '@eagleoutice/flowr/project/plugins/package-version-plugins/flowr-analyzer-package-versions-sigdb-plugin';
import { MemorySignatureSource } from '@eagleoutice/flowr/project/sigdb/memory-source';
import { FlowrInlineTextFile } from '@eagleoutice/flowr/project/context/flowr-file';
import { flowrVersion } from '@eagleoutice/flowr/util/version';
import { log, LogLevelNames } from '@eagleoutice/flowr/util/log';
import treeSitterWasm from 'web-tree-sitter/tree-sitter.wasm';
import rWasm from '@davisvaughan/tree-sitter-r/tree-sitter-r.wasm';
import { BaseRPackages, RFilePattern, ruleDocs, lintRule, lintInWorkers, type LintMessage, type Progress, type Report, analyzeWith, finishReport } from '../src/core';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';
import { parsePolicy } from '../src/policy-core';
import { ArgProp, CallProp, SemanticCallTag } from '@eagleoutice/flowr/dataflow/environments/built-in-props';
import { InputType } from '@eagleoutice/flowr/queries/catalog/input-sources-query/input-types';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import type { LintPackage, PolicyVocabulary, SourceFile, WorkerRequest, WorkerResponse } from './protocol';
import { packagesNamed } from './packages';

declare const BADGER_VERSION: string;

interface WebPackage { v?: string, x: string[], c: Record<string, string[]> }

const post = (m: WorkerResponse | LintMessage) => (self as unknown as Worker).postMessage(m);
const packageCache = new Map<string, Promise<WebPackage | undefined>>();
let packageIndex: Promise<{ sigdb?: string, packages: Record<string, string> } | undefined> | undefined;

async function fetchJson<T>(url: string): Promise<T | undefined> {
	const res = await fetch(url);
	return res.ok ? await res.json() as T : undefined;
}

function loadPackage(base: string, name: string): Promise<WebPackage | undefined> {
	let p = packageCache.get(name);
	if(p === undefined) {
		p = fetchJson<WebPackage>(`${base}pkgs/${encodeURIComponent(name)}.json`).catch(() => undefined);
		packageCache.set(name, p);
	}
	return p;
}

let treeSitterReady: Promise<void> | undefined;

/** `SideEffect` as `side-effect`: badger reads property names without case and dashes */
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const flags = (e: Record<string, string | number>) => Object.keys(e).filter(k => typeof e[k] === 'number').map(kebab);

function vocabulary(): PolicyVocabulary {
	return {
		lintRules: Object.entries(LintingRules as Record<string, { info?: { name?: string, description?: string } }>)
			.map(([name]) => ({ name, ...ruleDocs(name) })),
		tags:       Object.values(SemanticCallTag).map(String),
		callProps:  flags(CallProp as unknown as Record<string, string | number>),
		argProps:   flags(ArgProp as unknown as Record<string, string | number>),
		inputTypes: Object.values(InputType).map(String)
	};
}

/** about how long building the dataflow graph takes per line of R code in a browser, measured on a project of 8000 lines */
const MsPerLine = 1.5;

async function run(req: Extract<WorkerRequest, { type: 'analyze' }>): Promise<Report> {
	const start = Date.now();
	/* flowR reports nothing while it builds the dataflow graph: estimate that step from the lines of code */
	const lines = req.files.filter(f => RFilePattern.test(f.path)).reduce((n, f) => n + f.content.split('\n').length, 0);
	const progress = (p: Progress) => post({ type: 'progress', id: req.id, progress: p.phase === 'dataflow' && p.etaMs === undefined ? { ...p, etaMs: lines * MsPerLine, phaseEtaMs: lines * MsPerLine } : p });
	log.updateSettings(s => {
		s.settings.minLevel = LogLevelNames.fatal;
	});
	const policy = parsePolicy(req.policyText, req.policyName, req.policyHash);
	const rFiles = req.files.filter(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path));
	const base = {
		tool:         'badger' as const,
		toolVersion:  BADGER_VERSION,
		flowrVersion: String(flowrVersion()),
		sigdb:        { tag: undefined as string | undefined, present: true, scope: 'package data of this page (base R and CRAN, latest versions)' },
		policy:       { name: policy.name, hash: policy.hash, source: policy.source, modified: req.policyModified },
		target:       req.target,
		files:        rFiles.map(f => f.path),
		generatedAt:  new Date().toISOString()
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		progress({ phase: 'files', message: `${rFiles.length} R file(s)`, done: rFiles.length, total: rFiles.length });
		if(rFiles.length === 0) {
			throw new Error('no R files (.R, .Rmd, .qmd) found');
		}
		treeSitterReady ??= TreeSitterExecutor.initTreeSitter(undefined, rWasm, treeSitterWasm);
		packageIndex ??= fetchJson<{ sigdb?: string, packages: Record<string, string> }>(`${req.base}pkgs/index.json`).catch(() => undefined);
		const index = await packageIndex;
		base.sigdb.tag = index?.sigdb;
		const wanted = [...new Set([...BaseRPackages, ...packagesNamed(req.files)])];
		progress({ phase: 'files', message: `loading the data of ${wanted.length} package(s)`, done: 0, total: wanted.length });
		const loaded = new Map<string, WebPackage>();
		let done = 0;
		await Promise.all(wanted.map(async name => {
			const pkg = index === undefined || name in index.packages ? await loadPackage(req.base, name) : undefined;
			if(pkg !== undefined) {
				loaded.set(name, pkg);
			}
			progress({ phase: 'files', message: `loading the data of ${wanted.length} package(s)`, done: ++done, total: wanted.length });
		}));
		await treeSitterReady;

		const packages = [...loaded].map(([name, p]) => ({ name, v: p.v, x: p.x }));
		const analyzer = await buildAnalyzer(req.files, packages);
		lint = lintWorkers(req.files, packages, policy.lintTimeout, policy.lintReadTimeout);
		const work = analyzeWith(analyzer, policy, (pkg, fn) => {
			const p = loaded.get(pkg);
			if(p === undefined || !p.x.includes(fn)) {
				return undefined;
			}
			return p.c[fn] ?? [];
		}, progress, partial => post({ type: 'partial', id: req.id, report: finishReport(policy, base, start, partial) }), lint?.runner);
		/* the limit counts from the start of the run; flowR does not yield while it builds the dataflow graph, so it is checked between the steps */
		const limit = policy.timeout;
		const result = limit === undefined ? await work : await Promise.race([work, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timeout after ${limit} s (timeout in the policy)`)), Math.max(0, limit * 1000 - (Date.now() - start)));
		})]);
		return finishReport(policy, base, start, result);
	} catch(e) {
		return finishReport(policy, base, start, { error: e instanceof Error ? e.message : String(e) });
	} finally {
		clearTimeout(timer);
		lint?.stop();
	}
}

async function buildAnalyzer(files: readonly SourceFile[], packages: readonly LintPackage[]): Promise<FlowrAnalyzer> {
	const source = new MemorySignatureSource(Object.fromEntries(packages.map(p => [p.name, { version: p.v, exported: p.x as never[] }])));
	const analyzer = await new FlowrAnalyzerBuilder()
		.setParser(new TreeSitterExecutor())
		.unregisterPlugins(SigDbPluginName)
		.registerPlugins(new FlowrAnalyzerPackageVersionsSigDbPlugin(source))
		.build();
	analyzer.addFile(...files.map(f => new FlowrInlineTextFile(f.path, f.content)));
	analyzer.addRequest(...files.filter(f => RFilePattern.test(f.path)).map(f => ({ request: 'file' as const, content: f.path })));
	return analyzer;
}

/** the linting rules run in workers of their own, next to the rest of the analysis, see {@link lintInWorkers} */
function lintWorkers(files: readonly SourceFile[], packages: readonly LintPackage[], limitSeconds: number, readSeconds: number): ReturnType<typeof lintInWorkers> | undefined {
	if(typeof Worker === 'undefined') {
		return undefined;
	}
	return lintInWorkers(() => {
		const w = new Worker(self.location.href);
		w.postMessage({ type: 'lint-init', files, packages } satisfies WorkerRequest);
		return {
			next: () => new Promise<LintMessage>(resolve => {
				w.onmessage = (ev: MessageEvent<LintMessage>) => resolve(ev.data);
				w.onerror = ev => {
					ev.preventDefault();
					resolve({ type: 'lint-failed', error: ev.message || 'the linting worker failed' });
				};
			}),
			run:       rule => w.postMessage({ type: 'lint-rule', rule } satisfies WorkerRequest),
			terminate: () => w.terminate()
		};
	}, limitSeconds, readSeconds);
}

let lint: ReturnType<typeof lintWorkers>;
let lintAnalyzer: Promise<FlowrAnalyzer> | undefined;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
	const req = ev.data;
	if(req.type === 'warm') {
		treeSitterReady ??= TreeSitterExecutor.initTreeSitter(undefined, rWasm, treeSitterWasm);
		packageIndex ??= fetchJson<{ sigdb?: string, packages: Record<string, string> }>(`${req.base}pkgs/index.json`).catch(() => undefined);
		void packageIndex.then(index => {
			post({ type: 'ready', sigdb: index?.sigdb, vocabulary: vocabulary() });
			for(const name of BaseRPackages) {
				void loadPackage(req.base, name);
			}
		});
	} else if(req.type === 'lint-init') {
		treeSitterReady ??= TreeSitterExecutor.initTreeSitter(undefined, rWasm, treeSitterWasm);
		log.updateSettings(s => {
			s.settings.minLevel = LogLevelNames.fatal;
		});
		lintAnalyzer = treeSitterReady.then(() => buildAnalyzer(req.files, req.packages)).then(async a => {
			await a.dataflow();
			return a;
		});
		lintAnalyzer.then(() => post({ type: 'lint-ready' }), e => post({ type: 'lint-failed', error: e instanceof Error ? e.message : String(e) }));
	} else if(req.type === 'lint-rule') {
		void lintAnalyzer?.then(a => lintRule(a, req.rule)).then(r => post({ type: 'lint-done', ...r }));
	} else if(req.type === 'analyze') {
		run(req).then(
			report => post({ type: 'report', id: req.id, report }),
			e => post({ type: 'error', id: req.id, error: e instanceof Error ? e.message : String(e) })
		);
	}
};
