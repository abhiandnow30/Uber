import { useQuery } from '@tanstack/react-query';
import { get } from './api';

export type SsoConfig = { enabled: boolean; employeesMicrosoftOnly: boolean; adminsMicrosoft: boolean; notRegisteredMessage: string };

/** Whether Microsoft sign-in is available, and whether employees must use it (no employee passwords). */
export function useSsoConfig() {
  return useQuery({ queryKey: ['sso-config'], queryFn: () => get<SsoConfig>('/auth/sso/config'), staleTime: 5 * 60_000 });
}
