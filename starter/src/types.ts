import { SpeechStateExternalEvent } from "speechstate";
import { AnyActorRef } from "xstate";

export type Message = {
  role: "assistant" | "user" | "system";
  content: string;
};

export interface DMContext {
  spstRef: AnyActorRef;
  messages: Message[];
  documents: Document[];
}

export type Document = {
  title: string;
  url?: string;
  text: string;
};

export type DMEvents = SpeechStateExternalEvent | { type: "CLICK" } | { type: "DONE" };
