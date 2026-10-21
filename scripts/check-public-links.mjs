import { URL } from "node:url";

const fields = ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"];

function requirePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Expected an HTTPS URL without embedded credentials.");
  }
  return url.href;
}

export async function checkPublicLinks(
  pluginInterface,
  { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {},
) {
  const checks = await Promise.allSettled(
    fields.map(async (field) => {
      const url = requirePublicUrl(pluginInterface?.[field]);
      // Use GET: a successful HEAD response does not establish that the page loads.
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: globalThis.AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const finalUrl = requirePublicUrl(response.url);
      const body = await response.text();
      if (!body.trim()) throw new Error("The page returned an empty body.");
      return { field, url, finalUrl, status: response.status };
    }),
  );
  const failures = checks.flatMap((check, index) =>
    check.status === "rejected"
      ? [
          `${fields[index]} (${pluginInterface?.[fields[index]] ?? "missing"}): ${check.reason.message}`,
        ]
      : [],
  );
  if (failures.length) {
    throw new Error(`Public submission links are inaccessible:\n${failures.join("\n")}`);
  }
  return { checkedAt: new Date().toISOString(), results: checks.map((check) => check.value) };
}
