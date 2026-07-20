import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import * as tar from 'tar';
import * as config from '../config';
import { createLogger } from './logger';
const logger = createLogger('Updater');

class Updater {
    appRoot: string;
    updateCheckUrl: string;
    updatePackageUrl: string;
    currentVersion: string;
    tempDir: string;

    constructor(appRoot: string) {
        this.appRoot = appRoot;
        this.updateCheckUrl = config.UPDATE_CHECK_URL;
        this.updatePackageUrl = config.UPDATE_PACKAGE_URL;
        this.currentVersion = config.CURRENT_VERSION;
        this.tempDir = path.join(appRoot, 'temp_update');
    }

    async checkAndApplyUpdate(): Promise<boolean> {
        logger.info('Checking for updates...');
        try {
            const response = await axios.get(this.updateCheckUrl);
            const remoteVersionInfo = response.data;

            if (!remoteVersionInfo || !remoteVersionInfo.version) {
                logger.warn('Invalid remote version information received.');
                return false;
            }

            const remoteVersion = remoteVersionInfo.version;
            logger.info(`Current version: ${this.currentVersion}, Remote version: ${remoteVersion}`);

            if (remoteVersion !== this.currentVersion) {
                logger.info(`New version ${remoteVersion} available. Starting update...`);
                await this.downloadAndExtractUpdate(remoteVersion);
                logger.info('Update applied. Please restart the application to complete the update.');
                return true;
            } else {
                logger.info('No new updates available.');
                return false;
            }
        } catch (error) {
            logger.error('Error checking for updates:', error as Error);
            return false;
        }
    }

    async downloadAndExtractUpdate(version: string): Promise<void> {
        logger.info(`Downloading update package from ${this.updatePackageUrl}`);
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
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        logger.info('Update package downloaded.');

        logger.info('Extracting update package...');
        const extractDir = path.join(this.tempDir, 'extracted');
        await fs.ensureDir(extractDir);

        await tar.x({
            file: tempPackagePath,
            cwd: extractDir
        });
        logger.info('Update package extracted.');

        logger.info('Applying update...');
        let extractedContentPath = extractDir;
        const filesInExtractDir = await fs.readdir(extractDir);
        if (filesInExtractDir.length === 1 && await fs.stat(path.join(extractDir, filesInExtractDir[0])).then(s => s.isDirectory())) {
            extractedContentPath = path.join(extractDir, filesInExtractDir[0]);
        }

        await fs.copy(extractedContentPath, this.appRoot, { overwrite: true });
        logger.info('Update applied successfully. Cleaning up temporary files...');

        await fs.remove(this.tempDir);
        logger.info('Temporary files cleaned up.');
    }
}

export default Updater;