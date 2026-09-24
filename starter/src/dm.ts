import { assign, createActor, fromPromise, setup } from "xstate";
import { Settings, speechstate } from "speechstate";
import { GROQ_KEY, KEY } from "./credentials";
import { DMContext, DMEvents, Message } from "./types";
import OpenAI from "openai";

const REGION = "germanywestcentral";

const openai = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: GROQ_KEY,
  dangerouslyAllowBrowser: true,
});

const MODEL = "openai/gpt-oss-20b";

const azureCredentials = {
  endpoint: `https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
  key: KEY,
};

/** backup: Azure access via FLoV proxy
const azureProxyCredentials = {
  proxyUrl: "https://rndserv.flov.gu.se:4000/api/token",
  key: "",
  };
*/

const settings: Settings = {
  azureCredentials: azureCredentials,
  azureRegion: REGION,
  asrDefaultCompleteTimeout: 0,
  asrDefaultNoInputTimeout: 5000,
  locale: "en-US",
  ttsDefaultVoice: "en-US-DavisNeural",
  bargeIn: false,
};

const SYSTEM_PROMPT: Message = {
  role: "system",
  content:
    "You are a friendly voice assistant having a casual spoken conversation. " +
    "Reply in one or two short sentences, like in a chat. " +
    "Do not use lists, markdown or emojis, since your replies are read aloud.",
};

const GREETING = "Hi there! What would you like to chat about?";

function append(messages: Message[], message: Message): Message[] {
  return [...messages, message];
}

function lastMessage(messages: Message[]): Message {
  return messages[messages.length - 1];
}

const dmMachine = setup({
  types: {
    context: {} as DMContext,
    events: {} as DMEvents,
  },
  actions: {
    "spst.speak": ({ context }, params: { utterance: string }) =>
      context.spstRef.send({
        type: "SPEAK",
        value: {
          utterance: params.utterance,
        },
      }),
    "spst.listen": ({ context }) =>
      context.spstRef.send({
        type: "LISTEN",
      }),
  },
  actors: {
    chatCompletion: fromPromise<string, { messages: Message[] }>(
      async ({ input }) => {
        const completion = await openai.chat.completions.create({
          model: MODEL,
          messages: input.messages,
        });
        return completion.choices[0].message.content ?? "";
      },
    ),
  },
}).createMachine({
  context: ({ spawn }) => ({
    spstRef: spawn(speechstate, { input: settings }),
    messages: [SYSTEM_PROMPT],
  }),
  id: "DM",
  initial: "Prepare",
  states: {
    Prepare: {
      entry: ({ context }) => context.spstRef.send({ type: "PREPARE" }),
      on: { ASRTTS_READY: "WaitToStart" },
    },
    WaitToStart: {
      on: { CLICK: "Loop" },
    },
    Loop: {
      entry: assign(({ context }) => ({
        messages: append(context.messages, {
          role: "assistant",
          content: GREETING,
        }),
      })),
      initial: "Speaking",
      states: {
        Speaking: {
          entry: {
            type: "spst.speak",
            params: ({ context }) => ({
              utterance: lastMessage(context.messages).content,
            }),
          },
          on: { SPEAK_COMPLETE: "Ask" },
        },
        Ask: {
          entry: { type: "spst.listen" },
          on: {
            RECOGNISED: {
              actions: assign(({ context, event }) => ({
                messages: append(context.messages, {
                  role: "user",
                  content: event.value[0].utterance,
                }),
              })),
            },
            LISTEN_COMPLETE: [
              {
                target: "ChatCompletion",
                guard: ({ context }) =>
                  lastMessage(context.messages).role === "user",
              },
              { target: "Ask", reenter: true },
            ],
          },
        },
        ChatCompletion: {
          invoke: {
            src: "chatCompletion",
            input: ({ context }) => ({ messages: context.messages }),
            onDone: {
              target: "Speaking",
              actions: assign(({ context, event }) => ({
                messages: append(context.messages, {
                  role: "assistant",
                  content: event.output,
                }),
              })),
            },
          },
        },
      },
    },
  },
});

const dmActor = createActor(dmMachine, {}).start();

dmActor.subscribe((state) => {
  console.group("State update");
  console.log("State value:", state.value);
  console.log("State context:", state.context);
  console.groupEnd();
});

export function setupButton(element: HTMLButtonElement) {
  element.addEventListener("click", () => {
    dmActor.send({ type: "CLICK" });
  });
  dmActor.subscribe((snapshot) => {
    const meta: { view?: string } = Object.values(
      snapshot.context.spstRef.getSnapshot().getMeta(),
    )[0] || {
      view: undefined,
    };
    element.innerHTML = `${meta.view}`;
  });
}
