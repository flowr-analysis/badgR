/**
 * A package by name for the command line: `cran:glue`, `glue@1.8.0`, `cran:glue@1.8.0`, or `bioc:limma`,
 * downloaded once from its GitHub mirror (github.com/cran, github.com/bioc, as the web page reads them)
 * into a cache folder, and analyzed from there. Only the R code and the package metadata are kept.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MetaFilePattern, RFilePattern } from './core';

/** the top-level domains a bare `name.tld` most likely means, rather than a package such as `data.table` (as in web/sources.ts) */
export const Hosts = /\.(com|org|net|io|dev|app|edu|gov|de|uk|fr|ch|at|nl|eu|info|me|co|ai|sh|page|site|xyz)$/i;

export interface PackageSpec {
	readonly repo:     'cran' | 'bioc'
	readonly name:     string
	readonly version?: string
}

/**
 * A package the target names, or `undefined` for a path. A bare name (`glue`) only counts when no file
 * or folder of that name exists, `glue@1.8.0` and `cran:`/`bioc:` always do.
 */
export function packageSpec(target: string, exists: (p: string) => boolean = fs.existsSync): PackageSpec | undefined {
	const m = /^(?:(cran|bioc):)?([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9])(?:@([\w.-]+))?$/i.exec(target.trim());
	/* a version of dots only (`.`, `..`) would walk the URL's path */
	if(m === null || (m[3] !== undefined && /^\.+$/.test(m[3]))) {
		return undefined;
	}
	/* a bare word is a path if it exists or looks like a file name or a host, as the web page reads it */
	if(m[1] === undefined && m[3] === undefined && (exists(target) || /\.(R|r|Rmd|rmd|qmd|zip)$/.test(m[2]) || Hosts.test(m[2]))) {
		return undefined;
	}
	return { repo: (m[1]?.toLowerCase() ?? 'cran') as 'cran' | 'bioc', name: m[2], ...(m[3] ? { version: m[3] } : {}) };
}

export function packageLabel(p: PackageSpec): string {
	return `${p.repo}:${p.name}${p.version ? `@${p.version}` : ''}`;
}

/** the archive of the mirror: a released version is a tag, otherwise the default branch */
export function archiveUrl(p: PackageSpec): string {
	return `https://codeload.github.com/${p.repo}/${p.name}/tar.gz/${p.version ? `refs/tags/${p.version}` : 'HEAD'}`;
}

/** the files of a tar archive, as a reader of the POSIX (ustar and pax) format; links and folders are left out */
export function untar(data: Uint8Array): { path: string, content: Uint8Array }[] {
	const out: { path: string, content: Uint8Array }[] = [];
	const text = (from: number, len: number) => new TextDecoder().decode(data.subarray(from, from + len)).replace(/\0.*$/s, '');
	let longName: string | undefined;
	for(let at = 0; at + 512 <= data.length;) {
		const name = text(at, 100);
		if(name === '' && data.subarray(at, at + 512).every(b => b === 0)) {
			break;
		}
		const size = parseInt(text(at + 124, 12).trim() || '0', 8);
		/* a damaged header would not move on, or read past the end */
		if(!Number.isInteger(size) || size < 0 || at + 512 + size > data.length) {
			throw new Error(`damaged tar archive: an entry at byte ${at} has size ${text(at + 124, 12).trim()}`);
		}
		const type = String.fromCharCode(data[at + 156] || 48);
		const prefix = text(at + 345, 155);
		const body = data.subarray(at + 512, at + 512 + size);
		at += 512 + Math.ceil(size / 512) * 512;
		if(type === 'x') {
			/* a pax header: `<len> path=<name>\n` names the next file */
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body))?.[1] ?? longName;
			continue;
		}
		if(type === 'L') {
			longName = new TextDecoder().decode(body).replace(/\0.*$/s, '');
			continue;
		}
		const full = longName ?? (prefix ? `${prefix}/${name}` : name);
		longName = undefined;
		if(type === '0' || type === '\0' || type === '7') {
			out.push({ path: full, content: body });
		}
	}
	return out;
}

/** where downloaded packages are kept */
export function packageCache(): string {
	return path.resolve(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'badger', 'packages');
}

/**
 * Downloads a package (once; a version is cached for good, the default branch for a day) and returns its
 * folder. Paths that would leave the folder are refused.
 */
export async function fetchPackage(p: PackageSpec, log: (msg: string) => void = () => {}): Promise<string> {
	const dir = path.join(packageCache(), `${p.repo}-${p.name}${p.version ? `@${p.version}` : ''}`);
	const stamp = path.join(dir, Stamp);
	if(fs.existsSync(stamp) && (p.version !== undefined || Date.now() - fs.statSync(stamp).mtimeMs < 24 * 3600 * 1000)) {
		return dir;
	}
	return fetchTarball(archiveUrl(p), dir, packageLabel(p), log, status => status === 404
		? `no such package${p.version ? ' or version' : ''} on github.com/${p.repo}` : undefined);
}

/** marks a folder as downloaded completely */
const Stamp = '.badger-fetched';

/**
 * Downloads a GitHub archive (`.tar.gz`, everything below its top folder) into `dir`, keeping only the R
 * code and the package metadata. Paths that would leave the folder are refused.
 */
export async function fetchTarball(url: string, dir: string, label: string, log: (msg: string) => void = () => {}, explain: (status: number) => string | undefined = () => undefined): Promise<string> {
	log(`downloading ${label} from ${url}`);
	const res = await fetch(url);
	if(!res.ok) {
		const why = explain(res.status);
		throw new Error(`${label}: ${why ? `${why} (${url} answered ${res.status})` : `${url} answered ${res.status}`}`);
	}
	/* at most 1 GiB unpacked: a small archive must not unpack to more than the memory has */
	const files = untar(gunzipSync(new Uint8Array(await res.arrayBuffer()), { maxOutputLength: 1 << 30 }))
		/* GitHub puts everything below `<repo>-<ref>/` */
		.map(f => ({ path: f.path.split('/').slice(1).join('/'), content: f.content, from: f.path }));
	return writeFolder(files, dir, label, log);
}

/**
 * Writes the R code and package metadata of `files` into `dir`, replacing what was there. The files are
 * written next to the folder and moved in at the end: a download that fails halfway, or a second run of
 * badger, never leaves or reads a half-written folder. Paths that would leave the folder are refused.
 */
export function writeFolder(files: readonly { path: string, content: Uint8Array | string, from?: string }[], dir: string, label: string, log: (msg: string) => void = () => {}): string {
	const work = `${dir}.tmp-${process.pid}-${Date.now()}`;
	fs.rmSync(work, { recursive: true, force: true });
	fs.mkdirSync(work, { recursive: true });
	let kept = 0;
	try {
		for(const f of files) {
			const rel = f.path;
			if(rel === '' || !(RFilePattern.test(rel) || MetaFilePattern.test(rel))) {
				continue;
			}
			const to = path.resolve(work, rel);
			if(!to.startsWith(work + path.sep) || rel.split('/').includes('..')) {
				throw new Error(`${label}: the archive has a path outside its folder: ${f.from ?? f.path}`);
			}
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.writeFileSync(to, f.content);
			kept++;
		}
	} catch(e) {
		fs.rmSync(work, { recursive: true, force: true });
		throw e;
	}
	fs.writeFileSync(path.join(work, Stamp), new Date().toISOString() + '\n');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.renameSync(work, dir);
	log(`${label}: ${kept} file(s) in ${dir}`);
	return dir;
}
