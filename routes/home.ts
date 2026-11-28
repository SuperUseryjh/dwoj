import { Router } from '../lib/bun-http';
import { Problem, query } from '../lib/database';
import { createLogger } from '../lib/logger';

const logger = createLogger('http');

const router = new Router();

router.get('/', async (req, res, next) => {
    try {
        const problems = await query<Problem>("SELECT id, title FROM problems");
        res.render('index', { problems });
    } catch (err) {
        logger.error('Error fetching problems for index page', err as Error);
        res.status(500).send('服务器错误');
    }
});

export default router;
