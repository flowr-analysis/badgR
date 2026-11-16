import { parse } from 'yaml';

/** how a finding reaches its capability */
export type Via = 'direct' | 'package';

export interface CapabilitySpec {
	readonly class:            string
	readonly description?:     string
	readonly tags?:            readonly string[]
	readonly callProps?:       readonly string[]
	readonly functions?:       readonly string[]
	readonly exclude?:         readonly string[]
	readonly unlessCallProps?: readonly string[]
	readonly unlessArgProps?:  readonly string[]
}

export interface ForbidRule {
	readonly classes?:      readonly string[]
	readonly capabilities?: readonly string[]
	readonly origins?:      readonly string[]
	readonly via?:          Via | 'any'
	readonly reason?:       string
}

export interface TierSpec {
	readonly name:         string
	readonly color:        string
	readonly review:       string
	/** one line for lists and tooltips; `description` says it in full */
	readonly summary?:     string
	readonly description?: string
	readonly forbid:       readonly ForbidRule[]
	readonly lint:         readonly string[]
}

export interface Policy {
	readonly name:           string
	readonly version:        number
	readonly description?:   string
	readonly origins:        Readonly<Record<string, readonly string[]>>
	readonly fallbackOrigin: string
	readonly capabilities:   Readonly<Record<string, CapabilitySpec>>
	readonly trusted:        readonly string[]
	readonly report:         readonly string[]
	/** how long one linting rule may run, in seconds; a rule that runs longer counts as not run. */
	readonly lintTimeout:    number
	readonly tiers:          readonly TierSpec[]
	readonly fallbackTier:   { readonly name: string, readonly color: string, readonly review: string }
	/** sha256 of the policy file, so a report names exactly the policy it was checked against */
	readonly hash:           string
	readonly source:         string
}

export class PolicyError extends Error {}

/** in a forbid rule, the origin of a finding flowR traced no value for */
export const NoOrigin = 'none';

function fail(file: string, msg: string): never {
	throw new PolicyError(`${file}: ${msg}`);
}

function strings(file: string, where: string, v: unknown, required = false): string[] {
	if(v === undefined || v === null) {
		if(required) {
			fail(file, `${where} is required`);
		}
		return [];
	}
	if(!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
		fail(file, `${where} must be a list of strings`);
	}
	return v as string[];
}

function str(file: string, where: string, v: unknown, fallback?: string): string {
	if(typeof v === 'string') {
		return v;
	}
	if(v === undefined && fallback !== undefined) {
		return fallback;
	}
	return fail(file, `${where} must be a string`);
}

function checkRegexes(file: string, where: string, list: readonly string[]): void {
	for(const r of list) {
		try {
			new RegExp(r);
		} catch(e) {
			fail(file, `${where}: invalid regular expression ${JSON.stringify(r)} (${(e as Error).message})`);
		}
	}
}

/**
 * Parses and validates a policy, so a typo fails loudly instead of silently weakening a tier.
 * `file` names the policy in error messages and reports, `hash` identifies its exact text.
 */
