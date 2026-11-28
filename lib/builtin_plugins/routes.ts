import type { PluginDefinition } from '../plugin/types';
import authRoutes from '../../routes/auth';
import profileRoutes from '../../routes/profile';
import problemRoutes from '../../routes/problem';
import discussRoutes from '../../routes/discuss';
import adminRoutes from '../../routes/admin';
import homeRoutes from '../../routes/home';

/**
 * 系统路由插件：把原来的 routes/* 模块原样挂到 plugin 进程。
 *
 * 这些插件默认启用、不可禁用；路由内部仍使用原有 requireLogin / requireRole
 * 中间件，因此行为与重构前一致。
 */
export const systemRoutePlugins: PluginDefinition[] = [
    {
        name: 'system-home',
        version: '1.0.0',
        description: '首页与题目列表',
        system: true,
        setup(ctx) {
            ctx.system?.mount(homeRoutes);
        },
    },
    {
        name: 'system-auth',
        version: '1.0.0',
        description: '登录、注册与退出',
        system: true,
        setup(ctx) {
            ctx.system?.mount(authRoutes);
        },
    },
    {
        name: 'system-profile',
        version: '1.0.0',
        description: '个人资料与密码修改',
        system: true,
        setup(ctx) {
            ctx.system?.mount(profileRoutes);
        },
    },
    {
        name: 'system-problem',
        version: '1.0.0',
        description: '题目浏览、编辑、提交与评测状态',
        system: true,
        setup(ctx) {
            ctx.system?.mount(problemRoutes);
        },
    },
    {
        name: 'system-discuss',
        version: '1.0.0',
        description: '讨论区与帖子',
        system: true,
        setup(ctx) {
            ctx.system?.mount(discussRoutes);
        },
    },
    {
        name: 'system-admin',
        version: '1.0.0',
        description: '管理后台与插件管理',
        system: true,
        setup(ctx) {
            if (ctx.system) ctx.system.mount(adminRoutes(ctx.system.manager));
        },
    },
];
