import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import tar from 'tar';
import config from '../config';
import logger from './logger';

class Updater {
    private appRoot: string;
    private updateCheckUrl: string;
    private updatePackageUrl: string;
    private currentVersion: string;
    private tempDir: string;

    constructor(appRoot: string) {
        this.appRoot = appRoot;
        this.updateCheckUrl = config.UPDATE_CHECK_URL;
        this.updatePackageUrl = config.UPDATE_PACKAGE_URL;
        this.currentVersion = config.CURRENT_VERSION;
        this.tempDir = path.join(appRoot, 'temp_update');
    }

    public async checkAndApplyUpdate(): Promise<boolean> {
        logger.info('[Updater] Checking for updates...');
        try {
            const response = await axios.get(this.updateCheckUrl);
            const remoteVersionInfo = response.data;

            if (!remoteVersionInfo || !remoteVersionInfo.version) {
                logger.warn('[Updater] Invalid remote version information received.');
                return false;
            }

            const remoteVersion = remoteVersionInfo.version;
            logger.info(`[Updater] Current version: ${this.currentVersion}, Remote version: ${remoteVersion}`);

            if (remoteVersion !== this.currentVersion) {
                logger.info(`[Updater] New version ${remoteVersion} available. Starting update...`);
                await this.downloadAndExtractUpdate(remoteVersion);
                logger.info('[Updater] Update applied. Please restart the application to complete the update.');
                return true;
            } else {
                logger.info('[Updater] No new updates available.');
                return false;
            }
        } catch (error) {
            logger.error('[Updater] Error checking for updates:', error as Error);
            return false;
        }
    }

    private async downloadAndExtractUpdate(version: string): Promise<void> {
        logger.info(`[Updater] Downloading update package from ${this.updatePackageUrl}`);
        const tempPackagePath = path.join(this.tempDir, `dwoj-${version}.tar.gz`);

        await fs.ensureDir(this.tempDir);

        const writer = fs.createWriteStream(tempPackagePath);
        const response = await axios({
            url: this.updatePackageUrl,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', (err: Error) => reject(err));
        });
        logger.info('[Updater] Update package downloaded.');

        logger.info('[Updater] Extracting update package...');
        const extractDir = path.join(this.tempDir, 'extracted');
        await fs.ensureDir(extractDir);

        await tar.x({
            file: tempPackagePath,
            cwd: extractDir
        });
        logger.info('[Updater] Update package extracted.');

        logger.info('[Updater] Applying update...');
        let extractedContentPath = extractDir;
        const filesInExtractDir = await fs.readdir(extractDir);
        if (filesInExtractDir.length === 1) {
            const stat = await fs.stat(path.join(extractDir, filesInExtractDir[0]));
            if (stat.isDirectory()) {
                extractedContentPath = path.join(extractDir, filesInExtractDir[0]);
            }
        }

        await fs.copy(extractedContentPath, this.appRoot, { overwrite: true });
        logger.info('[Updater] Update applied successfully. Cleaning up temporary files...');

        await fs.remove(this.tempDir);
        logger.info('[Updater] Temporary files cleaned up.');
    }
}

export default Updater;
