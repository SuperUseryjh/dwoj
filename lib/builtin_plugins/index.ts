import type { PluginDefinition } from '../plugin/types';
import dbMonitor from './db-monitor';
import updater from './updater';
import { systemRoutePlugins } from './routes';

/**
 * 内置插件注册表。
 *
 * system: true 的插件是系统组件：默认启用、不可禁用/删除，
 * 路由与后台服务都通过它们接入 plugin 进程。
 */
export const BUILTIN_PLUGINS: PluginDefinition[] = [
    ...systemRoutePlugins,
    updater,
    dbMonitor,
];
