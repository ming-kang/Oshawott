import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setGlobalProxyFromEnv } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RELEASES } from "../src/manifest.ts";
import { dist, freshDir, root } from "./lib/paths.mjs";

// After `npm run package`: Mozilla signs dist/firefox on AMO's unlisted channel, so release Firefox installs it. The
// signed xpi and the update manifest naming it go to dist/signed, for the release to publish (docs/distribution.md).
// web-ext only submits; this script waits for approval itself, retrying AMO's transient failures, and skips the
// submission when AMO already has this version, so a failed run can simply be run again.
// Arguments go on to `web-ext sign`, such as `--api-proxy=<url>`; `--approval-timeout=<ms>` bounds the wait here.
for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"]) {
	if (!process.env[name]) throw new Error(`${name} is not set: put your AMO API credentials in .env (docs/distribution.md)`);
}
if (!process.env.npm_execpath) throw new Error("Run this through npm: npm run sign:firefox");

const AMO = "https://addons.mozilla.org/api/v5/";
const POLL_MS = 15_000;
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const approvalTimeout = Number(option("approval-timeout") ?? 15 * 60_000);
const passed = process.argv.slice(2).filter((arg) => !arg.startsWith("--approval-timeout="));
const proxy = option("api-proxy");
if (proxy) setGlobalProxyFromEnv({ HTTPS_PROXY: proxy });

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const { browser_specific_settings: { gecko } } = JSON.parse(await readFile(dist("firefox", "manifest.json"), "utf8"));
const versionUrl = `${AMO}addons/addon/${encodeURIComponent(gecko.id)}/versions/v${version}/`;

if (await details()) {
	console.log(`AMO already has ${version}; waiting for it instead of submitting again.`);
} else {
	const { status, error } = spawnSync(process.execPath, [
		process.env.npm_execpath, "exec", "--yes", "--package=web-ext@10", "--", "web-ext", "sign", "--channel=unlisted",
		`--source-dir=${dist("firefox")}`, `--artifacts-dir=${await freshDir("amo")}`,
		`--upload-source-code=${dist(`oshawott-${version}-source.zip`)}`, "--approval-timeout=0", ...passed,
	], { stdio: "inherit" });
	if (error) throw error;
	if (status !== 0) process.exit(status ?? 1);
}

const file = await approved();
const signed = Buffer.from(await (await amo(file.url)).arrayBuffer());
const hash = `sha256:${createHash("sha256").update(signed).digest("hex")}`;
if (hash !== file.hash) throw new Error(`The signed xpi's ${hash} is not the ${file.hash} AMO reports`);
const xpi = `oshawott-${version}-firefox.xpi`;
await mkdir(dist("signed"), { recursive: true });
await writeFile(dist("signed", xpi), signed);

// Firefox reads this from the latest release (the manifest's update_url) and installs any higher version it names.
const updates = { addons: { [gecko.id]: { updates: [
	{ version, update_link: `${RELEASES}/download/v${version}/${xpi}`, update_hash: hash },
] } } };
await writeFile(dist("signed", "updates.json"), `${JSON.stringify(updates, null, 2)}\n`);
console.log(`dist/signed/${xpi}\ndist/signed/updates.json`);

/** The version's file once AMO has signed it. */
async function approved() {
	const deadline = Date.now() + approvalTimeout;
	console.log(`Waiting for AMO to approve ${version}...`);
	for (;;) {
		const file = (await details())?.file;
		if (file?.status === "public") return file;
		if (file?.status === "disabled") throw new Error(`AMO rejected ${version}; see the developer hub for the reason`);
		if (Date.now() > deadline) {
			throw new Error(`AMO has not approved ${version} yet; run this again later to wait for it without resubmitting`);
		}
		await sleep(POLL_MS);
	}
}

/** AMO's details of this version, or `undefined` before it is submitted. */
async function details() {
	return (await amo(versionUrl))?.json();
}

/** An authenticated AMO request, `undefined` when not found; network, rate-limit and server failures are retried. */
async function amo(url) {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(url, { headers: { Authorization: `JWT ${jwt()}` } }).catch((error) => error);
		const transient = response instanceof Error || response.status === 429 || response.status >= 500;
		if (!transient) {
			if (response.status === 404) return undefined;
			if (!response.ok) throw new Error(`AMO ${response.status} for ${url}: ${await response.text()}`);
			return response;
		}
		const reason = response instanceof Error ? (response.cause?.code ?? response.message) : response.status;
		if (attempt === 6) throw new Error(`AMO kept failing (${reason}) for ${url}`);
		console.log(`AMO failed (${reason}); retrying.`);
		await sleep(2 ** attempt * 1000);
	}
}

/** A short-lived token for AMO's API, signed with the API secret. */
function jwt() {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const iat = Math.floor(Date.now() / 1000);
	const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: process.env.WEB_EXT_API_KEY, jti: randomUUID(), iat, exp: iat + 60 })}`;
	return `${unsigned}.${createHmac("sha256", process.env.WEB_EXT_API_SECRET).update(unsigned).digest("base64url")}`;
}
