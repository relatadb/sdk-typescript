/**
 * Wrap a fetch implementation for a usage-inventory example that needs exact
 * i64 nanosecond timestamps. The server's ordinary JSON number would lose
 * precision in JavaScript Number, so `observed_at` is converted to its source
 * decimal text before the SDK parses the query response.
 *
 * This requires a runtime implementing JSON.parse reviver `context.source`
 * (for example Node.js 26). It is intentionally not installed as the SDK's
 * global response decoder.
 */
export function createExactUsageFetch(
  innerFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await innerFetch(input, init);
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (!new URL(requestUrl).pathname.endsWith("/v1/query") || !response.ok) {
      return response;
    }

    const text = await response.text();
    type SourceContext = { source?: string };
    type ParseWithSource = (
      text: string,
      reviver: (
        this: unknown,
        key: string,
        value: unknown,
        context?: SourceContext,
      ) => unknown,
    ) => unknown;
    const parseWithSource = JSON.parse as unknown as ParseWithSource;
    const parsed = parseWithSource(text, function (key, value, context) {
      if (key !== "observed_at" || typeof value !== "number") return value;
      const source = context?.source;
      if (!source || !/^-?\d+$/.test(source)) {
        throw new Error(
          "Exact usage timestamps require JSON.parse reviver context.source support",
        );
      }
      return source;
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return new Response(JSON.stringify(parsed), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
