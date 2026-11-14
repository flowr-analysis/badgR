import type { Progress, Report } from '../src/core';

export interface SourceFile {
	readonly path:    string
	readonly content: string
}

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
};

export type WorkerResponse =
	| { readonly type: 'progress', readonly id: number, readonly progress: Progress }
	| { readonly type: 'report', readonly id: number, readonly report: Report }
	| { readonly type: 'error', readonly id: number, readonly error: string }
	| { readonly type: 'ready', readonly sigdb?: string, readonly vocabulary: PolicyVocabulary };
