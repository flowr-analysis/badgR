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

	test('a linting rule over the time limit is stopped, and no tier that needs it is reached', async() => {
		const r = await analyze(fixture('gold'), { ...policy, lintTimeout: 0.001 });
		expect(r.tier.tier).not.toBe('gold');
		/* a timer of 1 ms can fire late on a busy machine, after a quick rule already answered: most, not all, are stopped */
		expect(r.lint.filter(l => l.error !== undefined).map(l => l.error)).toEqual(r.lint.filter(l => l.error !== undefined).map(() => expect.stringMatching(/^stopped after 0.001 s/)));
		expect(r.lint.filter(l => l.error !== undefined).length).toBeGreaterThan(0);
	}, 120_000);

	test('the linting rules give the same results in their threads as in this one', async() => {
		const [threads, here] = await Promise.all([analyze(fixture('none'), policy), analyze(fixture('none'), policy, { lintInThread: true })]);
		expect(threads.lint).toEqual(here.lint);
		expect(threads.tier).toEqual(here.tier);
	}, 120_000);

	test('flowR\'s file roles split the findings, and only the shipped ones decide the tier', async() => {
		const r = await analyze(fixture('roles'), policy);
		expect(r.findings.map(f => [f.call, f.role, f.origins])).toEqual(expect.arrayContaining([
			[expect.stringMatching(/system$/), 'source', ['author']],
			[expect.stringMatching(/system$/), 'test', expect.arrayContaining(['outside'])]
		]));
		/* the user value in the test would give none, the constant in R/ gives silver */
		expect(r.tier.tier).toBe('silver');
		const all = await analyze(fixture('roles'), { ...policy, shipped: ['source', 'test'] });
		expect(all.tier.tier).toBe('none');
	}, 120_000);

	test('allowed calls never become findings', async() => {
		const r = await analyze(fixture('roles'), { ...policy, allow: ['system$'] });
		expect(r.findings.filter(f => f.call.endsWith('system'))).toEqual([]);
	}, 120_000);

	test('the policy\'s time limit stops the whole analysis', async() => {
		const r = await analyze(fixture('gold'), { ...policy, timeout: 0.001 });
		expect(r.analyzed).toBe(false);
		expect(r.error).toMatch(/timeout/);
	}, 120_000);

	test('a folder without R files gets no tier', async() => {
		const r = await analyze(path.join(__dirname, '..', 'policies'), policy);
		expect(r.analyzed).toBe(false);
		expect(r.tier.tier).toBe('none');
	});
});
