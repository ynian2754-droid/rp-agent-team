import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    'rp-team': { page?: string; runId?: string }
  }
}
