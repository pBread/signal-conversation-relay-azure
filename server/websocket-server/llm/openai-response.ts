import { nanoid } from "nanoid";
import { AzureOpenAI } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses.mjs";
import { Stream } from "openai/streaming.mjs";
import { deriveInstructions } from "../../agents/main/instructions/index.js";
import { deriveLLMConfig } from "../../agents/main/llm-config.js";
import { executeTool } from "../../agents/main/tool-functions.js";
import { deriveToolManifest } from "../../agents/main/tool-manifest.js";
import { createLogStreamer } from "../../common/debug/log-streamer.js";
import {
  BotTextTurn,
  BotToolTurn,
  TurnRecord,
} from "../../common/session-turns.js";
import { TypedEventEmitter } from "../../common/utils/typed-event-emitter.js";
import {
  AZURE_API_VERSION,
  AZURE_LLM_ENDPOINT,
  FOUNDRY_API_KEY,
} from "../../env.js";
import { getMakeWebsocketLogger, type WebsocketLogger } from "../logger.js";
import type { SessionStore } from "../session-store/index.js";
import type { ConversationRelayAdapter } from "../twilio/conversation-relay-adapter.js";
import type { LLMEvents, LLMInterface } from "./interface.js";

const MAX_RETRIES = 3;

export class OpenAIResponseService implements LLMInterface {
  private client: AzureOpenAI;
  private eventEmitter = new TypedEventEmitter<LLMEvents>();
  private log: WebsocketLogger;
  private logStreamer: ReturnType<typeof createLogStreamer>;

  constructor(
    private relay: ConversationRelayAdapter,
    private store: SessionStore
  ) {
    this.logStreamer = createLogStreamer(`response-${Date.now()}`);
    this.log = getMakeWebsocketLogger(this.store.callSid);

    this.client = new AzureOpenAI({
      apiKey: FOUNDRY_API_KEY,
      apiVersion: AZURE_API_VERSION ?? "2025-03-01-preview",
      endpoint: AZURE_LLM_ENDPOINT,
    });
  }

  // ========================================
  // LLM Response Execution
  // ========================================
  private stream: Stream<ResponseStreamEvent> | undefined = undefined;
  private responseId: string | undefined = undefined; // the responseId is used to detect when a stream was aborted or overwritten
  private timeout: NodeJS.Timeout | undefined = undefined;

  get isStreaming() {
    return !!this.stream;
  }

  run = async () => {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    this.timeout = setTimeout(async () => {
      this.log.info("llm", "run started");
      await this.doResponse();
      this.log.info("llm", "run finished");
    }, 200);
  };

