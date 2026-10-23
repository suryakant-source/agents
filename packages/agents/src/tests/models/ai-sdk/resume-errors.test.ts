import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { CloudflareAIError } from "../../../models/ai-sdk";
import { createTransport } from "../../../models/ai-sdk/transport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One SSE event, as `/run` sends it. */
const event = (data: string) => `data: ${data}\n\n`;

const EVENTS = ["one", "two"].map((word) => event(JSON.stringify({ word })));

/**
 * A body that hands out `chunks` one read at a time, then fails as a dropped
 * connection does, mirroring the core resume tests.
 */
function droppingBody(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.error(new TypeError("Network connection lost."));
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    }
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

/** A binding whose stream names its run and drops; `fetch` serves resumes. */
function droppingBinding(resume: () => Response) {
  const binding = {
    aiGatewayLogId: null,
    async fetch() {
      return resume();
    },
    async run() {
      return new Response(droppingBody([EVENTS[0] ?? ""]), {
        headers: { "content-type": "text/event-stream", "cf-aig-run-id": "run-123" }
      });
    }
  };
  return binding as unknown as Ai;
}

const REQUEST = {
  gateway: { id: "prod" },
  headers: {},
  input: { stream: true },
  model: "anthropic/claude-haiku-4.5"
};

describe("transport: streamed errors are AI SDK errors", () => {
  // #2687: a failed stream resume raised the internal core CloudflareAIError,
  // so `instanceof CloudflareAIError` on the documented import was false and
  // `ai`'s retry loop never saw an APICallError.
  it("lifts a failed stream resume into CloudflareAIError", async () => {
    const transport = createTransport({
      binding: droppingBinding(
        () =>
          new Response(JSON.stringify({ error: "Request not found" }), {
            status: 404
          })
      )
    });
    const response = await transport.run(REQUEST);

    const caught = await readAll(
      response.body as ReadableStream<Uint8Array>
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(caught).toBeInstanceOf(CloudflareAIError);
    expect(APICallError.isInstance(caught)).toBe(true);
    expect((caught as CloudflareAIError).status).toBe(404);
    expect((caught as CloudflareAIError).code).toBe("provider-error");
    expect((caught as CloudflareAIError).message).toMatch(
      /no longer holds the run/
    );
  });

  it("passes a healthy resumable stream through unchanged", async () => {
    const transport = createTransport({
      binding: droppingBinding(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(EVENTS[1] ?? ""));
                controller.close();
              }
            })
          )
      )
    });
    const response = await transport.run(REQUEST);

    expect(await readAll(response.body as ReadableStream<Uint8Array>)).toBe(
      EVENTS.join("")
    );
  });
});
