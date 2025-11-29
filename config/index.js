const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    DATA_DIR: path.join(__dirname, '..', 'data'),
    PROB_DIR: path.join(__dirname, '..', 'problems_data'),
    UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
    PLUGINS_DIR: path.join(__dirname, '..', 'plugins'),
    // 其他配置项...
};
