export type WizardStepResult<T extends object> = { value: Partial<T> } | "back" | "cancel";

export type WizardStep<T extends object> = (state: Readonly<T>) => Promise<WizardStepResult<T>>;

export async function runWizard<T extends object>(initialState: T, steps: readonly WizardStep<T>[]): Promise<T | undefined> {
  let index = 0;
  let state = initialState;
  while (index < steps.length) {
    const result = await steps[index]!(state);
    if (result === "cancel") return undefined;
    if (result === "back") {
      if (index === 0) return undefined;
      index -= 1;
      continue;
    }
    state = { ...state, ...result.value };
    index += 1;
  }
  return state;
}
