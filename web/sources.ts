/**
 * Where the page gets the code it analyzes from: files and folders the user picks or drops, and every
 * link `src/sources.ts` reads (zip archives, a file behind a URL, a repository, a gist).
 */
import { Skipped, fromZip, keep, limit, stripCommonRoot, uniquePaths, type SourceFile } from '../src/sources';

export * from '../src/sources';

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

