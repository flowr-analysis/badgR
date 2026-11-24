/**
 * Code behind a link, for the page and the command line: zip archives, a single file behind a URL, a
 * GitHub repository, a gist, a GitLab project, or the code inside a link of the playground. Everything
 * is read into memory; the only requests are the ones for the link given, and they only download.
 */
import { unzipSync, strFromU8, Inflate } from 'fflate';
import { unpackFromUrl } from '@eagleoutice/flowr/util/text/url-encoding';

export interface SourceFile {
	readonly path:    string
	readonly content: string
}

/** what the analysis reads: R code, R Markdown, Quarto, and the package metadata */
export const Wanted = /(\.(R|r|Rmd|rmd|qmd)$)|(^|\/)(DESCRIPTION|NAMESPACE|\.Rprofile)$/;
/** skipped folders: package libraries and version control */
export const Skipped = /(^|\/)(\.git|renv|packrat|node_modules|\.Rproj\.user|rv\/library)\//;
/** how much the page reads; the command line, which has no tab to keep alive, raises them */
export const SourceLimits = { files: 2000, bytes: 30 * 1024 * 1024, beyond: 'the page analyzes; use the command line for larger projects' };

export class SourceError extends Error {}

/** inflates the data of a link, at most `max` bytes: a link of a megabyte could otherwise unpack to gigabytes */
export function inflateLimited(data: Uint8Array, max = SourceLimits.bytes): Uint8Array {
	const parts: Uint8Array[] = [];
	let size = 0;
	const inflate = new Inflate(chunk => {
		size += chunk.length;
		if(size > max) {
			throw new SourceError(`the data in this link unpacks to more than ${Math.round(max / 1e6)} MB`);
		}
		parts.push(chunk);
	});
	for(let at = 0; at < data.length; at += 16384) {
		inflate.push(data.subarray(at, at + 16384), at + 16384 >= data.length);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for(const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export function keep(path: string): boolean {
	return Wanted.test(path) && !Skipped.test(path);
}

/** strips the folder all paths share, so `repo-main/app.R` becomes `app.R` */
export function stripCommonRoot(files: SourceFile[]): SourceFile[] {
	if(files.length === 0) {
		return files;
	}
	const first = files[0].path.split('/');
	let n = first.length - 1;
	for(const f of files) {
		const parts = f.path.split('/');
		let i = 0;
		while(i < n && i < parts.length - 1 && parts[i] === first[i]) {
			i++;
		}
		n = i;
	}
	return n === 0 ? files : files.map(f => ({ path: f.path.split('/').slice(n).join('/'), content: f.content }));
}

/** separate uploads may share a name (two `app.R`), flowR would see one file: number the later ones */
export function uniquePaths(files: SourceFile[]): SourceFile[] {
	const seen = new Map<string, number>();
	return files.map(f => {
		const n = seen.get(f.path) ?? 0;
		seen.set(f.path, n + 1);
		if(n === 0) {
			return f;
		}
		const dot = f.path.lastIndexOf('.');
		const path = dot > f.path.lastIndexOf('/') ? `${f.path.slice(0, dot)} (${n + 1})${f.path.slice(dot)}` : `${f.path} (${n + 1})`;
		return { path, content: f.content };
	});
}

export function limit(files: SourceFile[]): SourceFile[] {
	if(files.length > SourceLimits.files) {
		throw new SourceError(`${files.length} files is more than the ${SourceLimits.files} ${SourceLimits.beyond}`);
	}
	const bytes = files.reduce((s, f) => s + f.content.length, 0);
	if(bytes > SourceLimits.bytes) {
		throw new SourceError(`${Math.round(bytes / 1e6)} MB of R code is more than ${SourceLimits.beyond}`);
	}
	return files;
}

export function fromZip(bytes: Uint8Array): SourceFile[] {
	const entries = unzipSync(bytes, { filter: f => keep(f.name) });
	return limit(stripCommonRoot(Object.entries(entries).map(([path, data]) => ({ path, content: strFromU8(data) }))));
}

interface GitHubTarget { owner: string, repo: string, ref?: string, path: string, blob: boolean }

export function parseGitHub(url: string): GitHubTarget | undefined {
	/* the host in any case, the path as it is */
	url = url.trim().replace(/^(https?:\/\/)([^/]+)/i, (_, scheme: string, host: string) => scheme.toLowerCase() + host.toLowerCase());
	const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[?#].*)?$/.exec(url.trim());
	if(m === null) {
		return undefined;
	}
	return { owner: m[1], repo: m[2], ref: m[4], path: (m[5] ?? '').replace(/\/$/, ''), blob: m[3] === 'blob' };
}

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
	if(res.status === 403 || res.status === 429) {
		throw new SourceError('GitHub limits requests without a login to 60 per hour; try again later, or download the repository as a zip and upload it');
	}
	if(!res.ok) {
		throw new SourceError(`GitHub answered ${res.status} for ${url}`);
	}
	return await res.json() as T;
}

/**
 * A repository, a folder of it, or one file, through GitHub's API (one request for the file list) and its
 * raw file host (one request per R file). Both answer cross-origin requests, so no proxy is involved.
 */
export async function fromGitHub(url: string, progress: (msg: string) => void = () => {}): Promise<SourceFile[]> {
	const t = parseGitHub(url);
	if(t === undefined) {
		throw new SourceError('not a GitHub repository url');
	}
	const api = `https://api.github.com/repos/${t.owner}/${t.repo}`;
	const ref = t.ref ?? (await getJson<{ default_branch: string }>(api)).default_branch;
	const raw = (p: string) => `https://raw.githubusercontent.com/${t.owner}/${t.repo}/${encodeURIComponent(ref)}/${p.split('/').map(encodeURIComponent).join('/')}`;
	let paths: string[];
	if(t.blob) {
		paths = [t.path];
	} else {
		progress(`listing ${t.owner}/${t.repo}@${ref}`);
		const tree = await getJson<{ tree: { path: string, type: string, size?: number }[], truncated: boolean }>(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
		paths = tree.tree.filter(e => e.type === 'blob' && (t.path === '' || e.path.startsWith(t.path + '/')) && keep(e.path)).map(e => e.path);
		if(paths.length > SourceLimits.files) {
			throw new SourceError(`${paths.length} R files is more than the ${SourceLimits.files} ${SourceLimits.beyond}`);
		}
	}
	const files: SourceFile[] = [];
	let done = 0;
	const queue = [...paths];
	/* a few downloads at a time, not hundreds at once */
	await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async() => {
		for(let p = queue.shift(); p !== undefined; p = queue.shift()) {
			const res = await fetch(raw(p));
			if(!res.ok) {
				throw new SourceError(`could not download ${p} (${res.status})`);
			}
			/* a file by itself keeps its name, files of a folder their path below it, files of the repository their full path */
			files.push({ path: t.blob ? p.split('/').pop() as string : t.path ? p.slice(t.path.length + 1) : p, content: await res.text() });
			progress(`downloaded ${++done}/${paths.length} file(s)`);
		}
	}));
	files.sort((a, b) => a.path.localeCompare(b.path));
	return limit(files);
}

/** the code inside a link of flowR's playground (`#c=`, `n=`, `o=`), read without any request */
export function fromPlaygroundLink(url: string): SourceFile[] | undefined {
	const hash = url.split('#')[1];
	if(hash === undefined || !/(^|\/)playground\/?$/.test(url.split('#')[0].replace(/[?].*$/, ''))) {
		return undefined;
	}
	const q = new URLSearchParams(hash);
	const code = q.get('c');
	if(code === null) {
		throw new SourceError('this flowR playground link carries no code');
	}
	const main = unpackFromUrl(code);
	if(main === undefined) {
		throw new SourceError('the code in this flowR playground link is damaged');
	}
	const others = q.get('o');
	const files: SourceFile[] = [];
	if(others !== null) {
		const list = JSON.parse(unpackFromUrl(others) ?? '[]') as [string, string][];
		files.push(...list.map(([path, content]) => ({ path, content })));
	}
	files.push({ path: q.get('n') || 'main.R', content: main });
	return limit(uniquePaths(files));
}

/** the code inside a link of this page (`#z=` or `#code=`) */
function fromOwnLink(url: string): SourceFile[] | undefined {
	const hash = url.split('#')[1];
	if(hash === undefined) {
		return undefined;
	}
	const q = new URLSearchParams(hash);
	const z = q.get('z');
	if(z !== null) {
		const bin = atob(z.replace(/-/g, '+').replace(/_/g, '/'));
		return [{ path: 'main.R', content: strFromU8(inflateLimited(Uint8Array.from(bin, c => c.charCodeAt(0)))) }];
	}
	const code = q.get('code');
	return code === null ? undefined : [{ path: 'main.R', content: code }];
}

/** a gist: one request lists its files with their content */
async function fromGist(id: string, progress: (msg: string) => void): Promise<SourceFile[]> {
	progress(`fetching gist ${id}`);
	const gist = await getJson<{ files: Record<string, { filename: string, content: string, truncated?: boolean, raw_url: string }> }>(`https://api.github.com/gists/${id}`);
	const files: SourceFile[] = [];
	for(const f of Object.values(gist.files)) {
		if(keep(f.filename)) {
			files.push({ path: f.filename, content: f.truncated ? await (await fetch(f.raw_url)).text() : f.content });
		}
	}
	return limit(files);
}

/** a GitLab project, a folder of it, or a file, through GitLab's API, which answers cross-origin requests */
async function fromGitLab(host: string, project: string, ref: string | undefined, path: string, progress: (msg: string) => void): Promise<SourceFile[]> {
	const api = `https://${host}/api/v4/projects/${encodeURIComponent(project)}`;
	const meta = await fetch(api);
	if(!meta.ok) {
		throw new SourceError(`${host} answered ${meta.status} for ${project}`);
	}
	const branch = ref ?? (await meta.json() as { default_branch: string }).default_branch;
	const paths: string[] = [];
	for(let page = 1; page < 50; page++) {
		progress(`listing ${project}@${branch}, page ${page}`);
		const res = await fetch(`${api}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
		if(!res.ok) {
			throw new SourceError(`${host} answered ${res.status} when listing ${project}`);
		}
		const entries = await res.json() as { path: string, type: string }[];
		paths.push(...entries.filter(e => e.type === 'blob' && keep(e.path)).map(e => e.path));
		if(entries.length < 100) {
			break;
		}
	}
	if(paths.length > SourceLimits.files) {
		throw new SourceError(`${paths.length} R files is more than the ${SourceLimits.files} ${SourceLimits.beyond}`);
	}
	const files: SourceFile[] = [];
	let done = 0;
	for(const p of paths) {
		const res = await fetch(`${api}/repository/files/${encodeURIComponent(p)}/raw?ref=${encodeURIComponent(branch)}`);
		if(!res.ok) {
			throw new SourceError(`could not download ${p} (${res.status})`);
		}
		files.push({ path: path ? p.slice(path.length + 1) : p, content: await res.text() });
		progress(`downloaded ${++done}/${paths.length} file(s)`);
	}
	return limit(files);
}

/** what a link points at, read as well as the page can: see `fromUrl` */
export type UrlKind = 'playground' | 'own' | 'github' | 'gist' | 'gitlab' | 'cran' | 'bioc' | 'shiny-deployment' | 'file';

/** a short name for what the page will do with a link, for the input field */
export function describeUrl(url: string): { kind: UrlKind, note: string } | undefined {
	const u = normalizeUrl(url);
	if(u === undefined) {
		return undefined;
	}
	if(/(^|\/)playground\/?(#|$)/.test(u) && u.includes('#')) {
		return { kind: 'playground', note: 'a flowR playground link: its code is read from the link, without any request' };
	}
	if(/#(.*&)?(z|code)=/.test(u)) {
		return { kind: 'own', note: 'a badger link: its code is read from the link, without any request' };
	}
	const inner = ownLinkUrl(u);
	if(inner !== undefined) {
		const d = describeUrl(inner);
		return d === undefined ? undefined : { kind: d.kind, note: `a badger link to ${inner}: ${d.note}` };
	}
	if(/^https?:\/\/gist\.github\.com\//.test(u)) {
		return { kind: 'gist', note: 'a GitHub gist, through api.github.com' };
	}
	const cran = cranPackage(u);
	if(cran !== undefined) {
		return { kind: 'cran', note: `the CRAN package ${cran.name}${cran.version ? ` ${cran.version}` : ''}, from its mirror github.com/cran/${cran.name}` };
	}
	const bioc = biocPackage(u);
	if(bioc !== undefined) {
		return { kind: 'bioc', note: `the Bioconductor package ${bioc}, from its mirror github.com/bioc/${bioc}` };
	}
	if(parseGitHub(u) !== undefined) {
		return { kind: 'github', note: 'a GitHub repository, through api.github.com and raw.githubusercontent.com' };
	}
	if(/^https?:\/\/(gitlab\.com|[^/]*gitlab[^/]*)\/[^/]+\/[^/]+/.test(u)) {
		return { kind: 'gitlab', note: 'a GitLab project, through its API' };
	}
	if(/\.shinyapps\.io|\/connect\/|posit\.cloud|shinyapps/.test(u)) {
		return { kind: 'shiny-deployment', note: 'a running Shiny app: a server does not hand out the code of an app, so give its repository instead' };
	}
	return { kind: 'file', note: 'an R file or a .zip, if the server allows downloads from other sites (CORS)' };
}

/** an R package name: letters, digits, and dots, starting with a letter, not ending with a dot */
const PackageName = /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/;
/** the top-level domains a bare `name.tld` most likely means, rather than a package such as `data.table` */
const Hosts = /\.(com|org|net|io|dev|app|edu|gov|de|uk|fr|ch|at|nl|eu|info|me|co|ai|sh|page|site|xyz)$/i;

/**
 * `owner/repo` is a GitHub repository; a bare package name (`glue`, `data.table`, `glue@1.8.0`, `cran:glue`)
 * is a CRAN package and `bioc:limma` one of Bioconductor; a missing scheme is https.
 */
export function normalizeUrl(url: string): string | undefined {
	const t = url.trim();
	if(t.length === 0) {
		return undefined;
	}
	if(/^(cran|bioc):\s*$/i.test(t) || /^[A-Za-z][\w.]*@$/.test(t)) {
		return undefined;
	}
	const pkg = /^(?:(cran|bioc):\s*)?([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])(?:@([\w.-]+))?$/i.exec(t);
	if(pkg !== null && (pkg[1] !== undefined || pkg[3] !== undefined || (PackageName.test(pkg[2]) && !Hosts.test(pkg[2])))) {
		if(pkg[1]?.toLowerCase() === 'bioc') {
			return `https://bioconductor.org/packages/${pkg[2]}`;
		}
		return `https://cran.r-project.org/package=${pkg[2]}${pkg[3] ? `&version=${pkg[3]}` : ''}`;
	}
	if(/^[\w.-]+\/[\w.-]+$/.test(t)) {
		return `https://github.com/${t}`;
	}
	return /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
}

/**
 * The package (and version, if the link names one) of a CRAN page or file: `cran.r-project.org/package=x`,
 * `.../web/packages/x/...`, a source archive `.../src/contrib/x_1.0.tar.gz`, a mirror such as
 * `cloud.r-project.org` or `cran.rstudio.com`, or `cran.dev/x`.
 */
export function cranPackage(url: string): { name: string, version?: string } | undefined {
	const host = /^https?:\/\/(?:www\.)?(cran\.[\w.-]+|cloud\.r-project\.org|cran\.dev)(\/.*)?$/i.exec(url);
	if(host === null) {
		return undefined;
	}
	const rest = host[2] ?? '';
	const archive = /\/src\/contrib\/(?:Archive\/[\w.]+\/)?([A-Za-z][\w.]*)_([\w.-]+)\.tar\.gz$/.exec(rest);
	if(archive !== null) {
		return { name: archive[1], version: archive[2] };
	}
	const name = /^\/(?:web\/)?(?:packages\/|package=)([A-Za-z][\w.]*[A-Za-z0-9])/i.exec(rest)?.[1]
		?? (/^cran\.dev$/i.test(host[1]) ? /^\/([A-Za-z][\w.]*[A-Za-z0-9])/.exec(rest)?.[1] : undefined);
	if(name === undefined) {
		return undefined;
	}
	const version = /[?&]version=([\w.-]+)/.exec(rest)?.[1];
	return { name, ...(version ? { version } : {}) };
}

/** the package of a Bioconductor page: `bioconductor.org/packages/x`, `.../packages/release/bioc/html/x.html` */
export function biocPackage(url: string): string | undefined {
	const m = /^https?:\/\/(?:www\.)?bioconductor\.org\/packages\/(?:(?:release|devel|[\d.]+)\/bioc\/html\/)?([A-Za-z][\w.]*[A-Za-z0-9])(?:\.html)?\/?$/.exec(url);
	return m?.[1];
}

/** the URL inside a link of this page to a fetched repository or file, `...#url=<url>` */
function ownLinkUrl(url: string): string | undefined {
	const hash = url.split('#')[1];
	if(hash === undefined) {
		return undefined;
	}
	const inner = new URLSearchParams(hash).get('url');
	return inner === null || inner === url ? undefined : inner;
}

/**
 * Any link: a flowR playground or badger link (read from the link itself), a GitHub repository, folder,
 * file, or gist, a GitLab project, a CRAN package (from its GitHub mirror), or a zip archive or R file
 * on a server that allows downloads from other sites.
 */
export async function fromUrl(url: string, progress: (msg: string) => void = () => {}, depth = 0): Promise<SourceFile[]> {
	url = normalizeUrl(url) ?? url;
	/* a link of this page to a repository or file: what it points to, before anything else */
	const inner = /#(.*&)?(z|code)=/.test(url) ? undefined : ownLinkUrl(url);
	if(inner !== undefined) {
		if(depth > 4) {
			throw new SourceError('this link points to a link to a link: give the repository or file itself');
		}
		return fromUrl(inner, progress, depth + 1);
	}
	const kind = describeUrl(url)?.kind;
	if(kind === 'playground' || kind === 'own') {
		const files = kind === 'playground' ? fromPlaygroundLink(url) : fromOwnLink(url);
		if(files === undefined) {
			throw new SourceError('this link carries no code');
		}
		return files;
	}
	if(kind === 'gist') {
		const id = /gist\.github\.com\/(?:[\w-]+\/)?([0-9a-f]+)/.exec(url)?.[1];
		if(id === undefined) {
			throw new SourceError('not a gist url');
		}
		return fromGist(id, progress);
	}
	if(kind === 'cran') {
		const pkg = cranPackage(url) as { name: string, version?: string };
		/* the mirror tags every released version with its number */
		return fromGitHub(`https://github.com/cran/${pkg.name}${pkg.version ? `/tree/${pkg.version}` : ''}`, progress);
	}
	if(kind === 'bioc') {
		return fromGitHub(`https://github.com/bioc/${biocPackage(url) as string}`, progress);
	}
	if(kind === 'shiny-deployment') {
		throw new SourceError('This is a running Shiny app. Its server does not hand out the app\'s code, so badger cannot read it from here. Give the GitHub or GitLab repository of the app, or upload its folder.');
	}
	if(kind === 'gitlab') {
		const m = /^https?:\/\/([^/]+)\/(.+?)(?:\/-\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[?#].*)?$/.exec(url);
		if(m) {
			return fromGitLab(m[1], m[2].replace(/\.git$/, ''), m[3], (m[4] ?? '').replace(/\/$/, ''), progress);
		}
	}
	if(parseGitHub(url) !== undefined) {
		return fromGitHub(url, progress);
	}
	let res: Response;
	try {
		progress(`downloading ${url}`);
		res = await fetch(url);
	} catch{
		throw new SourceError(`could not download ${url}: the server does not allow downloads from other sites (CORS); download it yourself and upload it`);
	}
	if(!res.ok) {
		throw new SourceError(`the server answered ${res.status} for ${url}`);
	}
	const name = new URL(url).pathname.split('/').pop() || 'main.R';
	if(/\.zip$/i.test(name) || res.headers.get('content-type')?.includes('zip')) {
		return fromZip(new Uint8Array(await res.arrayBuffer()));
	}
	return limit([{ path: /\.(R|r|Rmd|rmd|qmd)$/.test(name) ? name : `${name}.R`, content: await res.text() }]);
}
