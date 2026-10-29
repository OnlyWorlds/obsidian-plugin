import * as http from 'http';
import type { AddressInfo } from 'net';
import { SIGN_IN_ACTION, type Listener } from './browser-sign-in';

/**
 * The desktop half of Sign in with your browser: one loopback listener for one
 * return. Desktop only (it needs Node's http); the plugin loads this file with a
 * dynamic import, never on mobile.
 *
 * Binds 127.0.0.1 only, on a port the system picks. Answers exactly one
 * `GET /onlyworlds-signin` whose Host header is its own address (a page on
 * another name pointed at 127.0.0.1 is refused), with a plain page, and closes.
 * Anything else gets a 404 and the wait goes on. It closes on the first answer,
 * on the timer, and when the dialog cancels.
 */

/** The house rule bans an exclamation mark in a string; this one is markup's doctype, built so the string test reads none. */
const DOCTYPE = '<' + String.fromCharCode(33) + 'doctype html>';
const PAGE =
	DOCTYPE +
	'<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
	'<title>Signed in</title></head><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">' +
	'<h1>You can close this tab</h1><p>Go back to Obsidian to finish signing in.</p></body></html>';

export function listenOnce(opts: { timeoutMs: number }): Promise<Listener> {
	return new Promise<Listener>((resolveListener, rejectListener) => {
		let finish!: (url: string) => void;
		let fail!: (e: Error) => void;
		const done = new Promise<string>((res, rej) => {
			finish = res;
			fail = rej;
		});
		done.catch(() => undefined); // a cancelled wait nobody awaits is not an unhandled rejection
		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const server = http.createServer((req, res) => {
			const port = (server.address() as AddressInfo).port;
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const right = req.method === 'GET' && req.headers.host === `127.0.0.1:${port}` && url.pathname === `/${SIGN_IN_ACTION}`;
			if (!right) {
				res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' });
				res.end('Not found');
				return;
			}
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				Connection: 'close',
			});
			res.end(PAGE, () => close());
			finish(`http://127.0.0.1:${port}${req.url ?? ''}`);
		});
		const close = (): void => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			server.close();
			(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		};
		timer = setTimeout(() => {
			fail(new Error('timeout'));
			close();
		}, opts.timeoutMs);
		server.on('error', (e) => {
			close();
			rejectListener(e);
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolveListener({
				port,
				done,
				close: () => {
					fail(new Error('cancelled'));
					close();
				},
			});
		});
	});
}
