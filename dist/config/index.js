"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const config = {
    PORT: process.env.PORT || 3000,
    DATA_DIR: path_1.default.join(__dirname, '..', 'data'),
    PROB_DIR: path_1.default.join(__dirname, '..', 'problems_data'),
    UPLOAD_DIR: path_1.default.join(__dirname, '..', 'uploads'),
    PLUGINS_DIR: path_1.default.join(__dirname, '..', 'plugins'),
    JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key',
    UPDATE_CHECK_URL: 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.json',
    UPDATE_PACKAGE_URL: 'http://static.mr-onion-blog.fun/deploy/dwoj/dwoj.tar.gz',
    CURRENT_VERSION: '2.0.0',
};
exports.default = config;
//# sourceMappingURL=index.js.map