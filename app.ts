import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import fs from 'fs-extra';
import path from 'path';
import config from './config';
import { db, initDb, connectDatabase } from './lib/database';
import logger from './lib/logger';
import PluginSystem from './lib/plugin_system';
import Updater from './lib/updater';
import globalMiddleware from './middleware/global';
import createRoutes from './routes';

const app = express();
const appRoot = path.resolve(__dirname);

fs.ensureDirSync(config.DATA_DIR);
fs.ensureDirSync(config.PROB_DIR);
fs.ensureDirSync(config.UPLOAD_DIR);
fs.ensureDirSync(config.PLUGINS_DIR);

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

const oj = { app, db, config, logger };
const pluginManager = new PluginSystem(config.PLUGINS_DIR, oj);
pluginManager.loadAll();
app.set('pluginManager', pluginManager);

app.use(globalMiddleware(pluginManager));

app.use(createRoutes(pluginManager));

const startServer = async () => {
    try {
        await connectDatabase();
        initDb();
        
        app.listen(config.PORT as number, async () => {
            logger.info(`DWOJ 2.0 running on port ${config.PORT}`);

            const updater = new Updater(appRoot);
            const updated = await updater.checkAndApplyUpdate();
            if (updated) {
                logger.info('Application updated. Please restart the server to load the new version.');
            }
        });
    } catch (error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
};

startServer();

export default app;
