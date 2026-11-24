/**
 * The hand classification of findings: a reviewer marks a finding as tolerated, a false positive, or to
 * fix, with a note. It never changes a tier; the badge says what the code can do, the review records what
 * people decided about it. A review entry finds its finding by file, call, capability, how it is reached,
 * and the text of its line, so it survives the code moving to other lines.
 */
import type { Finding } from './tiers';

export const ReviewStates = ['tolerated', 'false-positive', 'to-fix'] as const;
export type ReviewState = typeof ReviewStates[number];

export interface ReviewEntry {
	readonly key:   string
	readonly state: ReviewState
	readonly note?: string
}

export interface ReviewFile {
	readonly badgerReview: 1
	readonly entries:     readonly ReviewEntry[]
}

/** what identifies a finding for a review: not its line number, which moves with every edit above it */
export function findingKey(f: Pick<Finding, 'file' | 'call' | 'capability' | 'via'>, lineText: string | undefined): string {
	return [f.file ?? '', f.call, f.capability, f.via, (lineText ?? '').trim().replace(/\s+/g, ' ')].join('|');
}

export function parseReview(text: string): ReviewEntry[] {
	const raw = JSON.parse(text) as Partial<ReviewFile> | ReviewEntry[] | null;
	const entries = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' && Array.isArray(raw.entries) ? raw.entries : [];
	return entries.filter((e): e is ReviewEntry => typeof e?.key === 'string' && (ReviewStates as readonly string[]).includes(e.state));
}

export function reviewFile(entries: Iterable<ReviewEntry>): ReviewFile {
	return { badgerReview: 1, entries: [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) };
}

/** how many findings each state has, and how many nobody looked at yet */
export function reviewCounts(states: readonly (ReviewState | undefined)[]): Record<ReviewState | 'unreviewed', number> {
	const out = { 'tolerated': 0, 'false-positive': 0, 'to-fix': 0, 'unreviewed': 0 };
	for(const s of states) {
		out[s ?? 'unreviewed']++;
	}
	return out;
}

export const ReviewLabel: Record<ReviewState, string> = { 'tolerated': 'tolerated', 'false-positive': 'false positive', 'to-fix': 'to fix' };

/**
 * The findings with the decisions of the entries that match them. `fileOf` gives the path the entries use
 * (relative to the analyzed folder), `lineOf` the text of a line.
 */
export function applyReview<R extends { readonly findings: readonly Finding[] }>(report: R, entries: readonly ReviewEntry[],
	fileOf: (file: string | undefined) => string | undefined, lineOf: (file: string | undefined, line: number) => string | undefined): R {
	const byKey = new Map(entries.map(e => [e.key, e]));
	return {
		...report,
		findings: report.findings.map(f => {
			const e = byKey.get(findingKey({ ...f, file: fileOf(f.file) }, f.loc ? lineOf(f.file, f.loc[0]) : undefined));
			return e ? { ...f, review: { state: e.state, ...(e.note ? { note: e.note } : {}) } } : f;
		})
	};
}

/** how far the review of a report's findings is: `complete` once every finding is decided and none is left to fix */
export interface ReviewSummary {
	readonly total:      number
	readonly decided:    number
	readonly toFix:      number
	readonly complete:   boolean
}

export function reviewSummary(findings: readonly Pick<Finding, 'review'>[]): ReviewSummary {
	const c = reviewCounts(findings.map(f => f.review?.state));
	const decided = findings.length - c.unreviewed;
	return { total: findings.length, decided, toFix: c['to-fix'], complete: findings.length > 0 && c.unreviewed === 0 && c['to-fix'] === 0 };
}
