import assert from "node:assert/strict";
import test from "node:test";
import { describeError } from "../src/panel/errors.ts";

test("a status-prefixed JSON body yields the provider message and kind", () => {
	const description = describeError(`500: {"message":"The server had an error while processing your request","type":"server_error"}`);
	assert.equal(description.status, 500);
	assert.equal(description.kind, "server");
	assert.equal(description.summary, "The server had an error while processing your request");
});

test("an Anthropic-style rate limit is recognised from its nested error object", () => {
	const description = describeError(`429: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded the rate limit."}}`);
	assert.equal(description.status, 429);
	assert.equal(description.kind, "rate_limit");
	assert.equal(description.summary, "Number of request tokens has exceeded the rate limit.");
});

test("a non-JSON body stays readable on its own", () => {
	const description = describeError("502 Bad Gateway");
	assert.equal(description.status, 502);
	assert.equal(description.kind, "server");
	assert.equal(description.summary, "Bad Gateway");
});

test("transport failures map to the network kind", () => {
	assert.equal(describeError("Failed to fetch").kind, "network");
	assert.equal(describeError("NetworkError when attempting to fetch resource.").kind, "network");
	assert.equal(describeError("read ECONNRESET").kind, "network");
});

test("timeouts map to their own kind", () => {
	assert.equal(describeError("The request timed out after 30s").kind, "timeout");
	assert.equal(describeError("The operation was aborted due to timeout").kind, "timeout");
});

test("auth statuses map to the auth kind", () => {
	const description = describeError(`401: {"error":{"message":"Incorrect API key provided.","type":"authentication_error"}}`);
	assert.equal(description.kind, "auth");
	assert.equal(description.summary, "Incorrect API key provided.");
});

test("overload is recognised from status 529, an overloaded type or the word itself", () => {
	assert.equal(describeError("529").kind, "overloaded");
	assert.equal(describeError(`503: {"error":{"message":"Overloaded","type":"overloaded_error"}}`).kind, "overloaded");
	assert.equal(describeError(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`).kind, "overloaded");
});

test("unrecognised text falls back to unknown with the text as summary", () => {
	const description = describeError("something odd happened");
	assert.equal(description.kind, "unknown");
	assert.equal(description.summary, "something odd happened");
});
