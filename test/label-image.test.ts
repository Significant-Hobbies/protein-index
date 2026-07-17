import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashHttpsLabelImage,
  LabelImageHashError,
} from "../scripts/adapters/label-image";

function chunkedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "image/jpeg", ...headers } });
}

describe("label image hashing", () => {
  it("hashes exact streamed bytes without requesting an insecure URL", async () => {
    const chunks = [new Uint8Array([0xff, 0xd8]), new Uint8Array([1, 2, 3, 0xff, 0xd9])];
    const expected = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
    const result = await hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      fetcher: async (input, init) => {
        expect(input.toString()).toBe("https://images.openfoodfacts.org/label.jpg");
        expect(init?.redirect).toBe("follow");
        return chunkedResponse(chunks, { "content-length": "7" });
      },
    });
    expect(result).toEqual({
      requestedUrl: "https://images.openfoodfacts.org/label.jpg",
      effectiveUrl: "https://images.openfoodfacts.org/label.jpg",
      contentSha256: expected,
      byteLength: 7,
      mediaType: "image/jpeg",
      fetchedAt: "2026-07-17T10:00:00.000Z",
    });
  });

  it.each([
    ["http://images.openfoodfacts.org/label.jpg", "insecure_url"],
    ["not-a-url", "invalid_url"],
  ] as const)("rejects unsafe requested URL %s", async (url, code) => {
    await expect(hashHttpsLabelImage({ url, fetcher: async () => chunkedResponse([]) }))
      .rejects.toMatchObject({ code } satisfies Partial<LabelImageHashError>);
  });

  it("rejects a non-image response before reading it", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      fetcher: async () => new Response("html", { headers: { "content-type": "text/html" } }),
    })).rejects.toMatchObject({ code: "invalid_media_type" });
  });

  it("normalizes transport errors without leaking upstream messages", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      fetcher: async () => { throw new Error("socket 10.0.0.1 secret detail"); },
    })).rejects.toMatchObject({
      code: "fetch_failed",
      message: "Label image request failed before a response was received.",
    });
  });

  it("aborts a label request that never returns a response", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      timeoutMilliseconds: 5,
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    })).rejects.toMatchObject({
      code: "request_timeout",
      message: "Label image request exceeded 5 milliseconds.",
    });
  });

  it("aborts a response body that stops streaming", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      timeoutMilliseconds: 5,
      fetcher: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xd8]));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        },
      }), { headers: { "content-type": "image/jpeg" } }),
    })).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("rejects a redirect that leaves HTTPS", async () => {
    const redirected = chunkedResponse([new Uint8Array([1])]);
    Object.defineProperty(redirected, "url", { value: "http://images.openfoodfacts.org/label.jpg" });
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      fetcher: async () => redirected,
    })).rejects.toMatchObject({ code: "invalid_redirect" });
  });

  it("rejects oversized declared and streamed bodies deterministically", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      maximumBytes: 2,
      fetcher: async () => chunkedResponse([new Uint8Array([1])], { "content-length": "3" }),
    })).rejects.toMatchObject({ code: "declared_size_exceeded" });
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      maximumBytes: 2,
      fetcher: async () => chunkedResponse([new Uint8Array([1, 2]), new Uint8Array([3])]),
    })).rejects.toMatchObject({ code: "stream_size_exceeded" });
  });

  it("caps pathological chunk counts and checks declared-length truncation", async () => {
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      maximumChunks: 1,
      fetcher: async () => chunkedResponse([new Uint8Array([1]), new Uint8Array([2])]),
    })).rejects.toMatchObject({ code: "stream_chunk_limit_exceeded" });
    await expect(hashHttpsLabelImage({
      url: "https://images.openfoodfacts.org/label.jpg",
      fetcher: async () => chunkedResponse([new Uint8Array([1])], { "content-length": "2" }),
    })).rejects.toMatchObject({ code: "stream_read_failed" });
  });
});
