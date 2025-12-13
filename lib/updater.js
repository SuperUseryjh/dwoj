const fs = require('fs-extra');
const path = require('path');
const axios = require('axios'); // 用于 HTTP 请求
const tar = require('tar'); // 用于解压 .tar.gz 文件
const config = require('../config');
const logger = require('./logger');

class Updater {
    constructor(appRoot) {
        this.appRoot = appRoot;
        this.updateCheckUrl = config.UPDATE_CHECK_URL;
        this.updatePackageUrl = config.UPDATE_PACKAGE_URL;
        this.currentVersion = config.CURRENT_VERSION; // 应该从 package.json 读取
        this.tempDir = path.join(appRoot, 'temp_update'); // 临时目录
    }

    async checkAndApplyUpdate() {
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
            logger.error('[Updater] Error checking for updates:', error);
            return false;
        }
    }

    async downloadAndExtractUpdate(version) {
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

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
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

        // 应用更新：将解压后的文件移动到应用程序根目录
        // 注意：这会覆盖现有文件，请确保备份或在安全的环境中执行
        logger.info('[Updater] Applying update...');
        // 假设 tar.gz 解压后，内容直接在 extractDir 下，或者在一个子目录中
        // 这里需要根据实际的 tar.gz 结构进行调整
        // 假设解压后，所有文件都在 extractDir/dwoj-new-version/ 这样的子目录中
        // 或者直接在 extractDir 中
        let extractedContentPath = extractDir; // 假设内容直接在 extractDir
        // 如果解压后有一个顶层目录，例如 dwoj-2.1.0，则需要调整
        const filesInExtractDir = await fs.readdir(extractDir);
        if (filesInExtractDir.length === 1 && await fs.stat(path.join(extractDir, filesInExtractDir[0])).then(s => s.isDirectory())) {
            // 如果解压后只有一个目录，那么实际内容在这个子目录里
            extractedContentPath = path.join(extractDir, filesInExtractDir[0]);
        }

        // 复制所有文件，覆盖现有文件
        await fs.copy(extractedContentPath, this.appRoot, { overwrite: true });
        logger.info('[Updater] Update applied successfully. Cleaning up temporary files...');

        // 清理临时文件
        await fs.remove(this.tempDir);
        logger.info('[Updater] Temporary files cleaned up.');
    }
}

module.exports = Updater;