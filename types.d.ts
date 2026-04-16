import { Database } from 'sqlite3';
import { Application, Request, Response, NextFunction } from 'express';

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: number;
                role: string;
            };
        }
    }
}

export interface ConfigType {
    PORT: number | string;
    DATA_DIR: string;
    PROB_DIR: string;
    UPLOAD_DIR: string;
    PLUGINS_DIR: string;
    JWT_SECRET: string;
    UPDATE_CHECK_URL: string;
    UPDATE_PACKAGE_URL: string;
    CURRENT_VERSION: string;
}

export interface DatabaseInstance extends Database {
}

export interface Logger {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string, error?: Error) => void;
}

export interface OJContext {
    app: Application;
    db: DatabaseInstance;
    config: ConfigType;
    logger: Logger;
}

export interface PluginManifest {
    name?: string;
    description?: string;
    version?: string;
    permissions?: string[];
}

export interface PluginModule {
    manifest?: PluginManifest;
    exports?: Record<string, any>;
    onRoute?: (app: Application) => void;
    [hookName: string]: any;
}

export interface PluginInfo {
    filename: string;
    name: string;
    desc: string;
    version: string;
    enabled: boolean;
    token: string;
    permissions: string[];
}

export interface Submission {
    id: number;
    problemId: number;
    userId: number;
    username: string;
    language: string;
    code: string;
    status: string;
    time: string;
    caseResults: any[];
    result?: string;
    errorInfo?: string;
}

export interface User {
    id: number;
    username: string;
    password: string;
    role: string;
    bio?: string;
    tags?: string;
    isBanned?: number;
}

export interface Problem {
    id: number;
    title: string;
    description?: string;
    authorId?: number;
    timeLimit?: number;
}

export interface DiscussNode {
    id: number;
    name: string;
    desc?: string;
}

export interface Thread {
    id: number;
    nodeId: number;
    title: string;
    content?: string;
    author: string;
    time: string;
    replies?: string;
}

export interface PluginConfig {
    filename: string;
    enabled: number;
    token: string;
    permissions?: string;
}

export type RoleLevel = 'default' | 'super_user' | 'root';

export interface RoleLV {
    [key: string]: number;
}
