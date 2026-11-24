/**
 * A link for the command line, read as the web page reads it: a GitHub repository, folder, or file, a
 * gist, a GitLab project, a CRAN or Bioconductor page, a link of the flowR playground or of the page, or
 * an R file or zip archive anywhere. The code is downloaded into a cache folder and analyzed from there.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceLimits, biocPackage, cranPackage, fromUrl, normalizeUrl, parseGitHub } from './sources';
import { fetchPackage, fetchTarball, packageCache, writeFolder } from './fetch-package';

/**
 * The link a target names, or `undefined` for a path or a package: anything with a scheme
 * (`https://...`), or `host.tld/...` when no such file or folder exists.
 */
export function urlSpec(target: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
	const t = target.trim();
	if(/^https?:\/\//i.test(t)) {
		return t;
	}
	return !exists(t) && /^(www\.)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}\/\S/i.test(t) ? `https://${t}` : undefined;
}

/** where a link is downloaded to: a readable name and a hash, so two links never share a folder */
export function urlFolder(url: string): string {
	const name = url.replace(/^[a-z]+:\/\//i, '').replace(/[#?].*$/s, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
	const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
	return path.join(path.dirname(packageCache()), 'urls', `${name}-${hash}`);
}

/**
 * Downloads what a link points to (every time: a branch or a file behind a link may change) and returns
 * the folder to analyze. A GitHub repository or folder comes as one archive, without GitHub's API and
 * its limit of 60 requests an hour; a CRAN or Bioconductor page is the package, cached as `glue` is.
 */
export async function fetchUrl(target: string, log: (msg: string) => void = () => {}): Promise<string> {
	const url = normalizeUrl(target) ?? target;
	const cran = cranPackage(url);
	if(cran !== undefined) {
		return fetchPackage({ repo: 'cran', ...cran }, log);
	}
	const bioc = biocPackage(url);
	if(bioc !== undefined) {
		return fetchPackage({ repo: 'bioc', name: bioc }, log);
	}
	const dir = urlFolder(url);
	const gh = parseGitHub(url);
	if(gh !== undefined && !gh.blob) {
		const archive = `https://codeload.github.com/${gh.owner}/${gh.repo}/tar.gz/${gh.ref ? encodeURIComponent(gh.ref) : 'HEAD'}`;
		await fetchTarball(archive, dir, url, log, status => status === 404 ? 'no such repository or branch, or it is private' : undefined);
		const sub = path.resolve(dir, gh.path);
		if((sub !== dir && !sub.startsWith(dir + path.sep)) || !fs.existsSync(sub)) {
			throw new Error(`${url}: the repository has no R code in ${gh.path}`);
		}
		return sub;
	}
	/* no tab to keep responsive: as much as the machine reads */
	Object.assign(SourceLimits, { files: Infinity, bytes: Infinity });
	const files = await fromUrl(url, log);
	if(files.length === 0) {
		throw new Error(`${url}: no R code found`);
	}
	return writeFolder(files, dir, url, log);
}
