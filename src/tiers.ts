import { NoOrigin, type ForbidRule, type Policy, type Via } from './policy-core';

/** one call that reaches a capability */
export interface Finding {
	readonly id:          string
	readonly file?:       string
	/** `[startLine, startColumn, endLine, endColumn]` */
	readonly loc?:        readonly [number, number, number, number]
	/** the called function, `pkg::fn` when flowR could qualify it */
	readonly call:        string
	readonly capability:  string
	readonly class:       string
	readonly via:         Via
	/** for `via: package`, the function inside the package that has the capability */
	readonly through?:    string
	readonly origins:     readonly string[]
	readonly inputTypes:  readonly string[]
	/** flowR's semantic tags of the function that has the capability (for `via: package`, of `through`) */
	readonly tags?:       readonly string[]
	/** what flowR's contracts state of the called function's parameters, when it knows them */
	readonly contract?:   { readonly injectable: readonly string[], readonly resource: readonly string[], readonly written: readonly string[] }
	/** what a reviewer decided about it, by hand; never part of the tier */
	readonly review?:     { readonly state: 'tolerated' | 'false-positive' | 'to-fix', readonly note?: string }
}

/** a flowR quick fix: replace (or, without `replacement`, remove) the text at `loc` */
export interface QuickFix {
	readonly description:  string
	readonly loc:          readonly [number, number, number, number]
	readonly file?:        string
	readonly replacement?: string
}

export interface LintResult {
	readonly certainty?: string
	readonly file?:      string
	readonly loc?:       readonly [number, number, number, number]
	readonly message:    string
	readonly quickFix?:  readonly QuickFix[]
}

/** the findings of one flowR linting rule */
export interface LintSummary {
	readonly rule:    string
	/** the human name of the rule and its page in the flowR wiki */
	readonly title?:  string
	readonly about?:  string
	readonly docs?:   string
	readonly count:   number
	readonly results: readonly LintResult[]
	readonly error?:  string
}

export interface Violation {
	readonly rule:     string
	readonly reason:   string
	readonly findings: readonly string[]
}

export interface TierCheck {
	readonly tier:       string
	readonly met:        boolean
	readonly violations: readonly Violation[]
}

export interface TierResult {
	readonly tier:   string
	readonly color:  string
	readonly review: string
	readonly checks: readonly TierCheck[]
}

export function matchesRule(rule: ForbidRule, f: Finding): boolean {
	if(rule.classes !== undefined && !rule.classes.includes(f.class)) {
		return false;
	}
	if(rule.capabilities !== undefined && !rule.capabilities.includes(f.capability)) {
		return false;
	}
	if(rule.via !== undefined && rule.via !== 'any' && rule.via !== f.via) {
		return false;
	}
	if(rule.origins !== undefined && !f.origins.some(o => rule.origins?.includes(o)) && !(f.origins.length === 0 && rule.origins.includes(NoOrigin))) {
		return false;
	}
	return true;
}

function describeRule(rule: ForbidRule): string {
	const parts = [
		rule.classes ? `class ${rule.classes.join('|')}` : undefined,
		rule.capabilities ? `capability ${rule.capabilities.join('|')}` : undefined,
		rule.origins ? `origin ${rule.origins.join('|')}` : 'any origin',
		rule.via && rule.via !== 'any' ? `via ${rule.via}` : undefined
	];
	return parts.filter(p => p !== undefined).join(', ');
}

/**
 * Checks every tier in order and assigns the first one that is met. Each tier is checked on its own,
 * so the report also says why the stricter tiers failed. `analyzed: false` gives the fallback tier.
 */
export function assignTier(policy: Policy, findings: readonly Finding[], lint: readonly LintSummary[], analyzed = true): TierResult {
	const lintByRule = new Map(lint.map(l => [l.rule, l]));
	const checks: TierCheck[] = policy.tiers.map(t => {
		const violations: Violation[] = [];
		t.forbid.forEach((rule, i) => {
			const hit = findings.filter(f => matchesRule(rule, f));
			if(hit.length > 0) {
				violations.push({ rule: `${t.name}.forbid[${i}] (${describeRule(rule)})`, reason: rule.reason ?? describeRule(rule), findings: hit.map(f => f.id) });
			}
		});
		for(const name of t.lint) {
			const l = lintByRule.get(name);
			/* a rule that failed to run cannot vouch for anything, so it blocks the tier (sound) */
			if(l === undefined || l.error !== undefined) {
				violations.push({ rule: `${t.name}.lint.${name}`, reason: `linting rule ${name} could not run${l?.error ? `: ${l.error}` : ''}`, findings: [] });
			} else if(l.count > 0) {
				violations.push({ rule: `${t.name}.lint.${name}`, reason: `linting rule ${name} reports ${l.count} result${l.count === 1 ? '' : 's'}`, findings: [] });
			}
		}
		return { tier: t.name, met: analyzed && violations.length === 0, violations };
	});
	const met = checks.find(c => c.met);
	const spec = met ? policy.tiers.find(t => t.name === met.tier) : undefined;
	return spec
		? { tier: spec.name, color: spec.color, review: spec.review, checks }
		: { tier: policy.fallbackTier.name, color: policy.fallbackTier.color, review: policy.fallbackTier.review, checks };
}
