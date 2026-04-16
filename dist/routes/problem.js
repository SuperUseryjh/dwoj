"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const config_1 = __importDefault(require("../config"));
const auth_1 = require("../middleware/auth");
const database_1 = __importDefault(require("../lib/database"));
const logger_1 = __importDefault(require("../lib/logger"));
const router = express_1.default.Router();
const upload = (0, multer_1.default)({ dest: config_1.default.UPLOAD_DIR });
router.get('/problem/new', (0, auth_1.requireRole)('super_user'), (req, res) => res.render('problem_edit', { problem: null }));
router.post('/problem/save', (0, auth_1.requireRole)('super_user'), upload.single('testcaseZip'), (req, res) => {
    const { id, title, description, timeLimit } = req.body;
    if (id) {
        database_1.default.get("SELECT * FROM problems WHERE id = ?", [id], (err, problem) => {
            if (err) {
                logger_1.default.error('Error fetching problem for edit', err);
                return res.status(500).send('服务器错误');
            }
            if (!problem)
                return res.status(404).send('题目不存在');
            if (req.user.role !== 'root' && problem.authorId !== req.user.id) {
                return res.status(403).send("无权修改此题目");
            }
            database_1.default.run("UPDATE problems SET title = ?, description = ?, timeLimit = ? WHERE id = ?", [title, description, timeLimit, id], (err) => {
                if (err) {
                    logger_1.default.error('Error updating problem', err);
                    return res.status(500).send('服务器错误');
                }
                handleZipUpload(req, id, res);
            });
        });
    }
    else {
        database_1.default.run(`INSERT INTO problems (title, description, authorId, timeLimit) VALUES (?, ?, ?, ?)`, [title, description, req.user.id, timeLimit], function (err) {
            if (err) {
                logger_1.default.error('Error inserting new problem', err);
                return res.status(500).send('服务器错误');
            }
            const newProblemId = this.lastID;
            handleZipUpload(req, newProblemId, res);
        });
    }
});
const handleZipUpload = (req, problemId, res) => {
    if (req.file) {
        try {
            const zip = new adm_zip_1.default(req.file.path);
            const targetDir = path_1.default.join(config_1.default.PROB_DIR, problemId.toString());
            fs_extra_1.default.emptyDirSync(targetDir);
            zip.extractAllTo(targetDir, true);
            fs_extra_1.default.unlinkSync(req.file.path);
            res.redirect('/');
        }
        catch (e) {
            logger_1.default.error('Error processing testcase zip', e);
            res.status(500).send('处理测试数据失败');
        }
    }
    else {
        res.redirect('/');
    }
};
router.get('/problem/edit/:id', (0, auth_1.requireRole)('super_user'), (req, res) => {
    database_1.default.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err, problem) => {
        if (err) {
            logger_1.default.error('Error fetching problem for edit page', err);
            return res.status(500).send('服务器错误');
        }
        if (!problem)
            return res.status(404).send('题目不存在');
        res.render('problem_edit', { problem: problem });
    });
});
router.get('/problem/:id', (req, res) => {
    database_1.default.get("SELECT * FROM problems WHERE id = ?", [req.params.id], (err, problem) => {
        if (err) {
            logger_1.default.error('Error fetching problem details', err);
            return res.status(500).send('服务器错误');
        }
        if (!problem)
            return res.status(404).send('Not Found');
        res.render('problem', { problem: problem });
    });
});
router.post('/submit', auth_1.requireLogin, (req, res) => {
    const { problemId, language, code } = req.body;
    const submissionTime = new Date().toLocaleString();
    database_1.default.run(`INSERT INTO submissions (problemId, userId, username, language, code, status, time, caseResults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [problemId, req.user.id, req.user.username, language, code, "Pending", submissionTime, JSON.stringify([])], function (err) {
        if (err) {
            logger_1.default.error('Error inserting new submission', err);
            return res.status(500).send('服务器错误');
        }
        const newSubmissionId = this.lastID;
        res.redirect('/status');
    });
});
router.get('/status', (req, res) => {
    database_1.default.all("SELECT * FROM submissions ORDER BY id DESC", [], (err, submissions) => {
        if (err) {
            logger_1.default.error('Error fetching submissions for status page', err);
            return res.status(500).send('服务器错误');
        }
        submissions.forEach(sub => {
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                }
                catch (e) {
                    logger_1.default.error(`Error parsing caseResults for submission ${sub.id}`, e);
                    sub.caseResults = [];
                }
            }
        });
        res.render('status', { submissions: submissions });
    });
});
router.get('/submission/:id', auth_1.requireLogin, (req, res) => {
    database_1.default.get("SELECT * FROM submissions WHERE id = ?", [req.params.id], (err, sub) => {
        if (err) {
            logger_1.default.error('Error fetching submission details', err);
            return res.status(500).send('服务器错误');
        }
        if (!sub)
            return res.status(404).send('提交不存在');
        database_1.default.get("SELECT role FROM users WHERE id = ?", [req.user.id], (err, userRole) => {
            if (err) {
                logger_1.default.error('Error fetching user role for submission view', err);
                return res.status(500).send('服务器错误');
            }
            if (sub.userId !== req.user.id && auth_1.ROLE_LV[userRole.role] < auth_1.ROLE_LV['super_user']) {
                return res.status(403).send("无权查看代码");
            }
            if (sub.caseResults) {
                try {
                    sub.caseResults = JSON.parse(sub.caseResults);
                }
                catch (e) {
                    logger_1.default.error(`Error parsing caseResults for submission ${sub.id}`, e);
                    sub.caseResults = [];
                }
            }
            res.render('submission', { sub: sub });
        });
    });
});
exports.default = router;
//# sourceMappingURL=problem.js.map