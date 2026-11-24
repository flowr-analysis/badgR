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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-cx-'));
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
		/* quoted code that runs: its calls count */
		['future::future(system(readline()))', 'none', 'shell'],
		['delayedAssign("y", system(readline())); y', 'none', 'shell'],
		['trace(print, quote(system(readline())))', 'none', 'shell'],
		['e <- quote(system(readline())); eval(e)', 'none', 'shell'],
		['ex <- expression(system(readline())); eval(ex[[1]])', 'none', 'shell'],
		['f <- function(x) eval(substitute(x)); f(system(readline()))', 'none', 'shell'],
		['eval(quote(system(readline())))', 'none', 'shell'],
		/* code evaluated in data that defines its names or values */
		['with(list(f = system), f(readline()))', 'none', 'dynamic-call'],
		['within(list(f = system), f(readline()))', 'none', 'dynamic-call'],
		['with(list(mean = system), mean(readline()))', 'none', 'dynamic-call'],
		['l <- list(mean = system); with(l, mean(readline()))', 'none', 'dynamic-call'],
		['transform(list(f = system), b = f(readline()))', 'none', 'dynamic-call'],
		['eval(quote(f(readline())), list(f = system))', 'none', 'dynamic-call'],
		['local(f(readline()), envir = list2env(list(f = system)))', 'none', 'dynamic-call'],
		['with(list(x = readline()), system(x))', 'none', 'shell'],
		['e <- list2env(list(v = readline())); with(e, system(v))', 'none', 'shell'],
		['eval(substitute(system(x), list(x = readline())))', 'none', 'shell'],
		/* a string callee behind :: */
		['base::"system"(readline())', 'none', 'shell'],
		['base::"system"("ls")', 'silver', 'shell'],
		/* functions handed on as values, and lambdas handed to higher-order functions */
		['Reduce(function(f, x) f(x), list(readline()), system)', 'none', 'shell'],
		['Negate(system)(readline())', 'none', 'shell'],
		['Vectorize(system)(readline())', 'none', 'shell'],
		['Vectorize(function(x) system(x))(readline())', 'none', 'shell'],
		['readline() |> sapply(FUN = system)', 'none', 'shell'],
		['do.call(Negate(system), list(readline()))', 'none', 'shell'],
		['purrr::walk(readline(), ~system(.x))', 'none', 'shell'],
		['C <- R6::R6Class("C", public = list(f = system)); C$new()$f(readline())', 'none', 'shell'],
		/* values that pass through Shiny's reactives, R6 fields, and S4 slots */
		['library(shiny)\nserver <- function(input, output, session) { r <- reactive(input$cmd); observe(system(r())) }', 'none', 'shell'],
		['library(shiny)\nserver <- function(input, output, session) observe(system(isolate(input$cmd)))', 'none', 'shell'],
		['library(shiny)\nserver <- function(input, output, session) { v <- reactiveVal(); observeEvent(input$go, v(input$cmd)); observe(system(v())) }', 'none', 'shell'],
		['C <- R6::R6Class("C", public = list(c = NULL, initialize = function(c) self$c <- c, run = function() system(self$c))); C$new(readline())$run()', 'none', 'shell'],
		['setClass("A", representation(x = "character")); a <- new("A", x = readline()); system(a@x)', 'none', 'shell'],
		/* a callee resolved on one path, computed on another */
		['f <- if (runif(1) > 0.5) function(x) 1 else get(readline()); f(2)', 'none', 'dynamic-call'],
		['C <- R6::R6Class("C", public = list(f = NULL)); o <- C$new(); o$f <- get(readline()); o$f(1)', 'none', 'dynamic-call'],
		['C <- R6::R6Class("C", public = list(g = function() 1)); C$set("public", "f", system); C$new()$f(readline())', 'none', 'dynamic-call'],
		['n <- Negate(get(readline())); n(1)', 'none', 'dynamic-call'],
		/* functions that wrappers and factories make, and parameters that are called */
		['mk <- function() function(x) system(x); h <- mk(); h(readline())', 'none', 'shell'],
		['v <- Vectorize(function(x) system(x)); v(readline())', 'none', 'shell'],
		['g <- function(x) system(x); v <- Vectorize(g); v(readline())', 'none', 'shell'],
		['g <- function(f) f(1); g(get(readline()))', 'none', 'dynamic-call'],
		['library(shiny)\nserver <- function(input, output, session) { d <- debounce(reactive(input$x), 500); observe(system(d())) }', 'none', 'shell'],
		['library(shiny)\nserver <- function(input, output, session) { rv <- reactiveValues(a = NULL); observeEvent(input$go, rv$a <- input$cmd); observe(system(rv$a)) }', 'none', 'shell'],
		['A <- setRefClass("A", fields = list(c = "character"), methods = list(run = function() system(c))); A$new(c = readline())$run()', 'none', 'shell'],
		['A <- setRefClass("A", fields = list(n = "numeric")); A$methods(f = system); A$new()$f(readline())', 'none', 'dynamic-call'],
		['knitr::knit(readline())', 'none', 'code-download'],
		['rmarkdown::render(readline())', 'none', 'code-download'],
		/* reactives chained, piped, listed, and passed between modules */
		['library(shiny)\nserver <- function(input, output, session) { a <- reactive(input$c); b <- reactive(a()); r3 <- reactive(b()); observe(system(r3())) }', 'none', 'shell'],
		['library(shiny)\nserver <- function(input, output, session) { r <- reactive(input$c) |> bindEvent(input$go); observe(system(r())) }', 'none', 'shell'],
		['library(shiny)\nmodServer <- function(id, cmd) moduleServer(id, function(input, output, session) observe(system(cmd()))); server <- function(input, output, session) { r <- reactive(input$c); modServer(\'a\', r) }', 'none', 'shell'],
		['library(shiny)\nmodServer <- function(id) moduleServer(id, function(input, output, session) reactive(input$c)); server <- function(input, output, session) { y <- modServer(\'a\'); observe(system(y())) }', 'none', 'shell'],
		['library(shiny)\nmodA <- function(id) moduleServer(id, function(input, output, session) reactive(input$c)); modB <- function(id, cc) moduleServer(id, function(input, output, session) observe(system(cc()))); server <- function(input, output, session) { y <- modA(\'a\'); modB(\'b\', y) }', 'none', 'shell'],
		['library(shiny)\nserver <- function(input, output, session) { r <- reactive(input$c); l <- list(r = r); observe(system(l$r())) }', 'none', 'shell'],
		/* cat() and the like with a file */
		['cat(readline(), file = "out.txt")', 'silver', 'network-file'],
		['capture.output(print(1), file = readline())', 'silver', 'network-file'],
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
		'testthat::expect_equal(1, 1)',
		'with(mtcars, mean(mpg))',
		'df <- data.frame(a = 1:3); with(df, sum(a))',
		'subset(mtcars, mpg > 20, select = c(mpg, hp))',
		'q <- quote(mean(x)); print(q)',
		'testthat::expect_error(stop("x"))',
		'cat("hello\\n")',
		'eval(quote(1))',
		'evalq(mean(1:3))',
		'f <- if (runif(1) > 0.5) mean else median; f(2)',
		'f <- local(function(x) x); f(1)',
		'C <- R6::R6Class("C", public = list(add = function(x) x + 1)); C$new()$add(2)',
		'C <- R6::R6Class("C", public = list(n = 0, add = function(x) x + 1)); o <- C$new(); o$add(2)',
		'v <- Vectorize(function(x, y) x + y); v(1:3, 2)',
		'n <- Negate(is.null); n(1)',
		'setClass("P", representation(x = "numeric")); p <- new("P", x = 1); p@x',
		'compose <- function(f, g) function(x) g(f(x)); h <- compose(sqrt, abs); h(4)',
		'A <- setRefClass("A", fields = list(n = "numeric"), methods = list(inc = function() n <<- n + 1)); a <- A$new(n = 1); a$inc()',
		'library(shiny)\nserver <- function(input, output, session) { d <- debounce(reactive(input$x), 500); observe(print(d())) }\nshinyApp(fluidPage(), server)',
		'f <- match.fun(\'mean\'); f(1:3); g <- get(\'sum\'); g(1:2)',
		'x <- optim(1, function(x) x^2); integrate(function(x) x, 0, 1); uniroot(function(x) x - 1, c(0, 2))',
		'library(shiny)\nserver <- function(input, output, session) { r <- reactive(input$a) |> bindEvent(input$go); output$o <- renderText(r()) }',
		'library(shiny)\nmodServer <- function(id, x) moduleServer(id, function(input, output, session) { r <- reactive(input$n * x()); output$o <- renderText(r()); r })\nserver <- function(input, output, session) { x <- reactive(2); y <- modServer(\'a\', x); z <- modServer(\'b\', y) }',
		'library(shiny)\nx <- tags$div(class = \'a\', tags$p(\'b\'))',
		'library(ggplot2)\nggplot(mtcars, aes(mpg, cyl)) + geom_point() + theme_minimal() + facet_wrap(~cyl) + scale_x_continuous()',
		'library(dplyr)\nmtcars %>% mutate(across(everything(), ~ .x * 2)) %>% filter(if_any(everything(), ~ .x > 1))'
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
