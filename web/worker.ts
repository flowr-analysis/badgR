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
import { BaseRPackages, ruleDocs, type Progress, type Report, analyzeWith, finishReport } from '../src/core';
import { parsePolicy } from '../src/policy-core';
import { ArgProp, CallProp, SemanticCallTag } from '@eagleoutice/flowr/dataflow/environments/built-in-props';
import { InputType } from '@eagleoutice/flowr/queries/catalog/input-sources-query/input-types';
import { LintingRules } from '@eagleoutice/flowr/linter/linter-rules';
import type { PolicyVocabulary, WorkerRequest, WorkerResponse } from './protocol';
import { packagesNamed } from './packages';

declare const BADGR_VERSION: string;

interface WebPackage { v?: string, x: string[], c: Record<string, string[]> }

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);
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

/** `SideEffect` as `side-effect`: badgR reads property names without case and dashes */
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

async function run(req: Extract<WorkerRequest, { type: 'analyze' }>): Promise<Report> {
	const start = Date.now();
	const progress = (p: Progress) => post({ type: 'progress', id: req.id, progress: p });
	log.updateSettings(s => {
		s.settings.minLevel = LogLevelNames.fatal;
	});
	const policy = parsePolicy(req.policyText, req.policyName, req.policyHash);
	const rFiles = req.files.filter(f => /\.(R|r|Rmd|rmd|qmd)$/.test(f.path));
	const base = {
		tool:         'badgR' as const,
		toolVersion:  BADGR_VERSION,
		flowrVersion: String(flowrVersion()),
		sigdb:        { tag: undefined as string | undefined, present: true, scope: 'package data of this page (base R and CRAN, latest versions)' },
		policy:       { name: policy.name, hash: policy.hash, source: policy.source },
		target:       req.target,
		files:        rFiles.map(f => f.path),
		generatedAt:  new Date().toISOString()
	};
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

		const source = new MemorySignatureSource(Object.fromEntries([...loaded].map(([name, p]) => [name, { version: p.v, exported: p.x as never[] }])));
		const analyzer = await new FlowrAnalyzerBuilder()
			.setParser(new TreeSitterExecutor())
			.unregisterPlugins(SigDbPluginName)
			.registerPlugins(new FlowrAnalyzerPackageVersionsSigDbPlugin(source))
			.build();
		analyzer.addFile(...req.files.map(f => new FlowrInlineTextFile(f.path, f.content)));
		analyzer.addRequest(...rFiles.map(f => ({ request: 'file' as const, content: f.path })));
		const result = await analyzeWith(analyzer, policy, (pkg, fn) => {
			const p = loaded.get(pkg);
			if(p === undefined || !p.x.includes(fn)) {
				return undefined;
			}
			return p.c[fn] ?? [];
		}, progress);
		return finishReport(policy, base, start, result);
	} catch(e) {
		return finishReport(policy, base, start, { error: e instanceof Error ? e.message : String(e) });
	}
}

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
	} else if(req.type === 'analyze') {
		run(req).then(
			report => post({ type: 'report', id: req.id, report }),
			e => post({ type: 'error', id: req.id, error: e instanceof Error ? e.message : String(e) })
		);
	}
};
