export type RuleAction = "reject" | "silent" | "empty";

export interface Rule {
  resource: string;
  methods: string[];
  action: RuleAction;
}

export interface UpstreamConfig {
  url: string;
  bearer_token?: string;
}

export interface ServerConfig {
  port: number;
  base_path?: string;
}

export interface TransformsConfig {
  inject_email_type?: string;
}

export interface Config {
  upstream: UpstreamConfig;
  server: ServerConfig;
  rules: Rule[];
  transforms: TransformsConfig;
}

export async function loadConfig(
  path: string = process.env["CONFIG_PATH"] ?? "./scim-proxy.toml"
): Promise<Config> {
  const text = await Bun.file(path).text();
  const raw = Bun.TOML.parse(text) as Record<string, unknown>;

  const upstream = raw["upstream"] as Record<string, unknown> | undefined;
  if (!upstream || typeof upstream["url"] !== "string") {
    throw new Error("Config: [upstream] url is required");
  }

  const server = (raw["server"] ?? {}) as Record<string, unknown>;
  const port =
    typeof server["port"] === "number" ? server["port"] : 8080;

  const rawRules = (raw["rules"] ?? []) as Record<string, unknown>[];
  const rules: Rule[] = rawRules.map((r, i) => {
    if (typeof r["resource"] !== "string") {
      throw new Error(`Config: rules[${i}] resource is required`);
    }
    const methods = (r["methods"] as string[] | undefined) ?? ["*"];
    const action = (r["action"] as string | undefined) ?? "reject";
    if (action !== "reject" && action !== "silent" && action !== "empty") {
      throw new Error(
        `Config: rules[${i}] action must be "reject", "silent", or "empty"`
      );
    }
    return {
      resource: r["resource"] as string,
      methods: methods.map((m) => m.toUpperCase()),
      action,
    };
  });

  const transforms = (raw["transforms"] ?? {}) as Record<string, unknown>;

  return {
    upstream: {
      url: upstream["url"] as string,
      bearer_token: upstream["bearer_token"] as string | undefined,
    },
    server: {
      port,
      base_path: server["base_path"] as string | undefined,
    },
    rules,
    transforms: {
      inject_email_type: transforms["inject_email_type"] as string | undefined,
    },
  };
}
