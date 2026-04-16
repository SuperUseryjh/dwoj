import express from 'express';
import db from '../lib/database';
import logger from '../lib/logger';
import PluginSystem from '../lib/plugin_system';
import authRoutes from './auth';
import profileRoutes from './profile';
import problemRoutes from './problem';
import adminRoutes from './admin';
import discussRoutes from './discuss';

const router = express.Router();

export default (pluginManager: PluginSystem): express.Router => {
    router.get('/', (req, res) => {
        db.all("SELECT id, title FROM problems", [], (err: Error, problems: any[]) => {
            if (err) {
                logger.error('Error fetching problems for index page', err);
                return res.status(500).send('服务器错误');
            }
            res.render('index', { problems: problems });
        });
    });

    router.use(authRoutes);
    router.use(profileRoutes);
    router.use(problemRoutes);
    router.use(adminRoutes(pluginManager));
    router.use(discussRoutes);

    return router;
};
