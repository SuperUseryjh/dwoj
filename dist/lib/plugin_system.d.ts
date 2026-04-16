import { OJContext, PluginInfo } from '../types';
declare class PluginSystem {
    private pluginDir;
    private plugins;
    private oj;
    private db;
    private app;
    private pluginExports;
    constructor(pluginDir: string, ojRef: OJContext);
    loadAll(): Promise<void>;
    getPluginExports(pluginName: string): any;
    emit(hookName: string, ...args: any[]): any[];
    getList(): PluginInfo[];
    toggle(filename: string, enabled: boolean): Promise<void>;
    delete(filename: string): Promise<void>;
}
export default PluginSystem;
//# sourceMappingURL=plugin_system.d.ts.map