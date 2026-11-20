#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyze';
import { DefaultPolicyPath, PolicyError, loadPolicy } from './policy';
import { ensureSigDb, sigDbStatus } from './sigdb';
import { badgeSvg, logoSvg } from './badge';
import { applyReview, parseReview, reviewSummary, type ReviewEntry } from './review';
import { sarifLog } from './sarif';
import type { Report } from './core';
import { markdownReport, textReport } from './report';
import { ProgressPrinter } from './progress';
import { fetchPackage, packageLabel, packageSpec } from './fetch-package';

const usage = `Usage: badgr [options] <script.R | folder | package>...

Assigns a policy tier (gold, silver, bronze, or none) to R scripts, Shiny apps, and projects
with the static analysis of flowR.

A package is a CRAN package by name (glue, glue@1.8.0, cran:glue) or a Bioconductor
package (bioc:limma), downloaded once from its GitHub mirror into ~/.cache/badgr/packages.

Options:
  --policy <file.yaml>   the policy (default: the tiers of the threat model)
  --json [file]          write the JSON report (to stdout without a file)
  --md <file | ->        write a Markdown report (- for stdout)
  --badge <file.svg>     write the badge; a custom policy marks the tier with *, a review
                         (--review) that decided every finding and left none to fix with a check
  --sarif <file | ->     write SARIF 2.1.0 for code scanning (- for stdout)
  --min-tier <tier>      exit with 2 when the artifact does not reach this tier
  --review <file.json>   mark findings as a reviewer classified them (tolerated, false-positive,
                         to-fix), as the playground exports them; this never changes a tier
  --timeout <seconds>    give up on an artifact after this long (it then gets no tier)
  --sigdb-download       download the flowR signature database and exit
  --print-policy         print the policy file and exit
  --logo <file.svg>      write the badgR logo and exit
  --quiet                no progress output (it goes to stderr, so --json stays clean anyway)
  --verbose              show flowR warnings
  --help                 show this help

Output: progress goes to stderr. --json without a file, and --md -, write to stdout, so
\`badgr app/ --json --quiet | jq .tier.tier\` reads the tier.

Exit codes: 0 done, 1 error (bad arguments or policy), 2 below --min-tier.
`;

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			'policy':         { type: 'string' },
			'json':           { type: 'boolean' },
			'json-file':      { type: 'string' },
			'md':             { type: 'string' },
			'badge':          { type: 'string' },
			'sarif':          { type: 'string' },
			'min-tier':       { type: 'string' },
			'review':         { type: 'string' },
			'timeout':        { type: 'string' },
			'sigdb-download': { type: 'boolean' },
			'print-policy':   { type: 'boolean' },
			'logo':           { type: 'string' },
			'verbose':        { type: 'boolean' },
			'quiet':          { type: 'boolean' },
			'help':           { type: 'boolean' }
		},
		/* `--json file` writes to a file, a bare `--json` to stdout */
		args: rewriteJson(process.argv.slice(2))
	});
	if(values.help) {
		process.stdout.write(usage);
		return 0;
	}
	const policyFile = values.policy ?? DefaultPolicyPath;
	if(values['print-policy']) {
		process.stdout.write(fs.readFileSync(policyFile, 'utf-8'));
		return 0;
	}
	if(values.logo) {
		fs.writeFileSync(values.logo, logoSvg());
		return 0;
	}
	const err = (m: string) => process.stderr.write(m + '\n');
	if(values['sigdb-download']) {
		const s = await ensureSigDb(err);
		err(`signature database ${s.tag} in ${s.dir}: ${s.present ? 'present' : 'MISSING'}`);
		return s.present ? 0 : 1;
	}
	if(positionals.length === 0) {
		err(usage);
		return 1;
	}
	const policy = loadPolicy(policyFile);
	if(values['min-tier'] !== undefined && !policy.tiers.some(t => t.name === values['min-tier'])) {
		err(`--min-tier: the policy has no tier ${values['min-tier']}`);
		return 1;
	}
	if(!sigDbStatus().present) {
		err('the flowR signature database is missing, so calls into packages do not resolve; downloading it once');
		await ensureSigDb(err);
	}
	const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
	const review = values.review === undefined ? undefined : readReview(values.review);
	const toStdout = Boolean(values.json && values['json-file'] === undefined) || values.md === '-' || values.sarif === '-';
	let code = 0;
	const reports = [];
	const printer = new ProgressPrinter(positionals.length, process.stderr, values.quiet);
	for(const [i, target] of positionals.entries()) {
		const pkg = packageSpec(target);
		printer.startArtifact(i, pkg ? packageLabel(pkg) : target);
		let dir = target;
		if(pkg !== undefined) {
			try {
				dir = await fetchPackage(pkg, values.quiet ? undefined : err);
			} catch(e) {
				err(e instanceof Error ? e.message : String(e));
				return 1;
			}
		}
		let report = await analyze(dir, policy, { timeoutMs, verbose: values.verbose, progress: p => printer.update(p) });
		if(review !== undefined) {
			report = withReview(report, review);
		}
		printer.endArtifact();
		reports.push(report);
		if(!toStdout) {
			process.stdout.write(textReport(report) + '\n');
		}
		if(values['min-tier'] !== undefined) {
			const order = policy.tiers.map(t => t.name);
			const got = order.indexOf(report.tier.tier);
			if(got === -1 || got > order.indexOf(values['min-tier'])) {
				code = 2;
			}
		}
	}
	printer.summary(reports.map(r => r.tier.tier));
	const single = reports.length === 1 ? reports[0] : undefined;
	if(values['json-file'] !== undefined) {
		writeFile(values['json-file'], JSON.stringify(single ?? reports, null, 2) + '\n');
	} else if(values.json && values['json-file'] === undefined) {
		process.stdout.write(JSON.stringify(single ?? reports, null, 2) + '\n');
	}
	if(values.md !== undefined) {
		const md = reports.map(markdownReport).join('\n---\n\n');
		if(values.md === '-') {
			process.stdout.write(md);
		} else {
			writeFile(values.md, md);
		}
	}
	if(values.sarif !== undefined) {
		const sarif = JSON.stringify(sarifLog(reports, r => {
			const root = rootOf(r);
			const lines = lineReader();
			return {
				fileOf:       f => f === undefined ? undefined : relativeTo(root, f),
				lineOf:       lines,
				capabilities: policy.capabilities
			};
		}), null, 2) + '\n';
		if(values.sarif === '-') {
			process.stdout.write(sarif);
		} else {
			writeFile(values.sarif, sarif);
		}
	}
	if(values.badge !== undefined) {
		/* several artifacts share one badge only if they share the tier, otherwise the weakest counts */
		const order = [...policy.tiers.map(t => t.name), policy.fallbackTier.name];
		const weakest = reports.reduce((a, b) => order.indexOf(b.tier.tier) > order.indexOf(a.tier.tier) ? b : a);
		/* reviewed only when a review was given and it covers every finding of every artifact */
		const reviewed = review !== undefined && reports.some(r => r.findings.length > 0) && reports.every(r => r.findings.length === 0 || reviewSummary(r.findings).complete);
		writeFile(values.badge, badgeSvg(weakest.tier.tier, weakest.tier.color, { custom: weakest.policy.modified, reviewed }));
	}
	return code;
}

