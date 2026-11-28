import path from 'path';
import Updater from '../updater';
import type { PluginDefinition } from '../plugin/types';

let checked = false;

/** 系统插件：启动时执行一次更新检查（热重载不会重复触发） */
const updaterPlugin: PluginDefinition = {
    name: 'updater',
    version: '1.0.0',
    description: '启动时检查并应用更新',
    system: true,

    async setup(ctx) {
        if (checked) return;
        checked = true;

        // 不阻塞服务启动；更新完成后提示重启
        const appRoot = path.resolve(__dirname, '..', '..');
        void new Updater(appRoot).checkAndApplyUpdate()
            .then(updated => {
                if (updated) {
                    ctx.logger.info('Update applied. Please restart the server to load the new version.');
                }
            })
            .catch(err => ctx.logger.error('update check failed', err as Error));
    },
};

export default updaterPlugin;
