import { Router } from '../lib/bun-http';
import { Problem, query } from '../lib/database';
import { createLogger } from '../lib/logger';

const logger = createLogger('http');

const router = new Router();

import authRoutes from './auth';
import profileRoutes from './profile';
import problemRoutes from './problem';
import adminRoutes from './admin';
import discussRoutes from './discuss';

export default (pluginManager: any): Router => {
    router.get('/', async (req, res, next) => {
        try {
            const problems = await query<Problem>("SELECT id, title FROM problems");
            res.render('index', { problems });
        } catch (err) {
            logger.error('Error fetching problems for index page', err as Error);
            res.status(500).send('服务器错误');
        }
    });

    router.use(authRoutes);
    router.use(profileRoutes);
    router.use(problemRoutes);
    router.use(adminRoutes(pluginManager));
    router.use(discussRoutes);

    return router;
};