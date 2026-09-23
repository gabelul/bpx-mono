import type { BpxConsultConfig } from "./config.js";

/** Run gut-check through Solo without borrowing Solo's backend or CLI models. */
export function gutCheckConfig(config: BpxConsultConfig): BpxConsultConfig {
	const gut = config.modes?.gutCheck;
	if (!gut) return config;
	return {
		...config,
		modes: {
			...config.modes,
			solo: {
				...config.modes?.solo,
				...gut,
				model: gut.model ?? config.modes?.solo?.model,
				backend: gut.backend,
				codexModel: gut.codexModel,
				cliModels: gut.cliModels,
				cliWindows: gut.cliWindows,
			},
		},
	};
}
