/**
 * Writes the package data the web page analyzes with: per package of base R and CRAN (latest versions),
 * its exports, so `library(pkg)` brings their names into scope, and, per exported function, the functions it
 * calls transitively that the policy could give a capability. The page fetches the file of a package only
 * when a project uses that package, from the same site, so the analysis stays in the browser.
 *
 * Usage: tsx scripts/gen-web-data.ts <out-dir> [--limit n] [--only pkg,pkg,...]
 * `--only` (for local tests) writes the named packages and base R.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FlowrAnalyzerBuilder } from '@eagleoutice/flowr/project/flowr-analyzer-builder';
import { log, LogLevelNames } from '@eagleoutice/flowr/util/log';
import { loadPolicy } from '../src/policy';
import { BaseRPackages, acrossPackages, mayHaveCapability } from '../src/core';
import { ensureSigDb, sigDbStatus } from '../src/sigdb';

export interface WebPackage {
	/** version */
	readonly v?: string
	/** exports */
	readonly x: readonly string[]
	/** per exported function, its transitive callees that may have a capability */
	readonly c: Readonly<Record<string, readonly string[]>>
}

async function main(): Promise<void> {
	const out = process.argv[2] ?? 'web-dist/pkgs';
	const limitAt = process.argv.indexOf('--limit');
	const limit = limitAt > 0 ? Number(process.argv[limitAt + 1]) : Infinity;
	log.updateSettings(s => {
		s.settings.minLevel = LogLevelNames.fatal;
	});
	await ensureSigDb(m => process.stderr.write(m + '\n'));
	const sig = sigDbStatus();
	const policy = loadPolicy();
	const analyzer = await new FlowrAnalyzerBuilder().setEngine('tree-sitter').amendConfig(c => {
		c.solver.sigdb.additionalPaths = [sig.dir as string];
		c.solver.sigdb.eagerlyLoad = true;
	}).build();
	analyzer.addRequest({ request: 'text', content: 'x <- 1' });
	await analyzer.dataflow();
	const ctx = analyzer.inspectContext();
	const idx = ctx.env.builtInIndex;
	const src = ctx.deps.signatures().sources();
	const relevant = new Map<string, boolean>();
	const isRelevant = (name: string) => {
		let r = relevant.get(name);
		if(r === undefined) {
			r = mayHaveCapability(policy, idx, name);
			relevant.set(name, r);
		}
		return r;
	};
	fs.mkdirSync(out, { recursive: true });
	const onlyAt = process.argv.indexOf('--only');
	const only = onlyAt > 0 ? new Set([...process.argv[onlyAt + 1].split(','), ...BaseRPackages]) : undefined;
	const names = src.packageNames().map(String).filter(n => only === undefined || only.has(n)).sort().slice(0, limit);
	/* calls into other packages are followed, so a package's data names the sinks it reaches through them */
	const callees = acrossPackages((pkg, fn) => {
		const v = src.latestVersion(pkg as never)?.toString();
		return v === undefined ? undefined : [...src.transitiveCallees(pkg as never, fn as never, v as never) ?? []].map(String);
	}, c => policy.trusted.some(r => new RegExp(r).test(c)));
	const index: Record<string, string> = {};
	const start = Date.now();
	let bytes = 0;
	for(const [i, pkg] of names.entries()) {
		const version = src.latestVersion(pkg as never)?.toString();
		const exported = (src.lookup(pkg as never, version)?.exported ?? []).map(String);
		const c: Record<string, string[]> = {};
		for(const fn of exported) {
			const hits = [...new Set([...(callees(pkg, fn) ?? [])].map(String).filter(isRelevant))].sort();
			if(hits.length > 0) {
				c[fn] = hits;
			}
		}
		const data: WebPackage = { v: version, x: exported, c };
		const text = JSON.stringify(data);
		bytes += text.length;
		fs.writeFileSync(path.join(out, `${pkg}.json`), text);
		index[pkg] = version ?? '';
		if(i % 500 === 0 || i === names.length - 1) {
			const rate = (Date.now() - start) / (i + 1);
			process.stderr.write(`${i + 1}/${names.length} packages, ${(bytes / 1e6).toFixed(1)} MB, about ${Math.round((names.length - i - 1) * rate / 1000)}s left\n`);
		}
	}
	fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ sigdb: sig.tag, policy: policy.hash, packages: index }));
	process.stderr.write(`wrote ${names.length} packages to ${out} (${(bytes / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - start) / 1000)}s\n`);
}

void main();
