/**
 * A write the web host in front of OnlyWorlds refuses: the host answers 403 with an HTML page
 * titled "Blocked" where keel always answers JSON, so keel never sees the request. 3.19.0 put the whole page
 * (221,349 characters with its base64 font) into the error's message, and every command shows that message in
 * a notice (seen in the real app). The client now says one readable
 * line for a body that is not JSON.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { setRequestUrl } from "./support/obsidian-mock";
import { V2Client, V2ApiError } from "../client-v2";

const BLOCKED_PAGE =
	'<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>Blocked</title>\n    <style>@font-face { font-family: "Roobert"; src: url("data:font/woff2;base64,' +
	"d09GMk9UVE8AAKewAAwAAAABa6Q".repeat(9000) +
	'") }</style>\n  </head>\n  <body>Sorry, you have been blocked</body>\n</html>';

async function failure(status: number, text: string, json?: unknown): Promise<V2ApiError> {
	setRequestUrl(() => (json === undefined ? { status, text } : { status, json }));
	try {
		await new V2Client("ow_k_test", "1234").update("character", "019f0000-0000-7000-8000-0000000000c1", { description: "x" });
	} catch (e) {
		assert.ok(e instanceof V2ApiError, "the client threw something that is not a V2ApiError");
		return e;
	}
	assert.fail("the write did not throw");
}

test("★ the host's 403 HTML page is one short readable line, not the page", async () => {
	const e = await failure(403, BLOCKED_PAGE);
	assert.equal(e.status, 403);
	assert.equal(e.code, "host_refused");
	assert.ok(e.message.length < 400, `the message is ${e.message.length} characters`);
	assert.ok(!e.message.includes("<"), "the message still carries markup");
	assert.match(e.message, /web host in front of OnlyWorlds/);
	assert.match(e.message, /HTTP 403/);
	assert.match(e.message, /code block with a language word/);
});

test("an HTML page on another status says the host answered with a page, short", async () => {
	const e = await failure(502, "<html><head><title>Bad gateway</title></head><body>" + "x".repeat(5000) + "</body></html>");
	assert.equal(e.status, 502);
	assert.equal(e.code, "host_page");
	assert.ok(e.message.length < 300, `the message is ${e.message.length} characters`);
	assert.match(e.message, /HTTP 502/);
	assert.ok(!e.message.includes("<"));
});

test("a 403 page that is not the Blocked page does not claim the python -m rule", async () => {
	const e = await failure(403, "<html><head><title>Just a moment...</title></head><body>" + "x".repeat(3000) + "</body></html>");
	assert.equal(e.status, 403);
	assert.equal(e.code, "host_page");
	assert.ok(!/python|backtick|code block/.test(e.message), "the message names a cause it does not know: " + e.message);
	assert.match(e.message, /HTTP 403/);
});

test("a page after leading whitespace and a byte-order mark is read as a page", async () => {
	const e = await failure(403, "\n  ﻿<html><head><title>Blocked</title></head></html>");
	assert.equal(e.code, "host_refused");
});

test("keel's JSON error that mentions markup is kept as keel said it", async () => {
	const e = await failure(400, "", { error: { code: "invalid_field", message: "A <b> tag is not allowed here." } });
	assert.equal(e.code, "invalid_field");
	assert.equal(e.message, "A <b> tag is not allowed here.");
});

test("a plain text body is kept, cut at 200 characters", async () => {
	const e = await failure(500, "boom ".repeat(200));
	assert.equal(e.code, "http_500");
	assert.ok(e.message.startsWith("API error 500: boom"));
	assert.ok(e.message.length <= "API error 500: ".length + 201, `the message is ${e.message.length} characters`);
});

test("keel's own JSON error is unchanged: code, message and doc_url", async () => {
	const e = await failure(403, "", { error: { code: "forbidden", message: "Your key cannot write here.", doc_url: "https://example.test/e" } });
	assert.equal(e.code, "forbidden");
	assert.equal(e.message, "Your key cannot write here.");
	assert.equal(e.docUrl, "https://example.test/e");
});
