import { Router } from '../lib/bun-http';
import { Problem, query } from '../lib/database';
import logger from '../lib/logger';

const router = new Router();

import authRoutes from './auth';
import profileRoutes from './profile';
import problemRoutes from './problem';
import adminRoutes from './admin';
import discussRoutes from './discuss';

export default (pluginManager: any): Router => {
    router.get('/', (req, res, next) => {
        try {
            const problems = query<Problem>("SELECT id, title FROM problems");
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