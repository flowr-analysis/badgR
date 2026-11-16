import * as fs from 'node:fs';
import * as path from 'node:path';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { fileProtocol } from '@eagleoutice/flowr/r-bridge/retriever';
import { flowrVersion } from '@eagleoutice/flowr/util/version';
import { log, LogLevelNames } from '@eagleoutice/flowr/util/log';
import type { Policy } from './policy-core';
import { Worker } from 'node:worker_threads';
import type { FlowrAnalyzer } from '@eagleoutice/flowr/project/flowr-analyzer';
import { type LintMessage, type ProgressListener, type Report, RFilePattern, analyzeWith, finishReport, lintInWorkers } from './core';
import { sigDbStatus } from './sigdb';

export { type Report, type Progress, type ProgressListener, BaseRPackages, RFilePattern } from './core';

export function toolVersion(): string {
	for(const p of [path.resolve(__dirname, '..', 'package.json'), path.resolve(__dirname, '..', '..', 'package.json')]) {
		if(fs.existsSync(p)) {
			return (JSON.parse(fs.readFileSync(p, 'utf-8')) as { version: string }).version;
		}
	}
	return 'unknown';
}

/** all R files of a file or folder, skipping package libraries (`renv`, `packrat`, `rv/library`) and hidden folders */
export function collectFiles(target: string): string[] {
	const stat = fs.statSync(target);
	if(stat.isFile()) {
		return [path.resolve(target)];
	}
	const out: string[] = [];
	const walk = (dir: string) => {
		for(const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if(e.name.startsWith('.') || e.name === 'renv' || e.name === 'node_modules' || e.name === 'packrat') {
				continue;
			}
			const p = path.join(dir, e.name);
			/* rv installs the locked packages into rv/library, next to its own scripts in rv/scripts */
			if(e.isDirectory() && e.name === 'library' && path.basename(dir) === 'rv') {
				continue;
			}
			if(e.isDirectory()) {
				walk(p);
			} else if(RFilePattern.test(e.name)) {
				out.push(path.resolve(p));
			}
		}
	};
	walk(target);
	return out.sort();
}

export interface AnalyzeOptions {
	/** stop the analysis after this many milliseconds, the artifact then gets the fallback tier */
	readonly timeoutMs?: number
	readonly verbose?:   boolean
	readonly progress?:  ProgressListener
	/** run the linting rules in this thread, without their time limit */
	readonly lintInThread?: boolean
}

/** Analyzes an R file or project folder with flowR and the full signature database, and assigns its tier. */
export async function analyze(target: string, policy: Policy, opts: AnalyzeOptions = {}): Promise<Report> {
	const start = Date.now();
	log.updateSettings(s => {
		s.settings.minLevel = opts.verbose ? LogLevelNames.warn : LogLevelNames.fatal;
	});
	const progress = opts.progress ?? (() => {});
	const sig = sigDbStatus();
	let files: string[] = [];
	const base = () => ({
		tool:         'badgR' as const,
		toolVersion:  toolVersion(),
		flowrVersion: String(flowrVersion()),
		sigdb:        { tag: sig.tag, present: sig.present, scope: 'full (base R and all of CRAN)' },
		policy:       { name: policy.name, hash: policy.hash, source: policy.source },
		target:       path.resolve(target),
		files,
		generatedAt:  new Date().toISOString()
	});
	let timer: NodeJS.Timeout | undefined;
	let lint: ReturnType<typeof lintThreads> | undefined;
	try {
		files = collectFiles(target);
		progress({ phase: 'files', message: `${files.length} R file(s)`, done: files.length, total: files.length });
		if(files.length === 0) {
			throw new Error('no R files found');
		}
		const analyzer = await diskAnalyzer(files, sig.dir);
		lint = opts.lintInThread ? undefined : lintThreads(files, sig.dir, policy.lintTimeout);
		const db = () => analyzer.inspectContext().deps.signatures();
		const work = analyzeWith(analyzer, policy, (pkg, fn) => {
			const version = db().versionOf(pkg);
			return version === undefined ? undefined : db().sources().transitiveCallees(pkg, fn, version);
		}, progress, undefined, lint?.runner);
		const result = opts.timeoutMs === undefined ? await work : await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timeout after ${opts.timeoutMs} ms`)), opts.timeoutMs);
				timer.unref();
			})
		]);
		const report = finishReport(policy, base(), start, result);
		progress({ phase: 'done', message: `${report.tier.tier} in ${report.ms} ms` });
		return report;
	} catch(e) {
		return finishReport(policy, base(), start, { error: e instanceof Error ? e.message : String(e) });
	} finally {
		clearTimeout(timer);
		lint?.stop();
	}
}

/** an analyzer over files on disk, with the full signature database */
export async function diskAnalyzer(files: readonly string[], sigDir: string | undefined): Promise<FlowrAnalyzer> {
	const analyzer = await new FlowrAnalyzerBuilder()
		.setEngine('tree-sitter')
		.amendConfig(c => {
			if(sigDir !== undefined) {
				c.solver.sigdb.additionalPaths = [...(c.solver.sigdb.additionalPaths ?? []), sigDir];
			}
		})
		.build();
	for(const f of files) {
		analyzer.addRequest(fileProtocol + f);
	}
	return analyzer;
}

/** the linting rules in threads of their own, see {@link lintInWorkers}; the thread runs `lint-thread` */
function lintThreads(files: readonly string[], sigDir: string | undefined, limitSeconds: number): ReturnType<typeof lintInWorkers> {
	/* run from the sources with tsx, the thread needs tsx too */
	const ts = __filename.endsWith('.ts');
	const script = path.join(__dirname, ts ? 'lint-thread.ts' : 'lint-thread.js');
	return lintInWorkers(() => {
		const w = ts
			? new Worker(`require('tsx/cjs'); require(${JSON.stringify(script)});`, { eval: true, workerData: { files, sigDir } })
			: new Worker(script, { workerData: { files, sigDir } });
		const waiting: ((m: LintMessage) => void)[] = [];
		const answer = (m: LintMessage) => waiting.shift()?.(m);
		w.on('message', answer);
		w.on('error', (e: Error) => answer({ type: 'lint-failed', error: e.message }));
		w.on('exit', code => answer({ type: 'lint-failed', error: `the linting thread ended (${code})` }));
		return {
			next:      () => new Promise<LintMessage>(resolve => waiting.push(resolve)),
			run:       rule => w.postMessage(rule),
			terminate: () => void w.terminate()
		};
	}, limitSeconds);
}
