/** the packages a project names: `library(x)`, `require(x)`, `x::f`, `p_load(a, b)`, and a DESCRIPTION's Imports */
export function packagesNamed(files: readonly { path: string, content: string }[]): Set<string> {
	const names = new Set<string>();
	for(const f of files) {
		const text = f.content;
		for(const m of text.matchAll(/\b(?:library|require|requireNamespace|loadNamespace|attachNamespace)\s*\(\s*["']?([A-Za-z][\w.]*)/g)) {
			names.add(m[1]);
		}
		for(const m of text.matchAll(/\b([A-Za-z][\w.]*):::?[A-Za-z.`]/g)) {
			names.add(m[1]);
		}
		for(const m of text.matchAll(/\bp_load\s*\(([^)]*)\)/g)) {
			for(const n of m[1].split(',')) {
				const name = n.trim().replace(/^["']|["']$/g, '');
				if(/^[A-Za-z][\w.]*$/.test(name)) {
					names.add(name);
				}
			}
		}
		if(/(^|\/)DESCRIPTION$/.test(f.path)) {
			for(const field of text.matchAll(/^(?:Imports|Depends):\s*([\s\S]*?)(?=^\S|$(?![\s\S]))/gm)) {
				for(const dep of field[1].split(',')) {
					const name = dep.trim().split(/[\s(]/)[0];
					if(/^[A-Za-z][\w.]*$/.test(name) && name !== 'R') {
						names.add(name);
					}
				}
			}
		}
	}
	return names;
}
