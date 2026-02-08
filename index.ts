import { loadConfig } from "./config.ts";
import {
  matchRule,
  scimError,
  buildSilentResponse,
  buildEmptyResponse,
  applyTransforms,
  forwardRequest,
} from "./proxy.ts";

const config = await loadConfig();

console.log(`SCIM Proxy starting`);
console.log(`  Upstream: ${config.upstream.url}`);
console.log(`  Port:     ${config.server.port}`);
console.log(`  Rules:    ${config.rules.length}`);
if (config.server.base_path) {
  console.log(`  Base path: ${config.server.base_path}`);
}

Bun.serve({
  port: config.server.port,
  async fetch(req) {
    const url = new URL(req.url);

    // Read body once so it can be reused for logging, rule handling, and forwarding
    let bodyText: string | null = null;
    if (req.body) {
      bodyText = await req.text();
      console.log(`[REQUEST] ${req.method} ${url.pathname} with body`);
      //console.log(bodyText);
    }

    const rule = matchRule(
      url.pathname,
      req.method,
      config.rules,
      config.server.base_path
    );

    if (rule) {
      let body: unknown = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
      }

      switch (rule.action) {
        case "reject":
          console.log(
            `[REJECT] ${req.method} ${url.pathname} → 403`
          );
          return scimError(403, `Operation ${req.method} ${rule.resource} is not permitted`);

        case "silent":
          console.log(
            `[SILENT] ${req.method} ${url.pathname} → voided`
          );
          return buildSilentResponse(
            req.method,
            body,
            url.pathname,
            config.server.base_path
          );

        case "empty":
          console.log(
            `[EMPTY] ${req.method} ${url.pathname} → empty response`
          );
          return buildEmptyResponse(
            req.method,
            url.pathname,
            body,
            config.server.base_path
          );
      }
    }

    if (bodyText) {
      bodyText = applyTransforms(bodyText, config);
    }
    console.log(`[PROXY] ${req.method} ${url.pathname} → upstream`);
    return forwardRequest(req, config, bodyText);
  },
});

console.log(`SCIM Proxy listening on http://localhost:${config.server.port}`);
