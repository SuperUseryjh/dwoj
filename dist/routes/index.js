"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const auth_1 = __importDefault(require("./auth"));
const profile_1 = __importDefault(require("./profile"));
const problem_1 = __importDefault(require("./problem"));
const admin_1 = __importDefault(require("./admin"));
const discuss_1 = __importDefault(require("./discuss"));
const router = express_1.default.Router();
exports.default = (pluginManager) => {
    router.get('/', (req, res) => {
        database_1.default.all("SELECT id, title FROM problems", [], (err, problems) => {
            if (err) {
                logger_1.default.error('Error fetching problems for index page', err);
                return res.status(500).send('服务器错误');
            }
            res.render('index', { problems: problems });
        });
    });
    router.use(auth_1.default);
    router.use(profile_1.default);
    router.use(problem_1.default);
    router.use((0, admin_1.default)(pluginManager));
    router.use(discuss_1.default);
    return router;
};
//# sourceMappingURL=index.js.map