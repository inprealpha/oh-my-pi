/**
 * OpenCode login flows.
 *
 * OpenCode provides two authentication methods:
 * 1. API Key flow for OpenCode Zen/Go models
 * 2. OAuth flow for GitHub Copilot (using OpenCode's officially-supported OAuth)
 *
 * The OpenCode OAuth for Copilot flow avoids GitHub ToS concerns by using
 * OpenCode's official OAuth token to access Copilot services.
 */

import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const AUTH_URL = "https://opencode.ai/auth";
const OPENCODE_OAUTH_AUTHORIZE_URL = "https://opencode.ai/oauth/authorize";
const OPENCODE_OAUTH_TOKEN_URL = "https://opencode.ai/oauth/token";
const OPENCODE_COPILOT_TOKEN_URL = "https://opencode.ai/api/copilot/token";
const CALLBACK_PORT = 1456;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "copilot";

interface PKCE {
	verifier: string;
	challenge: string;
}

class OpenCodeCopilotOAuthFlow extends OAuthCallbackFlow {
	constructor(
		ctrl: OAuthController,
		private readonly pkce: PKCE,
	) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const searchParams = new URLSearchParams({
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPE,
			code_challenge: this.pkce.challenge,
			code_challenge_method: "S256",
			state,
		});

		const url = `${OPENCODE_OAUTH_AUTHORIZE_URL}?${searchParams.toString()}`;
		return { url, instructions: "A browser window should open. Complete login to finish." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeCodeForCopilotToken(code, this.pkce.verifier, redirectUri);
	}
}

async function exchangeCodeForCopilotToken(
	code: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	// First, exchange the authorization code for an OpenCode access token
	const tokenResponse = await fetch(OPENCODE_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.timeout(15000),
	});

	if (!tokenResponse.ok) {
		const errorText = await tokenResponse.text();
		throw new Error(`OpenCode token exchange failed: ${tokenResponse.status} ${errorText}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new Error("OpenCode token response missing required fields");
	}

	// Now exchange the OpenCode access token for a Copilot token
	const copilotResponse = await fetch(OPENCODE_COPILOT_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(15000),
	});

	if (!copilotResponse.ok) {
		const errorText = await copilotResponse.text();
		throw new Error(`Copilot token exchange failed: ${copilotResponse.status} ${errorText}`);
	}

	const copilotData = (await copilotResponse.json()) as {
		token?: string;
		expires_at?: number;
	};

	if (typeof copilotData.token !== "string" || typeof copilotData.expires_at !== "number") {
		throw new Error("Invalid Copilot token response");
	}

	return {
		refresh: tokenData.refresh_token,
		access: copilotData.token,
		expires: copilotData.expires_at * 1000 - 5 * 60 * 1000, // 5 min buffer
	};
}

/**
 * Login to GitHub Copilot using OpenCode OAuth.
 *
 * This flow uses OpenCode's officially-supported OAuth to obtain a Copilot token,
 * avoiding potential GitHub ToS concerns with direct Copilot authentication.
 */
export async function loginGitHubCopilotViaOpenCode(options: OAuthController): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const flow = new OpenCodeCopilotOAuthFlow(options, pkce);
	return flow.login();
}

/**
 * Refresh GitHub Copilot token obtained via OpenCode OAuth.
 */
export async function refreshGitHubCopilotViaOpenCodeToken(refreshToken: string): Promise<OAuthCredentials> {
	// First, refresh the OpenCode access token
	const tokenResponse = await fetch(OPENCODE_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		signal: AbortSignal.timeout(15000),
	});

	if (!tokenResponse.ok) {
		const errorText = await tokenResponse.text();
		throw new Error(`OpenCode token refresh failed: ${tokenResponse.status} ${errorText}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new Error("OpenCode token response missing required fields");
	}

	// Exchange the refreshed OpenCode token for a new Copilot token
	const copilotResponse = await fetch(OPENCODE_COPILOT_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(15000),
	});

	if (!copilotResponse.ok) {
		const errorText = await copilotResponse.text();
		throw new Error(`Copilot token exchange failed: ${copilotResponse.status} ${errorText}`);
	}

	const copilotData = (await copilotResponse.json()) as {
		token?: string;
		expires_at?: number;
	};

	if (typeof copilotData.token !== "string" || typeof copilotData.expires_at !== "number") {
		throw new Error("Invalid Copilot token response");
	}

	return {
		refresh: tokenData.refresh_token,
		access: copilotData.token,
		expires: copilotData.expires_at * 1000 - 5 * 60 * 1000, // 5 min buffer
	};
}

/**
 * Login to OpenCode Zen.
 *
 * Opens browser to auth page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginOpenCode(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("OpenCode Zen login requires onPrompt callback");
	}

	// Open browser to auth page
	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Log in and copy your API key",
	});

	// Prompt user to paste their API key
	const apiKey = await options.onPrompt({
		message: "Paste your OpenCode Zen API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	return trimmed;
}
