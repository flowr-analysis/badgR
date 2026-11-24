/**
 * Calls whose callee is a computed value: flowR resolves some to the function they call, the others become
 * findings of the policy's `dynamic: true` capability, traced to where the callee comes from. Calls flowR
 * resolves to a function of the code stay no finding.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyze } from '../src/analyze';
import { DefaultPolicyPath, loadPolicy, parsePolicy } from '../src/policy';
import { ensureSigDb } from '../src/sigdb';

const DynamicBlock = `  dynamic-call:
    class: severe
    description: calls a function the analysis cannot resolve
    dynamic: true
`;

const text = fs.readFileSync(DefaultPolicyPath, 'utf8');
const policy = /^\s+dynamic: true$/m.test(text) ? loadPolicy() : parsePolicy(text.replace(/^capabilities:\n/m, m => m + DynamicBlock), 'dynamic.yaml', 'test');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-dyn-'));
const order = [...policy.tiers.map(t => t.name), policy.fallbackTier.name];

async function run(code: string, p = policy) {
	const file = path.join(dir, `case-${Math.random().toString(36).slice(2)}.R`);
	fs.writeFileSync(file, code);
	return analyze(file, p, { lintInThread: true });
}

describe('dynamic calls', () => {
	beforeAll(async() => {
		await ensureSigDb();
	}, 600_000);

	test.each([
		/* [code, the best tier it may get, a capability it must have] */
		['f <- function() 1; body(f) <- call("system", readline()); f()', 'none', 'dynamic-call'],
		['l <- list(f = system); l$f(readline())', 'none', 'shell'],
		['getExportedValue("base", "system")(readline())', 'none', 'dynamic-call'],
		['mk <- function() system; mk()(readline())', 'none', 'shell'],
		['get0("system")(readline())', 'none', 'shell'],
		['mget("system", envir = baseenv())[[1]](readline())', 'none', 'dynamic-call'],
		['e <- new.env(); assign("f", system, e); get("f", e)(readline())', 'none', 'shell'],
		['as.function(alist(x = , system(x)))(readline())', 'none', 'dynamic-call'],
		['(base:::system)(readline())', 'none', 'shell'],
		['x <- readline(); get(x)("a")', 'none', 'dynamic-call'],
		['x <- readline(); match.fun(x)("a")', 'none', 'dynamic-call'],
		['x <- readline(); do.call(x, list())', 'none', 'dynamic-call'],
		['x <- readline(); getFromNamespace(x, "base")()', 'none', 'dynamic-call'],
		['x <- readline(); asNamespace("base")[[x]]()', 'none', 'dynamic-call'],
		['g <- function(f) f(1)', 'bronze', 'dynamic-call'],
		/* already resolved by name */
		['f <- get("system"); f(readline())', 'none', 'shell'],
		['do.call("system", list(readline()))', 'none', 'shell'],
		['s <- system; s(readline())', 'none', 'shell'],
		['sapply(readline(), system)', 'none', 'shell'],
		['match.fun("system")(readline())', 'none', 'shell'],
		/* a global read in a closure has the values of its definition where the closure is called */
		['x <- readline(); f <- function() eval(str2lang(x)); f()', 'none', 'code-execution']
	] as const)('%s', async(code, best, capability) => {
		const r = await run(code);
		expect(r.analyzed).toBe(true);
		expect(order.indexOf(r.tier.tier), `tier ${r.tier.tier}`).toBeGreaterThanOrEqual(order.indexOf(best));
		expect(r.findings.map(f => f.capability)).toContain(capability);
	}, 120_000);

	test.each([
		'(function(x) x)(1)',
		'f <- function() 1; f(); g <- f; g()',
		'h <- function() function(y) y; h()(2)',
		'g <- function(f) f(1); g(sum)',
		'purrr::map(1:3, ~ .x + 1); purrr::map(1:3, function(x) x + 1)',
		'Reduce(function(a, b) a + b, 1:3)',
		'library(shiny)\nserver <- function(input, output) { d <- reactive(input$n * 2); output$p <- renderText(d()) }',
		'x <- "1"; f <- function() print(x); f()'
	])('no dynamic call: %s', async code => {
		const r = await run(code);
		expect(r.analyzed).toBe(true);
		expect(r.findings.filter(f => f.capability === 'dynamic-call')).toEqual([]);
		expect(r.tier.tier).toBe('gold');
	}, 120_000);

	test('the shiny app fixture stays gold', async() => {
		const r = await analyze(path.join(__dirname, 'fixtures', 'gold'), policy, { lintInThread: true });
		expect(r.tier.tier).toBe('gold');
	}, 120_000);

	test('without a dynamic capability, dynamic calls are no finding', async() => {
		const plain = parsePolicy(text.replace(/^ {2}dynamic-call:\n(?: {4}.*\n)+/m, ''), 'plain.yaml', 'test');
		expect(Object.values(plain.capabilities).some(c => c.dynamic)).toBe(false);
		const r = await run('x <- readline(); get(x)("a")', plain);
		expect(r.findings).toEqual([]);
	}, 120_000);

	test('a policy with two dynamic capabilities fails', () => {
		expect(() => parsePolicy(text.replace(/^capabilities:\n/m, m => m + DynamicBlock + DynamicBlock.replace('dynamic-call', 'dynamic-two')), 'x.yaml', 'x')).toThrow(/only one capability can be dynamic|unique|duplicate/i);
	});
});
