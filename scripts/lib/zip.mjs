import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/** An MS-DOS date and time, the only timestamp a plain zip entry has (local time, two-second steps). */
function dosTime(date) {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/**
 * A zip archive of every file below `dir`, by `/`-separated path in a stable order: what Chromium's "Load unpacked"
 * needs once extracted, and what Firefox installs as an xpi. Entries are deflated unless that would make them larger.
 */
export async function zipDirectory(dir) {
	const paths = (await readdir(dir, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.sort();
	const parts = [];
	const directory = [];
	let offset = 0;
	for (const path of paths) {
		const file = join(dir, path);
		const data = await readFile(file);
		const deflated = deflateRawSync(data, { level: 9 });
		const method = deflated.length < data.length ? 8 : 0;
		const body = method === 8 ? deflated : data;
		const name = Buffer.from(path, "utf8");
		const { time, date } = dosTime((await stat(file)).mtime);
		// Version 2.0, UTF-8 names, method, time, date, CRC-32, compressed and uncompressed sizes, name length.
		const fields = (header) => {
			header.writeUInt16LE(20, 4);
			header.writeUInt16LE(0x0800, 6);
			header.writeUInt16LE(method, 8);
			header.writeUInt16LE(time, 10);
			header.writeUInt16LE(date, 12);
			header.writeUInt32LE(crc32(data), 14);
			header.writeUInt32LE(body.length, 18);
			header.writeUInt32LE(data.length, 22);
			header.writeUInt16LE(name.length, 26);
			return header;
		};
		const local = fields(Buffer.alloc(30));
		local.writeUInt32LE(0x04034b50, 0);
		// The central record has two more leading bytes (the creating version), so its fields sit two bytes later.
		const central = Buffer.alloc(46);
		fields(central.subarray(2));
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt32LE(offset, 42);
		parts.push(local, name, body);
		directory.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const size = directory.reduce((sum, part) => sum + part.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(paths.length, 8);
	end.writeUInt16LE(paths.length, 10);
	end.writeUInt32LE(size, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, ...directory, end]);
}
