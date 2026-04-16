"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const router = express_1.default.Router();
router.get('/profile', auth_1.requireLogin, (req, res) => res.render('profile'));
router.post('/profile', auth_1.requireLogin, (req, res) => {
    const { password, bio } = req.body;
    let updateFields = [];
    let updateValues = [];
    if (password) {
        updateFields.push("password = ?");
        updateValues.push(password);
    }
    if (bio !== undefined) {
        updateFields.push("bio = ?");
        updateValues.push(bio);
    }
    if (updateFields.length === 0) {
        return res.redirect('/profile');
    }
    updateValues.push(req.user.id);
    database_1.default.run(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateValues, function (err) {
        if (err) {
            logger_1.default.error('Error updating user profile', err);
            return res.status(500).send('服务器错误');
        }
        res.redirect('/profile');
    });
});
exports.default = router;
//# sourceMappingURL=profile.js.map