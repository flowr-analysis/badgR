/**
 * SARIF 2.1.0, the format code scanning (GitHub, GitLab, IDEs) reads: one run per analyzed artifact, a
 * result per finding and per linting result. Nothing in here touches the file system, so the web page
 * exports the same file as the command line.
 *
 * What stays the same between runs, so that a code scanner tracks a finding instead of opening a new one:
 * the rule ids (`badger/<capability>`, `flowr/<linting rule>`), and each result's `partialFingerprints`,
 * which hash what identifies a finding for a review (file, call, capability, how it is reached, and the
 * text of its line), not its line number.
 */
import type { Report } from './core';
import { reviewSummary } from './review';
import type { Finding, LintResult } from './tiers';

export const SarifSchema = 'https://json.schemastore.org/sarif-2.1.0.json';
const Home = 'https://github.com/flowr-analysis/badgR';
const Linter = 'https://github.com/flowr-analysis/flowr/wiki/Linter';

export interface SarifOptions {
	/** the path a result names for a file, relative to the analyzed folder, with `/` */
	readonly fileOf:  (file: string | undefined) => string | undefined
	/** the text of a line, for the fingerprints */
	readonly lineOf:  (file: string | undefined, line: number) => string | undefined
	/** the description of each capability, from the policy */
	readonly capabilities?: Readonly<Record<string, { readonly description?: string, readonly class: string }>>
	/** a link that shows a finding or linting result in the playground, when the code can go into a link */
	readonly linkOf?: (at: string) => string | undefined
}

/** FNV-1a, 64 bit, as hex: a short fingerprint that is the same everywhere (no crypto API needed) */
export function fingerprint(text: string): string {
	let h = 0xcbf29ce484222325n;
	for(const b of new TextEncoder().encode(text)) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, '0');
}

/** the selection a link names for a finding (`f:`) or a linting result (`l:`), see the web page */
export function findingAt(f: Pick<Finding, 'file' | 'loc' | 'call'>, file: string | undefined): string {
	return `f:${encodeURIComponent(file ?? '')}:${f.loc?.[0] ?? 0}:${encodeURIComponent(f.call)}`;
}
export function lintAt(rule: string, x: Pick<LintResult, 'loc'>, file: string | undefined): string {
	return `l:${encodeURIComponent(rule)}:${encodeURIComponent(file ?? '')}:${x.loc?.[0] ?? 0}`;
}

/**
 * The selection in a link: `f:<file>:<line>:<call>` or `l:<rule>:<file>:<line>`, each part URI-encoded.
 * Links from before the encoding have a `::` in the call (`base::system`) and are read as well.
 */
export function parseAt(at: string): { kind: 'f', file: string, line: string, call: string } | { kind: 'l', rule: string, file: string, line: string } | undefined {
	const parts = at.split(':');
	const dec = (x: string) => {
		try {
			return decodeURIComponent(x);
		} catch{
			return x;
		}
	};
	if(parts[0] === 'f' && parts.length >= 4) {
		return { kind: 'f', file: dec(parts[1]), line: parts[2], call: dec(parts.slice(3).join(':')) };
	}
	if(parts[0] === 'l' && parts.length >= 4) {
		return { kind: 'l', rule: dec(parts[1]), file: dec(parts.slice(2, -1).join(':')), line: parts[parts.length - 1] };
	}
	return undefined;
}

/** the text of a line as the fingerprints see it: without leading, trailing, and repeated white space */
function normalizeLine(text: string | undefined): string {
	return (text ?? '').trim().replace(/\s+/g, ' ');
}

const Level: Record<string, 'error' | 'warning' | 'note'> = { severe: 'error', outward: 'warning', other: 'note' };

function region(loc: readonly [number, number, number, number] | undefined): Record<string, number> | undefined {
	/* flowR's columns are 1-based and the end column inclusive, SARIF's end column is exclusive */
	return loc === undefined ? undefined : { startLine: loc[0], startColumn: loc[1], endLine: loc[2], endColumn: loc[3] + 1 };
}

