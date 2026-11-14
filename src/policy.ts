import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { type Policy, parsePolicy } from './policy-core';

export * from './policy-core';

/** the policy that formalizes the tiers of the threat model */
export const DefaultPolicyPath = path.resolve(__dirname, '..', 'policies', 'default.yaml');

/** Reads and validates a policy file. */
export function loadPolicy(file: string = DefaultPolicyPath): Policy {
	const text = fs.readFileSync(file, 'utf-8');
	return parsePolicy(text, path.resolve(file), createHash('sha256').update(text).digest('hex'));
}
