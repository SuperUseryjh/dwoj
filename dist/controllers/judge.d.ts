import PluginSystem from '../lib/plugin_system';
export declare const runJudge: (submissionId: number, pluginManager: PluginSystem) => Promise<void>;
export declare const executeCode: (lang: string, code: string, input: string) => Promise<string>;
declare const _default: {
    runJudge: (submissionId: number, pluginManager: PluginSystem) => Promise<void>;
    executeCode: (lang: string, code: string, input: string) => Promise<string>;
};
export default _default;
//# sourceMappingURL=judge.d.ts.map