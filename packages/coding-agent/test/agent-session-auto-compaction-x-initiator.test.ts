import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession auto-compaction Copilot initiator override", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-x-initiator-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("github-copilot", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
	});

	async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for auto-compaction");
	}

	it("reapplies the session Copilot initiator override to auto-compaction candidates", async () => {
		const model = getBundledModel("github-copilot", "gpt-4o");
		if (!model) {
			throw new Error("Expected github-copilot/gpt-4o model to exist");
		}

		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: "Initial request with enough text to summarize later.",
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Initial response with extra context for compaction." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "user",
			content: "Latest request before the oversized assistant turn.",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
			}),
			modelRegistry,
			forceCopilotAgentInitiator: true,
		});

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		const assistantMessage = {
			role: "assistant" as const,
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop" as const,
			usage: {
				input: model.contextWindow,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });

		await compactionDone;
		await waitFor(() => getApiKeySpy.mock.calls.length > 0);

		const apiKeyCandidate = getApiKeySpy.mock.calls[0]?.[0] as Model | undefined;
		expect(apiKeyCandidate).toMatchObject({
			provider: "github-copilot",
			id: model.id,
			headers: expect.objectContaining({ "X-Initiator": "agent" }),
		});
	});
});