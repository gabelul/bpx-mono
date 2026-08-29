import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGeneratedProviders, registerEndpointCommand } from "./src/command.js";

export default async function bpxEndpoints(pi: ExtensionAPI): Promise<void> {
  const startupState = await registerGeneratedProviders(pi);
  registerEndpointCommand(pi);
  pi.on("session_start", async (_event, ctx) => {
    if (startupState.staleProfileReminderCount > 0 && startupState.managed.value?.settings?.staleReminder !== false) {
      const days = startupState.managed.value?.settings?.staleReminderDays ?? 7;
      ctx.ui.notify(`${startupState.staleProfileReminderCount} Endpoint(s) have not been refreshed for over ${days} days. Consider /endpoints refresh.`, "info");
    }
    for (const issue of startupState.issues) {
      if (issue.code === "custom_parse_failed" || issue.code === "generated_parse_failed" || issue.code === "config_parse_failed") {
        ctx.ui.notify(`bpx-endpoints: ${issue.message}`, issue.level === "error" ? "error" : "warning");
      }
    }
  });
}
