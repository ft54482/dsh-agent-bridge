import { loadSecretFileSync, SecretStore } from "./auth.js";
import { normalizeConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { canonicalizeRoots } from "./paths.js";
import { createTools } from "./tools.js";

export const name = "dsh-agent-bridge";

/** The bridge drives the Host Session Controller, i.e. the same Web Sessions humans see. */
export const inject = ["sessionController", "workspaceRegistry"];

/**
 * Mount a loopback-only Streamable HTTP MCP endpoint inside the DSH Host.
 *
 * Fail-closed rules:
 * - invalid config, missing/short secret, non-loopback bind host, or an empty
 *   allowlist never opens a listener;
 * - a listener failure is logged and leaves the host running without a bridge
 *   rather than crashing the host.
 */
export function apply(ctx, rawConfig) {
  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    ctx.logger.error("dsh-agent-bridge: invalid config, bridge disabled: %s", error.message);
    return;
  }

  if (loadSecretFileSync(config.secretFile, config.secretMinLength) === null) {
    ctx.logger.error(
      "dsh-agent-bridge: secret file is missing, empty, or shorter than %d bytes (%s); refusing to start MCP",
      config.secretMinLength,
      config.secretFile
    );
    return;
  }

  ctx.effect(async () => {
    const { roots, dropped } = await canonicalizeRoots(config.workspaceAllowlist);
    for (const entry of dropped) {
      ctx.logger.warn("dsh-agent-bridge: dropped unusable allowlist root %s (%s)", entry.entry, entry.reason);
    }
    if (roots.length === 0) {
      ctx.logger.error("dsh-agent-bridge: no usable workspace allowlist root; refusing to start MCP");
      return () => {};
    }

    const secretStore = new SecretStore(config.secretFile, config.secretMinLength);
    const { tools } = createTools({ ctx, config, roots });
    const server = createMcpServer({ config, secretStore, tools, logger: ctx.logger });
    try {
      const address = await server.start();
      ctx.logger.info(
        "dsh-agent-bridge: MCP listening on %s (loopback only, %d allowlist root(s))",
        address.url,
        roots.length
      );
    } catch (error) {
      ctx.logger.error("dsh-agent-bridge: failed to start MCP listener on %s:%d: %s", config.host, config.port, error.message);
      return () => {};
    }
    return async () => {
      await server.stop();
      ctx.logger.info("dsh-agent-bridge: MCP listener stopped");
    };
  }, "dsh-agent-bridge.mcp");
}
