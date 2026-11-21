import { describe, expect, test } from 'vitest';
import { applyReview, findingKey, parseReview, reviewFile } from '../src/review';
import type { Finding } from '../src/tiers';

const f: Finding = { id: '1', file: 'app.R', loc: [4, 3, 4, 20], call: 'base::system', capability: 'shell', class: 'severe', via: 'direct', origins: ['outside'], inputTypes: ['user'] };

describe('the review', () => {
	test('finds its finding by file, call, capability, via, and line text, not by line number', () => {
		const key = findingKey(f, '  system(paste("ls", x))');
		const report = { findings: [{ ...f, loc: [40, 3, 40, 20] as const }] };
		const out = applyReview(report, [{ key, state: 'tolerated', note: 'fixed command' }], x => x, () => 'system(paste("ls",   x))  ');
		expect(out.findings[0].review).toEqual({ state: 'tolerated', note: 'fixed command' });
	});

	test('does not match a changed line, so an edit asks for a new review', () => {
		const key = findingKey(f, 'system(paste("ls", x))');
		const out = applyReview({ findings: [f] }, [{ key, state: 'tolerated' }], x => x, () => 'system(x)');
		expect(out.findings[0].review).toBeUndefined();
	});

	test('reads its own files and plain lists, and drops entries it does not know', () => {
		const file = JSON.stringify(reviewFile([{ key: 'b', state: 'to-fix' }, { key: 'a', state: 'false-positive' }]));
		expect(parseReview(file).map(e => e.key)).toEqual(['a', 'b']);
		expect(parseReview(JSON.stringify([{ key: 'x', state: 'tolerated' }, { key: 'y', state: 'ignored' }]))).toEqual([{ key: 'x', state: 'tolerated' }]);
	});
});

describe('the review, hostile input', () => {
	test('a JSON null, a number, or entries that are no list read as no entries', () => {
		expect(parseReview('null')).toEqual([]);
		expect(parseReview('3')).toEqual([]);
		expect(parseReview('{"entries": {"a": 1}}')).toEqual([]);
	});

	test('entries are sorted by code point, the same in every locale', () => {
		const keys = ['b', 'B', 'a', 'Z', 'é', 'e'];
		expect(reviewFile(keys.map(key => ({ key, state: 'tolerated' as const }))).entries.map(e => e.key)).toEqual(['B', 'Z', 'a', 'b', 'e', 'é']);
	});
});
