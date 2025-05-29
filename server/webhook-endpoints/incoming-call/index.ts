import type { RequestHandler } from "express";
import { nanoid } from "nanoid";
import * as baseContext from "../../agents/main/context.js";
import { getInboundGreeting } from "../../agents/main/greetings.js";
import { relayConfig } from "../../agents/main/relay-config.js";
import type { CallSummary } from "../../agents/summary/types.js";
import { company } from "../../common/company.js";
import { INCOMING_CALL_WEBHOOK_ROUTE } from "../../common/endpoints.js";
import {
  FORM_NAME_1,
  FORM_NAME_2,
  type FormRecord_1,
  type FormRecord_2,
} from "../../common/forms.js";
import { fetchUserByPhone } from "../../common/mock-database/users.js";
import { fetchSegmentInteractions } from "../../common/segment.js";
import type {
  CallDetails,
  SegmentInteractionLog,
  SegmentProfileLog,
  SessionContextParams,
} from "../../common/session-context.js";
import {
  fetchUserForm,
  sendDemoLog,
  sendInitiatingCallStreamMessage,
} from "../../common/sync-rest.js";
import type { TwilioCallWebhookPayload } from "../../common/twilio-types.js";
import { ServerlessLogger } from "../logger.js";
import { makeConversationRelayTwiML } from "../utils/twiml.js";
import { ALLOWED_PHONE_NUMBERS } from "../../env.js";

const screenCall: RequestHandler = async (req, res) => {
  const payload = req.body as TwilioCallWebhookPayload;

  const log = new ServerlessLogger();

  try {
    log.warn(
      INCOMING_CALL_WEBHOOK_ROUTE,
      `screened call from ${payload.From}. add to ALLOWED_PHONE_NUMBERS env var`
    );

    const twiml = `\
<Response>
  <Say language='en-GB'>Terribly sorry. Your call is being screened. Your phone number is not on the list.</Say>
</Response>
    `;

    res.status(200).type("text/xml").send(twiml);
  } catch (error) {
    log.error(INCOMING_CALL_WEBHOOK_ROUTE, `screen call error`, error);
    res.status(500).json({ status: "error", error });
  }
};

export const incomingCallWebhookHandler: RequestHandler = async (
  req,
  res,
  next
) => {
  const payload = req.body as TwilioCallWebhookPayload;
  const callSid = payload.CallSid;

  const log = new ServerlessLogger();

  try {
    log.info(INCOMING_CALL_WEBHOOK_ROUTE, `new call, ${callSid}`);

    await sendInitiatingCallStreamMessage(payload);

    const call: CallDetails = {
      sid: callSid,
      participantPhone: payload.From,
      status: payload.CallStatus,
    };

    const [user] = await Promise.all([fetchUserByPhone(payload.From)]);
    if (!user) return screenCall(req, res, next);

    const [form_1, form_2, interactions] = await Promise.all([
      fetchUserForm<FormRecord_1>(user.id, FORM_NAME_1),
      fetchUserForm<FormRecord_2>(user.id, FORM_NAME_2),
      fetchSegmentInteractions(user),
    ]);

    const summary: CallSummary = {
      description: "",
      sentiment: "neutral",
      title: "New Call",
      topics: [],
      current: "",
    };

    const profileLog: SegmentProfileLog = {
      source: "segment",
      type: "profile",

      id: nanoid(),
      callSid,
      dateCreated: new Date().toISOString(),
      details: `Segment Profile (${user.id}) successfully fetched and injected into agent context.`,
      profile: user,
    };

    const interactionsLog: SegmentInteractionLog = {
      source: "segment",
      type: "interactions",

      id: nanoid(),
      callSid,
      dateCreated: new Date().toISOString(),
      details: `User's Segment interaction history injected into agent context.`,
      interactions,
    };

    const context: SessionContextParams = {
      call,
      company,
      demo: baseContext.demo,
      form_1,
      form_2,
      recall: { items: [], newIds: [] },
      screenControl: { formPage: "19B-8671-D", permission: "not-requested" },
      summary,
      underwriter: {},
      user,
    };

    const welcomeGreeting = await getInboundGreeting(context);

    const twiml = makeConversationRelayTwiML({
      ...relayConfig,
      callSid,
      context,
      welcomeGreetingInterruptible: "false",
      intelligenceService: process.env.CONVINTEL_SERVICE_SID || "",

      parameters: { welcomeGreeting }, // include greeting in parameters so the websocket server can add the welcome message to the turn store
      welcomeGreeting,
      debug: "tokens-played",
    });

    log.info(INCOMING_CALL_WEBHOOK_ROUTE, `${payload.CallSid}, twiml: `, twiml);

    sendDemoLog(profileLog).then(() => {
      sendDemoLog({
        ...interactionsLog,
        dateCreated: new Date().toISOString(),
      });
    });

    res.status(200).type("text/xml").end(twiml);
  } catch (error) {
    log.error(INCOMING_CALL_WEBHOOK_ROUTE, `${callSid}, unknown error`, error);
    res.status(500).json({ status: "error", error });
  }
};
