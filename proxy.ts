import type { Config, Rule } from "./config.ts";

const SCIM_JSON = "application/scim+json";

/**
 * Extract the SCIM resource name from a URL pathname.
 * e.g. "/Users/abc-123" → "/Users", "/Groups" → "/Groups"
 * If basePath is set, it is stripped first.
 */
export function extractResource(
  pathname: string,
  basePath?: string
): string | null {
  let path = pathname;
  if (basePath) {
    if (!path.startsWith(basePath)) return null;
    path = path.slice(basePath.length);
  }
  // path should now look like "/Users" or "/Users/abc-123"
  const match = path.match(/^(\/[^/]+)/);
  return match ? match[1]! : null;
}

/**
 * Returns true if the path points to a collection (no id segment).
 * e.g. "/Users" → true, "/Users/abc" → false
 */
export function isRequestToCollection(
  pathname: string,
  basePath?: string
): boolean {
  let path = pathname;
  if (basePath) {
    path = path.slice(basePath.length);
  }
  // A collection has exactly one segment: "/Resource"
  // An individual has two: "/Resource/id"
  const segments = path.split("/").filter(Boolean);
  return segments.length <= 1;
}

/**
 * Find the first rule matching this request, or null.
 */
export function matchRule(
  pathname: string,
  method: string,
  rules: Rule[],
  basePath?: string
): Rule | null {
  const resource = extractResource(pathname, basePath);
  if (!resource) return null;

  const upperMethod = method.toUpperCase();
  for (const rule of rules) {
    if (rule.resource !== resource) continue;
    if (rule.methods.includes("*") || rule.methods.includes(upperMethod)) {
      return rule;
    }
  }
  return null;
}

/**
 * Build an RFC 7644 SCIM error response.
 */
export function scimError(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      detail,
    }),
    {
      status,
      headers: { "Content-Type": SCIM_JSON },
    }
  );
}

/**
 * Build a plausible success response for a silently voided request.
 */
export function buildSilentResponse(
  method: string,
  body: unknown,
  pathname: string,
  basePath?: string
): Response {
  const upper = method.toUpperCase();
  const isCollection = isRequestToCollection(pathname, basePath);

  if (upper === "DELETE") {
    return new Response(null, { status: 204 });
  }

  if (upper === "POST") {
    // Create: echo back with a fake id and 201
    const stub = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: crypto.randomUUID(),
      ...(typeof body === "object" && body !== null ? body : {}),
      meta: {
        resourceType: "User",
        created: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        location: "",
      },
    };
    return new Response(JSON.stringify(stub), {
      status: 201,
      headers: { "Content-Type": SCIM_JSON },
    });
  }

  if (upper === "PUT" || upper === "PATCH") {
    const stub = {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: crypto.randomUUID(),
      ...(typeof body === "object" && body !== null ? body : {}),
      meta: {
        resourceType: "User",
        lastModified: new Date().toISOString(),
      },
    };
    return new Response(JSON.stringify(stub), {
      status: 200,
      headers: { "Content-Type": SCIM_JSON },
    });
  }

  // GET
  if (isCollection) {
    return new Response(
      JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 0,
        Resources: [],
      }),
      { status: 200, headers: { "Content-Type": SCIM_JSON } }
    );
  }

  // GET single — return empty stub
  return new Response(
    JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      id: crypto.randomUUID(),
    }),
    { status: 200, headers: { "Content-Type": SCIM_JSON } }
  );
}

/**
 * Build an empty/default SCIM response — designed so the IdP thinks
 * the resource type simply has no data.
 */
export function buildEmptyResponse(
  method: string,
  pathname: string,
  body: unknown,
  basePath?: string
): Response {
  const upper = method.toUpperCase();
  const isCollection = isRequestToCollection(pathname, basePath);

  if (upper === "DELETE") {
    return new Response(null, { status: 204 });
  }

  // Writes succeed silently (same as silent)
  if (upper === "POST" || upper === "PUT" || upper === "PATCH") {
    return buildSilentResponse(method, body, pathname, basePath);
  }

  // GET collection → empty list
  if (isCollection) {
    return new Response(
      JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 0,
        Resources: [],
      }),
      { status: 200, headers: { "Content-Type": SCIM_JSON } }
    );
  }

  // GET single → 404 not found
  return scimError(404, "Resource not found");
}

/**
 * If configured, inject a "type" field into the first email entry
 * that lacks one. Passbolt (and others) require emails.[type=work].
 */
export function applyTransforms(
  bodyText: string,
  config: Config
): string {
  const emailType = config.transforms.inject_email_type;
  if (!emailType) return bodyText;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }

  const emails = parsed["emails"];
  if (!Array.isArray(emails) || emails.length === 0) return bodyText;

  const first = emails[0] as Record<string, unknown>;
  if (first && !first["type"]) {
    first["type"] = emailType;
    return JSON.stringify(parsed);
  }

  return bodyText;
}

/**
 * Forward the request to the upstream SCIM endpoint.
 */
export async function forwardRequest(
  req: Request,
  config: Config,
  bodyText?: string | null
): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (config.server.base_path && path.startsWith(config.server.base_path)) {
    path = path.slice(config.server.base_path.length);
  }

  const upstreamUrl = config.upstream.url.replace(/\/$/, "") + path + url.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");

  if (config.upstream.bearer_token) {
    headers.set("Authorization", `Bearer ${config.upstream.bearer_token}`);
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyText ?? req.body,
    });

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: upstreamRes.headers,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "upstream unreachable";
    return scimError(502, `Upstream error: ${message}`);
  }
}
