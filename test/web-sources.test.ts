import { Playground } from '@eagleoutice/flowr/util/text/playground-link';
import { describe, expect, test } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { packagesNamed } from '../web/packages';
import { describeUrl, fromUrl, fromZip, parseGitHub, stripCommonRoot, uniquePaths } from '../web/sources';

describe('what the page reads', () => {
	test.each([
		['https://github.com/o/r', { owner: 'o', repo: 'r', ref: undefined, path: '', blob: false }],
		['https://github.com/o/r.git', { owner: 'o', repo: 'r', ref: undefined, path: '', blob: false }],
		['https://github.com/o/r/tree/main/inst/app/', { owner: 'o', repo: 'r', ref: 'main', path: 'inst/app', blob: false }],
		['https://github.com/o/r/blob/v1.0/app.R', { owner: 'o', repo: 'r', ref: 'v1.0', path: 'app.R', blob: true }],
		['https://example.org/app.R', undefined]
	])('parses %s', (url, expected) => {
		expect(parseGitHub(url)).toEqual(expected);
	});

	test('strips the folder all files share', () => {
		expect(stripCommonRoot([{ path: 'repo-main/app.R', content: '' }, { path: 'repo-main/R/a.R', content: '' }]).map(f => f.path)).toEqual(['app.R', 'R/a.R']);
		expect(stripCommonRoot([{ path: 'app.R', content: '' }]).map(f => f.path)).toEqual(['app.R']);
	});

	test('numbers files of the same name', () => {
		expect(uniquePaths([{ path: 'app.R', content: '1' }, { path: 'app.R', content: '2' }, { path: 'x/app.R', content: '3' }]).map(f => f.path))
			.toEqual(['app.R', 'app (2).R', 'x/app.R']);
	});

	test('unpacks the R files of a zip and skips the rest', () => {
		const zip = zipSync({
			'proj/app.R': strToU8('system("ls")'),
			'proj/README.md': strToU8('# hi'),
			'proj/renv/library/x.R': strToU8('eval(1)'),
			'proj/DESCRIPTION': strToU8('Package: p\nImports: glue')
		});
		expect(fromZip(zip).map(f => f.path).sort()).toEqual(['DESCRIPTION', 'app.R']);
	});

	test('finds the packages a project names', () => {
		const names = packagesNamed([
			{ path: 'app.R', content: 'library(shiny)\nrequire("DT")\nx <- glue::glue("a")\npacman::p_load(dplyr, "tidyr")\nrequireNamespace(\'httr\')' },
			{ path: 'DESCRIPTION', content: 'Package: p\nImports:\n    jsonlite (>= 1.0),\n    processx\nSuggests: testthat\n' }
		]);
		expect([...names].sort()).toEqual(['DT', 'dplyr', 'glue', 'httr', 'jsonlite', 'pacman', 'processx', 'shiny', 'tidyr']);
	});

	describe('links', () => {
		test('names what each kind of link is', () => {
			const kind = (u: string) => describeUrl(u)?.kind;
			expect(kind('flowr-analysis/flowr')).toBe('github');
			expect(kind('https://github.com/rstudio/shiny-examples/tree/main/001-hello')).toBe('github');
			expect(kind('https://gist.github.com/someone/0123abcd')).toBe('gist');
			expect(kind('https://gitlab.com/group/project')).toBe('gitlab');
			expect(kind('https://cran.r-project.org/package=glue')).toBe('cran');
			expect(kind('https://cran.r-project.org/web/packages/shiny/index.html')).toBe('cran');
			expect(kind('https://someone.shinyapps.io/app/')).toBe('shiny-deployment');
			expect(kind(Playground.link({ code: 'x <- 1' }))).toBe('playground');
			expect(kind('https://example.org/badgr/#z=abc&tier=gold')).toBe('own');
			expect(kind('https://example.org/script.R')).toBe('file');
		});

		test('reads the code of a flowR playground link, with all its files, without a request', async() => {
			const link = Playground.link({ code: 'system(readline())', name: 'app.R', files: [{ name: 'R/helper.R', code: 'f <- function(x) eval(x)' }] });
			const files = await fromUrl(link);
			expect(files).toEqual([{ path: 'R/helper.R', content: 'f <- function(x) eval(x)' }, { path: 'app.R', content: 'system(readline())' }]);
		});

		test('explains that a running Shiny app does not hand out its code', async() => {
			await expect(fromUrl('https://someone.shinyapps.io/app/')).rejects.toThrow(/repository/);
		});
	});
});
