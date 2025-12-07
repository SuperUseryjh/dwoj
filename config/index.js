const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    DATA_DIR: path.join(__dirname, '..', 'data'),
    PROB_DIR: path.join(__dirname, '..', 'problems_data'),
    UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
    PLUGINS_DIR: path.join(__dirname, '..', 'plugins'),
    JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key', // TODO: Change this to a strong, random secret in production
    // 其他配置项...
};
