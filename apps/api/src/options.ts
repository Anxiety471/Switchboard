export type RuntimeSecrets = {
  registrationSecret?: string;
  dashboardSecret?: string;
};

export const MIN_DASHBOARD_SECRET_LENGTH = 32;

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
    throw new Error(
      `DASHBOARD_SECRET must be at least ${MIN_DASHBOARD_SECRET_LENGTH} characters`,
    );
  }
  return {
    ...(configured(registrationSecret) ? { registrationSecret } : {}),
    ...(configured(dashboardSecret) ? { dashboardSecret } : {}),
  };
}
