import { describe, expect, test } from "bun:test";
import {
  extractResource,
  isRequestToCollection,
  matchRule,
  scimError,
  buildSilentResponse,
  buildEmptyResponse,
  applyTransforms,
} from "./proxy.ts";
import type { Config, Rule } from "./config.ts";

// --- extractResource ---

describe("extractResource", () => {
  test("extracts resource from simple path", () => {
    expect(extractResource("/Users")).toBe("/Users");
  });

  test("extracts resource from path with id", () => {
    expect(extractResource("/Users/abc-123")).toBe("/Users");
  });

  test("extracts resource from path with base path", () => {
    expect(extractResource("/scim/v2/Groups", "/scim/v2")).toBe("/Groups");
  });

  test("extracts resource from path with base path and id", () => {
    expect(extractResource("/scim/v2/Groups/xyz", "/scim/v2")).toBe("/Groups");
  });

  test("returns null for root path", () => {
    expect(extractResource("/")).toBeNull();
  });

  test("returns null when base path does not match", () => {
    expect(extractResource("/other/Users", "/scim/v2")).toBeNull();
  });
});

// --- isRequestToCollection ---

describe("isRequestToCollection", () => {
  test("returns true for collection path", () => {
    expect(isRequestToCollection("/Users")).toBe(true);
  });

  test("returns false for individual path", () => {
    expect(isRequestToCollection("/Users/abc-123")).toBe(false);
  });

  test("returns true for collection with base path", () => {
    expect(isRequestToCollection("/scim/v2/Groups", "/scim/v2")).toBe(true);
  });

  test("returns false for individual with base path", () => {
    expect(isRequestToCollection("/scim/v2/Groups/xyz", "/scim/v2")).toBe(
      false
    );
  });
});

// --- matchRule ---

