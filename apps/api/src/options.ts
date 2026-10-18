export type RuntimeSecrets = {
  registrationSecret?: string;
  dashboardSecret?: string;
};

export const MIN_DASHBOARD_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function configured(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

export function runtimeSecrets(env: NodeJS.ProcessEnv): RuntimeSecrets {
  const registrationSecret = env.REGISTRATION_SECRET;
  const dashboardSecret = env.DASHBOARD_SECRET;
  if (
    configured(dashboardSecret) &&
    dashboardSecret.length < MIN_DASHBOARD_SECRET_LENGTH
  ) {
    throw new ConfigError(
      `DASHBOARD_SECRET must be at least ${MIN_DASHBOARD_SECRET_LENGTH} characters`,
    );
  }
  return {
    ...(configured(registrationSecret) ? { registrationSecret } : {}),
    ...(configured(dashboardSecret) ? { dashboardSecret } : {}),
  };
}

export function enforceRuntimeSecrets(env: NodeJS.ProcessEnv): RuntimeSecrets {
  try {
    return runtimeSecrets(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
