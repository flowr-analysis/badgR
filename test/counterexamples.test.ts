/**
 * Code that once got a better tier than it deserves, or lost a finding: each case is the smallest script
 * that showed the gap. A case must keep its findings, or the tier it may at best get.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyze } from '../src/analyze';
import { loadPolicy } from '../src/policy';
import { ensureSigDb } from '../src/sigdb';

const policy = loadPolicy();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badgr-cx-'));
const order = [...policy.tiers.map(t => t.name), policy.fallbackTier.name];

async function run(code: string) {
	const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.R`);
	fs.writeFileSync(file, code);
	return analyze(file, policy, { lintInThread: true });
}

describe('counterexamples', () => {
	beforeAll(async() => {
		await ensureSigDb();
	}, 600_000);

	test.each([
		/* [code, the best tier it may get, a capability it must have] */
		['con <- file("out.txt", "w"); writeLines(readline(), con)', 'silver', 'network-file'],
		['writeLines("x", "/etc/passwd")', 'silver', 'network-file'],
		['x <- readLines("data.txt")', 'silver', 'network-file'],
		['reticulate::py_run_string(readline())', 'none', 'code-execution'],
		['Rcpp::cppFunction(readline())', 'none', 'code-execution'],
		['rstudioapi::sendToConsole(readline())', 'none', 'code-execution'],
		['Sys.setenv(PATH = readline()); system("ls")', 'none', 'environment'],
		['callr::r(function() 1)', 'silver', 'shell'],
		/* a call into readr reaches vroom, another package, which writes */
		['readr::write_csv(data.frame(), readline())', 'silver', 'destructive'],
		['f <- get("system"); f(readline())', 'none', 'shell'],
		['do.call("system", list(readline()))', 'none', 'shell'],
		['s <- system; s(readline())', 'none', 'shell'],
		['sapply(readline(), system)', 'none', 'shell'],
		['x <- readline(); library(x, character.only = TRUE)', 'none', 'package-load'],
		['require(readline(), character.only = TRUE)', 'none', 'package-load'],
		/* the code these run is quoted; until it is traced, they at least lose gold */
		['future::future(system(readline()))', 'silver', 'code-execution'],
		['delayedAssign("y", system(readline())); y', 'silver', 'code-execution'],
		['trace(print, quote(system(readline())))', 'silver', 'code-execution'],
		['rlang::eval_tidy(rlang::parse_expr(readline()))', 'none', 'code-execution'],
		/* a variable named session is no Shiny session */
		['session <- list(); session$f <- get(readline()); session$f(1)', 'none', 'dynamic-call'],
		['f <- function(session) session$f(readline()); f(list(f = system))', 'none', 'dynamic-call'],
		/* loading a package by a computed name runs its code */
		['loadNamespace(readline())', 'silver', 'package-load'],
		['requireNamespace(readline())', 'silver', 'package-load'],
		['attachNamespace(readline())', 'silver', 'package-load'],
		/* archives, links, permissions, processes, and programs */
		['utils::unzip(readline())', 'silver', 'destructive'],
		['untar("a.tar")', 'silver', 'destructive'],
		['zip("a.zip", "b")', 'silver', 'destructive'],
		['file.symlink("a", "b")', 'silver', 'destructive'],
		['file.link("a", "b")', 'silver', 'destructive'],
		['Sys.chmod("x", "777")', 'silver', 'destructive'],
		['Sys.umask("000")', 'silver', 'destructive'],
		['Sys.setFileTime("x", Sys.time())', 'silver', 'destructive'],
		['browseURL("http://example.com")', 'silver', 'process-control'],
		['file.edit("x")', 'silver', 'process-control'],
		['tools::Rcmd("INSTALL x")', 'silver', 'process-control'],
		['tools::pskill(1)', 'silver', 'process-control']
	] as const)('%s', async(code, best, capability) => {
		const r = await run(code);
		expect(r.analyzed).toBe(true);
		expect(order.indexOf(r.tier.tier), `tier ${r.tier.tier}`).toBeGreaterThanOrEqual(order.indexOf(best));
		if(capability !== undefined) {
			expect(r.findings.map(f => f.capability)).toContain(capability);
		}
	}, 120_000);

	test.each([
		'library(shiny)',
		'library("shiny", character.only = TRUE)',
		'library(shiny)\nserver <- function(input, output, session) session$onSessionEnded(function() 1)\nshinyApp(fluidPage(), server)',
		'x <- data.table::data.table(a = 1)',
		'library(data.table)\ndt <- data.table(a = 1:3, g = 1)\ndt[a > 1, .(m = mean(a)), by = g]',
		'out <- DT::renderDT(mtcars)',
		'testthat::expect_equal(1, 1)'
	])('harmless code stays gold: %s', async code => {
		const r = await run(code);
		expect(r.tier.tier).toBe('gold');
	}, 120_000);

	test('rlang\'s argument checks inside Shiny inputs are no code execution', async() => {
		const r = await run('library(shiny)\nui <- fluidPage(numericInput("n", "n", 10))');
		expect(r.findings.filter(f => f.capability !== 'package-load')).toEqual([]);
	}, 120_000);
});

describe('packages', () => {
	test('a package: DESCRIPTION, NAMESPACE, .Rprofile, built vignettes, and tests', async() => {
		const r = await analyze(path.join(__dirname, 'fixtures', 'pkg'), policy, { lintInThread: true });
		expect(r.analyzed).toBe(true);
		const base = (f?: string) => path.relative(path.join(__dirname, 'fixtures', 'pkg'), f ?? '');
		expect(r.files.map(base).sort()).toEqual(['.Rprofile', 'DESCRIPTION', 'NAMESPACE', 'R/io.R', 'inst/doc/intro.R', 'tests/test-io.R']);
		const by = Object.fromEntries(r.findings.map(f => [`${base(f.file)} ${f.capability}`, f.role]));
		expect(by).toEqual(expect.objectContaining({
			'R/io.R shell':             'source',
			'.Rprofile environment':    'startup',
			'inst/doc/intro.R shell':   'vignette',
			'tests/test-io.R code-execution': 'test'
		}));
		/* the package's own system(cmd) gets a parameter: not silver */
		expect(r.tier.tier).toBe('bronze');
	}, 300_000);
});