  doResponse = async (
    attempt = 0,
    previousResponseId?: string
  ): Promise<undefined | Promise<any>> => {
    this.ensureNoActiveStream();
    this.log.info(
      "llm",
      "doResponse",
      previousResponseId ? `previousResponseId: ${previousResponseId}` : ""
    );

    const tools = this.getTools();
    const input = previousResponseId
      ? this.getInputItemsSinceResponse(previousResponseId)
      : this.getInputItems();

    let args: ResponseCreateParamsStreaming | undefined;

    try {
      args = {
        ...this.getLLMConfig(),
        input,
        instructions: deriveInstructions(this.store.context),
        stream: true,
        tools,
      };
      if (previousResponseId) args.previous_response_id = previousResponseId;

      this.stream = await this.client.responses.create(args); // responses API
    } catch (error) {
      const _args = JSON.stringify({ turns: this.store.turns.list(), ...args });
      this.log.error("llm", "Error attempting completion", error, "\n", _args);
      return this.handleRetry(attempt);
    }

    let responseId: string | undefined;

    let botText: BotTextTurn | undefined;
    let botTool: BotToolTurn | undefined;

    const toolPromises: Promise<void>[] = [];

    for await (const chunk of this.stream) {
      this.logStreamer.write(`${chunk.type}\n`, JSON.stringify(chunk, null, 2));

      if (chunk.type === "response.created") {
        responseId = chunk.response.id;
        this.responseId = responseId;
      }

      if (this.responseId !== responseId) break;

      // ========================================
      // Text
      // ========================================
      if (chunk.type === "response.output_item.added") {
        if (chunk.item.type === "message") {
          if (!responseId) throw Error(`unreachable-lJM7r-DSP-002`);
          if (chunk.item.content?.[0]?.type === "refusal") continue; // todo: handle refusals, e.g. abort
          const content = chunk.item.content?.[0]?.text || "";

          botText = this.store.turns.addBotText({
            content,
            id: chunk.item.id,
            responseId,
            status: "streaming",
          });
          if (content.length) this.emit("text", content, false);
        }
      }

      if (chunk.type === "response.output_text.delta") {
        if (!botText) throw Error("unreachable-ScobK-DSP-003");
        const delta = chunk.delta || "";
        botText.content += delta;

        this.emit("text", delta, false);
      }

      if (chunk.type === "response.output_text.done") {
        if (!botText) throw Error("unreachable-q46m3-DSP-005");

        if (chunk.text !== botText.content)
          this.log.warn("llm", `accumulated text is inaccurate`);

        this.emit("text", "", true, botText.content);
      }

      // ========================================
      // Tools
      // ========================================
      if (chunk.type === "response.output_item.added") {
        if (chunk.item.type === "function_call") {
          if (!responseId) throw Error("unreachable-GSkOq-DSP-006");

          if (!botTool)
            botTool = this.store.turns.addBotTool({
              id: nanoid(),
              responseId,
              status: "streaming",
              tool_calls: [],
            });

          botTool.tool_calls.push({
            id: chunk.item.call_id,
            index: botTool.tool_calls.length,
            type: "function",
            function: {
              name: chunk.item.name,
              arguments: chunk.item.arguments,
            },
          });
        }
      }

      if (chunk.type === "response.function_call_arguments.delta") {
        if (!botTool) throw Error("unreachable-9w8T3-DSP-007");

        const tool = botTool.tool_calls[botTool.tool_calls.length - 1];
        tool.function.arguments += chunk.delta;
      }

      if (chunk.type === "response.output_item.done") {
        if (chunk.item.type === "function_call") {
          if (!botTool) throw Error("unreachable-tfe36-DSP-009");

          const call_id = chunk.item.call_id;
          const tool = botTool.tool_calls.find((tool) => tool.id === call_id);
          if (!tool) throw Error(`Tool not found call_id: ${call_id}`);

          const deps = { log: this.log, relay: this.relay, store: this.store };

          tool.beginAt = new Date().toISOString();
          toolPromises.push(
            executeTool(tool.function, deps)
              .then((result) => {
                this.store.turns.setToolResult(tool.id, result);
              })
              .catch((error) => {
                this.log.warn(
                  "llm",
                  `Tool execution failed ${tool.function.name}. error: `,
                  error
                );
                this.store.turns.setToolResult(tool.id, {
                  status: "error",
                  message: "unknown",
                });
              })
          );
        }
      }
    }

    // ========================================
    // Wrap Up Response
    // ========================================
    await Promise.all(toolPromises);

    if (responseId === this.responseId) {
      if (botText && botText.status !== "interrupted")
        botText.status = "complete";

      this.cleanup();

      if (botTool && botTool?.status !== "interrupted") {
        botTool.status = "complete";
        return this.doResponse(0, responseId);
      }
    }
  };

  // ========================================
  // Translators
  // ========================================
  /** Formats the llm-config into the schema required for the LLM request  */
  private getLLMConfig = () => deriveLLMConfig(this.store.context);

  /** Formats the tool-manifest into the schema required for the LLM request  */
  private getTools = (): Tool[] => deriveToolManifest(this.store.context);

  // returns only the appended items
  private getInputItemsSinceResponse = (previousResponseId: string) => {
    const turns = this.store.turns.list();

    const firstIndexOfPrevious = turns.findIndex(
      (turn) => turn.role === "bot" && turn.responseId === previousResponseId
    );

    if (firstIndexOfPrevious === -1)
      throw Error("no turns found for previous response");

    const previousTurn = turns[firstIndexOfPrevious];
    if (previousTurn.role !== "bot")
      throw Error("previousResponseId must be bot turn");

    const previousOutputs = this.translateTurnsToLLMParams([
      previousTurn,
    ]).filter(
      (item) =>
        // only include outputs. the inputs are stored on the server
        item.type === "computer_call_output" ||
        item.type === "function_call_output"
    );

    const turnsAfterPrevious = turns.slice(firstIndexOfPrevious + 1);
    const allItemsAfterPrevious =
      this.translateTurnsToLLMParams(turnsAfterPrevious);

    return [...previousOutputs, ...allItemsAfterPrevious];
  };

