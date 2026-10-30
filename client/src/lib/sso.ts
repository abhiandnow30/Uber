import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export type SsoConfig = { enabled: boolean; employeesMicrosoftOnly: boolean; adminsMicrosoft: boolean; notRegisteredMessage: string };

/** Microsoft sign-in settings (e.g. the message shown to people who are not registered). */
export function useSsoConfig() {
  return useQuery({ queryKey: ['sso-config'], queryFn: () => get<SsoConfig>('/auth/sso/config'), staleTime: 5 * 60_000 });
}
