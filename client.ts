import { OnlyWorldsClient, OnlyWorldsConfig } from "@onlyworlds/sdk";
import { requestUrl, RequestUrlParam } from "obsidian";

/**
 * OnlyWorlds SDK client subclass that routes HTTP through Obsidian's requestUrl().
 *
 * The base SDK uses native fetch() which Obsidian plugin reviewers flag (CORS,
 * mobile compatibility). This subclass overrides request() to delegate to requestUrl
 * while preserving the SDK's resource accessors, _ids/_id rewriting, and error handling.
 */
export class ObsidianOnlyWorldsClient extends OnlyWorldsClient {
	private obsidianBaseUrl: string;
	private obsidianHeaders: Record<string, string>;

	constructor(config: OnlyWorldsConfig) {
		super(config);
		this.obsidianBaseUrl = config.baseUrl || "https://www.onlyworlds.com/api/worldapi";
		this.obsidianHeaders = {
			"Content-Type": "application/json",
			"API-Key": config.apiKey,
			"API-Pin": config.apiPin,
		};
	}

	async request<T>(
		method: string,
		path: string,
		options?: {
			params?: Record<string, unknown>;
			body?: unknown;
		}
	): Promise<T> {
		const url = new URL(`${this.obsidianBaseUrl}${path}`);

		if (options?.params) {
			for (const [key, value] of Object.entries(options.params)) {
				if (value !== undefined && value !== null) {
					url.searchParams.append(key, String(value));
				}
			}
		}

		const req: RequestUrlParam = {
			url: url.toString(),
			method,
			headers: this.obsidianHeaders,
			throw: false,
		};

		if (options?.body && ["POST", "PATCH", "PUT"].includes(method)) {
			req.body = JSON.stringify(options.body);
		}

		const response = await requestUrl(req);

		if (response.status >= 400) {
			let errorMessage = `API Error ${response.status}`;
			const text = response.text;
			if (text) {
				try {
					const errJson = JSON.parse(text);
					if (Array.isArray(errJson.detail)) {
						const validationErrors = errJson.detail
							.map((err: { loc?: unknown[]; msg?: string }) => {
								const location = Array.isArray(err.loc) ? err.loc.join(".") : "unknown";
								return `${location}: ${err.msg ?? ""}`;
							})
							.join("; ");
						errorMessage += `: ${validationErrors}`;
					} else {
						errorMessage += `: ${errJson.detail ?? errJson.error ?? text}`;
					}
				} catch {
					errorMessage += `: ${text}`;
				}
			}
			throw new Error(errorMessage);
		}

		if (response.status === 204) {
			return undefined as unknown as T;
		}

		return response.json as T;
	}
}
