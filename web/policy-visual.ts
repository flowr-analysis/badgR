/**
 * The policy as forms to click. Per tier, a grid of capabilities (grouped by sink class) against value
 * origins, each cell allowed or forbidden in the app's own calls, inside packages, or both. Below, the
 * settings of the whole policy: which flowR input types form which origin, the capabilities' classes and
 * tags, trusted functions, and extra linting rules. Every edit goes back into the YAML, which keeps its
 * comments.
 */
import { parse, parseDocument, isSeq, isMap, type Document } from 'yaml';
import DefaultPolicy from '../policies/default.yaml';
import { FileRoles, NoOrigin, parsePolicy, type ForbidRule, type Policy } from '../src/policy-core';
import type { PolicyVocabulary } from './protocol';

type Via = 'direct' | 'package' | 'any';
type Cell = Via | undefined;

const Order: (Via | 'none')[] = ['none', 'direct', 'package', 'any'];
const Label: Record<string, string> = { none: '·', direct: 'app', package: 'pkg', any: 'all', mixed: '~' };
const Title: Record<string, string> = {
	none: 'allowed', direct: 'forbidden in the app\'s own calls', package: 'forbidden inside packages',
	any: 'forbidden everywhere', mixed: 'differs between the capabilities of this class'
};
const Wiki = 'https://github.com/flowr-analysis/flowr/wiki/';
const Docs = {
	inputSources: `${Wiki}%5BQuery%5D-Input-Sources`,
	functionInfo: `${Wiki}%5BQuery%5D-Function-Info`,
	sigdb:        `${Wiki}Signature-Database`,
	linter:       `${Wiki}%5BQuery%5D-Linter`
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag);
	if(cls) {
		e.className = cls;
	}
	if(text !== undefined) {
		e.textContent = text;
	}
	return e;
};
const link = (href: string, text: string, title?: string) => {
	const a = el('a', '', text);
	a.href = href;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	if(title) {
		a.title = title;
	}
	return a;
};
const listing = (xs: readonly string[]) => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`;

/** short lists inline, `[a, b]`, as the default policy writes them */
function flowLists(node: unknown): void {
	if(isSeq(node)) {
		if(node.items.every(i => !isMap(i) && !isSeq(i))) {
			node.flow = true;
		}
		node.items.forEach(i => flowLists(i));
	} else if(isMap(node)) {
		node.items.forEach(p => flowLists(p.value));
	}
}
function flowed(doc: Document, value: unknown): unknown {
	const node = doc.createNode(value);
	flowLists(node);
	return node;
}

function merge(a: Cell, b: Via): Via {
	return a === undefined ? b : a === b ? a : 'any';
}

interface Shape {
	readonly classes: readonly string[]
	readonly capsOf:  ReadonlyMap<string, readonly string[]>
	readonly caps:    readonly string[]
	readonly origins: readonly string[]
}

export function shapeOf(policy: Policy): Shape {
	const capsOf = new Map<string, string[]>();
	for(const [name, c] of Object.entries(policy.capabilities)) {
		capsOf.set(c.class, [...capsOf.get(c.class) ?? [], name]);
	}
	return { classes: [...capsOf.keys()], capsOf, caps: Object.keys(policy.capabilities), origins: [...Object.keys(policy.origins), NoOrigin] };
}

/** the cells a list of rules forbids: every rule is classes or capabilities, origins, and via */
export function gridOf(rules: readonly ForbidRule[], shape: Shape): Map<string, Cell> {
	const grid = new Map<string, Cell>();
	for(const r of rules) {
		const byClass = r.classes?.flatMap(c => shape.capsOf.get(c) ?? []);
		const caps = r.capabilities && byClass ? r.capabilities.filter(c => byClass.includes(c)) : r.capabilities ?? byClass ?? shape.caps;
		for(const c of caps) {
			for(const o of r.origins ?? shape.origins) {
				grid.set(`${c}|${o}`, merge(grid.get(`${c}|${o}`), r.via ?? 'any'));
			}
		}
	}
	return grid;
}

function reasonFor(what: string, origins: readonly string[] | undefined, via: Via): string {
	const values = origins === undefined ? 'whatever its values'
		: origins.length === 1 && origins[0] === NoOrigin ? 'without a traced value'
			: `with ${listing(origins.filter(o => o !== NoOrigin))} values${origins.includes(NoOrigin) ? ' or none' : ''}`;
	const where = via === 'direct' ? ' in the app\'s own code' : via === 'package' ? ' inside a package' : '';
	return `${what}${where}, ${values}`;
}

/** the grid as rules: per via, the capabilities that forbid the same origins share a rule; whole classes are named as classes */
export function rulesOf(grid: Map<string, Cell>, shape: Shape, old: readonly ForbidRule[]): ForbidRule[] {
	const out: ForbidRule[] = [];
	const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	for(const via of ['any', 'direct', 'package'] as const) {
		const groups = new Map<string, string[]>();
		for(const c of shape.caps) {
			const os = shape.origins.filter(o => grid.get(`${c}|${o}`) === via);
			if(os.length > 0) {
				const key = os.join(',');
				groups.set(key, [...groups.get(key) ?? [], c]);
			}
		}
		for(const [key, caps] of groups) {
			const os = key.split(',');
			const origins = os.length === shape.origins.length ? undefined : os;
			const whole = shape.classes.filter(k => (shape.capsOf.get(k) ?? []).every(c => caps.includes(c)));
			const rest = caps.filter(c => !whole.some(k => shape.capsOf.get(k)?.includes(c)));
			const emit = (rule: Omit<ForbidRule, 'reason'>, what: string) => {
				const prev = old.find(r => same(r.classes, rule.classes) && same(r.capabilities, rule.capabilities) && same(r.origins, rule.origins) && (r.via ?? 'any') === via);
				out.push({ ...rule, ...(via === 'any' ? {} : { via }), reason: prev?.reason ?? reasonFor(what, origins, via) });
			};
			if(whole.length > 0) {
				emit({ classes: whole, ...(origins ? { origins } : {}) }, `a ${listing(whole)} sink`);
			}
			if(rest.length > 0) {
				emit({ capabilities: rest, ...(origins ? { origins } : {}) }, `a call with ${listing(rest)}`);
			}
		}
	}
	return out;
}

function cellButton(state: string, title: string, onClick: (back: boolean) => void): HTMLButtonElement {
	const b = el('button', `cell v-${state}`, Label[state]);
	b.type = 'button';
	b.title = title;
	b.addEventListener('click', ev => onClick(ev.shiftKey));
	b.addEventListener('contextmenu', ev => {
		ev.preventDefault();
		onClick(true);
	});
	return b;
}
const step = (state: string, back: boolean): Via | undefined => {
	const i = Order.indexOf(state as Via | 'none');
	const next = Order[(i + (back ? Order.length - 1 : 1)) % Order.length];
	return next === 'none' ? undefined : next as Via;
};

function chips(items: readonly string[], cls: string, href: (x: string) => string | undefined, title: (x: string) => string | undefined, remove: (x: string) => void): HTMLElement[] {
	return items.map(x => {
		const span = el('span', `chip on ${cls}`);
		const h = href(x);
		span.append(h ? link(h, x, title(x)) : x);
		const del = el('button', 'chip-x', '×');
		del.type = 'button';
		del.title = `remove ${x}`;
		del.addEventListener('click', () => remove(x));
		span.append(del);
		return span;
	});
}

function picker(label: string, options: readonly { value: string, title?: string }[], pick: (v: string) => void): HTMLSelectElement {
	const s = el('select');
	s.append(el('option', '', label));
	for(const o of options) {
		const opt = el('option', '', o.value);
		opt.value = o.value;
		if(o.title) {
			opt.title = o.title;
		}
		s.append(opt);
	}
	s.addEventListener('change', () => s.selectedIndex > 0 && pick(s.value));
	return s;
}

function option(value: string, text = value): HTMLOptionElement {
	const o = el('option', '', text);
	o.value = value;
	return o;
}

/** a text field that suggests values (a `datalist`) and writes on Enter or when it loses focus */
function addField(placeholder: string, title: string, suggestions: readonly string[], add: (v: string) => void): HTMLInputElement {
	const input = el('input');
	input.placeholder = placeholder;
	input.title = title;
	if(suggestions.length > 0) {
		const list = el('datalist');
		list.id = `vlist-${Math.random().toString(36).slice(2)}`;
		list.append(...suggestions.map(x => option(x)));
		input.setAttribute('list', list.id);
		queueMicrotask(() => input.parentElement?.append(list));
	}
	input.addEventListener('keydown', ev => {
		if(ev.key === 'Enter' && input.value.trim()) {
			ev.preventDefault();
			add(input.value.trim());
		}
	});
	return input;
}

/** a regular expression that is valid, or the reason it is not */
function regexError(r: string): string | undefined {
	try {
		new RegExp(r);
		return undefined;
	} catch(e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/** what the page can suggest besides the policy: the calls of the last report, as `^pkg::fn$` */
export interface VisualContext {
	readonly calls?: readonly string[]
}

/** which tiers are unfolded, kept across redraws */
const openTiers = new Set<number>([0]);

/** draws the forms into `root`; `change` receives the new YAML */
export function renderVisual(root: HTMLElement, text: string, vocabulary: PolicyVocabulary | undefined, change: (yaml: string) => void, context: VisualContext = {}): void {
	let policy: Policy;
	try {
		policy = parsePolicy(text, 'policy', '');
	} catch(e) {
		root.replaceChildren(el('p', 'hint', `Fix the YAML first: ${e instanceof Error ? e.message : String(e)}`));
		return;
	}
	const shape = shapeOf(policy);
	const settingsOpen = root.querySelector<HTMLDetailsElement>('.vsettings')?.open ?? false;
	const edit = (fn: (doc: Document) => void) => {
		const doc = parseDocument(text);
		fn(doc);
		change(doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
	};
	const ruleDocs = (r: string) => vocabulary?.lintRules.find(x => x.name === r);
	/* what differs from the default policy, so each part can go back to it */
	const defaults = parse(DefaultPolicy) as Record<string, unknown>;
	const now = parse(text) as Record<string, unknown>;
	const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	const resetButton = (what: string, differs: boolean, reset: (d: Document) => void): HTMLElement[] => {
		if(!differs) {
			return [];
		}
		const b = el('button', 'vreset', 'reset');
		b.type = 'button';
		b.title = `set ${what} back to the default policy`;
		b.addEventListener('click', ev => {
			ev.preventDefault();
			ev.stopPropagation();
			edit(reset);
		});
		return [b];
	};
	const resetKeys = (what: string, keys: readonly string[]) => resetButton(what, keys.some(k => !same(now[k], defaults[k])), d => {
		for(const k of keys) {
			if(defaults[k] === undefined) {
				d.delete(k);
			} else {
				d.set(k, flowed(d, defaults[k]));
			}
		}
	});
	const callSuggestions = [...new Set((context.calls ?? []).map(c => `^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))].sort();
	const fnSuggestions = [...new Set((context.calls ?? []).map(c => `^${(c.split('::').pop() ?? c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))].sort();

	const legend = el('p', 'hint legend');
	const key = (s: string) => el('span', `cell-key v-${s}`, Label[s]);
	legend.append('Click cycles ', key('none'), ' allowed; forbidden ', key('direct'), ' in the app, ', key('package'), ' in packages, ', key('any'), ' everywhere (right-click: back). Origins: ', link(Docs.inputSources, 'input sources'), ', packages: ', link(Docs.sigdb, 'signature database'), '.');

	const tiers = policy.tiers.map((t, ti) => {
		const box = el('details', 'vtier');
		box.open = openTiers.has(ti);
		box.addEventListener('toggle', () => box.open ? openTiers.add(ti) : openTiers.delete(ti));
		const head = el('summary');
		const color = el('input');
		color.type = 'color';
		color.value = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#888888';
		color.title = 'badge color';
		color.addEventListener('click', ev => ev.stopPropagation());
		color.addEventListener('change', () => edit(d => d.setIn(['tiers', ti, 'color'], color.value)));
		const tiersRaw = (now.tiers ?? []) as Record<string, unknown>[];
		const def = ((defaults.tiers ?? []) as Record<string, unknown>[]).find(x => x.name === t.name);
		head.append(color, el('strong', '', t.name), el('span', 'hint', t.summary ?? ''),
			...resetButton(`the tier ${t.name}`, def !== undefined && !same(tiersRaw[ti], def), d => d.setIn(['tiers', ti], flowed(d, def))));
		box.append(head);

		/* the grid shows the rules of the shipped files; rules naming their own files stay as written */
		const own = t.forbid.filter(r => r.files === undefined);
		const scoped = t.forbid.filter(r => r.files !== undefined);
		const grid = gridOf(own, shape);
		const write = () => edit(d => d.setIn(['tiers', ti, 'forbid'], flowed(d, [...rulesOf(grid, shape, own), ...scoped])));
		const wrap = el('div', 'table-wrap');
		const table = el('table', 'vgrid');
		const colgroup = el('colgroup');
		colgroup.append(el('col', 'vg-name'), ...shape.origins.map(() => el('col', 'vg-cell')));
		const hr = el('tr');
		hr.append(el('th'), ...shape.origins.map(o => {
			const th = el('th');
			th.append(o === NoOrigin
				? link(Docs.inputSources, 'no value', 'calls flowR traced no value for, such as calls without arguments')
				: link(Docs.inputSources, o, `flowR input types ${listing(policy.origins[o] ?? [])}`));
			return th;
		}));
		const thead = el('thead');
		thead.append(hr);
		const tbody = el('tbody');
		for(const k of shape.classes) {
			const caps = shape.capsOf.get(k) ?? [];
			/* the class row sets all its capabilities at once */
			const ctr = el('tr', 'vg-class');
			const cth = el('th', '', k);
			cth.title = `all ${caps.length} capabilities of class ${k}`;
			ctr.append(cth);
			for(const o of shape.origins) {
				const states = new Set(caps.map(c => grid.get(`${c}|${o}`) ?? 'none'));
				const state = states.size === 1 ? [...states][0] : 'mixed';
				const td = el('td');
				td.append(cellButton(state, `${k} × ${o === NoOrigin ? 'no value' : o}: ${Title[state]}, for all of ${listing(caps)}`, back => {
					const next = step(state === 'mixed' ? 'none' : state, back);
					caps.forEach(c => grid.set(`${c}|${o}`, next));
					write();
				}));
				ctr.append(td);
			}
			tbody.append(ctr);
			for(const c of caps) {
				const spec = policy.capabilities[c];
				const tr = el('tr', 'vg-cap');
				const th = el('th');
				th.append(link(Docs.functionInfo, c, `${spec.description ?? c}${spec.tags?.length ? `. flowR tags: ${spec.tags.join(', ')}` : ''}${spec.functions?.length ? `. Functions: ${spec.functions.join(' ')}` : ''}`));
				tr.append(th);
				for(const o of shape.origins) {
					const state = grid.get(`${c}|${o}`) ?? 'none';
					const td = el('td');
					td.append(cellButton(state, `${c} × ${o === NoOrigin ? 'no value' : o}: ${Title[state]}`, back => {
						grid.set(`${c}|${o}`, step(state, back));
						write();
					}));
					tr.append(td);
				}
				tbody.append(tr);
			}
		}
		table.append(colgroup, thead, tbody);
		wrap.append(table);
		box.append(wrap);
		if(scoped.length > 0) {
			box.append(el('p', 'hint', `Also ${scoped.length} rule${scoped.length > 1 ? 's' : ''} for other files (${[...new Set(scoped.flatMap(r => r.files ?? []))].join(', ')}), edit in YAML.`));
		}

		const lint = el('div', 'vrow');
		lint.append(el('span', 'vlabel', 'Linting rules'));
		lint.append(...chips(t.lint, 'rule-chip', r => ruleDocs(r)?.docs ?? Docs.linter, r => ruleDocs(r)?.about,
			r => edit(d => d.setIn(['tiers', ti, 'lint'], flowed(d, t.lint.filter(x => x !== r))))));
		lint.append(picker('+ rule', (vocabulary?.lintRules ?? []).filter(r => !t.lint.includes(r.name)).map(r => ({ value: r.name, title: r.about })),
			v => edit(d => d.setIn(['tiers', ti, 'lint'], flowed(d, [...t.lint, v])))));
		box.append(lint);

		for(const [key, label, value, hint] of [
			['name', 'Name', t.name, 'the tier on the badge; --min-tier takes it'],
			['summary', 'In one line', t.summary ?? '', 'shown next to the badge'],
			['description', 'In full', t.description ?? '', 'what the tier asks for, in the list of badges'],
			['review', 'Review left', t.review, 'what a person still reviews at this tier']] as const) {
			const row = el('label', 'vrow');
			row.append(el('span', 'vlabel', label));
			const input = el('input');
			input.value = value;
			input.title = hint;
			input.addEventListener('change', () => {
				const v = input.value.trim();
				/* a tier needs a name of its own; the others may be empty */
				if(key === 'name' && (v === '' || policy.tiers.some((x, i) => i !== ti && x.name === v))) {
					input.value = t.name;
					input.setCustomValidity(v === '' ? 'a tier needs a name' : `there is a tier ${v} already`);
					input.reportValidity();
					return;
				}
				edit(d => v === '' && key !== 'review' ? d.deleteIn(['tiers', ti, key]) : d.setIn(['tiers', ti, key], v));
			});
			row.append(input);
			box.append(row);
		}
		return box;
	});

	/* ---------------------------------------------------------------- the whole policy */
	const settings = el('details', 'vsettings');
	settings.open = settingsOpen;
	settings.append(el('summary', '', 'Policy settings'));

	/* the name and description reports show */
	const ng = el('div', 'vblock');
	const nh = el('h4');
	nh.append('Policy ', el('span', 'hint', 'its name and description in reports'), ...resetKeys('the name and description', ['name', 'description']));
	ng.append(nh);
	for(const [key, label, value] of [['name', 'Name', policy.name], ['description', 'Description', policy.description ?? '']] as const) {
		const row = el('label', 'vrow');
		row.append(el('span', 'vlabel', label));
		const input = el('input');
		input.value = value;
		input.addEventListener('change', () => edit(d => input.value.trim() === '' ? d.delete(key) : d.set(key, input.value.trim())));
		row.append(input);
		ng.append(row);
	}
	/* the tier of code no tier fits */
	const fbt = el('div', 'vblock');
	const fbh = el('h4');
	fbh.append('Fallback tier ', el('span', 'hint', 'for code that meets no tier, or that flowR could not analyze'), ...resetKeys('the fallback tier', ['fallbackTier']));
	fbt.append(fbh);
	const fbrow = el('div', 'vrow');
	const fbColor = el('input');
	fbColor.type = 'color';
	fbColor.value = /^#[0-9a-f]{6}$/i.test(policy.fallbackTier.color) ? policy.fallbackTier.color : '#6b6b6b';
	fbColor.title = 'badge color';
	fbColor.className = 'vcolor';
	fbColor.addEventListener('change', () => edit(d => d.setIn(['fallbackTier', 'color'], fbColor.value)));
	const fbName = el('input');
	fbName.value = policy.fallbackTier.name;
	fbName.title = 'its name on the badge';
	fbName.addEventListener('change', () => fbName.value.trim() && edit(d => d.setIn(['fallbackTier', 'name'], fbName.value.trim())));
	const fbReview = el('input');
	fbReview.value = policy.fallbackTier.review;
	fbReview.title = 'what is left to review';
	fbReview.addEventListener('change', () => edit(d => d.setIn(['fallbackTier', 'review'], fbReview.value.trim() || 'full')));
	fbrow.append(el('span', 'vlabel', 'Name, review'), fbColor, fbName, fbReview);
	fbt.append(fbrow);

	/* origins: each flowR input type in one class */
	const types = [...new Set([...vocabulary?.inputTypes ?? [], ...Object.values(policy.origins).flat()])];
	const classOf = (ty: string) => Object.entries(policy.origins).find(([, v]) => v.includes(ty))?.[0];
	const og = el('div', 'vblock');
	const oh = el('h4');
	oh.append('Origins ', el('span', 'hint', 'per flowR '), link(Docs.inputSources, 'input type'), ...resetKeys('the origins', ['origins', 'fallbackOrigin']));
	og.append(oh);
	const ot = el('div', 'vtypes');
	for(const ty of types) {
		const row = el('label', 'vtype');
		row.append(el('code', '', ty));
		const sel = el('select');
		sel.append(option('', `(${policy.fallbackOrigin}, the fallback)`), ...Object.keys(policy.origins).map(o => option(o)));
		sel.value = classOf(ty) ?? '';
		sel.addEventListener('change', () => edit(d => {
			for(const [o, list] of Object.entries(policy.origins)) {
				const next = list.filter(x => x !== ty);
				if(o === sel.value) {
					next.push(ty);
				}
				d.setIn(['origins', o], flowed(d, next));
			}
		}));
		row.append(sel);
		ot.append(row);
	}
	og.append(ot);
	const fb = el('label', 'vrow');
	fb.append(el('span', 'vlabel', 'Fallback origin'));
	const fsel = el('select');
	fsel.append(...Object.keys(policy.origins).map(o => option(o)));
	fsel.value = policy.fallbackOrigin;
	fsel.addEventListener('change', () => edit(d => d.set('fallbackOrigin', fsel.value)));
	fb.append(fsel, el('span', 'hint', 'for unlisted input types'));
	og.append(fb);

	/* capabilities: class and flowR tags */
	const cg = el('div', 'vblock');
	const ch = el('h4');
	ch.append('Capabilities ', el('span', 'hint', 'sink class, flowR '), link(Docs.functionInfo, 'tags'), el('span', 'hint', ', and functions (regexes, with :: on pkg::fn)'), ...resetKeys('the capabilities', ['capabilities']));
	cg.append(ch);
	const classes = [...new Set(['severe', 'outward', 'other', ...shape.classes])];
	for(const [name, spec] of Object.entries(policy.capabilities)) {
		const row = el('div', 'vrow vcap');
		const n = el('span', 'vlabel');
		n.append(el('code', '', name));
		n.title = `${spec.description ?? ''}${spec.functions?.length ? `. Functions: ${spec.functions.join(' ')}` : ''}`;
		const sel = el('select');
		sel.append(...classes.map(k => option(k)));
		sel.value = spec.class;
		sel.title = 'sink class';
		sel.addEventListener('change', () => edit(d => d.setIn(['capabilities', name, 'class'], sel.value)));
		row.append(n, sel, ...chips(spec.tags ?? [], 'tag-chip', () => Docs.functionInfo, t => `flowR semantic call tag ${t}`,
			t => edit(d => d.setIn(['capabilities', name, 'tags'], flowed(d, (spec.tags ?? []).filter(x => x !== t))))));
		row.append(picker('+ tag', (vocabulary?.tags ?? []).filter(t => !spec.tags?.includes(t)).map(t => ({ value: t })),
			t => edit(d => d.setIn(['capabilities', name, 'tags'], flowed(d, [...spec.tags ?? [], t])))));
		cg.append(row);
		/* the functions it matches by name, and the ones it leaves out again */
		for(const [key, label, list] of [['functions', 'functions', spec.functions ?? []], ['exclude', 'except', spec.exclude ?? []]] as const) {
			const frow = el('div', 'vrow vcap-fns');
			frow.append(el('span', 'vlabel', label), ...chips(list, 'regex-chip', () => undefined, () => undefined,
				x => edit(d => {
					const next = list.filter(y => y !== x);
					/* a capability must match something: the last function goes only with tags or properties left */
					if(key === 'functions' && next.length === 0 && !spec.tags?.length && !spec.callProps?.length) {
						return;
					}
					if(next.length === 0) {
						d.deleteIn(['capabilities', name, key]);
					} else {
						d.setIn(['capabilities', name, key], flowed(d, next));
					}
				})));
			const add = addField('^fn$ and Enter', key === 'functions' ? 'a regular expression on the function name, or on pkg::fn if it has ::' : 'functions that do not have this capability after all',
				fnSuggestions.filter(x => !list.includes(x)), v => {
					const bad = regexError(v);
					if(bad !== undefined) {
						add.setCustomValidity(bad);
						add.reportValidity();
						return;
					}
					edit(d => d.setIn(['capabilities', name, key], flowed(d, [...list, v])));
				});
			add.addEventListener('input', () => add.setCustomValidity(''));
			frow.append(add);
			cg.append(frow);
		}
	}

	/* trusted functions and extra linting rules */
	const tg = el('div', 'vblock');
	const th = el('h4');
	th.append('Trusted ', el('span', 'hint', 'regexes on pkg::fn; their package-internal sinks do not count'), ...resetKeys('the trusted functions', ['trusted']));
	tg.append(th);
	const trow = el('div', 'vrow');
	trow.append(...chips(policy.trusted, 'regex-chip', () => undefined, () => undefined,
		x => edit(d => d.set('trusted', flowed(d, policy.trusted.filter(y => y !== x))))));
	const add = addField('^pkg::fn$ and Enter', 'a regular expression on pkg::fn: calls into these package functions do not count what happens inside them',
		callSuggestions.filter(x => !policy.trusted.includes(x)), v => {
			const bad = regexError(v);
			if(bad !== undefined) {
				add.setCustomValidity(bad);
				add.reportValidity();
				return;
			}
			edit(d => d.set('trusted', flowed(d, [...policy.trusted, v])));
		});
	add.addEventListener('input', () => add.setCustomValidity(''));
	trow.append(add);
	tg.append(trow);

	/* which files ship, from flowR's file roles */
	const sg = el('div', 'vblock');
	const sh = el('h4');
	sh.append('Shipped files ', el('span', 'hint', 'tiers count findings in these flowR file roles only'), ...resetKeys('the shipped files', ['shipped']));
	sg.append(sh);
	const srow = el('div', 'vrow');
	for(const role of FileRoles) {
		const b = el('button', 'chip', role);
		b.type = 'button';
		b.setAttribute('aria-pressed', String(policy.shipped.includes(role)));
		b.addEventListener('click', () => edit(d => d.set('shipped', flowed(d, policy.shipped.includes(role) ? policy.shipped.filter(x => x !== role) : FileRoles.filter(x => x === role || policy.shipped.includes(x))))));
		srow.append(b);
	}
	sg.append(srow);

	/* calls that never become findings */
	const ag = el('div', 'vblock');
	const ah = el('h4');
	ah.append('Allowed calls ', el('span', 'hint', 'regexes on pkg::fn, never findings; use sparingly'), ...resetKeys('the allowed calls', ['allow']));
	ag.append(ah);
	const arow = el('div', 'vrow');
	arow.append(...chips(policy.allow, 'regex-chip', () => undefined, () => undefined,
		x => edit(d => d.set('allow', flowed(d, policy.allow.filter(y => y !== x))))));
	const addAllow = addField('^pkg::fn$ and Enter', 'a regular expression on pkg::fn (or fn): such calls never become findings',
		callSuggestions.filter(x => !policy.allow.includes(x)), v => {
			const bad = regexError(v);
			if(bad !== undefined) {
				addAllow.setCustomValidity(bad);
				addAllow.reportValidity();
				return;
			}
			edit(d => d.set('allow', flowed(d, [...policy.allow, v])));
		});
	addAllow.addEventListener('input', () => addAllow.setCustomValidity(''));
	arow.append(addAllow);
	ag.append(arow);

	const rg = el('div', 'vblock');
	const rh = el('h4');
	rh.append('Reported ', el('span', 'hint', 'extra '), link(Docs.linter, 'linting rules'), el('span', 'hint', ', no effect on the tier'), ...resetKeys('the reported rules', ['report']));
	rg.append(rh);
	const rrow = el('div', 'vrow');
	rrow.append(...chips(policy.report, 'rule-chip', r => ruleDocs(r)?.docs ?? Docs.linter, r => ruleDocs(r)?.about,
		r => edit(d => d.set('report', flowed(d, policy.report.filter(x => x !== r))))));
	rrow.append(picker('+ rule', (vocabulary?.lintRules ?? []).filter(r => !policy.report.includes(r.name)).map(r => ({ value: r.name, title: r.about })),
		v => edit(d => d.set('report', flowed(d, [...policy.report, v])))));
	rg.append(rrow);
	/* time limits */
	const lg = el('div', 'vblock');
	const lh = el('h4');
	lh.append('Time limits ', el('span', 'hint', 'seconds'), ...resetKeys('the time limits', ['lintTimeout', 'lintReadTimeout', 'timeout']));
	lg.append(lh);
	const limits: readonly { key: 'lintTimeout' | 'lintReadTimeout' | 'timeout', label: string, hint: string, value: number | undefined }[] = [
		{ key: 'lintTimeout', label: 'Per linting rule', hint: 'stopped after, counts as not run', value: policy.lintTimeout },
		{ key: 'lintReadTimeout', label: 'Reading the code', hint: 'per linting worker', value: policy.lintReadTimeout },
		{ key: 'timeout', label: 'Whole analysis', hint: 'empty: no limit; then the fallback tier', value: policy.timeout }
	];
	for(const l of limits) {
		const row = el('label', 'vrow');
		row.append(el('span', 'vlabel', l.label));
		const secs = el('input');
		secs.type = 'number';
		secs.min = '1';
		secs.step = '1';
		secs.value = l.value === undefined ? '' : String(l.value);
		secs.placeholder = 'none';
		secs.className = 'vnumber';
		secs.title = l.key;
		secs.addEventListener('change', () => {
			const v = Number(secs.value);
			if(secs.value.trim() === '' && l.key === 'timeout') {
				edit(d => d.delete('timeout'));
			} else if(secs.value.trim() !== '' && Number.isFinite(v) && v > 0) {
				edit(d => d.set(l.key, v));
			} else {
				secs.value = l.value === undefined ? '' : String(l.value);
			}
		});
		row.append(secs, el('span', 'hint', l.hint));
		lg.append(row);
	}

	settings.append(ng, lg, sg, og, cg, tg, ag, rg, fbt);
	root.replaceChildren(legend, ...tiers, settings);
}
