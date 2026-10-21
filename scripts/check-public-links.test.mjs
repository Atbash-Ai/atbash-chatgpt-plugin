import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { checkPublicLinks } from "./check-public-links.mjs";

const links = {
  websiteURL: "https://example.com/product",
  supportURL: "https://example.com/support",
  privacyPolicyURL: "https://example.com/privacy",
  termsOfServiceURL: "https://example.com/terms",
};

const page = (url, overrides = {}) => ({
  ok: true,
  status: 200,
  url,
  text: async () => "<html>Public page</html>",
  ...overrides,
});

test("checks every page with an unauthenticated GET and records redirect destinations", async () => {
  const requests = [];
  const result = await checkPublicLinks(links, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return page(`${url}/current`);
    },
  });
  assert.equal(requests.length, 4);
  for (const { options } of requests) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "follow");
    assert.ok(options.signal instanceof globalThis.AbortSignal);
    assert.equal(options.headers, undefined);
  }
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(
    result.results,
    Object.entries(links).map(([field, url]) => ({
      field,
      url,
      finalUrl: `${url}/current`,
      status: 200,
    })),
  );
});

test("reports both an inaccessible privacy page and missing support URL", async () => {
  await assert.rejects(
    checkPublicLinks(
      { ...links, supportURL: undefined },
      {
        fetchImpl: async (url) => page(url, { ok: !url.endsWith("/privacy"), status: 404 }),
      },
    ),
    (error) => {
      assert.match(error.message, /supportURL \(missing\)/);
      assert.match(error.message, /privacyPolicyURL .*HTTP 404/);
      return true;
    },
  );
});

test("rejects empty pages and network failures", async () => {
  await assert.rejects(
    checkPublicLinks(links, {
      fetchImpl: async (url) => {
        if (url.endsWith("/privacy")) throw new Error("Connection failed");
        return page(url, { text: async () => "  " });
      },
    }),
    (error) => {
      assert.match(error.message, /privacyPolicyURL .*Connection failed/);
      assert.match(error.message, /termsOfServiceURL .*empty body/);
      return true;
    },
  );
});

test("rejects insecure or credential-bearing URLs before requesting them", async () => {
  const requested = [];
  await assert.rejects(
    checkPublicLinks(
      {
        ...links,
        websiteURL: "http://example.com/product",
        supportURL: "https://user:secret@example.com/support",
      },
      {
        fetchImpl: async (url) => {
          requested.push(url);
          return page(url);
        },
      },
    ),
    /HTTPS URL without embedded credentials/,
  );
  assert.deepEqual(requested, [links.privacyPolicyURL, links.termsOfServiceURL]);
});

test("rejects redirects to HTTP pages", async () => {
  await assert.rejects(
    checkPublicLinks(links, { fetchImpl: async () => page("http://example.com/login") }),
    /HTTPS URL without embedded credentials/,
  );
});

test("applies the timeout while reading the response body", async () => {
  await assert.rejects(
    checkPublicLinks(links, {
      timeoutMs: 5,
      fetchImpl: async (url, { signal }) =>
        page(url, {
          text: async () => {
            await setTimeout(100, undefined, { signal });
            return "Public page";
          },
        }),
    }),
    /aborted/,
  );
});
