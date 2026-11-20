import { describe, expect, test } from 'vitest';
import { archiveUrl, packageSpec, untar } from '../src/fetch-package';

/** a tar archive of the given files, as GitHub's archives are: ustar, with a pax header for a long name */
function tar(files: Record<string, string>): Uint8Array {
	const blocks: Uint8Array[] = [];
	const header = (name: string, size: number, type: string) => {
		const h = new Uint8Array(512);
		const put = (at: number, s: string) => h.set(new TextEncoder().encode(s), at);
		put(0, name.slice(0, 99));
		put(100, '0000644\0');
		put(124, size.toString(8).padStart(11, '0') + '\0');
		put(156, type);
		put(257, 'ustar\x0000');
		return h;
	};
	const body = (data: Uint8Array) => {
		const b = new Uint8Array(Math.ceil(data.length / 512) * 512);
		b.set(data);
		return b;
	};
	for(const [name, content] of Object.entries(files)) {
		const data = new TextEncoder().encode(content);
		if(name.length > 99) {
			const rec = ` path=${name}\n`;
			const pax = new TextEncoder().encode(`${rec.length + String(rec.length + 2).length}${rec}`);
			blocks.push(header('pax', pax.length, 'x'), body(pax));
		}
		blocks.push(header(name, data.length, '0'), body(data));
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for(const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}

describe('packages by name', () => {
	test.each([
		['glue', { repo: 'cran', name: 'glue' }],
		['data.table', { repo: 'cran', name: 'data.table' }],
		['glue@1.8.0', { repo: 'cran', name: 'glue', version: '1.8.0' }],
		['cran:glue', { repo: 'cran', name: 'glue' }],
		['bioc:limma', { repo: 'bioc', name: 'limma' }],
		['app.R', undefined],
		['./app', undefined],
		['some/folder', undefined]
	])('reads %s', (target, spec) => {
		expect(packageSpec(target, () => false)).toEqual(spec);
	});

	test('a bare name that exists on disk is a path; with a version or a prefix it never is', () => {
		expect(packageSpec('glue', () => true)).toBeUndefined();
		expect(packageSpec('glue@1.0.0', () => true)).toEqual({ repo: 'cran', name: 'glue', version: '1.0.0' });
		expect(packageSpec('cran:glue', () => true)).toEqual({ repo: 'cran', name: 'glue' });
	});

	test('downloads from the GitHub mirror, a version by its tag', () => {
		expect(archiveUrl({ repo: 'cran', name: 'glue' })).toBe('https://codeload.github.com/cran/glue/tar.gz/HEAD');
		expect(archiveUrl({ repo: 'cran', name: 'glue', version: '1.8.0' })).toBe('https://codeload.github.com/cran/glue/tar.gz/refs/tags/1.8.0');
	});

	test('reads a tar archive, long names included', () => {
		const long = `glue-1.8.0/${'deep/'.repeat(22)}x.R`;
		const files = untar(tar({ 'glue-1.8.0/DESCRIPTION': 'Package: glue', 'glue-1.8.0/R/glue.R': 'glue <- function() 1', [long]: 'y <- 2' }));
		expect(files.map(f => [f.path, new TextDecoder().decode(f.content)])).toEqual([
			['glue-1.8.0/DESCRIPTION', 'Package: glue'], ['glue-1.8.0/R/glue.R', 'glue <- function() 1'], [long, 'y <- 2']
		]);
	});
});

describe('damaged archives', () => {
	test('a negative or oversized entry size is an error, not an endless loop', () => {
		const h = new Uint8Array(1024);
		h.set(new TextEncoder().encode('r/a.R'), 0);
		h.set(new TextEncoder().encode('-0001000\0'), 124);
		h[156] = 48;
		expect(() => untar(h)).toThrow(/damaged tar archive/);
		h.set(new TextEncoder().encode('77777777\0'), 124);
		expect(() => untar(h)).toThrow(/damaged tar archive/);
	});

	test('a bare host is no package, as on the web page', () => {
		expect(packageSpec('shiny.io', () => false)).toBeUndefined();
		expect(packageSpec('data.table', () => false)).toEqual({ repo: 'cran', name: 'data.table' });
	});
});
