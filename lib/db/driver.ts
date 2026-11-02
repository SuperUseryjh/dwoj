/**
 * 数据库驱动抽象层。
 *
 * 目标：让部署方通过配置选择 SQLite（默认，零依赖）或 MySQL / PostgreSQL
 * 等外部数据库，而不需要修改任何业务代码。
 *
 * 设计约定：
 *  - 所有驱动一律异步。即使 bun:sqlite 是同步的，也包装成 Promise，
 *    这样上层代码不会因为换驱动而改写。
 *  - SQL 里的占位符统一使用 `?`（SQLite / MySQL 原生支持；PostgreSQL 驱动
 *    内部负责把 `?` 转成 `$1..$n`，业务代码不需要关心）。
 *  - 返回的行对象使用 camelCase 之外的原始列名，与现有 SQL 保持一致。
 */

export type SqlValue = string | number | boolean | null | Date | Uint8Array;
export type SqlParams = readonly SqlValue[];

/** 写操作的结果，保持与 bun:sqlite 的语义一致 */
export interface ExecuteResult {
    /** 自增主键；没有自增主键的表（或驱动不支持时）为 0 */
    lastInsertRowid: number;
    /** 受影响行数 */
    changes: number;
}

export type DriverKind = 'sqlite' | 'mysql' | 'postgres';

/** 所有数据库驱动必须实现的接口 */
export interface SqlDriver {
    /** 驱动标识，用于日志 */
    readonly kind: DriverKind;
    /** 建表 / 迁移 / 初始化，服务启动时调用一次 */
    init(): Promise<void>;
    /** 查询多行 */
    query<T = any>(sql: string, params?: SqlParams): Promise<T[]>;
    /** 执行写操作 */
    execute(sql: string, params?: SqlParams): Promise<ExecuteResult>;
    /** 列出某张表的列名，用于跨方言的幂等迁移 */
    tableColumns(table: string): Promise<string[]>;
    /** 在事务中执行一组操作；出错自动回滚 */
    transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
    /** 关闭连接池 */
    close(): Promise<void>;
}
