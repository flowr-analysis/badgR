import type { Progress, Report } from '../src/core';
import type { SourceFile } from '../src/sources';

export type { SourceFile };

/** what the policy editor completes: the names flowR knows */
export interface PolicyVocabulary {
	readonly lintRules:  readonly { readonly name: string, readonly title?: string, readonly about?: string, readonly docs?: string }[]
	readonly tags:       readonly string[]
	readonly callProps:  readonly string[]
	readonly argProps:   readonly string[]
	readonly inputTypes: readonly string[]
}

/** loads the parser and the base R data before the first analysis, so it starts at once */
export type WorkerRequest = { readonly type: 'warm', readonly base: string } | {
	readonly type:       'analyze'
	readonly id:         number
	/** the base url the package data is fetched from (the page's own site) */
	readonly base:       string
	readonly target:     string
	readonly files:      readonly SourceFile[]
	readonly policyText: string
	readonly policyName: string
	readonly policyHash: string
	/** whether this is another policy than the page's default */
	readonly policyModified: boolean
}
	/* between the analysis worker and its linting worker */
	| { readonly type: 'lint-init', readonly files: readonly SourceFile[], readonly packages: readonly LintPackage[] }
	| { readonly type: 'lint-rule', readonly rule: string };

/** what the linting worker needs of a package: its version and exports */
export interface LintPackage { readonly name: string, readonly v?: string, readonly x: readonly string[] }

export type WorkerResponse =
	| { readonly type: 'progress', readonly id: number, readonly progress: Progress }
	/** a report while the analysis still runs: its findings are final, `report.pending` lists the linting rules still running, so its tier may still drop */
	| { readonly type: 'partial', readonly id: number, readonly report: Report }
	| { readonly type: 'report', readonly id: number, readonly report: Report }
	| { readonly type: 'error', readonly id: number, readonly error: string }
	| { readonly type: 'ready', readonly sigdb?: string, readonly vocabulary: PolicyVocabulary };
