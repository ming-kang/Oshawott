import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	createModels, fauxProvider, InMemoryCredentialStore, type AuthEvent, type MutableModels, type OAuthAuth, type OAuthCredential, type Provider,
} from "@earendil-works/pi-ai";
import type { LoginView } from "../src/contracts/chat.ts";
import { BROWSER_OAUTH, browserBuiltinProviders } from "../src/engine/builtin-providers.ts";
import { IndexedDbCredentialStore } from "../src/engine/credentials.ts";
import { loginFailure, LoginSessions, type OAuthSetups } from "../src/engine/oauth.ts";
import { until } from "./support/wait.ts";
import { connectPanel, context, openEngine, serveBrowser } from "./support/world.ts";
// @ts-expect-error The build helper is plain JavaScript without declarations.
import * as piOAuth from "../scripts/lib/pi-oauth.mjs";

const { BROWSER_FLOWS, loaderSource, staticNodeImports } = piOAuth as {
	BROWSER_FLOWS: Record<string, [loader: string, module: string, name: string]>;
	loaderSource: () => string;
	staticNodeImports: (source: string) => string[];
};
const SECRETS = /access-\w+|refresh-\w+|pasted-code/;
const token = (n: number, extra: Record<string, unknown> = {}): OAuthCredential =>
	({ type: "oauth", access: `access-${n}`, refresh: `refresh-${n}`, expires: Date.now() + 3_600_000, ...extra });

function account(id: string, login: OAuthAuth["login"], more: Partial<OAuthAuth> & Pick<Provider, "filterModels"> = {}): Provider {
	const { filterModels, ...oauth } = more;
	const faux = fauxProvider({ provider: id, models: [{ id: "one" }, { id: "two" }] });
	return {
		...faux.provider,
		auth: { oauth: { name: "Account", login, refresh: async (credential) => credential, toAuth: async ({ access }) => ({ apiKey: access }), ...oauth } },
		...(filterModels ? { filterModels } : {}),
	};
}

/** A device-code flow that then asks for a pasted code, as the real flows do between them. */
const deviceThenCode: OAuthAuth["login"] = async (interaction) => {
	interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://auth.test/device", expiresInSeconds: 600 });
	const code = await interaction.prompt({ type: "manual_code", message: "Paste the code", signal: interaction.signal });
	if (!code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging…" });
	return token(1);
};

function sessionsFor(provider: Provider, options: { setups?: OAuthSetups; timeoutMs?: number } = {}) {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(provider);
	const sessions = new LoginSessions({ models, ...options });
	let items: LoginView[] = [];
	const published: string[] = [];
	void sessions.observe({
		advance: (call) => {
			if (call.kind !== "value") return;
			items = call.value.items;
			published.push(JSON.stringify(call.value));
		},
		end: () => {},
	});
	return { credentials, models, sessions, published, view: (id: string) => items.find((item) => item.id === id), count: () => items.length };
}

test("a sign-in shows its code, takes one answer and stores the credential without publishing a secret", async () => {
	const { credentials, sessions, published, view, count } = sessionsFor(account("acct", deviceThenCode));
	const id = sessions.start("acct");
	assert.equal(sessions.start("acct"), id, "a second start joins the pending sign-in");
	assert.equal(count(), 1);
	const prompt = await until(() => view(id)?.prompt ?? undefined);
	assert.deepEqual({ ...view(id), prompt: null, expiresAt: null }, {
		id, provider: "acct", status: "pending", url: "https://auth.test/device", userCode: "ABCD-1234", expiresAt: null,
		progress: null, prompt: null, error: null, httpStatus: null,
	});
	assert.equal(prompt.kind, "code");
	assert.throws(() => sessions.answer(id, "stale", "pasted-code"), /no longer waiting/);
	sessions.answer(id, prompt.id, "pasted-code");
	await until(() => view(id)?.status === "done");
	assert.deepEqual(await credentials.read("acct"), { ...token(1), expires: (await credentials.read("acct") as OAuthCredential).expires });
	assert.equal(view(id)?.userCode, null, "a finished sign-in keeps no code or link");
	assert.ok(published.length > 3 && published.every((value) => !SECRETS.test(value)), "no publication carries a token or the pasted code");
	sessions.dismiss(id);
	assert.equal(count(), 0);
	sessions.close();
});

test("cancel, timeout and failure end a sign-in without a credential or a provider response", async () => {
	let finishLate!: (credential: OAuthCredential) => void;
	const stubborn: OAuthAuth["login"] = (interaction) => {
		interaction.notify({ type: "auth_url", url: "http://insecure.test/authorize" });
		return new Promise((resolve) => { finishLate = resolve; });
	};
	const cancelled = sessionsFor(account("acct", stubborn));
	const first = cancelled.sessions.start("acct");
	assert.equal(cancelled.view(first)?.url, null, "only an HTTPS page is offered");
	cancelled.sessions.cancel(first);
	await until(() => cancelled.view(first)?.status === "cancelled");
	finishLate(token(2));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(await cancelled.credentials.read("acct"), undefined, "a flow finishing after its cancellation stores nothing");
	const again = cancelled.sessions.start("acct");
	assert.notEqual(again, first);
	assert.equal(cancelled.count(), 1, "a new sign-in replaces the finished one");
	cancelled.sessions.close();
	assert.equal(cancelled.count(), 1, "closing publishes nothing more");

	const slow = sessionsFor(account("acct", deviceThenCode), { timeoutMs: 20 });
	const timed = slow.sessions.start("acct");
	await until(() => slow.view(timed)?.status === "failed");
	assert.deepEqual([slow.view(timed)?.error, slow.view(timed)?.prompt], ["timeout", null]);
	assert.equal(await slow.credentials.read("acct"), undefined);
	slow.sessions.close();

	const leaky = sessionsFor(account("acct", async () => {
		throw new Error('Token exchange failed. status=401; body={"access_token":"access-9","refresh_token":"refresh-9"}');
	}));
	const failed = leaky.sessions.start("acct");
	await until(() => leaky.view(failed)?.status === "failed");
	assert.deepEqual([leaky.view(failed)?.error, leaky.view(failed)?.httpStatus], ["http", 401]);
	assert.ok(leaky.published.every((value) => !SECRETS.test(value)));
	leaky.sessions.close();

	assert.deepEqual(loginFailure(new Error("OAuth state mismatch")), { error: "mismatch", httpStatus: null });
	assert.deepEqual(loginFailure(new Error("Meta login was denied.")), { error: "denied", httpStatus: null });
	assert.deepEqual(loginFailure(new Error("Device flow timed out")), { error: "expired", httpStatus: null });
	assert.deepEqual(loginFailure(new TypeError("Failed to fetch")), { error: "network", httpStatus: null });
	assert.deepEqual(loginFailure(new Error("OpenAI Codex token exchange failed (403): secret")), { error: "http", httpStatus: 403 });
	assert.deepEqual(loginFailure("anything"), { error: "unknown", httpStatus: null });
});

test("a setup answers the method and domain questions; other questions reach the user", async () => {
	const asked: string[] = [];
	const login: OAuthAuth["login"] = async (interaction) => {
		asked.push(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "copy_code", label: "Copy" }] }));
		asked.push(await interaction.prompt({ type: "text", message: "Enterprise domain" }));
		asked.push(await interaction.prompt({ type: "select", message: "Region", options: [{ id: "eu", label: "EU" }] }));
		return token(3);
	};
	const { sessions, view } = sessionsFor(account("acct", login), { setups: { acct: { origins: [], select: "copy_code", text: "" } } });
	const id = sessions.start("acct");
	const prompt = await until(() => view(id)?.prompt ?? undefined);
	assert.deepEqual([prompt.kind, prompt.options], ["select", [{ id: "eu", label: "EU" }]]);
	sessions.answer(id, prompt.id, "eu");
	await until(() => view(id)?.status === "done");
	assert.deepEqual(asked, ["copy_code", "", "eu"]);
	assert.throws(() => sessions.start("missing"), /no account sign-in/);
	sessions.close();
});

