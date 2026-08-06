// MySQL 에 접속해 스키마 조회와 쿼리 실행을 담당하는 드라이버

import mysql from 'mysql2/promise';
import type { FieldPacket, Pool, PoolOptions, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type {
    Column,
    Driver,
    Parameter,
    ProcedureRef,
    ProcedureResult,
    QueryResult,
    TableRef,
} from './driver.ts';
import { assertProcedureCall, assertReadOnly, toPositionalParams } from './driver.ts';

// MySQL 은 schema = database 라서 접속한 DB 로 제한한다.
// 제한하지 않으면 mysql / sys / performance_schema 노이즈가 섞인다.
const LIST_TABLES = `
SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME
`;

const DESCRIBE_TABLE = `
SELECT
  COLUMN_NAME              AS \`name\`,
  DATA_TYPE                AS \`type\`,
  IS_NULLABLE              AS \`nullable\`,
  CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
  COLUMN_DEFAULT           AS \`colDefault\`,
  COLUMN_KEY               AS \`columnKey\`
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION
`;

const LIST_PROCEDURES = `
SELECT ROUTINE_SCHEMA AS \`schema\`, ROUTINE_NAME AS \`name\`, LAST_ALTERED AS \`modifyDate\`
FROM information_schema.ROUTINES
WHERE ROUTINE_TYPE = 'PROCEDURE' AND ROUTINE_SCHEMA = DATABASE()
ORDER BY ROUTINE_NAME
`;

const DESCRIBE_PROCEDURE = `
SELECT
  PARAMETER_NAME           AS \`name\`,
  DATA_TYPE                AS \`type\`,
  CHARACTER_MAXIMUM_LENGTH AS \`maxLength\`,
  PARAMETER_MODE           AS \`mode\`
FROM information_schema.PARAMETERS
WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = 'PROCEDURE'
ORDER BY ORDINAL_POSITION
`;

function toQueryResult(rows: unknown[][], fields: FieldPacket[], maxRows: number): QueryResult {
    const totalRows = rows.length;
    const truncated = totalRows > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;

    return {
        columns: fields.map((f) => f.name),
        rows: kept,
        rowCount: kept.length,
        totalRows,
        truncated,
        multipleResultSets: false,
    };
}

export class MysqlDriver implements Driver {
    private pool?: Pool;
    private readonly cfg: PoolOptions;

    constructor(cfg: PoolOptions) {
        this.cfg = cfg;
    }

    /** mysql2 풀은 첫 쿼리에서 연결하므로 지연 연결이 기본이다. */
    private getPool(): Pool {
        this.pool ??= mysql.createPool(this.cfg);
        return this.pool;
    }

    async listTables(): Promise<TableRef[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(LIST_TABLES);
        return rows as TableRef[];
    }

    async describeTable(schema: string, table: string): Promise<Column[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(DESCRIBE_TABLE, [schema, table]);

        return rows.map((r) => ({
            name: String(r.name),
            type: String(r.type),
            nullable: r.nullable === 'YES',
            maxLength: r.maxLength === null ? null : Number(r.maxLength),
            default: r.colDefault === null ? null : String(r.colDefault),
            isPrimaryKey: r.columnKey === 'PRI',
        }));
    }

    async query(
        text: string,
        params: Record<string, unknown>,
        maxRows: number,
    ): Promise<QueryResult> {
        assertReadOnly(text, 'mysql');
        const bound = toPositionalParams(text, params, 'mysql');

        const [rows, fields] = await this.getPool().query<RowDataPacket[]>(
            { sql: bound.text, rowsAsArray: true },
            bound.values,
        );
        return toQueryResult(rows as unknown as unknown[][], fields ?? [], maxRows);
    }

    async listProcedures(): Promise<ProcedureRef[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(LIST_PROCEDURES);
        return rows.map((r) => ({
            schema: String(r.schema),
            name: String(r.name),
            modifyDate: r.modifyDate instanceof Date ? r.modifyDate : null,
        }));
    }

    async describeProcedure(schema: string, name: string): Promise<Parameter[]> {
        const [rows] = await this.getPool().query<RowDataPacket[]>(DESCRIBE_PROCEDURE, [schema, name]);

        return rows.map((r) => ({
            name: r.name === null ? '' : String(r.name),
            type: String(r.type),
            maxLength: r.maxLength === null ? null : Number(r.maxLength),
            isOutput: r.mode === 'OUT' || r.mode === 'INOUT',
        }));
    }

    /**
     * CALL 문장을 그대로 실행한다.
     *
     * CALL 결과는 결과 집합(배열)들 뒤에 ResultSetHeader 가 붙는 형태다.
     * 결과 집합이 없으면 헤더만 온다. 첫 결과 집합만 반환한다.
     */
    async callProcedure(text: string, maxRows: number): Promise<ProcedureResult> {
        assertProcedureCall(text, 'mysql');

        const [raw, fields] = await this.getPool().query({ sql: text, rowsAsArray: true });

        let firstSet: unknown[][] = [];
        let header: Pick<ResultSetHeader, 'affectedRows'> | undefined;
        let setCount = 0;

        if (Array.isArray(raw)) {
            for (const part of raw as unknown[]) {
                if (Array.isArray(part)) {
                    setCount++;
                    if (setCount === 1) firstSet = part as unknown[][];
                } else if (part && typeof part === 'object') {
                    header = part as ResultSetHeader;
                }
            }
        } else {
            header = raw;
        }

        // CALL 은 결과 집합별 필드 배열이 온다. 첫 번째만 쓴다.
        const fieldList: FieldPacket[] = Array.isArray(fields?.[0])
            ? ((fields as unknown as FieldPacket[][])[0] ?? [])
            : (fields ?? []);

        const result = toQueryResult(firstSet, fieldList, maxRows);
        result.multipleResultSets = setCount > 1;

        return { result, rowsAffected: header?.affectedRows ?? 0 };
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        const pool = this.pool;
        this.pool = undefined;
        await pool.end();
    }
}
