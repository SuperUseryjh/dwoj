import MarkdownIt from 'markdown-it';
import { ROLE_LV } from './auth';
import { createLogger } from '../lib/logger';
import type { PluginHost } from '../lib/plugin/host';

const logger = createLogger('plugin');

/**
 * plugin 进程里的页面运行时：
 * - 用户身份由 http 进程通过 x-dwoj-user 传入，这里只负责填充模板 locals；
 * - 插件 header/footer/CSS 在这里注入，因为页面现在由 plugin 进程渲染。
 */
export default function createPluginRuntime(pluginManager: Pick<PluginHost, 'inject'>) {
    const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

    return async (req: any, res: any, next: () => Promise<void>) => {
        res.locals.ROLE_LV = ROLE_LV;
        res.locals.user = req.user || null;
        res.locals.renderMarkdown = (content: string) => md.render(content || '');

        try {
            const injected = await pluginManager.inject(req);
            res.locals.pluginHeader = injected.header;
            res.locals.pluginFooter = injected.footer;
            res.locals.pluginStyles = injected.styles;
        } catch (err) {
            logger.error('Error injecting plugin headers/footers', err as Error);
            res.locals.pluginHeader = '';
            res.locals.pluginFooter = '';
            res.locals.pluginStyles = '';
        }

        return next();
    };
}
