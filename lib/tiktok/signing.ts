import { createHmac } from "crypto";

/**
 * TikTok Shop Open Platform request signing (HMAC-SHA256).
 *
 * Algorithm (per TikTok "Sign your API request"):
 *   1. Take all query params EXCEPT `sign` and `access_token`.
 *   2. Sort the remaining keys alphabetically.
 *   3. Concatenate them as `key + value` (no separators), in sorted order.
 *   4. Prepend the request path (e.g. "/order/202309/orders/search").
 *   5. If the method is not GET and the content type is not multipart/form-data,
 *      append the raw JSON request body string.
 *   6. Wrap the whole thing with the app secret on both ends:
 *        signString = appSecret + path + sortedKeyValues + body + appSecret
 *   7. HMAC-SHA256(signString, key = appSecret) → lowercase hex.
 *
 * The access token is passed in the `x-tts-access-token` header, not the query
 * string, and is explicitly excluded from the signature.
 */
export function signTiktokRequest(input: {
  appSecret: string;
  path: string;
  query: Record<string, string | number | undefined>;
  body?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  contentType?: string;
}): string {
  const { appSecret, path, query, body, method = "GET", contentType } = input;

  const keys = Object.keys(query)
    .filter((k) => k !== "sign" && k !== "access_token")
    .filter((k) => query[k] !== undefined && query[k] !== "")
    .sort();

  let signString = path;
  for (const key of keys) {
    signString += `${key}${query[key]}`;
  }

  const isMultipart = (contentType || "").includes("multipart/form-data");
  if (method !== "GET" && body && !isMultipart) {
    signString += body;
  }

  signString = `${appSecret}${signString}${appSecret}`;

  return createHmac("sha256", appSecret).update(signString, "utf8").digest("hex");
}
