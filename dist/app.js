"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const config_1 = __importDefault(require("./config"));
const database_1 = require("./lib/database");
const logger_1 = __importDefault(require("./lib/logger"));
const plugin_system_1 = __importDefault(require("./lib/plugin_system"));
const updater_1 = __importDefault(require("./lib/updater"));
const global_1 = __importDefault(require("./middleware/global"));
const routes_1 = __importDefault(require("./routes"));
const app = (0, express_1.default)();
const appRoot = path_1.default.resolve(__dirname);
fs_extra_1.default.ensureDirSync(config_1.default.DATA_DIR);
fs_extra_1.default.ensureDirSync(config_1.default.PROB_DIR);
fs_extra_1.default.ensureDirSync(config_1.default.UPLOAD_DIR);
fs_extra_1.default.ensureDirSync(config_1.default.PLUGINS_DIR);
(0, database_1.initDb)();
app.set('view engine', 'ejs');
app.use(express_1.default.static('public'));
app.use(body_parser_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
const oj = { app, db: database_1.db, config: config_1.default, logger: logger_1.default };
const pluginManager = new plugin_system_1.default(config_1.default.PLUGINS_DIR, oj);
pluginManager.loadAll();
app.set('pluginManager', pluginManager);
app.use((0, global_1.default)(pluginManager));
app.use((0, routes_1.default)(pluginManager));
app.listen(config_1.default.PORT, async () => {
    logger_1.default.info(`DWOJ 2.0 running on port ${config_1.default.PORT}`);
    const updater = new updater_1.default(appRoot);
    const updated = await updater.checkAndApplyUpdate();
    if (updated) {
        logger_1.default.info('Application updated. Please restart the server to load the new version.');
    }
});
exports.default = app;
//# sourceMappingURL=app.js.map