  private getInputItems = (): ResponseInputItem[] =>
    this.translateTurnsToLLMParams(this.store.turns.list());

  private translateTurnsToLLMParams = (
    turns: TurnRecord[]
  ): ResponseInputItem[] =>
    turns
      .filter(
        (turn) =>
          turn.role !== "bot" || turn.type !== "text" || !!turn.content.length // @spoken update to .spoken
      )
      .flatMap(this.translateTurnToLLMParam)
      .filter((item): item is ResponseInputItem => !!item);

  /**
   * Translates the store's turn schema to the OpenAI parameter schema required by their completion API
   */
  private translateTurnToLLMParam = (
    turn: TurnRecord
  ): ResponseInputItem | ResponseInputItem[] | undefined => {
    if (turn.role === "bot" && turn.type === "dtmf")
      return { role: "assistant", content: turn.content }; // @spoken update to .spoken

    if (turn.role === "bot" && turn.type === "text")
      return { role: "assistant", content: turn.content };

    if (turn.role === "human") return { role: "user", content: turn.content };

    if (turn.role === "system")
      return { role: "system", content: turn.content };

    if (turn.role === "bot" && turn.type === "tool") {
      // Each tool turn is blown out into two items: function_call and function_call_output
      const msgs: ResponseInputItem[] = [];
      for (const tool of turn.tool_calls) {
        msgs.push({
          type: "function_call",
          call_id: tool.id,
          arguments: tool.function.arguments,
          name: tool.function.name,
        });
      }

      // function_call_outputs are added after function_calls to make it easy to filter which items need to be appended if the previousResponseId is used
      for (const tool of turn.tool_calls) {
        msgs.push({
          type: "function_call_output",
          call_id: tool.id,
          output: JSON.stringify(
            tool.result ?? { status: "error", error: "unknown" }
          ),
        });
      }

      return msgs;
    }
  };

  // ========================================
  // Stream Cleanup
  // ========================================
  abort = () => {
    if (this.stream && !this.stream?.controller.signal.aborted)
      this.stream?.controller.abort();

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    this.cleanup();
  };

  private cleanup = () => {
    this.responseId = undefined;
    this.retryPromise = undefined;
    this.stream = undefined;
    if (this.timeout) this.timeout = undefined;
  };

  /** Checks for and handles any existing completion stream. There should only be one stream open at any given time. */
  private ensureNoActiveStream = () => {
    if (!this.stream) return;

    this.log.warn(
      "llm",
      "Starting a completion while one is already underway. Previous completion will be aborted."
    );
    this.abort(); // judgement call: should previous completion be aborted or should the new one be cancelled?
  };

  // ========================================
  // Helpers
  // ========================================
  retryPromise: NodeJS.Timeout | undefined = undefined;
  private handleRetry = (attempt: number) =>
    new Promise((resolve) => {
      this.abort(); // clean up previous

      const delay = 500 * Math.pow(2, attempt - 1) * (0.5 + Math.random()); // exponential backoff
      this.retryPromise = setTimeout(() => {
        if (this.stream) return resolve(null);
        if (attempt > MAX_RETRIES) {
          const message = `LLM completion failed more than max retry attempt`;
          this.log.error(`llm`, message);
          this.relay.end({ reason: "error", message });
          return resolve(null);
        }

        this.log.info(`llm`, `retry attempt: ${attempt}`);
        this.retryPromise = undefined;
        resolve(this.doResponse(attempt + 1));
      }, Math.max(250, delay));
    });

  // ========================================
  // Event Type Casting
  // ========================================
  public on: TypedEventEmitter<LLMEvents>["on"] = (...args) =>
    this.eventEmitter.on(...args);
  private emit: TypedEventEmitter<LLMEvents>["emit"] = (event, ...args) =>
    this.eventEmitter.emit(event, ...args);
}