/** a relative path as a URI reference: each segment encoded, so `#` and `?` stay part of the name */
export function fileUri(file: string): string {
	return file.split('/').map(encodeURIComponent).join('/');
}

/** a region SARIF accepts: whole numbers from 1 on, and an end that does not come before the start */
function validRegion(loc: readonly number[]): boolean {
	return loc.length >= 4 && loc.every(n => Number.isInteger(n) && n >= 1) && (loc[2] > loc[0] || (loc[2] === loc[0] && loc[3] >= loc[1]));
}

function location(file: string | undefined, loc: readonly [number, number, number, number] | undefined): Record<string, unknown>[] {
	/* a physical location needs a file; a region without one (or before line 1) says nothing */
	if(file === undefined || file === '') {
		return [];
	}
	const valid = loc !== undefined && validRegion(loc);
	return [{ physicalLocation: { artifactLocation: { uri: fileUri(file), uriBaseId: 'SRCROOT' }, ...(valid ? { region: region(loc) } : {}) } }];
}

function originWords(f: Finding): string {
	return f.origins.length === 0 ? 'no traced value' : `values from ${f.origins.join(', ')}`;
}

/** one SARIF run for one report */
export function sarifRun(r: Report, opts: SarifOptions): Record<string, unknown> {
	const rules = new Map<string, Record<string, unknown>>();
	const indices = new Map<string, number>();
	const ruleIndex = (id: string, make: () => Record<string, unknown>) => {
		if(!rules.has(id)) {
			indices.set(id, rules.size);
			rules.set(id, { id, ...make() });
		}
		return indices.get(id) as number;
	};
	/* which tiers each finding blocks */
	const blocked = new Map<string, string[]>();
	for(const c of r.tier.checks) {
		for(const v of c.violations) {
			for(const id of v.findings) {
				blocked.set(id, [...blocked.get(id) ?? [], c.tier]);
			}
		}
	}
	const results: Record<string, unknown>[] = [];
	for(const f of r.findings) {
		const id = `badger/${f.capability}`;
		const cap = opts.capabilities?.[f.capability];
		const index = ruleIndex(id, () => ({
			name:             f.capability,
			shortDescription: { text: cap?.description ?? f.capability },
			fullDescription:  { text: `A call that ${cap?.description ?? `has the capability ${f.capability}`} (class ${f.class}).` },
			helpUri:          `${Home}#readme`,
			defaultConfiguration: { level: Level[f.class] ?? 'warning' },
			properties:       { class: f.class, tags: ['security', f.class] }
		}));
		const file = opts.fileOf(f.file);
		const lineText = f.loc ? opts.lineOf(f.file, f.loc[0]) : undefined;
		const at = findingAt(f, file);
		const link = opts.linkOf?.(at);
		const suppressed = f.review?.state === 'tolerated' || f.review?.state === 'false-positive';
		results.push({
			ruleId:    id,
			ruleIndex: index,
			level:     Level[f.class] ?? 'warning',
			message:   { text: `${f.call} ${cap?.description ?? f.capability}${f.via === 'package' ? ` inside the package${f.through ? ` (through ${f.through})` : ''}` : ''}, with ${originWords(f)}.` },
			locations: location(file, f.loc),
			partialFingerprints: { 'badgerFinding/v1': fingerprint(JSON.stringify([file ?? '', f.call, f.capability, f.via, normalizeLine(lineText)])) },
			...(link ? { hostedViewerUri: link } : {}),
			...(suppressed ? { suppressions: [{ kind: 'external', status: 'accepted', ...(f.review?.note ? { justification: f.review.note } : {}) }] } : {}),
			properties: {
				capability: f.capability, class: f.class, via: f.via, ...(f.through ? { through: f.through } : {}),
				origins: f.origins, inputTypes: f.inputTypes, role: f.role ?? 'source',
				blocks: blocked.get(f.id) ?? [], ...(f.review ? { review: f.review.state, ...(f.review.note ? { reviewNote: f.review.note } : {}) } : {})
			}
		});
	}
	for(const l of r.lint) {
		for(const x of l.results) {
			const id = `flowr/${l.rule}`;
			const index = ruleIndex(id, () => ({
				name:             l.rule,
				shortDescription: { text: l.title ?? l.rule },
				...(l.about ? { fullDescription: { text: l.about } } : {}),
				helpUri:          l.docs ?? Linter,
				defaultConfiguration: { level: 'warning' }
			}));
			const file = opts.fileOf(x.file);
			const link = opts.linkOf?.(lintAt(l.rule, x, file));
			const lineText = x.loc ? opts.lineOf(x.file, x.loc[0]) : undefined;
			results.push({
				ruleId:    id,
				ruleIndex: index,
				level:     'warning',
				message:   { text: x.message },
				locations: location(file, x.loc),
				partialFingerprints: { 'badgerLint/v1': fingerprint(JSON.stringify([l.rule, file ?? '', x.message, normalizeLine(lineText)])) },
				...(link ? { hostedViewerUri: link } : {}),
				...(x.quickFix?.some(q => q.loc && validRegion(q.loc)) && opts.fileOf(x.file) ? { fixes: x.quickFix.filter(q => q.loc && validRegion(q.loc)).map(q => ({
					description:     { text: q.description },
					artifactChanges: [{ artifactLocation: { uri: fileUri(opts.fileOf(q.file ?? x.file) ?? ''), uriBaseId: 'SRCROOT' },
						replacements: [{ deletedRegion: region(q.loc), ...(q.replacement !== undefined ? { insertedContent: { text: q.replacement } } : {}) }] }]
				})) } : {}),
				...(x.certainty ? { properties: { certainty: x.certainty } } : {})
			});
		}
	}
	const notes = [
		...(r.analyzed ? [] : [{ level: 'error', message: { text: `flowR could not analyze the artifact: ${r.error ?? 'unknown error'}` } }]),
		...r.lint.filter(l => l.error).map(l => ({ level: 'warning', message: { text: `linting rule ${l.rule} did not run: ${l.error}` }, descriptor: { id: `flowr/${l.rule}` } })),
		...(r.unresolvedPackages.length ? [{ level: 'note', message: { text: `no signature data for ${r.unresolvedPackages.join(', ')}, so calls inside these packages are not checked` } }] : [])
	];
	const review = reviewSummary(r.findings);
	return {
		tool: { driver: {
			name: 'badger', version: r.toolVersion, semanticVersion: r.toolVersion, informationUri: Home,
			rules: [...rules.values()]
		}, extensions: [{ name: 'flowR', version: r.flowrVersion, informationUri: 'https://github.com/flowr-analysis/flowr' }] },
		originalUriBaseIds: { SRCROOT: { description: { text: 'the analyzed folder' } } },
		invocations: [{ executionSuccessful: r.analyzed, ...(notes.length ? { toolExecutionNotifications: notes } : {}) }],
		automationDetails: { id: `badger/${r.policy.name}/` },
		results,
		properties: {
			tier: r.tier.tier, color: r.tier.color, review: r.tier.review,
			policy: { name: r.policy.name, hash: r.policy.hash, modified: r.policy.modified ?? false },
			reviewed: review,
			sigdb: r.sigdb.tag, target: r.target, generatedAt: r.generatedAt
		}
	};
}

/** a SARIF log of one or more reports */
export function sarifLog(reports: readonly Report[], opts: SarifOptions | ((r: Report) => SarifOptions)): Record<string, unknown> {
	return { $schema: SarifSchema, version: '2.1.0', runs: reports.map(r => sarifRun(r, typeof opts === 'function' ? opts(r) : opts)) };
}
