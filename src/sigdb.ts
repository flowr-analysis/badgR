import * as fs from 'node:fs';
import { downloadFullSigDb, sigDbRemoteRelease, syncedSigDbDir } from '@eagleoutice/flowr/project/sigdb/sigdb-download';

export interface SigDbStatus {
	/** the release of the signature database flowR's link file points to */
	readonly tag?: string
	/** the directory the shards are cached in */
	readonly dir?: string
	/** whether the cached shards are present */
	readonly present: boolean
}

/** whether the full signature database (base R and all of CRAN, current and history) is cached */
export function sigDbStatus(): SigDbStatus {
	const dir = syncedSigDbDir();
	const present = dir !== undefined && fs.existsSync(dir)
		&& fs.readdirSync(dir).some(f => f.startsWith('current.manifest.'));
	return { tag: sigDbRemoteRelease()?.tag, dir, present };
}

/**
 * Downloads the signature-database shards flowR's link file names, verified by hash; cached shards are skipped.
 * Without them, calls into CRAN packages do not resolve and package-internal sinks stay invisible.
 */
export async function ensureSigDb(log: (msg: string) => void = () => {}): Promise<SigDbStatus> {
	const before = sigDbStatus();
	if(before.present) {
		return before;
	}
	log(`downloading the flowR signature database ${before.tag ?? ''} to ${before.dir ?? 'the cache'} ...`);
	const r = await downloadFullSigDb({ onProgress: log });
	log(`signature database ready: ${r.files.length} files, ${r.downloaded.length} downloaded (${Math.round(r.bytes / 1e6)} MB)`);
	return sigDbStatus();
}
