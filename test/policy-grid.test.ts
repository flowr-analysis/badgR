import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePolicy, NoOrigin, type ForbidRule } from '../src/policy-core';
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
const blocks = (rules: readonly ForbidRule[], f: Finding) => rules.some(r => matchesRule(r, f));

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
