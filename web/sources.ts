/**
 * Where the page gets the code it analyzes from: files and folders the user picks or drops, zip archives,
 * a single file behind a URL, or a GitHub repository. Everything is read into memory; the only requests
 * are the ones for the URL or repository the user typed, and they only download.
 */
import { unzipSync, strFromU8, inflateSync } from 'fflate';
import { unpackFromUrl } from '@eagleoutice/flowr/util/text/url-encoding';
import type { SourceFile } from './protocol';

/** what the analysis reads: R code, R Markdown, Quarto, and the package metadata */
export const Wanted = /(\.(R|r|Rmd|rmd|qmd)$)|(^|\/)DESCRIPTION$/;
/** skipped folders: package libraries and version control */
const Skipped = /(^|\/)(\.git|renv|packrat|node_modules|\.Rproj\.user|rv\/library)\//;
export const MaxFiles = 2000;
export const MaxBytes = 30 * 1024 * 1024;

export class SourceError extends Error {}

function keep(path: string): boolean {
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

function limit(files: SourceFile[]): SourceFile[] {
	if(files.length > MaxFiles) {
		throw new SourceError(`${files.length} files is more than the ${MaxFiles} the page analyzes; use the command line for larger projects`);
	}
	const bytes = files.reduce((s, f) => s + f.content.length, 0);
	if(bytes > MaxBytes) {
		throw new SourceError(`${Math.round(bytes / 1e6)} MB of R code is more than the page analyzes; use the command line for larger projects`);
	}
	return files;
}

export function fromZip(bytes: Uint8Array): SourceFile[] {
	const entries = unzipSync(bytes, { filter: f => keep(f.name) });
	return limit(stripCommonRoot(Object.entries(entries).map(([path, data]) => ({ path, content: strFromU8(data) }))));
}

/** files from an `<input type=file>` (with or without `webkitdirectory`) or a drop; zip archives are unpacked */
export async function fromFiles(list: Iterable<File & { webkitRelativePath?: string, relativePath?: string }>): Promise<SourceFile[]> {
	const out: SourceFile[] = [];
	for(const f of list) {
		const path = f.relativePath || f.webkitRelativePath || f.name;
		if(/\.zip$/i.test(f.name)) {
			out.push(...fromZip(new Uint8Array(await f.arrayBuffer())));
		} else if(keep(path)) {
			out.push({ path, content: await f.text() });
		}
	}
	return limit(uniquePaths(stripCommonRoot(out)));
}

/** everything below a dropped folder, read through the entries API */
export async function fromDrop(items: DataTransferItemList): Promise<SourceFile[]> {
	const files: (File & { relativePath?: string })[] = [];
	const walk = async(entry: FileSystemEntry, prefix: string): Promise<void> => {
		if(entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
			files.push(Object.assign(file, { relativePath: prefix + file.name }));
		} else if(entry.isDirectory && !Skipped.test(prefix + entry.name + '/')) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			let batch: FileSystemEntry[];
			do {
				batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
				for(const e of batch) {
					await walk(e, prefix + entry.name + '/');
				}
			} while(batch.length > 0);
		}
	};
	const entries = [...items].map(i => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
	for(const e of entries) {
		await walk(e, '');
	}
	return fromFiles(files);
}

interface GitHubTarget { owner: string, repo: string, ref?: string, path: string, blob: boolean }

export function parseGitHub(url: string): GitHubTarget | undefined {
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
		if(paths.length > MaxFiles) {
			throw new SourceError(`${paths.length} R files is more than the ${MaxFiles} the page analyzes; use the command line for larger projects`);
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
			files.push({ path: t.path && !t.blob ? p.slice(t.path.length + 1) : p.split('/').pop() as string, content: await res.text() });
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
		return [{ path: 'script.R', content: strFromU8(inflateSync(Uint8Array.from(bin, c => c.charCodeAt(0)))) }];
	}
	const code = q.get('code');
	return code === null ? undefined : [{ path: 'script.R', content: code }];
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
	if(paths.length > MaxFiles) {
		throw new SourceError(`${paths.length} R files is more than the ${MaxFiles} the page analyzes; use the command line for larger projects`);
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
export type UrlKind = 'playground' | 'own' | 'github' | 'gist' | 'gitlab' | 'cran' | 'shiny-deployment' | 'file';

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
		return { kind: 'own', note: 'a badgR link: its code is read from the link, without any request' };
	}
	if(/^https?:\/\/gist\.github\.com\//.test(u)) {
		return { kind: 'gist', note: 'a GitHub gist, through api.github.com' };
	}
	if(cranPackage(u) !== undefined) {
		return { kind: 'cran', note: `the CRAN package ${cranPackage(u)}, from its mirror github.com/cran/${cranPackage(u)}` };
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

/** `owner/repo` is a GitHub repository, a missing scheme is https */
function normalizeUrl(url: string): string | undefined {
	const t = url.trim();
	if(t.length === 0) {
		return undefined;
	}
	if(/^[\w.-]+\/[\w.-]+$/.test(t)) {
		return `https://github.com/${t}`;
	}
	return /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
}

/** the package of a CRAN page: `cran.r-project.org/package=x`, `.../web/packages/x/...`, or `cran.dev/x` */
function cranPackage(url: string): string | undefined {
	return /cran\.r-project\.org\/(?:web\/)?(?:packages\/|package=)([\w.]+)/.exec(url)?.[1]
		?? /cran\.dev\/([\w.]+)/.exec(url)?.[1]
		?? /CRAN\.R-project\.org\/package=([\w.]+)/i.exec(url)?.[1];
}

/**
 * Any link: a flowR playground or badgR link (read from the link itself), a GitHub repository, folder,
 * file, or gist, a GitLab project, a CRAN package (from its GitHub mirror), or a zip archive or R file
 * on a server that allows downloads from other sites.
 */
export async function fromUrl(url: string, progress: (msg: string) => void = () => {}): Promise<SourceFile[]> {
	const kind = describeUrl(url)?.kind;
	url = normalizeUrl(url) ?? url;
	if(kind === 'playground') {
		return fromPlaygroundLink(url) as SourceFile[];
	}
	if(kind === 'own') {
		return fromOwnLink(url) as SourceFile[];
	}
	if(kind === 'gist') {
		const id = /gist\.github\.com\/(?:[\w-]+\/)?([0-9a-f]+)/.exec(url)?.[1];
		if(id === undefined) {
			throw new SourceError('not a gist url');
		}
		return fromGist(id, progress);
	}
	if(kind === 'cran') {
		const pkg = cranPackage(url) as string;
		return fromGitHub(`https://github.com/cran/${pkg}`, progress);
	}
	if(kind === 'shiny-deployment') {
		throw new SourceError('This is a running Shiny app. Its server does not hand out the app\'s code, so badgR cannot read it from here. Give the GitHub or GitLab repository of the app, or upload its folder.');
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
	const name = new URL(url).pathname.split('/').pop() || 'script.R';
	if(/\.zip$/i.test(name) || res.headers.get('content-type')?.includes('zip')) {
		return fromZip(new Uint8Array(await res.arrayBuffer()));
	}
	return limit([{ path: /\.(R|r|Rmd|rmd|qmd)$/.test(name) ? name : `${name}.R`, content: await res.text() }]);
}
