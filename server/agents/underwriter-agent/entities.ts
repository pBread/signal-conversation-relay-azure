import { ResponseFormatJsonSchema } from "@azure/ai-agents";

export type RunEvent = ThreadMessageCompleteEvent;

// ========================================
// Message Complete
// ========================================
export interface ThreadMessageCompleteEvent {
  data: ThreadMessage;
  event: "thread.message.completed";
}

interface ThreadMessage {
  id: string;
  object: "thread.message";
  createdAt: string;
  threadId: string;
  status: string;
  incompleteDetails: any;
  completedAt: string;
  incompleteAt: any;
  role: string;
  content: Content[];
  assistantId: string;
  runId: string;
  attachments: any[];
  metadata: Metadata;
}

export interface Content {
  type: string;
  text: Text;
}

export interface Text {
  value: string;
  annotations: any[];
}

export interface Metadata {}

// ========================================
// json schema for underwriter answer
// ========================================
export const underwriterAnswerSchema: ResponseFormatJsonSchema = {
  name: "UnderwriterAnswer",
  description:
    "Structured response returned by the Underwriter agent after " +
    "reviewing an application.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "actions", "evidence", "next_steps"],
    properties: {
      answer: { type: "string" },

      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tool", "args", "result_ref"],
          properties: {
            tool: { type: "string" },
            args: { type: "object", additionalProperties: true },
            result_ref: { type: "string" },
          },
        },
      },

      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "value"],
          properties: {
            ref: { type: "string" },
            value: {},
            relevance: { type: "string" },
          },
        },
      },

      next_steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "detail"],
          properties: {
            type: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
    },
  },
};
