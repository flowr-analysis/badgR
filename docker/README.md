# badger

badger gives R scripts, Shiny apps, and R projects a security tier: gold, silver, bronze, or
none. It uses [flowR](https://github.com/flowr-analysis/flowr) to find risky calls (running
code or commands, files, the network) and where their values come from.

- Try it in the browser, without installing anything: <https://flowr-analysis.github.io/badgR/>
- Source, issues, and releases: <https://github.com/flowr-analysis/badgR>

The image carries flowR and its full signature database (base R and all of CRAN), so it needs no
network, except to download a package or a URL. It was called `eagleoutice/badgr` before; that
image no longer gets updates.

## Usage

```sh
# a folder or an .R, .Rmd, or .qmd file, mounted read-only
docker run --rm -v "$PWD/app:/work/src:ro" eagleoutice/badger --min-tier silver /work/src
# a repository, a file behind a URL, or a CRAN package, downloaded inside the container
docker run --rm eagleoutice/badger https://github.com/owner/repo/tree/main/app
docker run --rm eagleoutice/badger glue@1.8.0
# reports and the badge, written to a mounted folder
docker run --rm -v "$PWD/app:/work/src:ro" -v "$PWD/out:/work/out" -w /work/out \
  eagleoutice/badger /work/src --badge badge.svg --sarif badger.sarif --md report.md
```

Tags: `latest` follows the main branch, `1.2.3` is the release `v1.2.3`.

## Options

<!-- the output of --help; a test keeps it in sync -->
```text
Usage: badger [options] <script.R | folder | package | url>...

Assigns a policy tier (gold, silver, bronze, or none) to R scripts, Shiny apps, and projects
with the static analysis of flowR.

A package is a CRAN package by name (glue, glue@1.8.0, cran:glue) or a Bioconductor
package (bioc:limma), downloaded once from its GitHub mirror into ~/.cache/badger/packages.
A url is read as the web page reads it: a GitHub repository, folder, or file
(https://github.com/owner/repo/tree/main/app), a gist, a GitLab project, a CRAN page, a link
of the flowR playground or of the web page, or an R file or .zip anywhere; it is downloaded
on every run into ~/.cache/badger/urls.

Options:
  --policy <file.yaml>   the policy (default: the tiers of the threat model)
  --json [file]          write the JSON report (to stdout without a file)
  --md <file | ->        write a Markdown report (- for stdout)
  --badge <file.svg | -> write the badge (- for stdout); a custom policy marks the tier with *, a review
                         (--review) that decided every finding and left none to fix with a check
  --sarif <file | ->     write SARIF 2.1.0 for code scanning (- for stdout)
  --min-tier <tier>      exit with 2 when the artifact does not reach this tier
  --review <file.json>   mark findings as a reviewer classified them (tolerated, false-positive,
                         to-fix), as the playground exports them; this never changes a tier
  --timeout <seconds>    give up on an artifact after this long (it then gets no tier)
  --sigdb-download       download the flowR signature database and exit
  --print-policy         print the policy file and exit
  --logo <file.svg>      write the badger logo and exit
  --quiet                no progress output (it goes to stderr, so --json stays clean anyway)
  --verbose              show flowR warnings
  --help                 show this help

Output: progress goes to stderr. --json without a file, and --md -, write to stdout, so
`badger app/ --json --quiet | jq .tier.tier` reads the tier.

Exit codes: 0 done, 1 error (bad arguments or policy), 2 below --min-tier.
```
