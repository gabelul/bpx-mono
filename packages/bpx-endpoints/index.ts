import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGeneratedProviders, registerEndpointCommand } from "./src/command.js";

export default async function bpxEndpoints(pi: ExtensionAPI): Promise<void> {
  const startupState = await registerGeneratedProviders(pi);
  registerEndpointCommand(pi);
  pi.on("session_start", async (_event, ctx) => {
    if (startupState.staleProfileReminderCount > 0 && startupState.managed.value?.settings?.staleReminder !== false) {
      const days = startupState.managed.value?.settings?.staleReminderDays ?? 7;
      const count = startupState.staleProfileReminderCount;
      const noun = count === 1 ? "1 Endpoint has" : `${count} Endpoints have`;
      ctx.ui.notify(`${noun} not been refreshed for over ${days} days. Consider /endpoints refresh.`, "info");
    }
    for (const issue of startupState.issues) {
      if (issue.code === "custom_parse_failed" || issue.code === "generated_parse_failed" || issue.code === "config_parse_failed") {
        ctx.ui.notify(`bpx-endpoints: ${issue.message}`, issue.level === "error" ? "error" : "warning");
      }
    }
  });
}
