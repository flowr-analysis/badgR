import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePolicy, DefaultLintTimeout, DefaultLintReadTimeout, FileRoles, NoOrigin, type ForbidRule } from '../src/policy-core';
import { matchesRule, type Finding } from '../src/tiers';
import { gridOf, rulesOf, shapeOf } from '../web/policy-visual';

const policy = parsePolicy(fs.readFileSync(path.join(__dirname, '..', 'policies', 'default.yaml'), 'utf-8'), 'default.yaml', '');
const shape = shapeOf(policy);

/** every finding that differs in capability, via, and origins: one origin each, or none */
function* findings(): Generator<Finding> {
	for(const [capability, spec] of Object.entries(policy.capabilities)) {
		for(const via of ['direct', 'package'] as const) {
			for(const origins of [[], ...Object.keys(policy.origins).map(o => [o])]) {
				yield { id: `${capability}-${via}-${origins.join()}`, call: 'x', capability, class: spec.class, via, origins, inputTypes: [] };
			}
		}
	}
}
const blocks = (rules: readonly ForbidRule[], f: Finding) => rules.some(r => matchesRule(r, f, policy.shipped));

describe('the policy grid', () => {
	test.each(policy.tiers.map(t => [t.name, t.forbid] as const))('reads and writes the rules of %s without changing what they forbid', (_, forbid) => {
		const again = rulesOf(gridOf(forbid, shape), shape, forbid);
		for(const f of findings()) {
			expect(blocks(again, f), f.id).toBe(blocks(forbid, f));
		}
	});

	test('a single cell forbids exactly its capability, origin, and via', () => {
		const grid = gridOf([], shape);
		grid.set(`shell|outside`, 'direct');
		const rules = rulesOf(grid, shape, []);
		for(const f of findings()) {
			expect(blocks(rules, f), f.id).toBe(f.capability === 'shell' && f.via === 'direct' && f.origins.includes('outside'));
		}
	});

	test('a whole class is written as the class, and the no-value column as the origin none', () => {
		const grid = gridOf([], shape);
		for(const c of shape.capsOf.get('outward') ?? []) {
			grid.set(`${c}|${NoOrigin}`, 'any');
		}
		expect(rulesOf(grid, shape, [])).toEqual([{ classes: ['outward'], origins: [NoOrigin], reason: expect.any(String) }]);
	});
});

describe('the time limit of a linting rule', () => {
	const text = fs.readFileSync(path.join(__dirname, '..', 'policies', 'default.yaml'), 'utf-8');
	const withLimit = (line: string) => text.replace(/^lintTimeout:.*$/m, line);

	test('is read from the policy', () => {
		expect(policy.lintTimeout).toBe(120);
		expect(parsePolicy(withLimit('lintTimeout: 5'), 'p.yaml', '').lintTimeout).toBe(5);
	});

	test('defaults when the policy names none', () => {
		expect(parsePolicy(withLimit(''), 'p.yaml', '').lintTimeout).toBe(DefaultLintTimeout);
	});

	test.each(['0', '-3', 'soon', '.inf', '9999999'])('rejects %s', v => {
		expect(() => parsePolicy(withLimit(`lintTimeout: ${v}`), 'p.yaml', '')).toThrow(/lintTimeout/);
	});
});

describe('the other time limits', () => {
	const text = fs.readFileSync(path.join(__dirname, '..', 'policies', 'default.yaml'), 'utf-8');
	test('the reading limit defaults, the whole analysis has none by default', () => {
		expect(parsePolicy(text.replace(/^lintReadTimeout:.*$/m, ''), 'p.yaml', '').lintReadTimeout).toBe(DefaultLintReadTimeout);
		expect(policy.timeout).toBeUndefined();
		expect(parsePolicy(`${text}\ntimeout: 60\n`, 'p.yaml', '').timeout).toBe(60);
	});
	test.each(['lintReadTimeout: 0', 'timeout: -1', 'timeout: soon'])('rejects %s', line => {
		expect(() => parsePolicy(`${text.replace(/^lintReadTimeout:.*$/m, '')}\n${line}\n`, 'p.yaml', '')).toThrow(/Timeout|timeout/);
	});
});

describe('file roles and allowed calls', () => {
	const text = fs.readFileSync(path.join(__dirname, '..', 'policies', 'default.yaml'), 'utf-8');
	const f = (role: Finding['role']): Finding => ({ id: '1', call: 'base::system', capability: 'shell', class: 'severe', via: 'direct', origins: ['outside'], inputTypes: [], role });

	test('a rule applies to the shipped files unless it names others', () => {
		expect(policy.shipped).toEqual(['source', 'install', 'startup']);
		expect(matchesRule({}, f('source'), policy.shipped)).toBe(true);
		expect(matchesRule({}, f(undefined), policy.shipped)).toBe(true);
		expect(matchesRule({}, f('test'), policy.shipped)).toBe(false);
		expect(matchesRule({ files: ['test'] }, f('test'), policy.shipped)).toBe(true);
		expect(matchesRule({ files: ['test'] }, f('source'), policy.shipped)).toBe(false);
		expect(matchesRule({ files: ['shipped', 'vignette'] }, f('vignette'), policy.shipped)).toBe(true);
	});

	test('a policy without shipped ships every role', () => {
		expect(parsePolicy(text.replace(/^shipped:.*$/m, ''), 'p.yaml', '').shipped).toEqual([...FileRoles]);
	});

	test('the grid keeps rules that name their files', () => {
		const forbid: ForbidRule[] = [{ capabilities: ['shell'], files: ['test'], reason: 'r' }];
		const t = policy.tiers[0];
		const scoped = parsePolicy(text.replace(/^tiers:/m, `tiers:\n  - name: t\n    color: '#000000'\n    review: ''\n    forbid: [{ capabilities: [shell], files: [test] }]`), 'p.yaml', '');
		expect(scoped.tiers[0].forbid[0].files).toEqual(['test']);
		expect(t.forbid.every(r => r.files === undefined)).toBe(true);
		expect(forbid[0].files).toEqual(['test']);
	});

	test.each(['shipped: [tests]', 'allow: [\'(\']'])('rejects %s', line => {
		expect(() => parsePolicy(text.replace(/^(shipped|allow):.*$/m, '').concat(`\n${line}\n`), 'p.yaml', '')).toThrow();
	});
});
