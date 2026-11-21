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

flowR's linting rules run next to the rest of the analysis, each with a time limit (`lintTimeout`
in the policy, 120 seconds by default). A rule that takes longer is stopped and counts as not run,
so no tier that needs it is reached. (A browser without nested web workers runs the rules one after
the other, without the limit.) `lintReadTimeout` limits how long a linting worker may read the
code (900 seconds), and `timeout` the whole analysis (no limit by default; `--timeout` overrides it).

Findings carry flowR's file role: `source`, `test`, `vignette`, `install` (`inst/`), or `startup`
(`.Rprofile`). Only the roles in `shipped` (by default source, install, and startup) decide the tier;
a forbid rule can name other roles with `files:`. `allow` lists calls (regular expressions on
`pkg::fn`) that never become findings; the default policy allows none.

badgR reads scripts, Shiny apps, and R packages: a package's `DESCRIPTION` and `NAMESPACE`, its
`.Rprofile` (role `startup`), and its built vignettes in `inst/doc` (role `vignette`). A call into a
package is followed into the packages it calls in turn (as far as flowR's signature database knows them),
so `readr::write_csv` counts what `vroom` does.

The badge marks a tier checked against another policy than the default with `*` (`gold*`), and a
review that decided every finding and left none to fix with a check mark.

Playground: <https://flowr-analysis.github.io/badgR/> (runs in the browser, your code stays local).
It reads uploads, pasted code, GitHub and GitLab repositories, gists, and packages by name (`glue`,
`glue@1.8.0`, `cran:glue`, `bioc:limma`). A link to a result carries the code (or its URL), the policy
if it is not the default (`p=`), the review (`rv=`), and the selected finding (`at=`), always in the same
order, so the same result gives the same link; `&export=sarif` (or `json`, `md`, `badge`, `review`)
makes the page download that file once the analysis is done.

## Usage

```sh
npm ci
npm run sigdb                                   # once, downloads flowR's signature database
npm run badgr -- app/                           # a folder or an .R, .Rmd, or .qmd file
npm run badgr -- app/ --json report.json --md report.md --badge badge.svg
npm run badgr -- app/ --sarif badgr.sarif               # SARIF 2.1.0 for code scanning
npm run badgr -- glue@1.8.0                     # a CRAN package (or cran:glue, bioc:limma), from its GitHub mirror
npm run badgr -- app/ --min-tier silver         # exit code 2 below silver
npm run badgr -- app/ --review review.json      # reviewer decisions from the playground
```

With Docker: the image [`eagleoutice/badgr`](https://hub.docker.com/r/eagleoutice/badgr) carries flowR and its
signature database and needs no network.

```sh
docker run --rm -v "$PWD/app:/work/src:ro" eagleoutice/badgr --min-tier silver /work/src
./badgr app/ --badge badge.svg                  # the same through the wrapper; output in ./badgr-out
docker build -t badgr . && BADGR_IMAGE=badgr ./badgr app/      # an image built from this repository
```

SARIF results keep their identity across runs: rule ids are `badgr/<capability>` and
`flowr/<linting rule>`, and `partialFingerprints` hash the file, call, capability, and the text of the
line, not the line number. Findings a review tolerated or marked as false positives carry a suppression
with the reviewer's note. For GitHub code scanning:

```yaml
- run: ./badgr . --sarif badgr.sarif --review review.json
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: badgr.sarif }
```

## Development

```sh
npm test            # includes the playground in headless Chromium
npm run typecheck
npm run web:dev     # playground on http://127.0.0.1:8080, rebuilt on change
npm run web:data -- --only shiny,glue           # package data for a few packages (all of CRAN takes ~25 min)
```

CI runs the tests and the Docker image on every push. On `main` it also builds the playground with the
package data of all of CRAN and deploys it to GitHub Pages, and pushes the image to Docker Hub: `main` as `eagleoutice/badgr:latest`, a tag `v1.2.3` as
`eagleoutice/badgr:1.2.3`. CI logs in to Docker Hub with OIDC when the repository variable
`DOCKERHUB_OIDC_CONNECTIONID` names a Docker OIDC connection, and otherwise with the repository secret
`DOCKERHUB_TOKEN`, an access token with write access to `eagleoutice/badgr`. With neither, it skips the push
with a warning.

GPL-3.0-or-later, like flowR.