describe("matchRule", () => {
  const rules: Rule[] = [
    { resource: "/Groups", methods: ["*"], action: "empty" },
    { resource: "/Users", methods: ["DELETE"], action: "reject" },
    { resource: "/Bulk", methods: ["POST"], action: "silent" },
  ];

  test("matches wildcard method rule", () => {
    const rule = matchRule("/Groups", "GET", rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("empty");
  });

  test("matches wildcard for any method", () => {
    expect(matchRule("/Groups", "POST", rules)?.action).toBe("empty");
    expect(matchRule("/Groups", "DELETE", rules)?.action).toBe("empty");
    expect(matchRule("/Groups", "PATCH", rules)?.action).toBe("empty");
  });

  test("matches specific method rule", () => {
    const rule = matchRule("/Users/abc", "DELETE", rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("reject");
  });

  test("does not match unmatched method", () => {
    expect(matchRule("/Users", "GET", rules)).toBeNull();
  });

  test("does not match unmatched resource", () => {
    expect(matchRule("/ServiceProviderConfig", "GET", rules)).toBeNull();
  });

  test("matches with base path", () => {
    const rule = matchRule("/scim/v2/Groups", "GET", rules, "/scim/v2");
    expect(rule?.action).toBe("empty");
  });

  test("case-insensitive method matching", () => {
    const rule = matchRule("/Users/abc", "delete", rules);
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe("reject");
  });

  test("returns null for non-matching path with base path", () => {
    expect(matchRule("/other/Groups", "GET", rules, "/scim/v2")).toBeNull();
  });
});

// --- scimError ---

describe("scimError", () => {
  test("returns correct status code", () => {
    const res = scimError(403, "Forbidden");
    expect(res.status).toBe(403);
  });

  test("returns SCIM JSON content type", () => {
    const res = scimError(404, "Not found");
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
  });

  test("returns valid SCIM error body", async () => {
    const res = scimError(502, "Upstream error");
    const body = await res.json();
    expect(body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    expect(body.status).toBe("502");
    expect(body.detail).toBe("Upstream error");
  });
});

// --- buildSilentResponse ---

describe("buildSilentResponse", () => {
  test("DELETE returns 204", () => {
    const res = buildSilentResponse("DELETE", null, "/Users/abc");
    expect(res.status).toBe(204);
  });

  test("POST returns 201 with stub", async () => {
    const res = buildSilentResponse(
      "POST",
      { displayName: "Test" },
      "/Users"
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.displayName).toBe("Test");
    expect(body.meta).toBeDefined();
  });

  test("PUT returns 200 with stub", async () => {
    const res = buildSilentResponse(
      "PUT",
      { displayName: "Updated" },
      "/Users/abc"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Updated");
  });

  test("PATCH returns 200 with stub", async () => {
    const res = buildSilentResponse("PATCH", {}, "/Users/abc");
    expect(res.status).toBe(200);
  });

  test("GET collection returns empty ListResponse", async () => {
    const res = buildSilentResponse("GET", null, "/Groups");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:ListResponse",
    ]);
    expect(body.totalResults).toBe(0);
    expect(body.Resources).toEqual([]);
  });

  test("GET single returns 200 stub", async () => {
    const res = buildSilentResponse("GET", null, "/Groups/abc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
  });
});

// --- buildEmptyResponse ---

describe("buildEmptyResponse", () => {
  test("DELETE returns 204", () => {
    const res = buildEmptyResponse("DELETE", "/Groups/abc", null);
    expect(res.status).toBe(204);
  });

  test("GET collection returns empty ListResponse", async () => {
    const res = buildEmptyResponse("GET", "/Groups", null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(0);
    expect(body.Resources).toEqual([]);
  });

  test("GET single returns 404 SCIM error", async () => {
    const res = buildEmptyResponse("GET", "/Groups/abc-123", null);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    expect(body.detail).toBe("Resource not found");
  });

  test("POST returns 201 stub (same as silent)", async () => {
    const res = buildEmptyResponse("POST", "/Groups", {
      displayName: "Test Group",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.displayName).toBe("Test Group");
  });

  test("PUT returns 200 stub", async () => {
    const res = buildEmptyResponse("PUT", "/Groups/abc", {
      displayName: "Updated",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Updated");
  });

  test("works with base path", async () => {
    const res = buildEmptyResponse("GET", "/scim/v2/Groups", null, "/scim/v2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(0);
  });
});

// --- applyTransforms ---

describe("applyTransforms", () => {
  const configWith = (inject_email_type?: string): Config => ({
    upstream: { url: "https://example.com" },
    server: { port: 8080 },
    rules: [],
    transforms: { inject_email_type },
  });

  test("injects type into first email when missing", () => {
    const input = JSON.stringify({
      userName: "test",
      emails: [{ value: "a@b.com", primary: true }],
    });
    const result = JSON.parse(applyTransforms(input, configWith("work")));
    expect(result.emails[0].type).toBe("work");
    expect(result.emails[0].value).toBe("a@b.com");
  });

  test("does not overwrite existing type", () => {
    const input = JSON.stringify({
      emails: [{ value: "a@b.com", type: "home" }],
    });
    const result = JSON.parse(applyTransforms(input, configWith("work")));
    expect(result.emails[0].type).toBe("home");
  });

  test("no-op when inject_email_type is not configured", () => {
    const input = JSON.stringify({
      emails: [{ value: "a@b.com" }],
    });
    const result = applyTransforms(input, configWith(undefined));
    expect(result).toBe(input);
  });

  test("no-op when body has no emails array", () => {
    const input = JSON.stringify({ userName: "test" });
    const result = applyTransforms(input, configWith("work"));
    expect(result).toBe(input);
  });

  test("no-op when emails array is empty", () => {
    const input = JSON.stringify({ emails: [] });
    const result = applyTransforms(input, configWith("work"));
    expect(result).toBe(input);
  });

  test("no-op for invalid JSON", () => {
    const input = "not json";
    const result = applyTransforms(input, configWith("work"));
    expect(result).toBe(input);
  });
});