async function engineWith(models: MutableModels, credentials: InMemoryCredentialStore, oauth: OAuthSetups) {
	const broker = await serveBrowser();
	const engine = await openEngine(broker, { models, credentials, oauth });
	const open = async () => {
		const panel = await connectPanel(engine);
		await until(() => panel.workspace.providers.value.length > 0, "the provider list");
		return { workspace: panel.workspace, close: () => panel.close() };
	};
	return { engine, open, close: async () => { await engine.close(); await broker.close(context); } };
}

test("a panel signs in through the Engine, sees only the account's models, and signs out completely", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(account("acct", async (interaction) => ({ ...await deviceThenCode(interaction), availableModelIds: ["two"] }), {
		loginLabel: "Sign in with Account",
		filterModels: (list, credential) => credential?.type === "oauth" ? list.filter((model) => (credential.availableModelIds as string[]).includes(model.id)) : list,
	}));
	const { open, close } = await engineWith(models, credentials, { acct: { origins: ["https://auth.test/*"] } });
	const first = await open();
	const summary = (workspace: typeof first.workspace) => workspace.providers.value.find((provider) => provider.id === "acct")!;
	assert.deepEqual([summary(first.workspace).oauth, summary(first.workspace).apiKey, summary(first.workspace).auth],
		[{ label: "Sign in with Account", origins: ["https://auth.test/*"] }, false, null]);
	assert.equal(summary(first.workspace).models.length, 2);

	const id = await first.workspace.startLogin({ provider: "acct" }, context);
	await until(() => first.workspace.logins.value[0]?.prompt);
	// A panel that is closed and reopened finds the same sign-in.
	await first.close();
	const second = await open();
	const { workspace } = second;
	const pending = await until(() => workspace.logins.value.find((login) => login.id === id));
	assert.equal(await workspace.startLogin({ provider: "acct" }, context), id);
	await assert.rejects(workspace.answerLogin({ id, promptId: "stale", value: "pasted-code" }, context), /no longer waiting/);
	await workspace.answerLogin({ id, promptId: pending.prompt!.id, value: "pasted-code" }, context);
	await until(() => summary(workspace).auth === "oauth");
	assert.deepEqual(summary(workspace).models.map((model) => model.id), ["two"], "the model list follows the signed-in account");
	assert.ok(!SECRETS.test(JSON.stringify([workspace.providers.value, workspace.logins.value])));
	await workspace.dismissLogin({ id }, context);
	await until(() => workspace.logins.value.length === 0);

	// Signing out cancels a sign-in still running and leaves no credential behind.
	const retry = await workspace.startLogin({ provider: "acct" }, context);
	await until(() => workspace.logins.value.find((login) => login.id === retry)?.prompt);
	await workspace.logout({ provider: "acct" }, context);
	await until(() => workspace.logins.value.find((login) => login.id === retry)?.status === "cancelled");
	assert.equal(await credentials.read("acct"), undefined);
	assert.deepEqual([summary(workspace).configured, summary(workspace).models.length], [false, 2]);
	await assert.rejects(workspace.startLogin({ provider: "missing" }, context), /no account sign-in/);
	await second.close();
	await close();
});

