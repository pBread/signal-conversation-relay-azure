import { nanoid } from "nanoid";
import { RecallLog } from "../../common/session-context.js";
import type {
  BotTextTurn,
  HumanTextTurn,
  TurnRecord,
} from "../../common/session-turns.js";
import { sendDemoLog } from "../../common/sync-rest.js";
import {
  getMakeWebsocketLogger,
  type WebsocketLogger,
} from "../../websocket-server/logger.js";
import type { SessionStore } from "../../websocket-server/session-store/index.js";
import { searchTranscript } from "./vector-db.js";

const MAX_RUNTIME = 10 * 60 * 1000; // 10 minutes

export class RecallAgent {
  private readonly startedAt = Date.now();
  private frequency = 7 * 1000;

  private log: WebsocketLogger;
  constructor(private store: SessionStore) {
    this.log = getMakeWebsocketLogger(store.callSid);
  }

  private allIdSet = new Set<string>(); // all ids that were identified as  relevant

  private interval: NodeJS.Timeout | undefined = undefined;
  start = () => {
    const sec = this.frequency / 1000;
    this.log.info("recall", `starting recall agent, frequency: ${sec}s`);
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
    this.log.info("recall", `stopped recall agent`);
  };

  getSetResults = async () => {
    const items = await this.getResults();
    if (!items) return;
    const ids = items.map((item) => item.document.id);
    const newIds = ids.filter((id) => !this.allIdSet.has(id)).slice(0, 3);

    for (const id of newIds) this.allIdSet.add(id);

    this.store.context.update({ recall: { items, newIds } });

    const demoLogs: RecallLog[] = newIds
      .map((id) => items.find((item) => item.document.id === id))
      .map((item) => {
        if (!item) return;

        const demoLog: RecallLog = {
          id: nanoid(),
          callSid: this.store.callSid,
          dateCreated: new Date().toISOString(),
          source: "recall",
          result: item,
          details: item.document.feedback,
        };
        return demoLog;
      })
      .filter((item): item is RecallLog => !!item)
      .slice(0, 3);

    for (const demoLog of demoLogs) {
      await new Promise((resolve) =>
        setTimeout(async () => {
          resolve(null);
        }, 1000 + Math.floor(2000 * Math.random()))
      );

      await sendDemoLog({ ...demoLog, dateCreated: new Date().toISOString() });
    }
  };

  private count: number = 0; // the number of requests
  private getTopK = () => {
    if (this.count === 0) return ++this.count;

    return Math.min(Math.max(3, ++this.count), 8);
  };

  getResults = async () => {
    const transcript = turnsToTranscript(this.store.turns.list());
    try {
      const items = await searchTranscript(transcript, {}, this.getTopK());
      return items.sort((a, b) => b.score - a.score);
    } catch (error) {
      this.log.error("recall", "error searching transcripts: ", error);
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
