# Known issues (after the 0.2.0 counterexample rounds)

Open cases from the adversarial rounds, ordered by how wrong the tier is. The full snippets and outputs are in the
session's hunt reports (`hunt/REPORT.md`, `hunt2/REPORT.md`, `break2/REPORT.md`, `r1-opus/REPORT.md`); the flowR changes
that would replace badgR's workarounds are planned in `r1-opus/FLOWR-PLAN.md`.

## Tier too good (unsound)

- `f <- function(...) system(..1); f(readline())` gets **bronze** (origin `parameter`; deserved none): flowR does not link
  `..N` to the call's arguments (FLOWR-PLAN 1).
- flowR's signature database does not list the `.Call` inside Rcpp/cpp11 wrappers (`py_run_string_impl`, `vroom_write_`), so a
  package's native code is only seen when the wrapper's caller is in the database (FLOWR-PLAN 2).
- Code evaluated in data badgR cannot see (`with(readRDS(f), mean(x))`): a name flowR resolves (`mean`) is trusted, though the
  data could rebind it; only names flowR resolves to nothing become dynamic calls there.
- A reactive handed to a lambda of a higher-order helper (`r <- reactive(input$c); system(sapply(list(r), function(f) f()))`,
  also `Reduce(function(a, b) b(), list(r), NULL)`) gets **bronze** (origin `parameter`; deserved none): the lambda's parameter is not
  traced to the elements of the list its helper is given.
- A function a Shiny module returns that is computed (`moduleServer(id, function(...) get(input$n))`, then `y <- mod("a"); y()`) is a
  dynamic call with origin `unknown` only (bronze; deserved none): the value the module computes is not followed.
- `ggplot2::ggsave(readline(), p)` is **gold** (deserved silver, a file write): the signature database does not show the device call
  `ggsave` makes. `ggsave` is excluded from the trusted ggplot2 functions, so a future database entry will count.
- R6/RefClass objects are trusted when the class's members are function definitions or constants and the class is not changed
  with `$set()`/`$methods()`; members changed through other routes (`C[["set"]](...)`, `assign(..., envir = obj)`) are not seen.

## False positives

- `function(f) f(1)` (a function called through a parameter, with no caller in the code) blocks silver, as `eval(param)` does:
  by the policy, a parameter in a dangerous call of the app is not silver. With callers in the code, flowR resolves them.
- `readRDS(system.file(...))` (serialization is severe) and tempfile round trips (`writeLines`/`readLines` are outward) lose
  gold by the policy's classes, not by their origins.
- `environment(f) <- e; f()` is a dynamic call (bronze): the new environment can change what `f`'s free names mean.
- `with(read.csv(f), foo(x))` with an unresolved `foo` is a dynamic call: the data could hold a function named `foo`.
- `fs <- list(sq = function(x) x^2); fs[[n]](2)`, `rr <- list(a = reactive(...)); rr$a()`, R6 `super$f()` and `self$f(x)` with a
  function field set from a parameter: dynamic calls (bronze); the call is through a list element or field, not resolved by flowR.
- `eval(quote(foo(1)))` with an unresolved `foo` is a dynamic call (silver), unlike a plain `foo(1)`.

## By design, worth a decision

- `Sys.getenv` is the origin `system`, which silver trusts.
- `unlink(user)` and other destructive calls are class `outward`: only gold forbids them.
- `httr::GET(user)`, `DBI::dbGetQuery(con, paste0("SELECT ", user))` are silver (outward / other): silver forbids only severe.
- `tier=` and `n=` of a shared link are shown before the analysis runs again, so a link can claim a tier until then.
- `export=` downloads a file when the analysis of a link is done, without a click.

## Fixed in round r2 (tests in `test/counterexamples.test.ts`)

- `f <- get("sum"); f(1)`, `match.fun("mean")` were a dynamic call (silver) since r1 ("computed on another path"): a literal name is resolved.
- `r <- reactive(...) |> bindEvent(...)`, a reactive given to or returned from a Shiny module, and `optim(1, function(x) x^2)`,
  `integrate(...)`, `uniroot(...)` (flowR links them to the names the lambda uses): no longer dynamic calls.
- `tags$div(...)` (an object of an attached package, member called) was a dynamic call (bronze).
- Reactives chained more than three times, piped into `bindEvent`, in lists, handed to modules and returned from modules: values trace to `input`.
- ggplot2 (except `ggsave`) and dplyr's `across`/`if_any`/`if_all`/`c_across`/`pick` are trusted packages (were silver by `eval`/`.Call` inside).

## Fixed in round r1 (tests in `test/counterexamples.test.ts`)

- Quoted code that runs (`future(...)`, `delayedAssign`, `trace(f, quote(...))`, `e <- quote(...); eval(e)`, `eval(substitute(x))`):
  its calls count when the quoting call, or a call its value reaches, is a severe capability. `eval(quote(1))` is gold now.
- `with`/`within`/`transform`/`subset`/`eval(envir =)`/`evalq`/`local(envir =)`/`substitute(env =)`: a call whose name the data
  defines is a dynamic call that traces the data; dangerous calls in the masked code trace the data too.
- `base::"system"(x)` (quoted callee names behind `::`).
- Function values handed to other calls (`Negate(system)`, `Vectorize(system)`, `Reduce(..., system)`, `sapply(FUN = system)`,
  `do.call(Negate(system), ...)`, `R6Class(public = list(f = system))`), lambdas handed to higher-order functions
  (`purrr::walk(x, ~system(.x))`, `Vectorize(function(x) system(x))`), and functions made by wrappers and factories.
- Shiny `reactive()`, `isolate()`, `reactiveVal()`, `reactiveValues()`, `debounce()`: a call returning a value of unknown source
  traces its arguments, the call that made its function, and the other calls of that function. Same for S4 slots and R6/RefClass fields.
- Parameters are traced to the arguments of their calls (`g <- function(f) f(1); g(get(readline()))`).
- A callee resolved on one path but computed on another (`f <- if (c) function() 1 else get(x)`) is a dynamic call.
- `knitr::knit(user)`, `rmarkdown::render(user)` were bronze: rendering is `code-download` now (none with a user path).
- `cat(x, file = path)`, `capture.output(file =)`, `dput(file =)` are `network-file` (new policy key `withArgument`).
- False positives fixed: `C$new()$add(2)` for R6 and RefClass generators, `Vectorize(function(x, y) x + y)`, `Negate(is.null)`,
  `setClass(...)` (flowR's synthetic `S7::S7_dispatch` calls), function factories (`compose(f, g)`), `shiny::debounce`.
