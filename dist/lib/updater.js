"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const tar_1 = __importDefault(require("tar"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("./logger"));
class Updater {
    constructor(appRoot) {
        this.appRoot = appRoot;
        this.updateCheckUrl = config_1.default.UPDATE_CHECK_URL;
        this.updatePackageUrl = config_1.default.UPDATE_PACKAGE_URL;
        this.currentVersion = config_1.default.CURRENT_VERSION;
        this.tempDir = path_1.default.join(appRoot, 'temp_update');
    }
    async checkAndApplyUpdate() {
        logger_1.default.info('[Updater] Checking for updates...');
        try {
            const response = await axios_1.default.get(this.updateCheckUrl);
            const remoteVersionInfo = response.data;
            if (!remoteVersionInfo || !remoteVersionInfo.version) {
                logger_1.default.warn('[Updater] Invalid remote version information received.');
                return false;
            }
            const remoteVersion = remoteVersionInfo.version;
            logger_1.default.info(`[Updater] Current version: ${this.currentVersion}, Remote version: ${remoteVersion}`);
            if (remoteVersion !== this.currentVersion) {
                logger_1.default.info(`[Updater] New version ${remoteVersion} available. Starting update...`);
                await this.downloadAndExtractUpdate(remoteVersion);
                logger_1.default.info('[Updater] Update applied. Please restart the application to complete the update.');
                return true;
            }
            else {
                logger_1.default.info('[Updater] No new updates available.');
                return false;
            }
        }
        catch (error) {
            logger_1.default.error('[Updater] Error checking for updates:', error);
            return false;
        }
    }
    async downloadAndExtractUpdate(version) {
        logger_1.default.info(`[Updater] Downloading update package from ${this.updatePackageUrl}`);
        const tempPackagePath = path_1.default.join(this.tempDir, `dwoj-${version}.tar.gz`);
        await fs_extra_1.default.ensureDir(this.tempDir);
        const writer = fs_extra_1.default.createWriteStream(tempPackagePath);
        const response = await (0, axios_1.default)({
            url: this.updatePackageUrl,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', (err) => reject(err));
        });
        logger_1.default.info('[Updater] Update package downloaded.');
        logger_1.default.info('[Updater] Extracting update package...');
        const extractDir = path_1.default.join(this.tempDir, 'extracted');
        await fs_extra_1.default.ensureDir(extractDir);
        await tar_1.default.x({
            file: tempPackagePath,
            cwd: extractDir
        });
        logger_1.default.info('[Updater] Update package extracted.');
        logger_1.default.info('[Updater] Applying update...');
        let extractedContentPath = extractDir;
        const filesInExtractDir = await fs_extra_1.default.readdir(extractDir);
        if (filesInExtractDir.length === 1) {
            const stat = await fs_extra_1.default.stat(path_1.default.join(extractDir, filesInExtractDir[0]));
            if (stat.isDirectory()) {
                extractedContentPath = path_1.default.join(extractDir, filesInExtractDir[0]);
            }
        }
        await fs_extra_1.default.copy(extractedContentPath, this.appRoot, { overwrite: true });
        logger_1.default.info('[Updater] Update applied successfully. Cleaning up temporary files...');
        await fs_extra_1.default.remove(this.tempDir);
        logger_1.default.info('[Updater] Temporary files cleaned up.');
    }
}
exports.default = Updater;
//# sourceMappingURL=updater.js.map