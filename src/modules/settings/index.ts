export { default as Settings } from '@/modules/settings/Settings';
export {
  readDeviceName,
  readMcpNavigationPolicy,
} from '@/modules/settings/hooks/useMcpNavigationSettings';
export type { McpNavigationPolicy } from '@/modules/settings/hooks/useMcpNavigationSettings';
