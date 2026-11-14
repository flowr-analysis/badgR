/** R syntax highlighting, shared by the editor and the report's code view. */
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { r } from '@codemirror/legacy-modes/mode/r';
import { classHighlighter, highlightCode, tagHighlighter, tags } from '@lezer/highlight';

/**
 * The R mode of CodeMirror, plus what it leaves plain: a name followed by `(` is a call, a name before `::`
 * a package. Builtins such as `library` keep their own color.
 */
const rCalls: StreamParser<unknown> = {
	...(r as StreamParser<unknown>),
	token(stream, state) {
		const style = (r as StreamParser<unknown>).token(stream, state);
		if(style === 'variable' || style === 'builtin') {
			const rest = stream.string.slice(stream.pos);
			if(/^:::?/.test(rest)) {
				return 'namespace';
			}
			if(/^\s*\(/.test(rest)) {
				return style === 'builtin' ? 'builtinCall' : 'call';
			}
		}
		return style;
	},
	tokenTable: {
		call:        tags.function(tags.variableName),
		builtinCall: tags.function(tags.standard(tags.variableName)),
		namespace:   tags.namespace
	}
};

export const rLanguage = StreamLanguage.define(rCalls);

/** the classes of the page's stylesheet, with calls, builtins, and packages added */
export const highlighter = tagHighlighter([
	{ tag: tags.function(tags.standard(tags.variableName)), class: 'tok-builtin tok-call' },
	{ tag: tags.function(tags.variableName), class: 'tok-call' },
	{ tag: tags.standard(tags.variableName), class: 'tok-builtin' },
	{ tag: tags.namespace, class: 'tok-namespace' }
]);

export interface Token { readonly text: string, readonly cls: string }

/** the tokens of every line, with `tok-*` classes */
export function highlightLines(code: string): Token[][] {
	const lines: Token[][] = [[]];
	highlightCode(code, rLanguage.parser.parse(code), [highlighter, classHighlighter],
		(text, cls) => lines[lines.length - 1].push({ text, cls }),
		() => lines.push([]));
	return lines;
}
