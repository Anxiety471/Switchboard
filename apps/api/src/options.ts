export type RuntimeSecrets = {
  registrationSecret?: string;
  dashboardSecret?: string;
};

function configured(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

export function runtimeSecrets(env: NodeJS.ProcessEnv): RuntimeSecrets {
  const registrationSecret = env.REGISTRATION_SECRET;
  const dashboardSecret = env.DASHBOARD_SECRET;
  return {
    ...(configured(registrationSecret) ? { registrationSecret } : {}),
    ...(configured(dashboardSecret) ? { dashboardSecret } : {}),
  };
}
