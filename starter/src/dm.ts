import { assign, createActor, fromPromise, setup } from "xstate";
import { Settings, speechstate } from "speechstate";
import { GROQ_KEY, KEY } from "./credentials";
import { DMContext, DMEvents, Document, Message } from "./types";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

const REGION = "germanywestcentral";

const openai = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: GROQ_KEY,
  dangerouslyAllowBrowser: true,
});

const MODEL = "openai/gpt-oss-20b";

const ollama = new OpenAI({
  baseURL: "http://localhost:11434/v1/",
  apiKey: "ollama",
  dangerouslyAllowBrowser: true,
});

const qdrant = new QdrantClient({ url: "http://localhost:6333" });

const COLLECTION = "gu-support";

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
    "You are a friendly voice assistant for students at the University of Gothenburg. " +
    "Reply in one or two short sentences, like in a chat. " +
    "Do not use lists, markdown or emojis, since your replies are read aloud.",
};

const GREETING = "Hi there! How can I help you with your studies today?";

function append(messages: Message[], message: Message): Message[] {
  return [...messages, message];
}

function lastMessage(messages: Message[]): Message {
  return messages[messages.length - 1];
}

function augment(messages: Message[], documents: Document[]): Message[] {
  const [system, ...history] = messages;
  const sources = documents
    .map((d) => `[${d.title}]\n${d.text}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content: `${system.content}

Answer questions about the university using only the information from the student portal below. If the answer is not there, say you don't know.

STUDENT PORTAL START

${sources}

STUDENT PORTAL END`,
    },
    ...history,
  ];
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
    queryRAG: fromPromise<Document[], { query: string }>(async ({ input }) => {
      const embedding = await ollama.embeddings
        .create({
          model: "qwen3-embedding",
          input: input.query,
          dimensions: 384,
        })
        .then((result) => result.data[0].embedding);
      const result = await qdrant.query(COLLECTION, {
        query: embedding,
        with_payload: true,
        limit: 5,
      });
      return result.points.map((point) => point.payload as Document);
    }),
  },
}).createMachine({
  context: ({ spawn }) => ({
    spstRef: spawn(speechstate, { input: settings }),
    messages: [SYSTEM_PROMPT],
    documents: [],
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
                target: "Retrieval",
                guard: ({ context }) =>
                  lastMessage(context.messages).role === "user",
              },
              { target: "Ask", reenter: true },
            ],
          },
        },
        Retrieval: {
          invoke: {
            src: "queryRAG",
            input: ({ context }) => ({
              query: lastMessage(context.messages).content,
            }),
            onDone: {
              target: "ChatCompletion",
              actions: assign({ documents: ({ event }) => event.output }),
            },
            onError: {
              target: "ChatCompletion",
              actions: [
                assign({ documents: [] }),
                ({ event }) => console.error("RAG query failed", event.error),
              ],
            },
          },
        },
        ChatCompletion: {
          invoke: {
            src: "chatCompletion",
            input: ({ context }) => ({
              messages: augment(context.messages, context.documents),
            }),
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