export function parsePolicy(text: string, file: string, hash: string): Policy {
	const raw = parse(text) as Record<string, unknown> | null;
	if(raw === null || typeof raw !== 'object') {
		fail(file, 'not a YAML mapping');
	}

	const originsRaw = raw.origins as Record<string, unknown> | undefined;
	if(!originsRaw || typeof originsRaw !== 'object') {
		fail(file, 'origins is required');
	}
	const origins: Record<string, string[]> = {};
	if(NoOrigin in originsRaw) {
		fail(file, `origins.${NoOrigin}: the name is reserved for findings without any traced value`);
	}
	const seenTypes = new Map<string, string>();
	for(const [cls, types] of Object.entries(originsRaw)) {
		origins[cls] = strings(file, `origins.${cls}`, types, true);
		for(const t of origins[cls]) {
			const prev = seenTypes.get(t);
			if(prev !== undefined) {
				fail(file, `input type ${t} is in both origins.${prev} and origins.${cls}`);
			}
			seenTypes.set(t, cls);
		}
	}
	const fallbackOrigin = str(file, 'fallbackOrigin', raw.fallbackOrigin);
	if(!(fallbackOrigin in origins)) {
		fail(file, `fallbackOrigin ${fallbackOrigin} is no origin class`);
	}

	const capsRaw = raw.capabilities as Record<string, Record<string, unknown>> | undefined;
	if(!capsRaw || typeof capsRaw !== 'object') {
		fail(file, 'capabilities is required');
	}
	const capabilities: Record<string, CapabilitySpec> = {};
	const classes = new Set<string>();
	for(const [name, c] of Object.entries(capsRaw)) {
		const where = `capabilities.${name}`;
		const spec: CapabilitySpec = {
			class:           str(file, `${where}.class`, c?.class),
			description:     c?.description === undefined ? undefined : str(file, `${where}.description`, c.description),
			tags:            strings(file, `${where}.tags`, c?.tags),
			callProps:       strings(file, `${where}.callProps`, c?.callProps),
			functions:       strings(file, `${where}.functions`, c?.functions),
			exclude:         strings(file, `${where}.exclude`, c?.exclude),
			unlessCallProps: strings(file, `${where}.unlessCallProps`, c?.unlessCallProps),
			unlessArgProps:  strings(file, `${where}.unlessArgProps`, c?.unlessArgProps)
		};
		if(!spec.tags?.length && !spec.callProps?.length && !spec.functions?.length) {
			fail(file, `${where} matches nothing: give tags, callProps, or functions`);
		}
		checkRegexes(file, `${where}.functions`, spec.functions ?? []);
		checkRegexes(file, `${where}.exclude`, spec.exclude ?? []);
		capabilities[name] = spec;
		classes.add(spec.class);
	}

	const trusted = strings(file, 'trusted', raw.trusted);
	checkRegexes(file, 'trusted', trusted);

	const tiersRaw = raw.tiers;
	if(!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
		fail(file, 'tiers must be a non-empty list');
	}
	const tiers: TierSpec[] = tiersRaw.map((t: Record<string, unknown>, i: number) => {
		const where = `tiers[${i}]`;
		const forbidRaw = t?.forbid ?? [];
		if(!Array.isArray(forbidRaw)) {
			fail(file, `${where}.forbid must be a list`);
		}
		const forbid: ForbidRule[] = forbidRaw.map((r: Record<string, unknown>, j: number) => {
			const w = `${where}.forbid[${j}]`;
			const rule: ForbidRule = {
				classes:      r?.classes === undefined ? undefined : strings(file, `${w}.classes`, r.classes),
				capabilities: r?.capabilities === undefined ? undefined : strings(file, `${w}.capabilities`, r.capabilities),
				origins:      r?.origins === undefined ? undefined : strings(file, `${w}.origins`, r.origins),
				via:          r?.via === undefined ? 'any' : str(file, `${w}.via`, r.via) as ForbidRule['via'],
				reason:       r?.reason === undefined ? undefined : str(file, `${w}.reason`, r.reason)
			};
			if(!['direct', 'package', 'any'].includes(rule.via as string)) {
				fail(file, `${w}.via must be direct, package, or any`);
			}
			for(const c of rule.classes ?? []) {
				if(!classes.has(c)) {
					fail(file, `${w}.classes: no capability has the class ${c}`);
				}
			}
			for(const c of rule.capabilities ?? []) {
				if(!(c in capabilities)) {
					fail(file, `${w}.capabilities: unknown capability ${c}`);
				}
			}
			for(const o of rule.origins ?? []) {
				/* `none` matches findings flowR traced no value for, such as calls without arguments */
				if(o !== NoOrigin && !(o in origins)) {
					fail(file, `${w}.origins: unknown origin class ${o}`);
				}
			}
			return rule;
		});
		return {
			name:        str(file, `${where}.name`, t?.name),
			color:       str(file, `${where}.color`, t?.color, '#555555'),
			review:      str(file, `${where}.review`, t?.review, ''),
			summary:     t?.summary === undefined ? undefined : str(file, `${where}.summary`, t.summary),
			description: t?.description === undefined ? undefined : str(file, `${where}.description`, t.description),
			forbid,
			lint:        strings(file, `${where}.lint`, t?.lint)
		};
	});
	const names = new Set<string>();
	for(const t of tiers) {
		if(names.has(t.name)) {
			fail(file, `tier ${t.name} is defined twice`);
		}
		names.add(t.name);
	}

	const fb = (raw.fallbackTier ?? {}) as Record<string, unknown>;
	return {
		name:         str(file, 'name', raw.name, file.split(/[\\/]/).pop() ?? file),
		version:      typeof raw.version === 'number' ? raw.version : 1,
		description:  raw.description === undefined ? undefined : str(file, 'description', raw.description),
		origins,
		fallbackOrigin,
		capabilities,
		trusted,
		report:       strings(file, 'report', raw.report),
		lintTimeout:  lintTimeoutOf(file, raw.lintTimeout),
		tiers,
		fallbackTier: {
			name:   str(file, 'fallbackTier.name', fb.name, 'none'),
			color:  str(file, 'fallbackTier.color', fb.color, '#6b6b6b'),
			review: str(file, 'fallbackTier.review', fb.review, 'full')
		},
		hash,
		source: file
	};
}

/** the default of `lintTimeout`, in seconds */
export const DefaultLintTimeout = 120;

function lintTimeoutOf(file: string, v: unknown): number {
	if(v === undefined) {
		return DefaultLintTimeout;
	}
	/* setTimeout takes at most 2^31 - 1 ms, about 24 days */
	if(typeof v !== 'number' || !(v > 0) || !Number.isFinite(v) || v * 1000 > 2 ** 31 - 1) {
		fail(file, 'lintTimeout must be a positive number of seconds, at most 2147483');
	}
	return v;
}

/** every flowR linting rule the policy runs, for its tiers and for the report */
export function lintRulesOf(policy: Policy): string[] {
	return [...new Set([...policy.tiers.flatMap(t => t.lint), ...policy.report])];
}
