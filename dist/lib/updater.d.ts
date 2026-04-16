declare class Updater {
    private appRoot;
    private updateCheckUrl;
    private updatePackageUrl;
    private currentVersion;
    private tempDir;
    constructor(appRoot: string);
    checkAndApplyUpdate(): Promise<boolean>;
    private downloadAndExtractUpdate;
}
export default Updater;
//# sourceMappingURL=updater.d.ts.map