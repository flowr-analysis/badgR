# badger

badger checks R scripts, Shiny apps, and R projects against a policy and gives them the
strictest of its tiers they meet: gold, silver, bronze, or none. It uses [flowR](https://github.com/flowr-analysis/flowr) to find risky calls (running
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

<!-- CI puts the output of --help of the pushed image here -->