test("concurrent requests rotate an expired token once, and the rotation survives a restart", async () => {
	const database = `oshawott-credentials-${crypto.randomUUID()}`;
	const refreshed: string[] = [];
	const provider = () => account("acct", deviceThenCode, {
		refresh: async (credential) => {
			refreshed.push(credential.refresh);
			await new Promise((resolve) => setTimeout(resolve, 20));
			return token(refreshed.length + 10);
		},
	});
	const credentials = new IndexedDbCredentialStore(database);
	await credentials.modify("acct", async () => ({ ...token(1), expires: Date.now() - 1 }));
	const models = createModels({ credentials });
	models.setProvider(provider());
	const auths = await Promise.all(Array.from({ length: 8 }, () => models.getAuth("acct")));
	assert.deepEqual(refreshed, ["refresh-1"], "one refresh serves every concurrent request");
	assert.ok(auths.every((auth) => auth?.auth.apiKey === "access-11"));

	// A new Engine (or browser session) reads the rotated token from the same database and has nothing to refresh.
	const restarted = createModels({ credentials: new IndexedDbCredentialStore(database) });
	restarted.setProvider(provider());
	assert.equal((await restarted.getAuth("acct"))?.auth.apiKey, "access-11");
	assert.deepEqual(await restarted.checkAuth("acct"), { type: "oauth", source: "OAuth" });
	assert.equal(refreshed.length, 1);
	await restarted.logout("acct");
	assert.equal(await new IndexedDbCredentialStore(database).read("acct"), undefined);
});

test("only loopback-free sign-ins are registered, and the build bundles exactly those flows", async () => {
	const providers = browserBuiltinProviders();
	const withOAuth = providers.filter((provider) => provider.auth.oauth).map((provider) => provider.id).sort();
	assert.deepEqual(withOAuth, Object.keys(BROWSER_OAUTH).sort());
	assert.deepEqual(Object.keys(BROWSER_FLOWS).sort(), withOAuth);
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	assert.equal(byId.get("openai-codex")?.auth.apiKey, undefined, "Codex is sign-in only");
	for (const id of ["openai", "openrouter"]) assert.ok(byId.get(id)?.auth.apiKey && !byId.get(id)?.auth.oauth, `${id} keeps its API key only`);
	for (const setup of Object.values(BROWSER_OAUTH)) for (const origin of setup.origins) assert.match(origin, /^https:\/\/[^/]+\/\*$/);

	// Each loader the replacement module defines must exist in the installed Pi-AI, with the export it reads.
	const oauthDir = new URL("../node_modules/@earendil-works/pi-ai/dist/auth/oauth/", import.meta.url);
	const original = await readFile(new URL("load.js", oauthDir), "utf8");
	const replacement = loaderSource();
	for (const [, loader] of original.matchAll(/export const (load\w+)/g)) assert.match(replacement, new RegExp(`export const ${loader} =`));
	for (const [loader, module, name] of Object.values(BROWSER_FLOWS)) {
		assert.match(original, new RegExp(`export const ${loader} =`));
		assert.match(await readFile(new URL(module, oauthDir), "utf8"), new RegExp(`export const ${name} =`));
	}

	assert.deepEqual(staticNodeImports('import{createServer as a}from"node:http";var b=1;export{c}from"node:fs";'), ["node:http", "node:fs"]);
	assert.deepEqual(staticNodeImports('if(p)import("node:crypto").then(f);const s="import x from \'node:os\'";'), []);
});

test("sign-in events never reach a Panel as anything but the declared view", async () => {
	const events: AuthEvent[] = [
		{ type: "info", message: "x".repeat(1000) },
		{ type: "device_code", userCode: "CODE", verificationUri: "javascript:alert(1)" },
	];
	const { sessions, view } = sessionsFor(account("acct", async (interaction) => {
		for (const event of events) interaction.notify(event);
		return new Promise(() => {});
	}));
	const id = sessions.start("acct");
	assert.deepEqual([view(id)?.progress?.length, view(id)?.url, view(id)?.userCode, view(id)?.expiresAt], [300, null, "CODE", null]);
	sessions.close();
});
