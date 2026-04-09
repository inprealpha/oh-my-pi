import { describe, expect, test, vi } from "vitest";
import type { Api, Model } from "../src/types";
import * as copilot from "../src/utils/oauth/github-copilot";
import * as models from "../src/models";

describe("loginGitHubCopilot - OpenCode auth", () => {
	test("uses OpenCode OAuth token when authMethod is opencode", async () => {
		const refreshSpy = vi.spyOn(copilot, "refreshGitHubCopilotToken").mockResolvedValue({
			refresh: "refresh-token",
			access: "access-token",
			expires: Date.now() + 10_000,
			enterpriseUrl: "enterprise.example.com",
		});

		const bundledModelsSpy = vi
			.spyOn(models, "getBundledModels")
			.mockReturnValue([] as Model<Api>[]);
		const progress = vi.fn();

		const credentials = await copilot.loginGitHubCopilot({
			authMethod: "opencode",
			enterpriseDomain: "enterprise.example.com",
			onAuth: () => {},
			onPrompt: async () => "opencode-oauth-token",
			onProgress: progress,
		});

		expect(refreshSpy).toHaveBeenCalledWith("opencode-oauth-token", "enterprise.example.com");
		expect(progress).toHaveBeenCalledWith("Enabling models...");
		expect(bundledModelsSpy).toHaveBeenCalledWith("github-copilot");
		expect(credentials.access).toBe("access-token");
	});
});
