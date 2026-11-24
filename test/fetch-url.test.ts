import { afterEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchUrl, urlFolder, urlSpec } from '../src/fetch-url';

describe('links on the command line', () => {
	test.each([
		['https://github.com/o/r', 'https://github.com/o/r'],
		['HTTP://example.org/app.R', 'HTTP://example.org/app.R'],
		['github.com/o/r/tree/main/app', 'https://github.com/o/r/tree/main/app'],
		['gist.github.com/someone/0123abcd', 'https://gist.github.com/someone/0123abcd'],
		['app.R', undefined],
		['some/folder', undefined],
		['glue', undefined],
		['cran:glue', undefined]
	])('reads %s', (target, url) => {
		expect(urlSpec(target, () => false)).toBe(url);
	});

	test('a folder that looks like a host is a path when it exists', () => {
		expect(urlSpec('example.org/app', () => true)).toBeUndefined();
	});

	test('two links never share a folder', () => {
		expect(urlFolder('https://example.org/a.R')).not.toBe(urlFolder('https://example.org/a.R?x'));
		expect(path.basename(urlFolder('https://example.org/a.R'))).toMatch(/^example\.org-a\.R-[0-9a-f]{10}$/);
	});

	describe('downloads', () => {
		const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'badger-url-'));
		afterEach(() => {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		});

		test('an R file behind a link lands in its own folder, fresh on every run', async() => {
			vi.stubEnv('XDG_CACHE_HOME', cache);
			let body = 'x <- 1\n';
			vi.stubGlobal('fetch', vi.fn(async() => new Response(body)));
			const dir = await fetchUrl('https://example.org/code/app.R');
			expect(fs.readFileSync(path.join(dir, 'app.R'), 'utf-8')).toBe('x <- 1\n');
			body = 'x <- 2\n';
			expect(fs.readFileSync(path.join(await fetchUrl('https://example.org/code/app.R'), 'app.R'), 'utf-8')).toBe('x <- 2\n');
		});

		test('a missing file is told with its status', async() => {
			vi.stubEnv('XDG_CACHE_HOME', cache);
			vi.stubGlobal('fetch', vi.fn(async() => new Response('', { status: 404 })));
			await expect(fetchUrl('https://example.org/missing.R')).rejects.toThrow(/404/);
		});
	});
});