function rewriteJson(args: string[]): string[] {
	const out: string[] = [];
	for(let i = 0; i < args.length; i++) {
		if(args[i] === '--json' && args[i + 1] !== undefined && !args[i + 1].startsWith('-') && /\.json$/.test(args[i + 1])) {
			out.push('--json-file', args[++i]);
		} else {
			out.push(args[i]);
		}
	}
	return out;
}

function readReview(file: string): ReviewEntry[] {
	try {
		return parseReview(fs.readFileSync(file, 'utf-8'));
	} catch(e) {
		throw new Error(`--review ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** the folder the paths of reviews and SARIF are relative to: the analyzed folder, or the folder of the analyzed file */
function rootOf(report: Report): string {
	return fs.existsSync(report.target) && fs.statSync(report.target).isDirectory() ? report.target : path.dirname(report.target);
}

function relativeTo(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

/** the text of a line of a file on disk, each file read once */
function lineReader(): (file: string | undefined, line: number) => string | undefined {
	const lines = new Map<string, string[]>();
	return (file, line) => {
		if(file === undefined) {
			return undefined;
		}
		if(!lines.has(file)) {
			lines.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n') : []);
		}
		return lines.get(file)?.[line - 1];
	};
}

/** the reviewer's decisions on the findings, matched by file (relative to the target), call, and line text */
function withReview(report: Report, entries: readonly ReviewEntry[]): Report {
	const root = rootOf(report);
	return applyReview(report, entries, f => f === undefined ? undefined : relativeTo(root, f), lineReader());
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, content);
}

/* a pipe takes large writes asynchronously, so exit only once stdout and stderr are flushed, or a report
 * longer than the pipe buffer (64 KiB) is cut off */
function exitAfterFlush(code: number): void {
	process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

main().then(exitAfterFlush, e => {
	process.stderr.write((e instanceof PolicyError ? `policy error: ${e.message}` : (e as Error)?.stack ?? String(e)) + '\n');
	exitAfterFlush(1);
});
