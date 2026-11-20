import { Playground } from '@eagleoutice/flowr/util/text/playground-link';
import { describe, expect, test } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { packagesNamed } from '../web/packages';
import { cranPackage, describeUrl, fromUrl, fromZip, normalizeUrl, parseGitHub, stripCommonRoot, uniquePaths } from '../web/sources';

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
			'proj/rv/library/4.6/x/R/y.R': strToU8('eval(1)'),
			'proj/rv/scripts/activate.R': strToU8('x <- 1'),
			'proj/DESCRIPTION': strToU8('Package: p\nImports: glue')
		});
		expect(fromZip(zip).map(f => f.path).sort()).toEqual(['DESCRIPTION', 'app.R', 'rv/scripts/activate.R']);
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

		test.each([
			['glue', 'https://cran.r-project.org/package=glue'],
			['data.table', 'https://cran.r-project.org/package=data.table'],
			['glue@1.8.0', 'https://cran.r-project.org/package=glue&version=1.8.0'],
			['cran:glue', 'https://cran.r-project.org/package=glue'],
			['CRAN: glue', 'https://cran.r-project.org/package=glue'],
			['bioc:limma', 'https://bioconductor.org/packages/limma'],
			['example.org', 'https://example.org'],
			['owner/repo', 'https://github.com/owner/repo'],
			['  https://x.org/a.R ', 'https://x.org/a.R']
		])('reads %s as %s', (input, url) => {
			expect(normalizeUrl(input)).toBe(url);
		});

		test.each([
			['https://cran.r-project.org/package=glue', { name: 'glue' }],
			['https://CRAN.R-project.org/package=data.table', { name: 'data.table' }],
			['https://cran.r-project.org/web/packages/shiny/index.html', { name: 'shiny' }],
			['https://cloud.r-project.org/web/packages/fs/', { name: 'fs' }],
			['https://cran.rstudio.com/web/packages/fs/index.html', { name: 'fs' }],
			['https://cran.r-project.org/src/contrib/glue_1.8.0.tar.gz', { name: 'glue', version: '1.8.0' }],
			['https://cran.r-project.org/src/contrib/Archive/glue/glue_1.6.2.tar.gz', { name: 'glue', version: '1.6.2' }],
			['https://cran.dev/glue', { name: 'glue' }],
			['https://github.com/cran/glue', undefined],
			['https://example.org/package=glue', undefined]
		])('finds the CRAN package of %s', (url, pkg) => {
			expect(cranPackage(url)).toEqual(pkg);
		});

		test('names packages by name, Bioconductor packages, and links of this page to a repository', () => {
			const kind = (u: string) => describeUrl(u)?.kind;
			expect(kind('glue')).toBe('cran');
			expect(kind('glue@1.8.0')).toBe('cran');
			expect(describeUrl('glue@1.8.0')?.note).toContain('glue 1.8.0');
			expect(kind('bioc:limma')).toBe('bioc');
			expect(kind('https://bioconductor.org/packages/release/bioc/html/limma.html')).toBe('bioc');
			expect(kind(`https://example.org/badgr/#url=${encodeURIComponent('https://github.com/o/r')}&tier=gold`)).toBe('github');
			expect(kind('example.org')).toBe('file');
		});

		test('fetches a CRAN package, at a version, from its GitHub mirror, and a badgR link from where it points', async() => {
			const asked: string[] = [];
			const real = globalThis.fetch;
			globalThis.fetch = (async(input: string | URL | Request) => {
				const url = String(input);
				asked.push(url);
				if(url.includes('/git/trees/')) {
					return new Response(JSON.stringify({ tree: [{ path: 'R/a.R', type: 'blob' }, { path: 'DESCRIPTION', type: 'blob' }, { path: 'README.md', type: 'blob' }], truncated: false }));
				}
				if(url.startsWith('https://api.github.com/repos/')) {
					return new Response(JSON.stringify({ default_branch: 'master' }));
				}
				return new Response(url.endsWith('DESCRIPTION') ? 'Package: glue' : 'x <- 1');
			}) as typeof fetch;
			try {
				const files = await fromUrl('glue@1.6.2');
				expect(files.map(f => f.path)).toEqual(['DESCRIPTION', 'R/a.R']);
				expect(asked).toContain('https://api.github.com/repos/cran/glue/git/trees/1.6.2?recursive=1');
				expect(asked.some(u => u.startsWith('https://raw.githubusercontent.com/cran/glue/1.6.2/'))).toBe(true);
				asked.length = 0;
				await fromUrl(`https://example.org/badgr/#url=${encodeURIComponent('cran:glue')}&tier=gold`);
				expect(asked[0]).toBe('https://api.github.com/repos/cran/glue');
				expect(asked).toContain('https://api.github.com/repos/cran/glue/git/trees/master?recursive=1');
			} finally {
				globalThis.fetch = real;
			}
		});

		test('explains that a running Shiny app does not hand out its code', async() => {
			await expect(fromUrl('https://someone.shinyapps.io/app/')).rejects.toThrow(/repository/);
		});
	});
});
