import { ClientOptions } from "./base";
import { BetterAuth } from "../auth";
import { InferActions } from "./type";
import { getProxy } from "./proxy";
import { createClient } from "better-call/client";
import { betterFetch, BetterFetchPlugin } from "@better-fetch/fetch";
import { BetterAuthError } from "../error/better-auth-error";
import {
	CustomProvider,
	OAuthProvider,
	OAuthProviderList,
} from "../types/provider";
import { UnionToIntersection } from "../types/helper";
import { Prettify } from "better-call";
import { atom, computed, task } from "nanostores";
import { FieldAttribute, InferFieldOutput, InferValueType } from "../db";
import { Session, User } from "../adapters/schema";

const redirectPlugin = {
	id: "redirect",
	name: "Redirect",
	hooks: {
		onSuccess(context) {
			if (context.data?.url && context.data?.redirect) {
				console.log("redirecting to", context.data.url);
				window.location.href = context.data.url;
			}
		},
	},
} satisfies BetterFetchPlugin;

const addCurrentURL = {
	id: "add-current-url",
	name: "Add current URL",
	hooks: {
		onRequest(context) {
			const url = new URL(context.url);
			url.searchParams.set("currentURL", window.location.href);
			context.url = url;
			return context;
		},
	},
} satisfies BetterFetchPlugin;

export const csrfPlugin = {
	id: "csrf",
	name: "CSRF Check",
	async init(url, options) {
		if (options?.method !== "GET") {
			options = options || {};
			const { data, error } = await betterFetch<{
				csrfToken: string;
			}>("/csrf", {
				baseURL: options.baseURL,
			});
			if (error?.status === 404) {
				throw new BetterAuthError(
					"Route not found. Make sure the server is running and the base URL is correct and includes the path (e.g. http://localhost:3000/api/auth).",
				);
			}
			if (error) {
				throw new BetterAuthError(error.message || "Failed to get CSRF token.");
			}
			options.body = {
				...options?.body,
				csrfToken: data.csrfToken,
			};
		}
		return { url, options };
	},
} satisfies BetterFetchPlugin;

function inferBaeURL() {
	const url =
		process.env.AUTH_URL ||
		process.env.NEXT_PUBLIC_AUTH_URL ||
		process.env.BETTER_AUTH_URL ||
		process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
		process.env.VERCEL_URL ||
		process.env.NEXT_PUBLIC_VERCEL_URL;
	if (url) {
		return url;
	}
	if (
		!url &&
		(process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
	) {
		return "http://localhost:3000";
	}
	throw new BetterAuthError(
		"Could not infer baseURL from environment variables. Please pass it as an option to the createClient function.",
	);
}

export const createAuthClient = <Auth extends BetterAuth = BetterAuth>(
	options?: ClientOptions,
) => {
	type API = BetterAuth["api"];
	const client = createClient<API>({
		...options,
		baseURL: options?.baseURL || inferBaeURL(),
		plugins: [redirectPlugin, addCurrentURL, csrfPlugin],
	});
	const signInOAuth = async (data: {
		provider: Auth["options"]["providers"] extends Array<infer T>
			? T extends OAuthProvider
				? T["id"]
				: never
			: OAuthProviderList[number];
		callbackURL: string;
	}) => {
		const res = await client("@post/signin/oauth", {
			body: data,
		});
		if (res.data?.redirect) {
			window.location.href = res.data.url;
		}
		return res;
	};
	const actions = {
		signInOAuth,
	};
	type ProviderEndpoint = UnionToIntersection<
		Auth["options"]["providers"] extends Array<infer T>
			? T extends CustomProvider
				? T["endpoints"]
				: {}
			: {}
	>;
	type Actions = ProviderEndpoint & Auth["api"];

	type ExcludeCredentialPaths = Auth["options"]["emailAndPassword"] extends {
		enabled: true;
	}
		? ""
		: "signUpCredential" | "signInCredential";

	type ExcludedPaths =
		| "signinOauth"
		| "signUpOauth"
		| "callback"
		| "session"
		| ExcludeCredentialPaths;

	const $signal = atom<boolean>(false);

	type AdditionalSessionFields = Auth["options"]["plugins"] extends Array<
		infer T
	>
		? T extends {
				schema: {
					session: {
						fields: infer Field;
					};
				};
			}
			? Field extends Record<string, FieldAttribute>
				? InferFieldOutput<Field>
				: {}
			: {}
		: {};

	const $session = computed($signal, () =>
		task(async () => {
			const session = await client("/session", {
				credentials: "include",
				method: "GET",
			});
			return session.data as {
				user: User;
				session: Prettify<Session & AdditionalSessionFields>;
			} | null;
		}),
	);
	const proxy = getProxy(actions, client) as Prettify<
		Omit<InferActions<Actions>, ExcludedPaths>
	> &
		typeof actions;
	return {
		...proxy,
		$session,
	};
};
