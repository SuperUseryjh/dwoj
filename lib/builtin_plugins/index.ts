import type { PluginDefinition } from '../plugin/types';
import dbMonitor from './db-monitor';

/** 内置插件注册表（不经过文件系统加载） */
export const BUILTIN_PLUGINS: PluginDefinition[] = [dbMonitor];
