<img src="assets/badgr-logo.svg" width="90" align="right" alt="">

# badgR

badgR gives R scripts, Shiny apps, and R projects a security tier: gold, silver, bronze, or none.
It uses [flowR](https://github.com/flowr-analysis/flowr) to find risky calls (running code or
commands, files, the network) and where their values come from.

| Tier | Requirement | Left to review by hand |
|---|---|---|
| gold | Nothing leaves the app, and other risky calls only use values written in the code. | deployment and access control |
| silver | No value from users, files, or the network reaches a dangerous call. | the remaining findings |
| bronze | Such values reach dangerous calls only inside packages. | also those package calls |
| none | anything else | everything |

The tiers follow *A Threat Model for R / Shiny Applications*. `policies/default.yaml` defines them;
pass your own with `--policy`.

Playground: <https://flowr-analysis.github.io/badgR/> (runs in the browser, your code stays local)

## Usage

```sh
npm ci
npm run sigdb                                   # once, downloads flowR's signature database
npm run badgr -- app/                           # a folder or an .R, .Rmd, or .qmd file
npm run badgr -- app/ --json report.json --md report.md --badge badge.svg
npm run badgr -- app/ --min-tier silver         # exit code 2 below silver
npm run badgr -- app/ --review review.json      # reviewer decisions from the playground
```

With Docker, which needs no network once built:

```sh
docker build -t badgr .
./badgr app/ --badge badge.svg                  # output in ./badgr-out
```

## Development

```sh
npm test            # includes the playground in headless Chromium
npm run typecheck
npm run web:dev     # playground on http://127.0.0.1:8080, rebuilt on change
npm run web:data -- --only shiny,glue           # package data for a few packages (all of CRAN takes ~25 min)
```

CI runs the tests and the Docker image on every push. On `main` it also builds the playground with the
package data of all of CRAN and deploys it to GitHub Pages.

GPL-3.0-or-later, like flowR.
