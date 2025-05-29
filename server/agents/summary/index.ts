import { readFileSync } from "fs";
import { nanoid } from "nanoid";
import { AzureOpenAI } from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { TopicLog } from "../../common/session-context.js";
import type {
  BotTextTurn,
  HumanTextTurn,
  TurnRecord,
} from "../../common/session-turns.js";
import { sendDemoLog } from "../../common/sync-rest.js";
import { interpolateString } from "../../common/utils/interpolate-string.js";
import {
  AZURE_API_VERSION,
  AZURE_LLM_DEPLOYMENT,
  AZURE_LLM_ENDPOINT,
  FOUNDRY_API_KEY,
} from "../../env.js";
import {
  getMakeWebsocketLogger,
  type WebsocketLogger,
} from "../../websocket-server/logger.js";
import type { SessionStore } from "../../websocket-server/session-store/index.js";
import { CallSummary } from "./types.js";

const MAX_RUNTIME = 10 * 60 * 1000; // 10 minutes

export class SummaryAgent {
  private readonly startedAt = Date.now();
  private log: WebsocketLogger;
  private frequency = 10 * 1000;
  private client: AzureOpenAI;
  private instructions: string;

  constructor(private store: SessionStore) {
    this.log = getMakeWebsocketLogger(store.callSid);

    this.instructions = readInstructionsFile();

    this.client = new AzureOpenAI({
      apiKey: FOUNDRY_API_KEY,
      apiVersion: AZURE_API_VERSION ?? "2025-03-01-preview",
      endpoint: AZURE_LLM_ENDPOINT,
    });
  }

  private interval: NodeJS.Timeout | undefined = undefined;
  start = () => {
    const sec = this.frequency / 1000;
    this.log.info("recall", `starting summary agent, frequency: ${sec}s`);

    this.interval = setInterval(async () => {
      await this.getSetResults();

      // stop conditions
      const callStatus = this.store.context.call.status;
      if (callStatus === "failed" || callStatus === "completed") this.stop();

      const elapsed = Date.now() - this.startedAt;
      if (elapsed >= MAX_RUNTIME) this.stop();
    }, this.frequency);
  };

  stop = () => {
    clearInterval(this.interval);
    this.log.info("summary", `stopped recall agent`);
  };

  getSetResults = async () => {
    const summary = await this.getResults();
    if (!summary) return;

    const topicSet = new Set(this.store?.context?.summary?.topics ?? []);
    const newTopics = summary.topics.filter((topic) => !topicSet.has(topic));

    for (const topic of summary.topics) topicSet.add(topic);

    const nextSummary: CallSummary = {
      ...(this.store?.context?.summary ?? {}),
      ...summary,
      topics: [...topicSet],
    };
    this.store.context.update({ summary: nextSummary });

    const demoLogs: TopicLog[] = newTopics.map((topic) => {
      const demoLog: TopicLog = {
        source: "summary",
        id: nanoid(),
        callSid: this.store.callSid,
        dateCreated: new Date().toISOString(),
        topic,
        articles: [],
        details: `identified new topic: ${topic}`,
      };

      return demoLog;
    });

    for (const demoLog of demoLogs) await sendDemoLog(demoLog);
  };

  errorCount = 0;
  getResults = async () => {
    const transcript = turnsToTranscript(this.store.turns.list());

    let completion: ChatCompletion;
    try {
      const prompt = interpolateString(this.instructions, {
        ...this.store.context,
        transcript,
      });

      completion = await this.client.chat.completions.create({
        model: AZURE_LLM_DEPLOYMENT,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });

      const content = completion.choices[0].message.content;
      if (!content) return;
      const result = JSON.parse(content);
      return result as CallSummary;
    } catch (error) {
      this.log.error("summary", "error executing summary completion", error);

      if (this.errorCount++ > 3) {
        this.log.error("summary", `stopping summary bot due to errors`);
        this.stop();
      }
      return;
    }
  };
}

function turnsToTranscript(turns: TurnRecord[]) {
  return turns
    .filter(
      (turn): turn is BotTextTurn | HumanTextTurn =>
        (turn.role === "bot" && turn.type === "text") ||
        (turn.role === "human" && turn.type === "text")
    )
    .map((turn) => `[${turn.role}]: ${turn.content}`)
    .join("\n\n");
}

function readInstructionsFile() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const filePath = join(__dirname, "instructions.md");

    const instructions = readFileSync(filePath, "utf8");
    return instructions;
  } catch (error) {
    console.error("Error reading instructions.md", error);
    throw error;
  }
}
