import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Pi-AI's sign-in flows a browser can complete, by provider ID: the loader `auth/oauth/load.js` exports, the flow's
 * module beside it and that module's export. Must list the providers of `BROWSER_OAUTH` (src/engine/builtin-providers.ts).
 */
export const BROWSER_FLOWS = {
	anthropic: ["loadAnthropicOAuth", "./anthropic.js", "anthropicOAuth"],
	"openai-codex": ["loadOpenAICodexOAuth", "./openai-codex.js", "openaiCodexOAuth"],
	"github-copilot": ["loadGitHubCopilotOAuth", "./github-copilot.js", "githubCopilotOAuth"],
	"kimi-coding": ["loadKimiCodingOAuth", "./kimi-coding.js", "kimiCodingOAuth"],
	meta: ["loadMetaOAuth", "./meta.js", "metaOAuth"],
	xai: ["loadXaiOAuth", "./xai.js", "xaiOAuth"],
};
/** Flows built on a loopback callback server; their providers are registered without OAuth. */
const NODE_FLOWS = ["loadOpenAIChatGPTOAuth", "loadOpenRouterOAuth", "loadRadiusOAuth"];

const OAUTH_DIR = /[\\/]pi-ai[\\/]dist[\\/]auth[\\/]oauth[\\/]/;

export function loaderSource() {
	return [
		...Object.values(BROWSER_FLOWS).map(([loader, module, name]) =>
			`export const ${loader} = async () => (await import(${JSON.stringify(module)})).${name};`),
		...NODE_FLOWS.map((loader) =>
			`export const ${loader} = async () => { throw new Error("This sign-in needs a loopback callback and is not available in a browser."); };`),
		"export function registerBundledOAuthFlowLoaders() {}",
	].join("\n");
}

/**
 * Pi-AI loads its sign-in flows through a variable `import()` no bundler can follow, because some of them need Node.
 * This puts the browser-capable flows into the bundle and keeps Node builtins off the paths a browser runs: the
 * adaptation lives here, `node_modules` is untouched.
 */
export function piOAuth() {
	return {
		name: "pi-oauth",
		setup(build) {
			build.onLoad({ filter: /[\\/]pi-ai[\\/]dist[\\/]auth[\\/]oauth[\\/]load\.js$/ }, (args) => ({
				contents: loaderSource(), resolveDir: dirname(args.path), loader: "js",
			}));
			// The copy-code and device-code methods never start the callback server those modules also import.
			build.onResolve({ filter: /^node:http$/ }, (args) =>
				OAUTH_DIR.test(args.importer) ? { path: "node:http", namespace: "pi-oauth" } : undefined);
			build.onLoad({ filter: /.*/, namespace: "pi-oauth" }, () => ({
				contents: `export function createServer() { throw new Error("A loopback callback server is not available in a browser."); }`,
				loader: "js",
			}));
		},
	};
}

/** Pi-AI modules that reach Node (files, environment, the AWS SDK) through `import()` of a variable. */
const NODE_ONLY = /[\\/]pi-ai[\\/]dist[\\/](?:auth[\\/]context|env-api-keys|api[\\/]bedrock-converse-stream\.lazy)\.js$/;
const VARIABLE_IMPORT = /\bimport\(__rewriteRelativeImportExtension\((\w+)\)\)/g;

/**
 * In a browser those imports can only fail (or never run: Bedrock is not offered), so they fail without loading
 * anything, and AMO's validator finds no `import()` of a value it cannot check.
 */
export function piNodeOnly() {
	return {
		name: "pi-node-only",
		setup(build) {
			build.onLoad({ filter: NODE_ONLY }, async (args) => {
				const source = await readFile(args.path, "utf8");
				const contents = source.replace(VARIABLE_IMPORT, (_, specifier) =>
					`Promise.reject(new Error(\`\${${specifier}} is not available in a browser.\`))`);
				if (contents === source) throw new Error(`${args.path} no longer has the import() this build replaces`);
				return { contents, resolveDir: dirname(args.path), loader: "js" };
			});
		},
	};
}

/** Node builtins a bundle imports when it loads, which would stop a browser from loading it at all. */
export function staticNodeImports(source) {
	return [...source.matchAll(/(?:^|[;\n}])\s*(?:import|export)\b[^;"'()]*?["'](node:[\w/]+)["']/g)].map((match) => match[1]);
}
