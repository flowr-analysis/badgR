import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPolicy, PolicyError } from '../src/policy';
import { assignTier, matchesRule, type Finding, type LintSummary } from '../src/tiers';

const policy = loadPolicy();
const clean: LintSummary[] = ['secret-exfiltration', 'process-state-in-session', 'no-leaked-credentials'].map(rule => ({ rule, count: 0, results: [] }));

function finding(p: Partial<Finding>): Finding {
	return { id: '1', call: 'base::system', capability: 'shell', class: 'severe', via: 'direct', origins: ['author'], inputTypes: ['const'], ...p };
}

describe('the default policy formalizes the tiers of the threat model', () => {
	test.each<[string, Finding[], string]>([
		['no findings', [], 'gold'],
		['an author value at another sink', [finding({ capability: 'output', class: 'other' })], 'gold'],
		['a system value at another sink', [finding({ capability: 'output', class: 'other', origins: ['system'] })], 'silver'],
		['a constant at a severe sink', [finding({})], 'silver'],
		['a constant at an outward sink', [finding({ capability: 'network-file', class: 'outward' })], 'silver'],
		['a user value at an outward sink', [finding({ capability: 'network-file', class: 'outward', origins: ['outside'] })], 'silver'],
		['a system value at a severe sink', [finding({ origins: ['system'] })], 'silver'],
		['a parameter at a severe sink inside a package', [finding({ via: 'package', origins: ['parameter'] })], 'silver'],
		['an unknown value at a severe sink inside a package', [finding({ via: 'package', origins: ['unknown'] })], 'silver'],
		['a parameter at a severe function', [finding({ origins: ['parameter'] })], 'bronze'],
		['an unknown value at a severe function', [finding({ origins: ['unknown'] })], 'bronze'],
		['a user value at a severe sink inside a package', [finding({ via: 'package', origins: ['outside'] })], 'bronze'],
		['a user value at a severe function', [finding({ origins: ['author', 'outside'] })], 'none']
	])('%s gives %s', (_, findings, tier) => {
		expect(assignTier(policy, findings, clean).tier).toBe(tier);
	});

	test.each(['secret-exfiltration', 'process-state-in-session', 'no-leaked-credentials'])('a %s result costs gold, not silver', rule => {
		const lint = clean.map(l => l.rule === rule ? { ...l, count: 1 } : l);
		expect(assignTier(policy, [], lint).tier).toBe('silver');
	});

	test('a linting rule that failed to run cannot vouch for gold', () => {
		const lint = clean.map(l => l.rule === 'secret-exfiltration' ? { ...l, error: 'boom' } : l);
		expect(assignTier(policy, [], lint).tier).toBe('silver');
	});

	test('an artifact flowR could not analyze gets no tier', () => {
		expect(assignTier(policy, [], clean, false).tier).toBe('none');
	});

	test('every stricter tier says why it was not met', () => {
		const r = assignTier(policy, [finding({ via: 'package', origins: ['outside'] })], clean);
		expect(r.checks.map(c => [c.tier, c.met])).toEqual([['gold', false], ['silver', false], ['bronze', true]]);
		expect(r.checks[1].violations[0].findings).toEqual(['1']);
	});
});

describe('policy validation', () => {
	function load(yaml: string) {
		const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badgr-')), 'p.yaml');
		fs.writeFileSync(f, yaml);
		return () => loadPolicy(f);
	}
	const base = `
origins: { author: [const], outside: [user] }
fallbackOrigin: outside
capabilities: { shell: { class: severe, functions: ['^system$'] } }
`;
	test('a minimal policy loads', () => {
		expect(load(base + 'tiers: [{ name: gold, forbid: [{ classes: [severe] }] }]')().tiers[0].name).toBe('gold');
	});
	test.each([
		['an unknown origin class', 'tiers: [{ name: gold, forbid: [{ origins: [users] }] }]'],
		['an unknown sink class', 'tiers: [{ name: gold, forbid: [{ classes: [sever] }] }]'],
		['an unknown capability', 'tiers: [{ name: gold, forbid: [{ capabilities: [shel] }] }]'],
		['an invalid via', 'tiers: [{ name: gold, forbid: [{ via: inside }] }]'],
		['a duplicate tier', 'tiers: [{ name: gold }, { name: gold }]'],
		['no tiers', 'tiers: []']
	])('rejects %s', (_, tiers) => {
		expect(load(base + tiers)).toThrow(PolicyError);
	});
	test('rejects an input type in two origin classes', () => {
		expect(load(base.replace('outside: [user]', 'outside: [user, const]') + 'tiers: [{ name: gold }]')).toThrow(/both/);
	});

	test('the origin none matches findings without any traced value, and only those', () => {
		const rule = { classes: ['severe'], origins: ['none'] };
		const f = (origins: string[]) => ({ id: '1', call: 'base::system', capability: 'shell', class: 'severe', via: 'direct' as const, origins, inputTypes: [] });
		expect(matchesRule(rule, f([]), ['source'])).toBe(true);
		expect(matchesRule(rule, f(['author']), ['source'])).toBe(false);
		expect(matchesRule({ ...rule, origins: ['none', 'outside'] }, f(['outside']), ['source'])).toBe(true);
	});
});
