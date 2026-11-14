import { beforeAll, describe, expect, test } from 'vitest';
import * as path from 'node:path';
import { analyze } from '../src/analyze';
import { loadPolicy } from '../src/policy';
import { ensureSigDb } from '../src/sigdb';

const policy = loadPolicy();
const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

describe('flowR analysis of the fixtures', () => {
	beforeAll(async() => {
		await ensureSigDb();
	}, 600_000);

	test.each([
		['gold', 'gold'],
		['silver', 'silver'],
		['bronze', 'bronze'],
		['none', 'none'],
		['param', 'bronze']
	])('%s gets %s', async(name, tier) => {
		const r = await analyze(fixture(name), policy);
		expect(r.analyzed).toBe(true);
		expect(r.tier.tier).toBe(tier);
	}, 120_000);

	test('a user value through glue reaches eval inside the package', async() => {
		const r = await analyze(fixture('bronze'), policy);
		expect(r.findings).toEqual([expect.objectContaining({ call: 'glue::glue', capability: 'code-execution', via: 'package', origins: ['outside'] })]);
	}, 120_000);

	test('Shiny reactives and renderers are trusted', async() => {
		const r = await analyze(fixture('gold'), policy);
		expect(r.findings).toEqual([]);
	}, 120_000);

	test('a folder without R files gets no tier', async() => {
		const r = await analyze(path.join(__dirname, '..', 'policies'), policy);
		expect(r.analyzed).toBe(false);
		expect(r.tier.tier).toBe('none');
	});
});
